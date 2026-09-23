/**
 * pi-context-view - inspect what occupies the model context.
 *
 * Passively captures the first real turn, or runs one on-demand silent probe
 * when a context view is opened before any real turn.
 */
import { buildSessionContext, type BeforeAgentStartEvent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ConfigStore, createDefaultConfigFile } from "./config.ts";
import {
	CONTEXT_COMMAND_DESCRIPTION,
	getContextArgumentCompletions,
	parseContextCommand,
	reportCommandMessage,
	reportConfigCreation,
	reportTuiOnly,
	resolveInitialCapture,
} from "./command.ts";
import {
	CompactionState,
	InitialCaptureState,
	buildNativeSnapshot,
	buildUsageSnapshot,
	collectPromptSources,
	parsePersistedIdentities,
	PROBE_IDENTITIES_CUSTOM_TYPE,
	SilentProbeState,
} from "./capture.ts";
import { readProbeToken } from "./probe-token.ts";
import { readAutoCompactReserveTokens } from "./settings.ts";
import { showInjectionsView } from "./ui/injections-view.ts";
import { showUsageView } from "./ui/usage-view.ts";
import { computeUsage, toReportedUsage } from "./usage.ts";
import {
	attributeVisibleSources,
	recordRequestCompletion,
	recordToolFailure,
	recordUnpairedRequest,
	recordRetry,
	readHistoryRecords,
	RetryTracker,
	summarizeHistory,
	type PendingRequest,
} from "./history.ts";
import { showHistoryView } from "./ui/history-view.ts";

