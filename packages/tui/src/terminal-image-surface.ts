import type { Terminal } from "./terminal.ts";

export interface TerminalImageCapability {
	readonly protocol: "kitty";
	readonly canDeleteData: true;
	readonly canDeletePlacement: true;
	readonly canCrop: true;
	readonly transmission: "direct";
	readonly multiplexerTransport: false;
}

export interface ImagePlacement {
	readonly stableKey: string;
	readonly generation: string;
	readonly png: Uint8Array;
	readonly row: number;
	readonly column: number;
	readonly width: number;
	readonly height: number;
}

export interface TerminalImageSurface {
	readonly capability: TerminalImageCapability | null;
	reconcile(placements: readonly ImagePlacement[]): Promise<void>;
	dispose(): Promise<void>;
}

export interface TerminalImageSurfaceOptions {
	readonly terminal: Terminal;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly allocateId: () => number;
}

interface ImageRecord {
	readonly id: number;
	generation: string;
}

const KITTY_ESCAPE = "\x1b_G";
const STRING_TERMINATOR = "\x1b\\";
const CHUNK_SIZE = 4_096;
const KITTY_CAPABILITY: TerminalImageCapability = Object.freeze({
	protocol: "kitty",
	canDeleteData: true,
	canDeletePlacement: true,
	canCrop: true,
	transmission: "direct",
	multiplexerTransport: false,
});

export function detectTerminalImageCapability(
	environment: Readonly<Record<string, string | undefined>>,
): TerminalImageCapability | null {
	const term = environment.TERM?.toLowerCase() ?? "";
	if (
		environment.TMUX ||
		environment.ZELLIJ ||
		environment.STY ||
		term.startsWith("screen") ||
		term.startsWith("tmux")
	) {
		return null;
	}
	const program = environment.TERM_PROGRAM?.toLowerCase() ?? "";
	if (
		term.includes("kitty") ||
		environment.KITTY_WINDOW_ID !== undefined ||
		program.includes("ghostty") ||
		program.includes("wezterm")
	) {
		return KITTY_CAPABILITY;
	}
	return null;
}

class KittyImageSurface implements TerminalImageSurface {
	readonly #terminal: Terminal;
	readonly #allocateId: () => number;
	readonly #records = new Map<string, ImageRecord>();
	readonly capability: TerminalImageCapability;
	#disposed = false;

	constructor(options: TerminalImageSurfaceOptions, capability: TerminalImageCapability) {
		this.#terminal = options.terminal;
		this.#allocateId = options.allocateId;
		this.capability = capability;
	}

	async reconcile(placements: readonly ImagePlacement[]): Promise<void> {
		if (this.#disposed) this.#disposed = false;
		const desired = new Map<string, ImagePlacement>();
		for (const placement of placements) {
			validatePlacement(placement);
			if (desired.has(placement.stableKey)) throw new Error(`Duplicate Image Placement: ${placement.stableKey}`);
			desired.set(placement.stableKey, placement);
		}
		let output = "";
		for (const [key, record] of this.#records) {
			if (desired.has(key)) continue;
			output += kittyCommand(`a=d,d=I,i=${record.id},q=2`);
			this.#records.delete(key);
		}
		for (const placement of placements) {
			let record = this.#records.get(placement.stableKey);
			if (!record) {
				record = { id: this.#nextId(), generation: placement.generation };
				this.#records.set(placement.stableKey, record);
				output += transmitPng(record.id, placement.png);
			} else if (record.generation !== placement.generation) {
				output += kittyCommand(`a=d,d=I,i=${record.id},q=2`);
				record.generation = placement.generation;
				output += transmitPng(record.id, placement.png);
			} else {
				output += kittyCommand(`a=d,d=p,i=${record.id},q=2`);
			}
			output += `\x1b[${placement.row + 1};${placement.column + 1}H`;
			output += kittyCommand(`a=p,i=${record.id},p=${record.id},c=${placement.width},r=${placement.height},q=2,z=1`);
		}
		if (!output) return;
		this.#terminal.write(`${output}\x1b[?25l`);
		await this.#terminal.flushOutput();
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		let output = "";
		for (const record of this.#records.values()) {
			output += kittyCommand(`a=d,d=I,i=${record.id},q=2`);
		}
		this.#records.clear();
		if (!output) return;
		this.#terminal.write(output);
		await this.#terminal.flushOutput();
	}

	#nextId(): number {
		const id = this.#allocateId();
		if (!Number.isSafeInteger(id) || id < 1 || id > 0xffff_ffff) {
			throw new RangeError("Kitty image id must be a positive 32-bit integer");
		}
		return id;
	}
}

class UnsupportedImageSurface implements TerminalImageSurface {
	readonly capability = null;

	async reconcile(_placements: readonly ImagePlacement[]): Promise<void> {}

	async dispose(): Promise<void> {}
}

export function createTerminalImageSurface(options: TerminalImageSurfaceOptions): TerminalImageSurface {
	const capability = detectTerminalImageCapability(options.environment);
	return capability ? new KittyImageSurface(options, capability) : new UnsupportedImageSurface();
}

function transmitPng(id: number, png: Uint8Array): string {
	const encoded = Buffer.from(png).toString("base64");
	let output = "";
	for (let offset = 0; offset < encoded.length; offset += CHUNK_SIZE) {
		const chunk = encoded.slice(offset, offset + CHUNK_SIZE);
		const more = offset + CHUNK_SIZE < encoded.length ? 1 : 0;
		const parameters = offset === 0 ? `a=T,f=100,t=d,i=${id},q=2,m=${more}` : `m=${more}`;
		output += kittyCommand(parameters, chunk);
	}
	return output;
}

function kittyCommand(parameters: string, payload = ""): string {
	return `${KITTY_ESCAPE}${parameters}${payload ? `;${payload}` : ""}${STRING_TERMINATOR}`;
}

function validatePlacement(placement: ImagePlacement): void {
	if (!placement.stableKey || !placement.generation) throw new Error("Image Placement identity must be non-empty");
	if (placement.png.byteLength === 0) throw new Error("Image Placement PNG must be non-empty");
	for (const [name, value, minimum] of [
		["row", placement.row, 0],
		["column", placement.column, 0],
		["width", placement.width, 1],
		["height", placement.height, 1],
	] as const) {
		if (!Number.isSafeInteger(value) || value < minimum) {
			throw new RangeError(`Image Placement ${name} must be an integer >= ${minimum}`);
		}
	}
}
