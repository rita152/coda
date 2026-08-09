export interface ViewportBlock {
	readonly id: string;
	readonly lines: readonly string[];
}

export interface ViewportAnchor {
	readonly blockId: string;
	readonly lineOffset: number;
}

export interface ViewportFrame {
	readonly lines: readonly string[];
	readonly sourceRows: readonly ViewportSourceRow[];
	readonly atStart: boolean;
	readonly atEnd: boolean;
	readonly totalLines: number;
}

export interface ViewportSourceRow {
	readonly blockId: string;
	readonly lineOffset: number;
}

interface IndexedBlock {
	readonly block: ViewportBlock;
	readonly position: number;
	readonly start: number;
	readonly end: number;
}

interface DocumentIndex {
	readonly source: readonly ViewportBlock[];
	readonly blocks: readonly IndexedBlock[];
	readonly byId: ReadonlyMap<string, IndexedBlock>;
	readonly totalLines: number;
}

/** Maintains transcript position in semantic block coordinates instead of terminal rows. */
export class TimelineViewport {
	#followEnd = true;
	#anchor?: ViewportAnchor;
	#fallbackIndex = 0;
	#unreadUpdates = 0;
	#index?: DocumentIndex;

	get followEnd(): boolean {
		return this.#followEnd;
	}

	get anchor(): ViewportAnchor | undefined {
		return this.#anchor ? Object.freeze({ ...this.#anchor }) : undefined;
	}

	get unreadUpdates(): number {
		return this.#unreadUpdates;
	}

