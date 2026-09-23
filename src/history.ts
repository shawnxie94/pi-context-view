import { createHash } from "node:crypto";
import type { ContextEvent, ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

import { textTokens } from "./measure.ts";

export const HISTORY_CUSTOM_TYPE = "pi-context-view:history";
export const HISTORY_SCHEMA_VERSION = 2;
export const LEGACY_HISTORY_SCHEMA_VERSION = 1;
const MAX_PERSISTED_RECORDS = 10_000;
export const MAX_INVOCATION_SUMMARIES = 256;

export type InvocationOutcome = "success" | "error" | "unknown";
export type InvocationFailureClass = "tool-error" | "compound-uncertain" | "unknown";
export type InvocationDurationBucket = "instant" | "short" | "medium" | "long" | "unknown";

export interface InvocationSummary {
	readonly sequence: number;
	readonly tool: string;
	readonly outcome: InvocationOutcome;
	readonly failureClass?: InvocationFailureClass;
	readonly duration?: InvocationDurationBucket;
}

export interface InvocationCollection {
	readonly summaries: readonly InvocationSummary[];
	readonly omitted: number;
	readonly truncated: boolean;
}
const RETRY_WINDOW_MS = 5 * 60 * 1000;
const ALLOWED_INVOCATION_TOOLS = new Set([
	"bash", "read", "write", "edit", "grep", "find", "ls", "powershell", "other-tool",
	"ab.task.new", "ab.task.status", "ab.task.validate", "ab.task.accept", "ab.task.close", "ab.task.finish",
	"ab.project.attach", "ab.project.detach", "ab.project.scan", "ab.artifact.create", "ab.artifact.get", "ab.artifact.list", "ab.artifact.update",
	"ab.roadmap.show", "ab.roadmap.add", "ab.roadmap.move", "ab.roadmap.remove", "ab.roadmap.edit", "ab.roadmap.update",
	"ab.experience.event", "ab.experience.pack", "ab.experience.review", "ab.experience.finalize", "ab.experience.replay",
	"ab.ops.doctor", "ab.ops.db", "ab.ops.metrics", "ab.ops.batch", "ab.ops.eval", "ab.ops.input", "ab.ops.file", "ab.other",
]);

export type SourceTotals = Record<string, number>;
export interface SourceAttributionExecution {
	readonly toolName: "bash" | "read";
	readonly command?: string;
	readonly path?: string;
	readonly output: string;
	readonly isError: boolean;
	readonly timestamp: number;
	readonly tokens: number;
	readonly sharedOutput?: boolean;
}

export interface SourceAttributionDetail {
	readonly group: "commands" | "skills-docs";
	readonly label: string;
	readonly tokens: number;
	readonly executions?: readonly SourceAttributionExecution[];
}
type ContextMessage = ContextEvent["messages"][number];

export interface ProviderUsageRecord {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
}

export interface RequestRecord {
	readonly schemaVersion: 1 | 2;
	readonly kind: "request";
	readonly timestamp: number;
	readonly model: string;
	readonly usage?: ProviderUsageRecord;
	readonly estimatedCategories: SourceTotals;
	readonly attributedSources: SourceTotals;
	readonly invocations?: InvocationCollection;
}

export interface FailureRecord {
	readonly schemaVersion: 1;
	readonly kind: "failure" | "retry";
	readonly timestamp: number;
	readonly source: string;
	readonly inputTokens: number;
	readonly resultTokens: number;
}

export type HistoryRecord = RequestRecord | FailureRecord;

export interface HistorySummary {
	readonly requests: number;
	readonly requestsWithUsage: number;
	readonly unknownUsageRequests: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly providerInputOutputTokens: number;
	readonly estimatedCategories: SourceTotals;
	readonly attributedSources: SourceTotals;
	readonly failedCalls: number;
	readonly retries: number;
	readonly estimatedFailureTokens: number;
	readonly estimatedRetryTokens: number;
	readonly failureSources: SourceTotals;
	readonly retrySources: SourceTotals;
}

export interface CurrentContextSummary extends HistorySummary {
	/** Latest request's source attribution, not a sum across the compacted generation. */
	readonly latestRequest?: RequestRecord;
}

export interface PendingRequest {
	readonly timestamp: number;
	readonly model: string;
	readonly estimatedCategories: SourceTotals;
	readonly attributedSources: SourceTotals;
}

interface FailureFingerprint {
	readonly digest: string;
	readonly failedAt: number;
}

/** Keep only validated, content-free history entries from the Pi session tree. */
export function readHistoryRecords(entries: readonly unknown[]): HistoryRecord[] {
	const records: HistoryRecord[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== HISTORY_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (!isRecord(data) || !Array.isArray(data.records)) continue;
		for (const candidate of data.records) {
			const record = parseHistoryRecord(candidate);
			if (record !== undefined) records.push(record);
		}
	}
	return records.slice(-MAX_PERSISTED_RECORDS);
}

/** Keep only current-generation metadata after the latest compaction in the active branch. */
export function readCurrentContextRecords(branch: readonly unknown[]): HistoryRecord[] {
	let latestCompaction = -1;
	for (let index = 0; index < branch.length; index++) {
		const entry = branch[index];
		if (isRecord(entry) && entry.type === "compaction") latestCompaction = index;
	}
	return readHistoryRecords(branch.slice(latestCompaction + 1));
}

export function parseHistoryRecord(value: unknown): HistoryRecord | undefined {
	if (!isRecord(value) || ![LEGACY_HISTORY_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION].includes(value.schemaVersion as number) || !isFiniteNumber(value.timestamp)) return undefined;
	if (value.kind === "request") {
		const estimatedCategories = parseTotals(value.estimatedCategories);
		const attributedSources = parseTotals(value.attributedSources);
		if (!estimatedCategories || !attributedSources) return undefined;
		const usage = parseProviderUsage(value.usage);
		const invocations = value.schemaVersion === HISTORY_SCHEMA_VERSION ? parseInvocations(value.invocations) : undefined;
		if (value.schemaVersion === HISTORY_SCHEMA_VERSION && value.invocations !== undefined && invocations === undefined) return undefined;
		return {
			schemaVersion: value.schemaVersion as 1 | 2,
			kind: "request",
			timestamp: value.timestamp,
			model: typeof value.model === "string" ? value.model.slice(0, 160) : "unknown",
			...(usage === undefined ? {} : { usage }),
			estimatedCategories,
			attributedSources,
			...(invocations === undefined ? {} : { invocations }),
		};
	}
	if (value.kind === "failure" || value.kind === "retry") {
		if (value.schemaVersion !== LEGACY_HISTORY_SCHEMA_VERSION || !isFiniteNumber(value.inputTokens) || !isFiniteNumber(value.resultTokens) || typeof value.source !== "string") return undefined;
		return {
			schemaVersion: LEGACY_HISTORY_SCHEMA_VERSION,
			kind: value.kind,
			timestamp: value.timestamp,
			source: value.source.slice(0, 80),
			inputTokens: value.inputTokens,
			resultTokens: value.resultTokens,
		};
	}
	return undefined;
}

export function summarizeHistory(records: readonly HistoryRecord[]): HistorySummary {
	const estimatedCategories: SourceTotals = {};
	const attributedSources: SourceTotals = {};
	let requests = 0;
	let requestsWithUsage = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let providerInputOutputTokens = 0;
	let failedCalls = 0;
	let retries = 0;
	let estimatedFailureTokens = 0;
	let estimatedRetryTokens = 0;
	const failureSources: SourceTotals = {};
	const retrySources: SourceTotals = {};
	for (const record of records) {
		if (record.kind === "request") {
			requests++;
			if (record.usage) {
				requestsWithUsage++;
				inputTokens += record.usage.input;
				outputTokens += record.usage.output;
				cacheReadTokens += record.usage.cacheRead;
				cacheWriteTokens += record.usage.cacheWrite;
				providerInputOutputTokens += record.usage.input + record.usage.output;
			}
			addTotals(estimatedCategories, record.estimatedCategories);
			addTotals(attributedSources, record.attributedSources);
		} else if (record.kind === "failure") {
			failedCalls++;
			estimatedFailureTokens += record.inputTokens + record.resultTokens;
			addTotal(failureSources, record.source, record.inputTokens + record.resultTokens);
		} else {
			retries++;
			estimatedRetryTokens += record.inputTokens + record.resultTokens;
			addTotal(retrySources, record.source, record.inputTokens + record.resultTokens);
		}
	}
	return {
		requests,
		requestsWithUsage,
		unknownUsageRequests: requests - requestsWithUsage,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		providerInputOutputTokens,
		estimatedCategories,
		attributedSources,
		failedCalls,
		retries,
		estimatedFailureTokens,
		estimatedRetryTokens,
		failureSources,
		retrySources,
	};
}

/** Summarize one current compaction generation and retain its latest request view. */
export function summarizeCurrentContext(records: readonly HistoryRecord[]): CurrentContextSummary {
	let latestRequest: RequestRecord | undefined;
	for (const record of records) {
		if (record.kind === "request") latestRequest = record;
	}
	return { ...summarizeHistory(records), ...(latestRequest === undefined ? {} : { latestRequest }) };
}

/** Classify one tool call without retaining its command, path, arguments, or output. */
export function classifyToolSource(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash" && typeof input.command === "string" && isAbCommand(input.command)) return "ab-command";
	const filePath = typeof input.path === "string" ? input.path : "";
	if ((toolName === "read" || toolName === "write") && isTemporaryPath(filePath)) return "temporary-documents";
	if (toolName === "read" && isAgentBrainReference(filePath)) return "agent-brain-docs";
	return "other-tools";
}

export function isAbCommand(command: string): boolean {
	return splitShellCommands(command).some((segment) => {
		const executable = firstShellExecutable(segment);
		const basename = executable?.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
		return basename === "ab" || basename === "agent-brain";
	});
}

/** Split only on unquoted command separators; shell syntax is never executed. */
function splitShellCommands(command: string): string[] {
	const segments: string[] = [];
	let segment = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const char of command) {
		if (escaped) {
			segment += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			segment += char;
			escaped = true;
			continue;
		}
		if (quote !== undefined) {
			segment += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') quote = char;
		if (char === ";" || char === "|" || char === "&" || char === "\n") {
			if (segment.trim()) segments.push(segment);
			segment = "";
			continue;
		}
		segment += char;
	}
	if (segment.trim()) segments.push(segment);
	return segments;
}

/** A conservative tokenizer for one command prefix; shell syntax is not executed. */
function firstShellExecutable(command: string): string | undefined {
	const trimmed = command.trimStart();
	if (!trimmed || trimmed.startsWith("#")) return undefined;
	const words: string[] = [];
	let token = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const char of trimmed) {
		if (escaped) {
			token += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else token += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (token) words.push(token);
			token = "";
			continue;
		}
		token += char;
	}
	if (token) words.push(token);
	let index = 0;
	while (words[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
	while (words[index] === "env" || words[index] === "command" || words[index] === "exec") index++;
	while (words[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
	return words[index];
}

function isAgentBrainReference(path: string): boolean {
	return agentBrainReferenceLabel(path) !== undefined;
}

/** Keep only a useful repo-relative identity; never surface an absolute or arbitrary path. */
function agentBrainReferenceLabel(path: string): string | undefined {
	const normalized = path.replace(/\\/g, "/");
	const patterns = [
		/(?:^|\/)(skills\/[^/]+\/.+)$/i,
		/(?:^|\/)(\.agent\/(?:protocols|project-profile)\/.+)$/i,
		/(?:^|\/)(attach\/(?:protocols|project-profiles)\/.+)$/i,
		/(?:^|\/)(playbooks\/.+)$/i,
		/(?:^|\/)(agent-brain\/.+)$/i,
	];
	for (const pattern of patterns) {
		const match = normalized.match(pattern);
		if (match?.[1] !== undefined) {
			const segments = match[1].split("/");
			const relativeLabel = segments[0] === "skills"
				? `${segments[1]}/${segments.at(-1)}`
				: segments.slice(-2).join("/");
			return relativeLabel.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").slice(0, 64);
		}
	}
	return undefined;
}

function isTemporaryPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	return /(?:^|\/)(?:tmp|temp|scratch)(?:\/|$)/i.test(normalized)
		|| /\.(?:tmp|temp|scratch)(?:\.|$)/i.test(normalized);
}

/** Derive aggregate source overlays from messages already present in the model request. */
export function attributeVisibleSources(messages: readonly ContextMessage[]): SourceTotals {
	const toolSources = new Map<string, string>();
	const totals: SourceTotals = {};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const source = classifyToolSource(block.name, block.arguments);
				if (source !== "other-tools") {
					toolSources.set(block.id, source);
					addTotal(totals, `${source}-input`, textTokens(JSON.stringify(block.arguments)));
				}
			}
		} else if (message.role === "toolResult") {
			const source = toolSources.get(message.toolCallId);
			if (source !== undefined) {
				const text = message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
				addTotal(totals, `${source}-output`, textTokens(text));
			}
		}
	}
	return totals;
}

