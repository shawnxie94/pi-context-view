/**
 * Pure presentation model for the Injections view: flattened rows and
 * list navigation/scrolling state. No pi or TUI access — unit-testable.
 */
import type { InitialSnapshot, InjectionItem } from "../model.ts";

/** One flattened list row derived from the snapshot hierarchy. */
export type InjectionRow =
	| {
		readonly kind: "group";
		readonly label: string;
		readonly tokens: number;
		readonly depth: 0;
	}
	| {
		readonly kind: "item";
		readonly label: string;
		readonly tokens: number;
		/** One for items and two for constituent sub-items. */
		readonly depth: 1 | 2;
		/** Whether this row is the final sibling at its depth. */
		readonly isLast: boolean;
		/** Whether a depth-two row's parent has a following sibling. */
		readonly parentContinues?: boolean;
		/** Whether a `--system-prompt` replacement dropped this contribution. */
		readonly dropped?: boolean;
		/** Whether an extension moved this part out of the region pi renders it into. */
		readonly moved?: boolean;
		/** Stable preview target id from the snapshot. */
		readonly itemId: string;
	}
	| {
		readonly kind: "separator";
		readonly label: "";
		readonly tokens: 0;
		readonly depth: 0;
	}
	| {
		readonly kind: "total";
		readonly label: "TOTAL";
		readonly tokens: number;
		readonly depth: 0;
	};

/** Index snapshot items (including sub-items) by id for preview lookup. */
export function collectItemsById(snapshot: InitialSnapshot): Map<string, InjectionItem> {
	const items = new Map<string, InjectionItem>();
	for (const group of snapshot.groups) {
		for (const item of group.items) {
			items.set(item.id, item);
			for (const child of item.children ?? []) items.set(child.id, child);
		}
	}
	return items;
}

/** Flatten snapshot groups into rows separated from the non-selectable Initial total. */
export function buildInjectionRows(snapshot: InitialSnapshot): InjectionRow[] {
	const rows: InjectionRow[] = [];
	for (const group of snapshot.groups) {
		rows.push({
			kind: "group",
			label: group.source.label,
			tokens: group.totalTokens,
			depth: 0,
		});
		group.items.forEach((item, itemIndex) => {
			const isLastItem = itemIndex === group.items.length - 1;
			rows.push({
				kind: "item",
				label: item.label,
				tokens: item.tokens,
				depth: 1,
				isLast: isLastItem,
				dropped: item.dropped,
				moved: item.moved,
				itemId: item.id,
			});
			const children = item.children ?? [];
			children.forEach((child, childIndex) => {
				rows.push({
					kind: "item",
					label: child.label,
					tokens: child.tokens,
					depth: 2,
					isLast: childIndex === children.length - 1,
					parentContinues: !isLastItem,
					dropped: child.dropped,
					moved: child.moved,
					itemId: child.id,
				});
			});
		});
	}
	rows.push({ kind: "separator", label: "", tokens: 0, depth: 0 });
	rows.push({ kind: "total", label: "TOTAL", tokens: snapshot.totalTokens, depth: 0 });
	return rows;
}

/**
 * Selection and scroll-window state over fixed rows. Sparse selectable indices
 * let headings and summaries scroll without taking part in selection navigation.
 */
export class ListNavigator {
	private readonly rowCount: number;
	private readonly selectableRowIndices: readonly number[];
	private visibleCount: number;
	private selectedOrdinalValue = 0;
	private scrollOffset = 0;

	public constructor(
		rowCount: number,
		visibleCount: number,
		selectableRows: number | readonly number[] = rowCount,
	) {
		this.rowCount = Math.max(0, rowCount);
		this.selectableRowIndices = typeof selectableRows === "number"
			? Array.from({ length: Math.min(this.rowCount, Math.max(0, selectableRows)) }, (_, index) => index)
			: [...new Set(selectableRows.filter((index) => Number.isInteger(index) && index >= 0 && index < this.rowCount))].sort((a, b) => a - b);
		this.visibleCount = Math.max(1, visibleCount);
	}

