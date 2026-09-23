import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";

import type { HistorySummary } from "../history.ts";
import { normalizeInlineText } from "../text.ts";
import {
	BODY_INDENT,
	calculateViewport,
	DEFAULT_TERMINAL_ROWS,
	descriptionBlockRows,
	fitLine,
	fitToTerminalHeight,
	hintRow,
	isPageBackKey,
	isPageForwardKey,
	isStepBackKey,
	isStepForwardKey,
	normalizeTerminalRows,
	spreadLine,
	STEP_KEY_HINT,
	wrapDescriptionLines,
} from "./layout.ts";

const FIXED_LINE_COUNT = 10;
const SOURCE_LABELS: Readonly<Record<string, string>> = {
	"system-prompt": "System Prompt",
	"context-files": "Instruction Files",
	skills: "Skills",
	"built-in-tools": "Built-in Tools",
	"custom-tools": "Custom Tools",
	"mcp-tools": "MCP Tools",
	"user-messages": "User Messages",
	"assistant-messages": "Assistant Messages",
	"assistant-thinking": "Assistant Thinking",
	"tool-calls": "Tool Calls",
	"tool-output": "Tool Output",
	extensions: "Extensions",
	"compacted-data": "Compacted Data",
};

export interface HistoryViewInput {
	readonly mode: "history" | "failures";
	readonly summary: HistorySummary;
	readonly sessionId: string;
}

type DisplayRow =
	| { readonly label: string; readonly value: string; readonly kind?: never }
	| { readonly label: string; readonly kind: "section" | "note"; readonly value?: never };

export async function showHistoryView(context: ExtensionCommandContext, input: HistoryViewInput): Promise<void> {
	await context.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const view = new HistoryView(theme, input, done, () => tui.terminal.rows);
			return {
				render: (width: number) => view.render(width),
				invalidate: () => view.invalidate(),
				handleInput: (data: string) => {
					view.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } },
	);
}

export class HistoryView {
	private readonly theme: Theme;
	private readonly input: HistoryViewInput;
	private readonly done: (result: undefined) => void;
	private readonly getTerminalRows: () => number;
	private readonly rows: DisplayRow[];
	private selected = 0;
	private offset = 0;
	private cachedWidth: number | undefined;
	private cachedHeight: number | undefined;
	private cachedLines: string[] | undefined;

	public constructor(
		theme: Theme,
		input: HistoryViewInput,
		done: (result: undefined) => void,
		getTerminalRows: () => number = () => process.stdout.rows ?? DEFAULT_TERMINAL_ROWS,
	) {
		this.theme = theme;
		this.input = input;
		this.done = done;
		this.getTerminalRows = getTerminalRows;
		this.rows = buildRows(input);
	}