/** Derive one row per AB command invocation plus transient document totals for the latest request. */
export function attributeVisibleSourceDetails(
	messages: readonly ContextMessage[],
	throughTimestamp: number,
): SourceAttributionDetail[] {
	type MutableExecution = {
		toolName: "bash" | "read";
		command?: string;
		path?: string;
		output: string;
		isError: boolean;
		timestamp: number;
		tokens: number;
		sharedOutput?: boolean;
	};
	type MutableDetail = {
		group: SourceAttributionDetail["group"];
		label: string;
		tokens: number;
		executions?: MutableExecution[];
	};
	type CallDetails = {
		readonly commandRows?: readonly { readonly detail: MutableDetail; readonly execution: MutableExecution }[];
		readonly commandWeights?: readonly number[];
		readonly document?: MutableDetail;
		readonly documentExecution?: MutableExecution;
	};
	const calls = new Map<string, CallDetails>();
	const commandRows: MutableDetail[] = [];
	const documents = new Map<string, MutableDetail>();

	for (const message of messages) {
		if (message.timestamp > throughTimestamp) continue;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const source = classifyToolSource(block.name, block.arguments);
				if (source === "ab-command" && typeof block.arguments.command === "string") {
					const descriptors = abCommandSegments(block.arguments.command);
					if (descriptors.length === 0) continue;
					const weights = descriptors.map(({ command }) => Math.max(1, command.length));
					const inputShares = distributeTokens(textTokens(JSON.stringify(block.arguments)), weights);
					const rows = descriptors.map((descriptor, index) => {
						const tokens = inputShares[index] ?? 0;
						const execution: MutableExecution = {
							toolName: "bash",
							command: block.arguments.command as string,
							output: "",
							isError: false,
							timestamp: message.timestamp,
							tokens,
							...(descriptors.length > 1 ? { sharedOutput: true } : {}),
						};
						const detail: MutableDetail = { group: "commands", label: descriptor.label, tokens, executions: [execution] };
						commandRows.push(detail);
						return { detail, execution };
					});
					calls.set(block.id, { commandRows: rows, commandWeights: weights });
					continue;
				}

				const identity = sourceAttributionIdentity(source, block.arguments);
				if (identity === undefined) continue;
				const key = identity.label;
				const detail = documents.get(key) ?? { ...identity, tokens: 0 };
				const inputTokens = textTokens(JSON.stringify(block.arguments));
				detail.tokens += inputTokens;
				detail.executions ??= [];
				const execution: MutableExecution = {
					toolName: "read",
					path: typeof block.arguments.path === "string" ? block.arguments.path : undefined,
					output: "",
					isError: false,
					timestamp: message.timestamp,
					tokens: inputTokens,
				};
				detail.executions.push(execution);
				documents.set(key, detail);
				calls.set(block.id, { document: detail, documentExecution: execution });
			}
		} else if (message.role === "toolResult") {
			const call = calls.get(message.toolCallId);
			if (call === undefined) continue;
			const output = message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
			const outputTokens = textTokens(output);
			if (call.document !== undefined) {
				call.document.tokens += outputTokens;
				const execution = call.documentExecution;
				if (execution !== undefined) {
					execution.output = output;
					execution.isError = message.isError;
					execution.tokens += outputTokens;
				}
				continue;
			}
			const commandRows = call.commandRows ?? [];
			const outputShares = distributeTokens(outputTokens, call.commandWeights ?? []);
			for (const [index, row] of commandRows.entries()) {
				const share = outputShares[index] ?? 0;
				row.detail.tokens += share;
				row.execution.tokens += share;
				row.execution.output = output;
				row.execution.isError = message.isError;
			}
		}
	}
	const documentRows = [...documents.values()].sort((left, right) => left.label.localeCompare(right.label));
	return [...commandRows, ...documentRows];
}

