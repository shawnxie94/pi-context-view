import assert from "node:assert/strict";
import { test } from "node:test";

import type { BeforeAgentStartEvent, ContextEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { normalizeBuildSystemPromptOptions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { HISTORY_CUSTOM_TYPE, readHistoryRecords } from "../src/history.ts";

import registerExtension from "../src/index.ts";

test("history command opens from persisted entries without resolving Initial or starting a probe", async () => {
	let commandHandler: ((args: string, context: ExtensionCommandContext) => Promise<void>) | undefined;
	let customOpened = false;
	let probeSends = 0;
	const pi = {
		on: () => undefined,
		registerCommand: (_name: string, definition: { handler: typeof commandHandler }) => {
			commandHandler = definition.handler;
		},
		appendEntry: () => undefined,
		getAllTools: () => [],
		getActiveTools: () => [],
		getCommands: () => [],
		sendUserMessage: () => { probeSends++; },
	} as unknown as ExtensionAPI;
	registerExtension(pi);

	const context = {
		mode: "tui",
		getSystemPrompt: () => { throw new Error("history must not resolve Initial"); },
		sessionManager: {
			getEntries: () => [],
			getSessionId: () => "session-1",
		},
		ui: {
			custom: async () => { customOpened = true; },
		},
	} as unknown as ExtensionCommandContext;

	assert.ok(commandHandler);
	await commandHandler("history", context);
	assert.equal(customOpened, true);
	assert.equal(probeSends, 0);
});

test("real request events persist provider usage and token-only attribution metadata", () => {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const persisted: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => { handlers.set(event, handler); },
		registerCommand: () => undefined,
		appendEntry: (customType: string, data: unknown) => { persisted.push({ customType, data }); },
		getAllTools: () => [],
		getActiveTools: () => [],
		getCommands: () => [],
	} as unknown as ExtensionAPI;
	registerExtension(pi);

	const context = {
		getSystemPrompt: () => "system text must not be persisted",
		model: { provider: "test-provider", id: "test-model" },
		sessionManager: { getEntries: () => [], getLeafId: () => null },
	} as unknown as ExtensionContext;
	const beforeAgentStart = handlers.get("before_agent_start") as (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown;
	const onContext = handlers.get("context") as (event: ContextEvent, ctx: ExtensionContext) => unknown;
	const onMessageEnd = handlers.get("message_end") as (event: unknown, ctx: ExtensionContext) => unknown;
	beforeAgentStart({
		type: "before_agent_start",
		prompt: "private prompt text",
		systemPrompt: "system text must not be persisted",
		systemPromptOptions: normalizeBuildSystemPromptOptions({ cwd: "/tmp" }),
	}, context);
	onContext({
		type: "context",
		messages: [
			{ role: "user", content: "private prompt text", timestamp: 1 },
			{
				role: "assistant", timestamp: 2,
				content: [
					{ type: "toolCall", id: "command-call", name: "bash", arguments: { command: "ab task finish private-run" } },
					{ type: "toolCall", id: "skill-read", name: "read", arguments: { path: "/Users/me/.pi/agent/skills/agent-brain/SKILL.md" } },
				],
			},
			{ role: "toolResult", toolCallId: "command-call", toolName: "bash", isError: false, content: [{ type: "text", text: "private command output" }], timestamp: 3 },
			{ role: "toolResult", toolCallId: "skill-read", toolName: "read", isError: false, content: [{ type: "text", text: "private skill contents" }], timestamp: 4 },
		] as unknown as ContextEvent["messages"],
	}, context);
	onMessageEnd({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "private answer text" }],
			provider: "test-provider",
			model: "test-model",
			timestamp: 2,
			usage: { input: 20, output: 4, cacheRead: 1, cacheWrite: 0, totalTokens: 24, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		},
	}, context);

	const historyEntry = persisted.find((entry) => entry.customType === HISTORY_CUSTOM_TYPE);
	assert.ok(historyEntry);
	assert.equal(JSON.stringify(historyEntry).includes("private prompt text"), false);
	assert.equal(JSON.stringify(historyEntry).includes("private answer text"), false);
	assert.equal(JSON.stringify(historyEntry).includes("private-run"), false);
	assert.equal(JSON.stringify(historyEntry).includes("/Users/me"), false);
	assert.equal(JSON.stringify(historyEntry).includes("private command output"), false);
	assert.equal(JSON.stringify(historyEntry).includes("private skill contents"), false);
	const request = readHistoryRecords([{ type: "custom", customType: historyEntry.customType, data: historyEntry.data }])[0];
	assert.equal(request?.kind, "request");
	if (request?.kind === "request") {
		assert.ok((request.attributedSources["ab-command-output"] ?? 0) > 0);
		assert.ok((request.attributedSources["agent-brain-docs-output"] ?? 0) > 0);
	}
});