	layout(blocks: readonly ViewportBlock[], height: number): ViewportFrame {
		assertHeight(height);
		const document = this.#indexDocument(blocks);
		if (height === 0 || document.totalLines === 0) {
			return Object.freeze({
				lines: [],
				sourceRows: [],
				atStart: true,
				atEnd: true,
				totalLines: document.totalLines,
			});
		}

		const start = this.#resolveStart(document, height);
		if (!this.#followEnd) this.#setAnchor(document, start);
		const slice = sliceDocument(document, start, height);
		return Object.freeze({
			lines: slice.lines,
			sourceRows: slice.sourceRows,
			atStart: start === 0,
			atEnd: start + height >= document.totalLines,
			totalLines: document.totalLines,
		});
	}

	pageUp(blocks: readonly ViewportBlock[], height: number): void {
		assertHeight(height);
		const document = this.#indexDocument(blocks);
		if (document.totalLines === 0 || height === 0) return;
		const start = this.#resolveStart(document, height);
		const target = Math.max(0, start - Math.max(1, height - 1));
		this.#followEnd = false;
		this.#setAnchor(document, target);
	}

	pageDown(blocks: readonly ViewportBlock[], height: number): void {
		assertHeight(height);
		const document = this.#indexDocument(blocks);
		if (document.totalLines === 0 || height === 0) return;
		const start = this.#resolveStart(document, height);
		const maximum = Math.max(0, document.totalLines - height);
		const target = start + Math.max(1, height - 1);
		if (target >= maximum) {
			this.jumpToEnd();
			return;
		}
		this.#followEnd = false;
		this.#setAnchor(document, target);
	}

	scrollBy(blocks: readonly ViewportBlock[], height: number, rows: number): void {
		assertHeight(height);
		if (!Number.isSafeInteger(rows)) throw new RangeError("Scroll distance must be a safe integer");
		const document = this.#indexDocument(blocks);
		if (document.totalLines === 0 || height === 0 || rows === 0) return;
		const start = this.#resolveStart(document, height);
		const maximum = Math.max(0, document.totalLines - height);
		const target = Math.min(maximum, Math.max(0, start + rows));
		if (target >= maximum) {
			this.jumpToEnd();
			return;
		}
		this.#followEnd = false;
		this.#setAnchor(document, target);
	}

	jumpToStart(blocks: readonly ViewportBlock[]): void {
		const document = this.#indexDocument(blocks);
		this.#followEnd = false;
		this.#unreadUpdates = 0;
		if (document.totalLines === 0) {
			this.#anchor = undefined;
			this.#fallbackIndex = 0;
			return;
		}
		this.#setAnchor(document, 0);
	}

	jumpToEnd(): void {
		this.#followEnd = true;
		this.#anchor = undefined;
		this.#fallbackIndex = 0;
		this.#unreadUpdates = 0;
	}

	noteUpdate(count = 1): void {
		if (!Number.isSafeInteger(count) || count < 0)
			throw new RangeError("Update count must be a non-negative integer");
		if (!this.#followEnd) this.#unreadUpdates += count;
	}

	#resolveStart(document: DocumentIndex, height: number): number {
		const maximum = Math.max(0, document.totalLines - height);
		if (this.#followEnd) return maximum;
		const anchor = this.#anchor;
		const anchoredBlock = anchor ? document.byId.get(anchor.blockId) : undefined;
		const anchored =
			anchor && anchoredBlock && anchoredBlock.end > anchoredBlock.start
				? anchoredBlock.start + Math.min(anchoredBlock.end - anchoredBlock.start - 1, anchor.lineOffset)
				: -1;
		return Math.min(maximum, Math.max(0, anchored >= 0 ? anchored : this.#fallbackIndex));
	}

	#setAnchor(document: DocumentIndex, index: number): void {
		const resolved = Math.min(document.totalLines - 1, Math.max(0, index));
		const block = findBlock(document.blocks, resolved);
		if (!block) return;
		this.#anchor = Object.freeze({ blockId: block.block.id, lineOffset: resolved - block.start });
		this.#fallbackIndex = resolved;
	}

	#indexDocument(blocks: readonly ViewportBlock[]): DocumentIndex {
		if (this.#index?.source === blocks) return this.#index;
		const ids = new Set<string>();
		const indexed: IndexedBlock[] = [];
		const byId = new Map<string, IndexedBlock>();
		let totalLines = 0;
		for (const [position, block] of blocks.entries()) {
			if (ids.has(block.id)) throw new Error(`Duplicate viewport block id: ${block.id}`);
			ids.add(block.id);
			const entry = Object.freeze({ block, position, start: totalLines, end: totalLines + block.lines.length });
			indexed.push(entry);
			byId.set(block.id, entry);
			totalLines = entry.end;
		}
		this.#index = Object.freeze({
			source: blocks,
			blocks: Object.freeze(indexed),
			byId,
			totalLines,
		});
		return this.#index;
	}
}

function findBlock(blocks: readonly IndexedBlock[], lineIndex: number): IndexedBlock | undefined {
	let low = 0;
	let high = blocks.length - 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const block = blocks[middle]!;
		if (lineIndex < block.start) high = middle - 1;
		else if (lineIndex >= block.end) low = middle + 1;
		else return block;
	}
	return undefined;
}

function sliceDocument(
	document: DocumentIndex,
	start: number,
	height: number,
): { readonly lines: readonly string[]; readonly sourceRows: readonly ViewportSourceRow[] } {
	const lines: string[] = [];
	const sourceRows: ViewportSourceRow[] = [];
	let block = findBlock(document.blocks, start);
	let blockIndex = block?.position ?? document.blocks.length;
	let lineIndex = start;
	while (block && lines.length < height) {
		const offset = Math.max(0, lineIndex - block.start);
		for (let index = offset; index < block.block.lines.length && lines.length < height; index++) {
			lines.push(block.block.lines[index]!);
			sourceRows.push(Object.freeze({ blockId: block.block.id, lineOffset: index }));
			lineIndex++;
		}
		block = document.blocks[++blockIndex];
	}
	return Object.freeze({ lines: Object.freeze(lines), sourceRows: Object.freeze(sourceRows) });
}

function assertHeight(height: number): void {
	if (!Number.isSafeInteger(height) || height < 0)
		throw new RangeError("Viewport height must be a non-negative integer");
}