function sourceAttributionIdentity(
	source: string,
	input: Record<string, unknown>,
): { readonly group: SourceAttributionDetail["group"]; readonly label: string } | undefined {
	if (source === "agent-brain-docs") {
		const label = typeof input.path === "string" ? agentBrainReferenceLabel(input.path) : undefined;
		if (label !== undefined) return { group: "skills-docs", label };
	}
	return undefined;
}

/** Divide one call's estimate across distinct AB command segments without double-counting output. */
function distributeTokens(tokens: number, weights: readonly number[]): number[] {
	if (weights.length === 0) return [];
	const totalWeight = weights.reduce((sum, weight) => sum + Math.max(1, weight), 0);
	let distributed = 0;
	return weights.map((weight, index) => {
		if (index === weights.length - 1) return tokens - distributed;
		const share = Math.floor(tokens * Math.max(1, weight) / totalWeight);
		distributed += share;
		return share;
	});
}

/** Return one sanitized dashboard label per AB segment; exact shell text stays in the preview payload. */
function abCommandSegments(command: string): Array<{ readonly command: string; readonly label: string }> {
	return splitShellCommands(command).flatMap((segment) => {
		const executable = firstShellExecutable(segment);
		const basename = executable?.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
		if (basename !== "ab" && basename !== "agent-brain") return [];
		const prefix = segment.slice(Math.max(0, segment.indexOf(executable!) + executable!.length));
		const match = prefix.match(/\b(task|project|artifact|roadmap|experience|ops)\s+([a-z][a-z-]*)/i);
		const label = match === null ? "ab command" : `ab ${match[1]!.toLowerCase()} ${match[2]!.toLowerCase()}`;
		return [{ command: segment.trim(), label }];
	});
}

