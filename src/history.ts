import { createHash } from "node:crypto";
import type { ContextEvent, ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

import { textTokens } from "./measure.ts";

export const HISTORY_CUSTOM_TYPE = "pi-context-view:history";
export const HISTORY_SCHEMA_VERSION = 1;
const MAX_PERSISTED_RECORDS = 10_000;
const RETRY_WINDOW_MS = 5 * 60 * 1000;

export type SourceTotals = Record<string, number>;
type ContextMessage = ContextEvent["messages"][number];

export interface ProviderUsageRecord {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
}

export interface RequestRecord {
	readonly schemaVersion: 1;
	readonly kind: "request";
	readonly timestamp: number;
	readonly model: string;
	readonly usage?: ProviderUsageRecord;
	readonly estimatedCategories: SourceTotals;
	readonly attributedSources: SourceTotals;
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
	readonly providerTotalTokens: number;
	readonly estimatedCategories: SourceTotals;
	readonly attributedSources: SourceTotals;
	readonly failedCalls: number;
	readonly retries: number;
	readonly estimatedFailureTokens: number;
	readonly estimatedRetryTokens: number;
	readonly failureSources: SourceTotals;
	readonly retrySources: SourceTotals;
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

export function parseHistoryRecord(value: unknown): HistoryRecord | undefined {
	if (!isRecord(value) || value.schemaVersion !== HISTORY_SCHEMA_VERSION || !isFiniteNumber(value.timestamp)) return undefined;
	if (value.kind === "request") {
		const estimatedCategories = parseTotals(value.estimatedCategories);
		const attributedSources = parseTotals(value.attributedSources);
		if (!estimatedCategories || !attributedSources) return undefined;
		const usage = parseProviderUsage(value.usage);
		return {
			schemaVersion: HISTORY_SCHEMA_VERSION,
			kind: "request",
			timestamp: value.timestamp,
			model: typeof value.model === "string" ? value.model.slice(0, 160) : "unknown",
			...(usage === undefined ? {} : { usage }),
			estimatedCategories,
			attributedSources,
		};
	}
	if (value.kind === "failure" || value.kind === "retry") {
		if (!isFiniteNumber(value.inputTokens) || !isFiniteNumber(value.resultTokens) || typeof value.source !== "string") return undefined;
		return {
			schemaVersion: HISTORY_SCHEMA_VERSION,
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
	let providerTotalTokens = 0;
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
				providerTotalTokens += record.usage.totalTokens;
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
		providerTotalTokens,
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
	const normalized = path.replace(/\\/g, "/");
	return /(?:^|\/)(?:skills\/agent-brain(?:\/|$)|attach\/protocols(?:\/|$)|\.agent\/protocols(?:\/|$)|playbooks(?:\/|$))/.test(normalized)
		|| /(?:^|\/)agent-brain\/[^/]*AGENTS(?:\.override)?\.md$/i.test(normalized);
}

function isTemporaryPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	return /(?:^|\/)(?:tmp|temp|scratch)(?:\/|$)/i.test(normalized)
		|| /\.(?:tmp|temp|scratch)(?:\.|$)/i.test(normalized);
}

/** Derive source overlays from messages already present in the model request. */
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

/** Classify and persist only counters for provider requests; all source text stays transient. */
export function recordRequestCompletion(
	pi: ExtensionAPI,
	pending: PendingRequest,
	message: Extract<ContextMessage, { role: "assistant" }>,
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
	} : undefined);
}

export function recordUnpairedRequest(pi: ExtensionAPI, pending: PendingRequest): RequestRecord {
	return persistRequest(pi, pending, pending.model, undefined);
}

export function recordToolFailure(pi: ExtensionAPI, event: ToolResultEvent, timestamp = Date.now()): FailureRecord | undefined {
	if (!event.isError) return undefined;
	const source = classifyToolSource(event.toolName, event.input);
	const output = event.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
	const record: FailureRecord = {
		schemaVersion: HISTORY_SCHEMA_VERSION,
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
		schemaVersion: HISTORY_SCHEMA_VERSION,
		kind: "retry",
		timestamp,
		source: classifyToolSource(toolName, input),
		inputTokens: textTokens(JSON.stringify(input)),
		resultTokens: 0,
	};
	appendHistoryRecord(pi, record);
	return record;
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
): RequestRecord {
	const record: RequestRecord = {
		schemaVersion: HISTORY_SCHEMA_VERSION,
		kind: "request",
		timestamp: pending.timestamp,
		model,
		...(usage === undefined ? {} : { usage }),
		estimatedCategories: pending.estimatedCategories,
		attributedSources: pending.attributedSources,
	};
	appendHistoryRecord(pi, record);
	return record;
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