	public handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
			return;
		}
		let next = this.selected;
		if (isStepBackKey(data)) next--;
		else if (isStepForwardKey(data)) next++;
		else if (isPageBackKey(data)) next -= 8;
		else if (isPageForwardKey(data)) next += 8;
		else if (matchesKey(data, Key.home)) next = 0;
		else if (matchesKey(data, Key.end)) next = this.rows.length - 1;
		else return;
		const clamped = Math.min(this.rows.length - 1, Math.max(0, next));
		if (clamped === this.selected) return;
		this.selected = clamped;
		this.ensureVisible();
		this.clearCache();
	}

	public render(width: number): string[] {
		const terminalRows = normalizeTerminalRows(this.getTerminalRows());
		if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === terminalRows) return this.cachedLines;
		const border = this.theme.fg("border", "─".repeat(Math.max(1, width)));
		const title = this.theme.fg("accent", this.theme.bold(this.input.mode === "history" ? "Context History" : "Context Failures"));
		const descriptionText = this.input.mode === "history"
			? "Cumulative usage for this Pi session. Provider totals are actual reported values; category and source rows are estimates."
			: "Hard tool failures and same-runtime retries. Their token estimates overlap session totals and are not additional provider usage or proof of avoidable waste.";
		const description = wrapDescriptionLines(this.theme, descriptionText, "dim", width);
		const descriptionRows = terminalRows >= 18 ? description : [];
		const extraRows = descriptionBlockRows(descriptionRows);
		const viewport = calculateViewport(this.rows.length, terminalRows, FIXED_LINE_COUNT, extraRows);
		this.ensureVisible(viewport.visibleCount);
		const visibleRows = this.rows.slice(this.offset, this.offset + viewport.visibleCount);
		const lines: string[] = [border, "", fitLine(title, width), ""];
		if (descriptionRows.length > 0) lines.push(...descriptionRows, "");
		lines.push(fitLine(this.theme.fg("muted", `Session ${this.input.sessionId}`), width), "");
		for (let index = 0; index < visibleRows.length; index++) {
			const absoluteIndex = this.offset + index;
			lines.push(this.renderRow(visibleRows[index]!, absoluteIndex === this.selected, width));
		}
		if (viewport.showScroll) {
			lines.push(fitLine(`${BODY_INDENT}${this.theme.fg("dim", `(${this.offset + visibleRows.length}/${this.rows.length})`)}`, width));
		}
		while (lines.length < terminalRows - 4) lines.push("");
		lines.push("", fitLine(hintRow(this.theme, [[STEP_KEY_HINT, "Navigate"], ["Esc", "Close"]]), width), "", border);
		const result = fitToTerminalHeight(lines, terminalRows, border);
		this.cachedWidth = width;
		this.cachedHeight = terminalRows;
		this.cachedLines = result;
		return result;
	}

	public invalidate(): void {
		this.clearCache();
	}

	private renderRow(row: DisplayRow, selected: boolean, width: number): string {
		if (row.kind === "section") return fitLine(this.theme.fg("mdHeading", this.theme.bold(row.label)), width);
		if (row.kind === "note") return fitLine(`${BODY_INDENT}${this.theme.fg("dim", row.label)}`, width);
		const cursor = selected ? this.theme.fg("accent", "→ ") : "  ";
		const label = this.theme.fg(selected ? "text" : "muted", normalizeInlineText(row.label));
		const value = this.theme.fg(selected ? "accent" : "text", row.value ?? "");
		const gap = Math.max(1, width - visibleWidth(cursor) - visibleWidth(label) - visibleWidth(value));
		return fitLine(`${cursor}${label}${this.theme.fg("dim", "·".repeat(Math.min(3, gap)))}${" ".repeat(Math.max(1, gap - 3))}${value}`, width);
	}

	private ensureVisible(visibleCount = Math.max(1, normalizeTerminalRows(this.getTerminalRows()) - FIXED_LINE_COUNT)): void {
		if (this.selected < this.offset) this.offset = this.selected;
		else if (this.selected >= this.offset + visibleCount) this.offset = this.selected - visibleCount + 1;
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.rows.length - visibleCount)));
	}

	private clearCache(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedLines = undefined;
	}
}

function buildRows(input: HistoryViewInput): DisplayRow[] {
	const summary = input.summary;
	if (input.mode === "failures") {
		return [
			{ label: "Hard Tool Failures", value: format(summary.failedCalls) },
			{ label: "Same-Runtime Retries", value: format(summary.retries) },
			{ kind: "section", label: "Estimated Failure-Related Footprint" },
			{ label: "Failed Call + Error Result", value: format(summary.estimatedFailureTokens) },
			{ label: "Retry Call", value: format(summary.estimatedRetryTokens) },
			{ kind: "section", label: "Estimated Tokens by Tool Source" },
			...Object.entries(summary.failureSources).sort((a, b) => b[1] - a[1]).map(([source, tokens]) => ({
				label: `Failure · ${source.replace(/-/g, " ")}`,
				value: `≈${format(tokens)}`,
			})),
			...Object.entries(summary.retrySources).sort((a, b) => b[1] - a[1]).map(([source, tokens]) => ({
				label: `Retry · ${source.replace(/-/g, " ")}`,
				value: `≈${format(tokens)}`,
			})),
			{ kind: "note", label: "Counts only explicit tool errors; semantic failures are not inferred." },
		];
	}
	const rows: DisplayRow[] = [
		{ label: "Model Requests", value: `${format(summary.requestsWithUsage)} reported · ${format(summary.unknownUsageRequests)} unknown` },
		{ kind: "section", label: "Provider-Reported Usage" },
		{ label: "Input", value: format(summary.inputTokens) },
		{ label: "Cache Read", value: format(summary.cacheReadTokens) },
		{ label: "Cache Write", value: format(summary.cacheWriteTokens) },
		{ label: "Output", value: format(summary.outputTokens) },
		{ label: "Provider Total", value: format(summary.providerTotalTokens) },
		{ kind: "section", label: "Estimated Context by Category" },
	];
	for (const [id, tokens] of Object.entries(summary.estimatedCategories).sort((a, b) => b[1] - a[1])) {
		rows.push({ label: SOURCE_LABELS[id] ?? id, value: `≈${format(tokens)}` });
	}
	rows.push({ kind: "section", label: "Source Attribution (Estimated Subsets)" });
	for (const [id, tokens] of Object.entries(summary.attributedSources).sort((a, b) => b[1] - a[1])) {
		rows.push({ label: id.replace(/-/g, " "), value: `≈${format(tokens)}` });
	}
	rows.push({ kind: "note", label: "Source attribution overlaps the category estimates above." });
	return rows;
}

function format(value: number): string {
	return Math.max(0, Math.floor(value)).toLocaleString("en-US");
}