/** Classify and persist only counters for provider requests; all source text stays transient. */
export function recordRequestCompletion(
	pi: ExtensionAPI,
	pending: PendingRequest,
	message: Extract<ContextMessage, { role: "assistant" }>,
	invocations?: InvocationCollection,
): RequestRecord {
	const usage = message.usage;
	const hasReportedUsage = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens]
		.some((value) => Number.isFinite(value) && value > 0);
	return persistRequest(pi, pending, `${message.provider}/${message.model}`, hasReportedUsage ? {
		input: finiteNonnegative(usage.input),
		output: finiteNonnegative(usage.output),
		cacheRead: finiteNonnegative(usage.cacheRead),
		cacheWrite: finiteNonnegative(usage.cacheWrite),
		totalTokens: finiteNonnegative(usage.totalTokens),
	} : undefined, invocations);
}

export function recordUnpairedRequest(pi: ExtensionAPI, pending: PendingRequest, invocations?: InvocationCollection): RequestRecord {
	return persistRequest(pi, pending, pending.model, undefined, invocations);
}

export function recordToolFailure(pi: ExtensionAPI, event: ToolResultEvent, timestamp = Date.now()): FailureRecord | undefined {
	if (!event.isError) return undefined;
	const source = classifyToolSource(event.toolName, event.input);
	const output = event.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
	const record: FailureRecord = {
		schemaVersion: LEGACY_HISTORY_SCHEMA_VERSION,
		kind: "failure",
		timestamp,
		source,
		inputTokens: textTokens(JSON.stringify(event.input)),
		resultTokens: textTokens(output),
	};
	appendHistoryRecord(pi, record);
	return record;
}

