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

test("real request events persist only provider usage and estimated metadata", () => {
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
	onContext({ type: "context", messages: [{ role: "user", content: "private prompt text", timestamp: 1 }] }, context);
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
	assert.equal(readHistoryRecords([{ type: "custom", customType: historyEntry.customType, data: historyEntry.data }]).length, 1);
});