	public get selected(): number {
		return this.selectableRowIndices[this.selectedOrdinalValue] ?? 0;
	}

	public get selectedOrdinal(): number {
		return this.selectedOrdinalValue;
	}

	public get selectableCount(): number {
		return this.selectableRowIndices.length;
	}

	public get offset(): number {
		return this.scrollOffset;
	}

	public get windowSize(): number {
		return Math.min(this.visibleCount, this.rowCount);
	}

	/** One-based final row currently visible, suitable for a scroll counter. */
	public get visibleEnd(): number {
		return Math.min(this.rowCount, this.scrollOffset + this.windowSize);
	}

	public get hasOverflow(): boolean {
		return this.rowCount > this.visibleCount;
	}

	public setVisibleCount(count: number): void {
		this.visibleCount = Math.max(1, count);
		this.ensureVisible();
	}

	public moveBy(delta: number): boolean {
		return this.moveToOrdinal(this.selectedOrdinalValue + delta);
	}

	public moveTo(index: number): boolean {
		if (this.selectableRowIndices.length === 0) return false;
		const nextOrdinal = this.selectableRowIndices.findIndex((rowIndex) => rowIndex >= index);
		return this.moveToOrdinal(nextOrdinal < 0 ? this.selectableRowIndices.length - 1 : nextOrdinal);
	}

	public page(direction: -1 | 1): boolean {
		return this.moveBy(direction * Math.max(1, this.visibleCount - 1));
	}

	private moveToOrdinal(ordinal: number): boolean {
		if (this.selectableRowIndices.length === 0) return false;
		const next = Math.min(this.selectableRowIndices.length - 1, Math.max(0, ordinal));
		if (next === this.selectedOrdinalValue) return false;
		this.selectedOrdinalValue = next;
		this.ensureVisible();
		return true;
	}

	private ensureVisible(): void {
		const selectedIndex = this.selected;
		const maxOffset = Math.max(0, this.rowCount - this.visibleCount);
		if (selectedIndex < this.scrollOffset) {
			this.scrollOffset = selectedIndex;
		} else if (selectedIndex >= this.scrollOffset + this.visibleCount) {
			this.scrollOffset = selectedIndex - this.visibleCount + 1;
		}

		const trailingRows = this.rowCount - selectedIndex - 1;
		if (this.selectedOrdinalValue === this.selectableRowIndices.length - 1 && trailingRows < this.visibleCount) {
			this.scrollOffset = maxOffset;
		}
		this.scrollOffset = Math.min(maxOffset, Math.max(0, this.scrollOffset));
	}
}

/**
 * Scroll-only window over wrapped preview lines. Extent is re-declared each
 * render (wrapping depends on width); the offset is clamped to stay valid.
 */
export class PreviewScroller {
	private lineCount = 0;
	private visibleCount = 1;
	private offsetValue = 0;

	public get offset(): number {
		return this.offsetValue;
	}

	public get windowSize(): number {
		return Math.min(this.visibleCount, this.lineCount);
	}

	/** One-based final line currently visible, suitable for a progress counter. */
	public get visibleEnd(): number {
		return Math.min(this.lineCount, this.offsetValue + this.windowSize);
	}

	public get hasOverflow(): boolean {
		return this.lineCount > this.visibleCount;
	}

	public get maxOffset(): number {
		return Math.max(0, this.lineCount - this.visibleCount);
	}

	public setExtent(lineCount: number, visibleCount: number): void {
		this.lineCount = Math.max(0, lineCount);
		this.visibleCount = Math.max(1, visibleCount);
		this.offsetValue = Math.min(this.maxOffset, this.offsetValue);
	}

	public scrollBy(delta: number): boolean {
		return this.scrollTo(this.offsetValue + delta);
	}

	public scrollTo(offset: number): boolean {
		const next = Math.min(this.maxOffset, Math.max(0, offset));
		if (next === this.offsetValue) return false;
		this.offsetValue = next;
		return true;
	}

	public page(direction: -1 | 1): boolean {
		return this.scrollBy(direction * Math.max(1, this.visibleCount - 1));
	}

	public reset(): void {
		this.offsetValue = 0;
	}
}