export function recordRetry(pi: ExtensionAPI, toolName: string, input: Record<string, unknown>, timestamp = Date.now()): FailureRecord {
	const record: FailureRecord = {
		schemaVersion: LEGACY_HISTORY_SCHEMA_VERSION,
		kind: "retry",
		timestamp,
		source: classifyToolSource(toolName, input),
		inputTokens: textTokens(JSON.stringify(input)),
		resultTokens: 0,
	};
	appendHistoryRecord(pi, record);
	return record;
}

type PendingInvocation = {
	readonly sequence: number;
	readonly tool: string;
	readonly startedAt: number;
	readonly compound: boolean;
};

/** Collect transient lifecycle summaries; raw inputs, outputs, and ids never leave this object. */
export class InvocationTracker {
	private nextSequence = 1;
	private readonly pending = new Map<string, PendingInvocation>();
	private readonly completed: InvocationSummary[] = [];

	public noteCall(event: Pick<ToolCallEvent, "toolCallId" | "toolName" | "input">, timestamp = Date.now()): void {
		const input = event.input as Record<string, unknown>;
		const command = event.toolName === "bash" && typeof input.command === "string" ? input.command : undefined;
		this.pending.set(event.toolCallId, {
			sequence: this.nextSequence++,
			tool: invocationLabel(event.toolName, input),
			startedAt: timestamp,
			compound: command !== undefined && abCommandSegments(command).length > 1,
		});
	}

