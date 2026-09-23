import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContextEvent, ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

import {
	attributeVisibleSources,
	classifyToolSource,
	isAbCommand,
	parseHistoryRecord,
	recordToolFailure,
	RetryTracker,
	summarizeHistory,
	type HistoryRecord,
} from "../src/history.ts";

function mockPi(): { pi: ExtensionAPI; entries: Array<{ type: string; data: unknown }> } {
	const entries: Array<{ type: string; data: unknown }> = [];
	return {
		pi: { appendEntry: (type: string, data: unknown) => entries.push({ type, data }) } as unknown as ExtensionAPI,
		entries,
	};
}

test("parseHistoryRecord accepts bounded metadata and rejects raw or malformed data", () => {
	assert.deepEqual(parseHistoryRecord({
		schemaVersion: 1,
		kind: "request",
		timestamp: 1,
		model: "provider/model",
		usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 15 },
		estimatedCategories: { skills: 8 },
		attributedSources: { "ab-command-input": 4 },
	}), {
		schemaVersion: 1,
		kind: "request",
		timestamp: 1,
		model: "provider/model",
		usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 15 },
		estimatedCategories: { skills: 8 },
		attributedSources: { "ab-command-input": 4 },
	});
	assert.equal(parseHistoryRecord({ schemaVersion: 1, kind: "request", timestamp: 1, command: "ab task new" }), undefined);
	assert.equal(parseHistoryRecord({ schemaVersion: 2, kind: "failure", timestamp: 1, source: "ab-command", inputTokens: 2, resultTokens: 4 }), undefined);
});

test("summarizeHistory keeps provider totals, estimates, and failure overhead separate", () => {
	const records: HistoryRecord[] = [
		{
			schemaVersion: 1, kind: "request", timestamp: 1, model: "p/m",
			usage: { input: 100, output: 20, cacheRead: 15, cacheWrite: 2, totalTokens: 137 },
			estimatedCategories: { skills: 24, "tool-output": 40 },
			attributedSources: { "ab-command-output": 10 },
		},
		{ schemaVersion: 1, kind: "request", timestamp: 2, model: "p/m", estimatedCategories: {}, attributedSources: {} },
		{ schemaVersion: 1, kind: "failure", timestamp: 3, source: "ab-command", inputTokens: 3, resultTokens: 5 },
		{ schemaVersion: 1, kind: "retry", timestamp: 4, source: "ab-command", inputTokens: 3, resultTokens: 0 },
	];
	assert.deepEqual(summarizeHistory(records), {
		requests: 2,
		requestsWithUsage: 1,
		unknownUsageRequests: 1,
		inputTokens: 100,
		outputTokens: 20,
		cacheReadTokens: 15,
		cacheWriteTokens: 2,
		providerTotalTokens: 137,
		estimatedCategories: { skills: 24, "tool-output": 40 },
		attributedSources: { "ab-command-output": 10 },
		failedCalls: 1,
		retries: 1,
		estimatedFailureTokens: 8,
		estimatedRetryTokens: 3,
		failureSources: { "ab-command": 8 },
		retrySources: { "ab-command": 3 },
	});
});

test("ab classification parses executable position, not arbitrary command text", () => {
	assert.equal(isAbCommand("ab task pack --run x"), true);
	assert.equal(isAbCommand("env FOO=bar /opt/bin/agent-brain roadmap show"), true);
	assert.equal(isAbCommand("cd /repo && ab task status"), true);
	assert.equal(isAbCommand("command ab task list"), true);
	assert.equal(isAbCommand("echo ab task list"), false);
	assert.equal(isAbCommand("cat /tmp/ab-notes.md"), false);
	assert.equal(isAbCommand("printf '%s' 'ab task new'"), false);
});

test("document reads and temporary documents are attributed from tool input paths", () => {
	assert.equal(classifyToolSource("read", { path: "/Users/me/.pi/agent/skills/agent-brain/references/task-loop.md" }), "agent-brain-docs");
	assert.equal(classifyToolSource("read", { path: "/repo/.agent/protocols/daily.md" }), "agent-brain-docs");
	assert.equal(classifyToolSource("read", { path: "/tmp/context-packet.md" }), "temporary-documents");
	assert.equal(classifyToolSource("write", { path: "/tmp/context-packet.md" }), "temporary-documents");
	assert.equal(classifyToolSource("read", { path: "/repo/src/index.ts" }), "other-tools");
});

test("source attribution records only ab and document token counts", () => {
	const messages = [
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "ab-call", name: "bash", arguments: { command: "ab task show" } },
				{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "/tmp/packet.md" } },
			],
		},
		{
			role: "toolResult", toolCallId: "ab-call", toolName: "bash", isError: false,
			content: [{ type: "text", text: "task is running" }],
		},
		{
			role: "toolResult", toolCallId: "read-call", toolName: "read", isError: false,
			content: [{ type: "text", text: "temporary packet body" }],
		},
	] as unknown as ContextEvent["messages"];
	assert.ok((attributeVisibleSources(messages)["ab-command-input"] ?? 0) > 0);
	assert.ok((attributeVisibleSources(messages)["ab-command-output"] ?? 0) > 0);
	assert.ok((attributeVisibleSources(messages)["temporary-documents-input"] ?? 0) > 0);
	assert.ok((attributeVisibleSources(messages)["temporary-documents-output"] ?? 0) > 0);
});

test("tool failures persist only source and token counts", () => {
	const { pi, entries } = mockPi();
	const event = {
		toolName: "bash",
		input: { command: "ab task new private-goal" },
		content: [{ type: "text", text: "permission denied" }],
		isError: true,
		toolCallId: "failure-1",
	} as unknown as ToolResultEvent;
	const record = recordToolFailure(pi, event, 10);
	assert.equal(record?.kind, "failure");
	assert.equal(record?.source, "ab-command");
	assert.ok((record?.inputTokens ?? 0) > 0);
	assert.ok((record?.resultTokens ?? 0) > 0);
	assert.equal(JSON.stringify(entries).includes("private-goal"), false);
	assert.equal(JSON.stringify(entries).includes("permission denied"), false);
});

test("RetryTracker flags only the immediate same-input retry within its time window", () => {
	const tracker = new RetryTracker();
	tracker.noteFailure("bash", { command: "ab task status" }, 100);
	assert.equal(tracker.noteCall("bash", { command: "ab task status" }, 200), true);
	assert.equal(tracker.noteCall("bash", { command: "ab task status" }, 300), false);
	tracker.noteFailure("bash", { command: "ab task status" }, 400);
	assert.equal(tracker.noteCall("read", { path: "/tmp/a.md" }, 450), false);
	assert.equal(tracker.noteCall("bash", { command: "ab task status" }, 500), false, "an intervening tool call breaks immediacy");
	tracker.noteFailure("read", { path: "/tmp/a.md" }, 100);
	assert.equal(tracker.noteCall("read", { path: "/tmp/a.md" }, 100 + 5 * 60 * 1000 + 1), false);
});