test("successful compaction drops pending requests but failed compaction preserves the generation", () => {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const persisted: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => { handlers.set(event, handler); },
		registerCommand: () => undefined,
		appendEntry: (customType: string, data: unknown) => { persisted.push({ customType, data }); },
		getAllTools: () => [],
		getActiveTools: () => [],
		getCommands: () => [],
	} as unknown as ExtensionAPI;
	registerExtension(pi);

	const context = {
		getSystemPrompt: () => "system prompt",
		model: { provider: "test-provider", id: "test-model" },
		sessionManager: { getEntries: () => [], getBranch: () => [], getLeafId: () => null },
	} as unknown as ExtensionContext;
	const onContext = handlers.get("context") as (event: ContextEvent, ctx: ExtensionContext) => unknown;
	const beforeAgentStart = handlers.get("before_agent_start") as (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown;
	const agentEnd = handlers.get("agent_end") as (event: unknown, ctx: ExtensionContext) => unknown;
	const compact = handlers.get("session_compact") as (event: unknown, ctx: ExtensionContext) => unknown;
	const compactFailed = handlers.get("session_compact_failed") as (event: unknown, ctx: ExtensionContext) => unknown;
	const makePending = (timestamp: number) => {
		beforeAgentStart({
			type: "before_agent_start",
			prompt: `private prompt ${timestamp}`,
			systemPrompt: "system prompt",
			systemPromptOptions: normalizeBuildSystemPromptOptions({ cwd: "/tmp" }),
		}, context);
		return onContext({
			type: "context",
			messages: [{ role: "user", content: `private prompt ${timestamp}`, timestamp }],
		}, context);
	};
	const requests = () => persisted.flatMap((entry) => entry.customType === HISTORY_CUSTOM_TYPE
		? readHistoryRecords([{ type: "custom", customType: entry.customType, data: entry.data }]).filter((record) => record.kind === "request")
		: []);

	makePending(1);
	compact({ type: "session_compact" }, context);
	agentEnd({ type: "agent_end" }, context);
	assert.equal(requests().length, 0, "successful compaction clears requests pending completion");

	makePending(2);
	compactFailed({ type: "session_compact_failed" }, context);
	agentEnd({ type: "agent_end" }, context);
	assert.equal(requests().length, 1, "failed compaction does not discard pending request metadata");

	const toolCall = handlers.get("tool_call") as (event: unknown, ctx: ExtensionContext) => unknown;
	const toolResult = handlers.get("tool_result") as (event: unknown, ctx: ExtensionContext) => unknown;
	const retries = () => persisted.flatMap((entry) => entry.customType === HISTORY_CUSTOM_TYPE
		? readHistoryRecords([{ type: "custom", customType: entry.customType, data: entry.data }]).filter((record) => record.kind === "retry")
		: []);
	const failedTool = (command: string) => toolResult({
		type: "tool_result", toolCallId: command, toolName: "bash", input: { command },
		content: [{ type: "text", text: "private output" }], isError: true,
	}, context);
	const callTool = (command: string) => toolCall({
		type: "tool_call", toolCallId: command, toolName: "bash", input: { command },
	}, context);

	failedTool("retry-before-failed-compaction");
	compactFailed({ type: "session_compact_failed" }, context);
	callTool("retry-before-failed-compaction");
	assert.equal(retries().length, 1, "failed compaction preserves retry matching state");
	failedTool("retry-before-successful-compaction");
	compact({ type: "session_compact" }, context);
	callTool("retry-before-successful-compaction");
	assert.equal(retries().length, 1, "successful compaction clears retry matching state");
	assert.equal(JSON.stringify(persisted).includes("private prompt"), false);
	assert.equal(JSON.stringify(persisted).includes("private output"), false);
});
