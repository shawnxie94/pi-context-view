import assert from "node:assert/strict";
import { test } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { HistorySummary } from "../src/history.ts";
import { HistoryView } from "../src/ui/history-view.ts";

function createTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}

function summary(): HistorySummary {
	return {
		requests: 2,
		requestsWithUsage: 1,
		unknownUsageRequests: 1,
		inputTokens: 100,
		outputTokens: 30,
		cacheReadTokens: 20,
		cacheWriteTokens: 5,
		providerTotalTokens: 130,
		estimatedCategories: { skills: 240, "tool-output": 80 },
		attributedSources: { "ab-command-input": 12 },
		failedCalls: 1,
		retries: 1,
		estimatedFailureTokens: 22,
		estimatedRetryTokens: 11,
		failureSources: { "ab-command": 22 },
		retrySources: { "ab-command": 11 },
	};
}

test("history view keeps provider usage and estimated source overlays distinct", () => {
	const view = new HistoryView(createTheme(), { mode: "history", summary: summary(), sessionId: "session-1" }, () => {}, () => 24);
	const lines = view.render(60);
	const text = lines.join("\n");

	assert.match(text, /Provider-Reported Usage/);
	assert.match(text, /Estimated Context by Category/);
	assert.doesNotMatch(text, /Provider Total.*≈/);
	view.handleInput("\x1b[4~");
	const endPage = view.render(60).join("\n");
	assert.match(endPage, /Source Attribution \(Estimated Subsets\)/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 60));
	assert.equal(lines.length, 24);
});

test("failure view states estimate semantics and respects narrow terminal bounds", () => {
	const view = new HistoryView(createTheme(), { mode: "failures", summary: summary(), sessionId: "session-1" }, () => {}, () => 14);
	const lines = view.render(40);
	const text = lines.join("\n");

	assert.match(text, /Estimated Failure-Related Footprint/);
	assert.match(text, /Hard Tool Failures/);
	assert.match(text, /Estimated Failure-Related Footprint/);
	assert.ok(lines.length <= 14);
	assert.ok(lines.every((line) => visibleWidth(line) <= 40));
});
