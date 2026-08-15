import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@coda/ai";
import { createSystemScheduler, stripAnsi, VirtualTerminal } from "@coda/tui";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class BufferOutput implements ApplicationOutput {
	readonly isTTY = false;
	value = "";

	write(chunk: string): void {
		this.value += chunk;
	}
}

describe("interactive image attachments", () => {
	it("turns a dropped image path into a filename Attachment and renders a Kitty preview", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-interactive-media-"));
		temporaryDirectories.push(root);
		const imagePath = join(root, "reference image.png");
		await writeFile(
			imagePath,
			await sharp({ create: { width: 32, height: 24, channels: 3, background: "#336699" } })
				.png()
				.toBuffer(),
		);
		const runtime = testTimeRuntime(500);
		const faux = fauxProvider({ runtime });
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 80, rows: 24 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({ defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id } }),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: root,
				homeDirectory: root,
				platform: "darwin",
				environment: { TERM_PROGRAM: "ghostty" },
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		const running = application.run(["--interactive", "--no-session"]);
		await until(() => terminal.started);
		await terminal.emit({ type: "paste", text: imagePath });
		await until(() => stripAnsi(terminal.readOutput()).includes("[reference image.png]"));
		expect(stripAnsi(terminal.readOutput())).not.toContain(imagePath);

		await terminal.emit(key("tab"));
		await terminal.emit(key("enter"));
		await until(() => terminal.readOutput().includes("\x1b_Ga=t,f=100"));
		await until(() => stripAnsi(terminal.readOutput()).includes("Image preview"));
		await terminal.emit(key("q"));
		await terminal.emit(key("escape"));
		await terminal.emit(key("c", { control: true, text: "c" }));
		await terminal.emit(key("c", { control: true, text: "c" }));
		await terminal.emit(key("c", { control: true, text: "c" }));

		await expect(running).resolves.toBe(0);
		expect(stdout.value).toBe("");
		expect(stderr.value).toBe("");
	});

	it("sends removed /attach syntax as an ordinary User Prompt", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-interactive-media-"));
		temporaryDirectories.push(root);
		const imagePath = join(root, "reference image.png");
		await writeFile(
			imagePath,
			await sharp({ create: { width: 32, height: 24, channels: 3, background: "#336699" } })
				.png()
				.toBuffer(),
		);
		const runtime = testTimeRuntime(500);
		let observedContent: unknown;
		const faux = fauxProvider({ runtime });
		faux.setResponses([
			(context) => {
				observedContent = context.messages.at(-1)?.content;
				return fauxAssistantMessage("attach syntax was prompt text", { timestamp: 500 });
			},
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 80, rows: 24 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({ defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id } }),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: root,
				homeDirectory: root,
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		const running = application.run(["--interactive", "--no-session"]);
		await until(() => terminal.started);
		await terminal.emit({ type: "text", text: `/attach ${imagePath}` });
		await terminal.emit(key("enter"));
		await until(() => stripAnsi(terminal.readOutput()).includes("attach syntax was prompt text"));
		await terminal.emit(key("c", { control: true, text: "c" }));
		await terminal.emit(key("c", { control: true, text: "c" }));

		await expect(running).resolves.toBe(0);
		expect(observedContent).toBe(`/attach ${imagePath}`);
		expect(stdout.value).toBe("attach syntax was prompt text\n");
		expect(stderr.value).toBe("");
	});
});

function key(
	keyName: "c" | "enter" | "escape" | "q" | "tab",
	overrides: Partial<Extract<Parameters<VirtualTerminal["emit"]>[0], { type: "key" }>> = {},
): Extract<Parameters<VirtualTerminal["emit"]>[0], { type: "key" }> {
	return {
		type: "key",
		key: keyName,
		shift: false,
		control: false,
		alt: false,
		meta: false,
		action: "press",
		...overrides,
	};
}

async function until(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 2_000; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Condition did not become true");
}
