import { describe, expect, it, vi } from "vitest";
import {
	type KeyInput,
	type PasteInput,
	type ResizeInput,
	type TerminalInput,
	type TextInput,
	VirtualTerminal,
} from "../src/index.ts";

describe("VirtualTerminal public contract", () => {
	it("has an asynchronous idempotent lifecycle and immutable instance snapshots", async () => {
		const terminal = new VirtualTerminal({ columns: 100, rows: 30 });

		await expect(terminal.start()).resolves.toBe(true);
		await expect(terminal.start()).resolves.toBe(true);
		expect(terminal.started).toBe(true);
		expect(terminal.size).toEqual({ columns: 100, rows: 30 });
		expect(Object.isFrozen(terminal.size)).toBe(true);
		expect(Object.isFrozen(terminal.capabilities)).toBe(true);

		terminal.write("hello");
		await terminal.flush();
		expect(terminal.readOutput()).toBe("hello");

		await expect(terminal.stop()).resolves.toBeUndefined();
		await expect(terminal.stop()).resolves.toBeUndefined();
		expect(terminal.started).toBe(false);
	});

	it("emits the same structured input union and updates size before resize listeners", async () => {
		const terminal = new VirtualTerminal();
		const received: TerminalInput[] = [];
		const listener = vi.fn(async (input: TerminalInput) => {
			received.push(input);
			if (input.type === "resize") {
				expect(terminal.size).toEqual({ columns: input.columns, rows: input.rows });
			}
		});
		const unsubscribe = terminal.onInput(listener);
		await terminal.start();

		const key: KeyInput = {
			type: "key",
			key: "a",
			text: "A",
			shift: true,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		};
		const text: TextInput = { type: "text", text: "你好" };
		const paste: PasteInput = { type: "paste", text: "one\ntwo" };
		const resize: ResizeInput = { type: "resize", columns: 120, rows: 40 };

		await terminal.emit(key);
		await terminal.emit(text);
		await terminal.emit(paste);
		await terminal.emit(resize);

		expect(received).toEqual([key, text, paste, resize]);
		expect(listener).toHaveBeenCalledTimes(4);
		expect(Object.isFrozen(terminal.size)).toBe(true);

		unsubscribe();
		await terminal.emit(key);
		expect(listener).toHaveBeenCalledTimes(4);
	});

	it("awaits listeners in registration order", async () => {
		const terminal = new VirtualTerminal();
		const order: string[] = [];
		await terminal.start();
		terminal.onInput(async () => {
			order.push("first:start");
			await Promise.resolve();
			order.push("first:end");
		});
		terminal.onInput(() => {
			order.push("second");
		});

		await terminal.emit({ type: "text", text: "x" });

		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("replaces a fallback capability snapshot after virtual resize just like ProcessTerminal", async () => {
		const terminal = new VirtualTerminal({ capabilities: { sizeFallback: true } });
		await terminal.start();
		const fallback = terminal.capabilities;

		await terminal.emit({ type: "resize", columns: 90, rows: 25 });

		expect(fallback.sizeFallback).toBe(true);
		expect(terminal.capabilities.sizeFallback).toBe(false);
		expect(terminal.capabilities).not.toBe(fallback);
		expect(Object.isFrozen(terminal.capabilities)).toBe(true);
	});
});