export default function (pi: ExtensionAPI) {
	const capture = new InitialCaptureState();
	const probe = new SilentProbeState();
	const compaction = new CompactionState();
	const configStore = new ConfigStore();
	let persistedIdentityCount = 0;
	let requestPromptOptions: BeforeAgentStartEvent["systemPromptOptions"] | undefined;
	const pendingRequests: PendingRequest[] = [];
	const retryTracker = new RetryTracker();

	/** Persist identities (role and timestamp only, never content) not yet written this runtime. */
	function persistProbeIdentities(): void {
		const identities = probe.syntheticMessages;
		if (identities.length <= persistedIdentityCount) return;
		pi.appendEntry(PROBE_IDENTITIES_CUSTOM_TYPE, { messages: identities });
		persistedIdentityCount = identities.length;
	}

	pi.on("session_start", (_event, ctx) => {
		compaction.finish();
		pendingRequests.length = 0;
		retryTracker.clear();
		// Rehydrate probe identities from all prior runtimes so persisted probe
		// messages stay out of later model contexts and Usage after resume,
		// reload, or fork. Restored identities are already persisted.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === PROBE_IDENTITIES_CUSTOM_TYPE) {
				probe.restoreIdentities(parsePersistedIdentities(entry.data));
			}
		}
		persistedIdentityCount = probe.syntheticMessages.length;
	});

	pi.on("session_before_compact", (event) => {
		compaction.begin(event.signal);
	});

	// Pi ends every observed compaction with exactly one of these two events.
	pi.on("session_compact", () => {
		compaction.finish();
	});

	pi.on("session_compact_failed", () => {
		compaction.finish();
	});

	pi.on("input", (event) => {
		// Reset text earlier input transforms added to our own synthetic prompt:
		// the probe carries no instructions, and its run is identified by token.
		if (event.text === "" || !probe.isProbeInput(event.source, readProbeToken())) return undefined;
		return { action: "transform", text: "" } as const;
	});

	pi.on("before_agent_start", (event) => {
		requestPromptOptions = structuredClone(event.systemPromptOptions);
		probe.beginRun(readProbeToken());
		// The chained prompt here already carries additions from extensions loaded
		// earlier; anything the context event adds came from extensions after us.
		capture.prepare(event.systemPromptOptions, event.systemPrompt);
	});

	pi.on("turn_start", (_event, ctx) => {
		if (probe.isCurrentRun) ctx.abort();
	});

	pi.on("message_start", (event) => {
		probe.recordMessage(event.message);
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant" && !probe.isCurrentRun) {
			const pending = pendingRequests.shift();
			if (pending !== undefined) recordRequestCompletion(pi, pending, event.message);
		}
		const message = probe.sanitizeMessage(event.message);
		return message === undefined ? undefined : { message };
	});

	pi.on("agent_end", () => {
		while (pendingRequests.length > 0) {
			const pending = pendingRequests.shift();
			if (pending !== undefined) recordUnpairedRequest(pi, pending);
		}
	});

	pi.on("tool_call", (event) => {
		if (retryTracker.noteCall(event.toolName, event.input as Record<string, unknown>)) {
			recordRetry(pi, event.toolName, event.input as Record<string, unknown>);
		}
	});

	pi.on("tool_result", (event) => {
		if (!event.isError) return;
		retryTracker.noteFailure(event.toolName, event.input, Date.now());
		recordToolFailure(pi, event);
	});

	pi.on("context", (event, ctx) => {
		const messages = probe.filterMessages(event.messages);
		// Lazy: this event fires once per LLM request, but only the freezing call
		// reads these inputs, and the baseline rebuild alone is O(session).
		const allTools = pi.getAllTools();
		const activeToolNames = pi.getActiveTools();
		const promptSources = collectPromptSources(allTools, pi.getCommands());
		capture.finalize(() => ({
			systemPrompt: ctx.getSystemPrompt(),
			messages,
			baselineMessages: probe.filterMessages(
				buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
			),
			allTools,
			activeToolNames,
			promptSources,
			origin: probe.isCurrentRun ? "synthetic-probe" : "real-turn",
		}));

		if (!probe.isCurrentRun && requestPromptOptions !== undefined) {
			try {
				const initial = buildNativeSnapshot({
					systemPrompt: ctx.getSystemPrompt(),
					options: requestPromptOptions,
					allTools,
					activeToolNames,
					promptSources,
				});
				const snapshot = buildUsageSnapshot({
					messages,
					initial,
					systemPrompt: ctx.getSystemPrompt(),
					options: requestPromptOptions,
					allTools,
					activeToolNames,
					promptSources,
				});
				const estimated = computeUsage({ snapshot, messages });
				pendingRequests.push({
					timestamp: Date.now(),
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
					estimatedCategories: Object.fromEntries(estimated.categories.map((category) => [category.id, category.tokens])),
					attributedSources: attributeVisibleSources(messages),
				});
			} catch {
				// Context telemetry is best-effort and must never affect a model request.
			}
		}
		return messages === event.messages ? undefined : { messages };
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!probe.isCurrentRun) return;
		if (ctx.mode === "tui") ctx.ui.setWorkingVisible(true);
		probe.settle(capture.snapshot !== undefined);
		persistProbeIdentities();
	});

	pi.on("session_shutdown", () => {
		compaction.finish();
		// A shutdown mid-probe can leave probe messages already persisted in the
		// session; write their identities so the next runtime keeps filtering them.
		persistProbeIdentities();
		probe.fail("Session ended before the silent probe completed.");
	});

	pi.registerCommand("context", {
		description: CONTEXT_COMMAND_DESCRIPTION,
		getArgumentCompletions: getContextArgumentCompletions,
		handler: async (args, ctx) => {
			const command = parseContextCommand(args);
			if (command.type === "invalid") {
				reportCommandMessage(ctx, command.message, "error");
				return;
			}
			// Creating the file needs no UI, so it stays available in every run mode.
			if (command.type === "config") {
				reportConfigCreation(ctx, createDefaultConfigFile());
				return;
			}
			if (ctx.mode !== "tui") {
				reportTuiOnly(ctx, command.view);
				return;
			}
			if (command.view === "history" || command.view === "failures") {
				const records = readHistoryRecords(ctx.sessionManager.getEntries());
				await showHistoryView(ctx, {
					mode: command.view,
					summary: summarizeHistory(records),
					sessionId: ctx.sessionManager.getSessionId(),
				});
				return;
			}
			const initial = await resolveInitialCapture(pi, capture, probe, compaction, ctx);
			if (command.view === "injections") {
				await showInjectionsView(ctx, {
					snapshot: initial.snapshot,
					degradedReason: initial.degradedReason,
				});
				return;
			}
			// Loaded only for the Usage view, the sole consumer of configured colors.
			const loadedConfig = configStore.load();
			// ReadonlySessionManager lacks buildSessionContext(); use pi's exported builder.
			const messages = probe.filterMessages(
				buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
			);
			const current = buildUsageSnapshot({
				messages,
				initial: initial.snapshot,
				systemPrompt: ctx.getSystemPrompt(),
				options: ctx.getSystemPromptOptions(),
				allTools: pi.getAllTools(),
				activeToolNames: pi.getActiveTools(),
				promptSources: collectPromptSources(pi.getAllTools(), pi.getCommands()),
			});
			await showUsageView(ctx, {
				usage: computeUsage({
					snapshot: current,
					messages,
					reported: toReportedUsage(ctx.getContextUsage()),
					modelLabel: ctx.model?.id,
					autoCompactReserveTokens: readAutoCompactReserveTokens(ctx),
				}),
				degradedReason: initial.degradedReason,
				// Reported inside the view: a notification would stay hidden behind the fullscreen overlay.
				notices: loadedConfig.warnings,
				categoryColors: loadedConfig.config.categoryColors,
				mapSize: loadedConfig.config.mapSize,
			});
		},
	});
}