	public noteResult(event: Pick<ToolResultEvent, "toolCallId" | "isError">, timestamp = Date.now()): void {
		const call = this.pending.get(event.toolCallId);
		if (call === undefined) return;
		this.pending.delete(event.toolCallId);
		const outcome: InvocationOutcome = event.isError ? "error" : "success";
		this.completed.push({
			sequence: call.sequence,
			tool: call.tool,
			outcome,
			...(event.isError ? { failureClass: call.compound ? "compound-uncertain" : "tool-error" } : {}),
			duration: durationBucket(timestamp - call.startedAt),
		});
	}

	public take(): InvocationCollection | undefined {
		for (const call of this.pending.values()) {
			this.completed.push({ sequence: call.sequence, tool: call.tool, outcome: "unknown", failureClass: "unknown", duration: "unknown" });
		}
		this.pending.clear();
		if (this.completed.length === 0) return undefined;
		this.completed.sort((left, right) => left.sequence - right.sequence);
		const omitted = Math.max(0, this.completed.length - MAX_INVOCATION_SUMMARIES);
		const summaries = this.completed.slice(0, MAX_INVOCATION_SUMMARIES);
		this.completed.length = 0;
		this.nextSequence = 1;
		return { summaries, omitted, truncated: omitted > 0 };
	}

	public clear(): void {
		this.pending.clear();
		this.completed.length = 0;
	}
}

export class RetryTracker {
	private failed: FailureFingerprint | undefined;

	public clear(): void {
		this.failed = undefined;
	}

	public noteCall(toolName: string, input: Record<string, unknown>, timestamp = Date.now()): boolean {
		const digest = this.fingerprint(toolName, input);
		const previous = this.failed;
		this.failed = undefined;
		return previous !== undefined
			&& previous.digest === digest
			&& timestamp >= previous.failedAt
			&& timestamp - previous.failedAt <= RETRY_WINDOW_MS;
	}

	public noteFailure(toolName: string, input: Record<string, unknown>, timestamp = Date.now()): void {
		this.failed = { digest: this.fingerprint(toolName, input), failedAt: timestamp };
	}

	private fingerprint(toolName: string, input: Record<string, unknown>): string {
		// The digest exists only in memory; no tool arguments or fingerprints are persisted.
		return createHash("sha256").update(toolName).update("\0").update(JSON.stringify(input)).digest("hex");
	}
}

export function appendHistoryRecord(pi: ExtensionAPI, record: HistoryRecord): void {
	pi.appendEntry(HISTORY_CUSTOM_TYPE, { records: [record] });
}

function persistRequest(
	pi: ExtensionAPI,
	pending: PendingRequest,
	model: string,
	usage: ProviderUsageRecord | undefined,
	invocations?: InvocationCollection,
): RequestRecord {
	const record: RequestRecord = {
		schemaVersion: HISTORY_SCHEMA_VERSION,
		kind: "request",
		timestamp: pending.timestamp,
		model,
		...(usage === undefined ? {} : { usage }),
		estimatedCategories: pending.estimatedCategories,
		attributedSources: pending.attributedSources,
		...(invocations === undefined ? {} : { invocations }),
	};
	appendHistoryRecord(pi, record);
	return record;
}

function parseInvocations(value: unknown): InvocationCollection | undefined {
	if (!isRecord(value) || !Array.isArray(value.summaries) || !isFiniteNumber(value.omitted) || typeof value.truncated !== "boolean") return undefined;
	const summaries: InvocationSummary[] = [];
	for (const item of value.summaries.slice(0, MAX_INVOCATION_SUMMARIES)) {
		if (!isRecord(item) || !Number.isInteger(item.sequence) || item.sequence < 1 || typeof item.tool !== "string" || !ALLOWED_INVOCATION_TOOLS.has(item.tool) || !isInvocationOutcome(item.outcome)) return undefined;
		if (item.failureClass !== undefined && !isInvocationFailureClass(item.failureClass)) return undefined;
		if (item.duration !== undefined && !isInvocationDuration(item.duration)) return undefined;
		summaries.push({ sequence: item.sequence, tool: item.tool, outcome: item.outcome, ...(item.failureClass === undefined ? {} : { failureClass: item.failureClass }), ...(item.duration === undefined ? {} : { duration: item.duration }) });
	}
	return { summaries, omitted: Math.floor(value.omitted), truncated: value.truncated };
}

function isInvocationOutcome(value: unknown): value is InvocationOutcome {
	return value === "success" || value === "error" || value === "unknown";
}

function isInvocationFailureClass(value: unknown): value is InvocationFailureClass {
	return value === "tool-error" || value === "compound-uncertain" || value === "unknown";
}

function isInvocationDuration(value: unknown): value is InvocationDurationBucket {
	return value === "instant" || value === "short" || value === "medium" || value === "long" || value === "unknown";
}

function invocationLabel(toolName: string, input: Record<string, unknown>): string {
	if (toolName !== "bash" || typeof input.command !== "string") return ALLOWED_INVOCATION_TOOLS.has(toolName) ? toolName : "other-tool";
	const descriptor = abCommandSegments(input.command)[0]?.label.match(/^ab (task|project|artifact|roadmap|experience|ops) ([a-z-]+)$/i);
	if (descriptor === undefined || descriptor === null) return "ab.other";
	const candidate = `ab.${descriptor[1]!.toLowerCase()}.${descriptor[2]!.toLowerCase()}`;
	return ALLOWED_INVOCATION_TOOLS.has(candidate) ? candidate : "ab.other";
}

function durationBucket(milliseconds: number): InvocationDurationBucket {
	if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
	if (milliseconds < 100) return "instant";
	if (milliseconds < 1_000) return "short";
	if (milliseconds < 10_000) return "medium";
	return "long";
}

function parseProviderUsage(value: unknown): ProviderUsageRecord | undefined {
	if (!isRecord(value)) return undefined;
	const fields = [value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens];
	if (!fields.every(isFiniteNumber)) return undefined;
	return {
		input: finiteNonnegative(value.input),
		output: finiteNonnegative(value.output),
		cacheRead: finiteNonnegative(value.cacheRead),
		cacheWrite: finiteNonnegative(value.cacheWrite),
		totalTokens: finiteNonnegative(value.totalTokens),
	};
}

function parseTotals(value: unknown): SourceTotals | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value);
	if (entries.length > 100 || !entries.every(([key, count]) => key.length <= 80 && isFiniteNumber(count))) return undefined;
	return Object.fromEntries(entries.map(([key, count]) => [key, finiteNonnegative(count)]));
}

function addTotals(target: SourceTotals, source: SourceTotals): void {
	for (const [key, count] of Object.entries(source)) addTotal(target, key, count);
}

function addTotal(target: SourceTotals, key: string, count: number): void {
	target[key] = (target[key] ?? 0) + finiteNonnegative(count);
}

function finiteNonnegative(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
