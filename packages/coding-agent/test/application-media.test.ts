import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@coda/ai";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import { FileSessionManager } from "../src/session/file-session-manager.ts";
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

describe("Coding Agent image attachments", () => {
	it("accepts repeated --image paths and submits normalized image content after text", async () => {
		const fixture = await setup();
		const firstPath = await fixture.image("first.png", "#336699");
		const secondPath = await fixture.image("second.webp", "#993366");
		let observedContent: unknown;
		fixture.faux.setResponses([
			(context) => {
				observedContent = context.messages.at(-1)?.content;
				return fauxAssistantMessage("I can see both images", { timestamp: 100 });
			},
		]);

		const exitCode = await fixture.application.run([
			"--print",
			"--model",
			fixture.model,
			"--image",
			firstPath,
			"--image",
			secondPath,
			"compare them",
		]);

		expect(exitCode).toBe(0);
		expect(observedContent).toEqual([
			{ type: "text", text: "compare them" },
			expect.objectContaining({ type: "image", mimeType: "image/jpeg" }),
			expect.objectContaining({ type: "image", mimeType: "image/jpeg" }),
		]);
		for (const block of observedContent as Array<Record<string, unknown>>) {
			if (block.type === "image") expect(Buffer.from(block.data as string, "base64").byteLength).toBeGreaterThan(0);
		}
		expect(fixture.stdout.value).toBe("I can see both images\n");
		expect(fixture.stderr.value).toBe("");
	});

	it("rejects image submission before a provider call when the selected Model is text-only", async () => {
		const fixture = await setup({ modelInput: ["text"] });
		const imagePath = await fixture.image("unsupported.png", "#123456");
		fixture.faux.setResponses([fauxAssistantMessage("must not run", { timestamp: 100 })]);

		const exitCode = await fixture.application.run([
			"--print",
			"--model",
			fixture.model,
			"--image",
			imagePath,
			"describe",
		]);

		expect(exitCode).toBe(1);
		expect(fixture.faux.state.callCount).toBe(0);
		expect(fixture.stdout.value).toBe("");
		expect(fixture.stderr.value).toContain("does not support image input");
	});

	it("emits JSON v2 media descriptors without base64 unless explicitly requested", async () => {
		const fixture = await setup();
		const imagePath = await fixture.image("json image.png", "#654321");
		fixture.faux.setResponses([fauxAssistantMessage("described", { timestamp: 100 })]);

		const exitCode = await fixture.application.run([
			"--print",
			"--json",
			"--model",
			fixture.model,
			"--image",
			imagePath,
			"describe",
		]);

		expect(exitCode).toBe(0);
		const runStart = fixture.stdout.value
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line))
			.find((event) => event.type === "run_start");
		expect(runStart).toMatchObject({
			schemaVersion: 2,
			inputMessage: {
				message: {
					content: [
						{ type: "text", text: "describe" },
						{
							type: "media",
							filename: "json image.png",
							digest: expect.stringMatching(/^[a-f0-9]{64}$/),
							rendition: { digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
						},
					],
				},
			},
		});
		expect(fixture.stdout.value).not.toContain('"data":');
	});

	it("includes base64 only behind --include-media-data", async () => {
		const fixture = await setup();
		const imagePath = await fixture.image("included.png", "#111111");
		fixture.faux.setResponses([fauxAssistantMessage("done", { timestamp: 100 })]);

		await expect(
			fixture.application.run([
				"--print",
				"--json",
				"--include-media-data",
				"--model",
				fixture.model,
				"--image",
				imagePath,
				"describe",
			]),
		).resolves.toBe(0);
		const runStart = fixture.stdout.value
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line))
			.find((event) => event.type === "run_start");
		expect(runStart.inputMessage.message.content[1].data).toMatch(/^[a-zA-Z0-9+/]+=*$/);
	});

	it("persists Session v4 media references and restores model-visible bytes on resume", async () => {
		const fixture = await setup({ persistentSessions: true });
		const imagePath = await fixture.image("durable image.png", "#223344");
		let resumedImageData: string | undefined;
		fixture.faux.setResponses([
			fauxAssistantMessage("first answer", { timestamp: 100 }),
			(context) => {
				const firstUser = context.messages.find((message) => message.role === "user");
				if (Array.isArray(firstUser?.content)) {
					resumedImageData = firstUser.content.find((block) => block.type === "image")?.data;
				}
				return fauxAssistantMessage("resumed answer", { timestamp: 100 });
			},
		]);

		await expect(
			fixture.application.run(["--print", "--session", "--model", fixture.model, "--image", imagePath, "describe"]),
		).resolves.toBe(0);
		const [descriptor] = await fixture.sessions!.list(fixture.workspace);
		expect(descriptor).toBeDefined();
		const journal = await readFile(descriptor!.path!, "utf8");
		expect(JSON.parse(journal.split("\n")[0]!)).toMatchObject({ version: 4 });
		expect(journal).toContain('"type":"media"');
		expect(journal).not.toContain('"data":');
		const reference = JSON.parse(journal.split("\n").find((line) => line.includes('"type":"media"'))!).payload.message
			.message.content[1];
		expect(reference.filename).toBe("durable image.png");
		expect((await stat(join(`${descriptor!.path}.media`, `${reference.digest}.model.jpg`))).mode & 0o777).toBe(0o600);

		await expect(fixture.application.run(["--print", "--resume", descriptor!.id, "continue"])).resolves.toBe(0);
		expect(resumedImageData).toMatch(/^[a-zA-Z0-9+/]+=*$/);
	});
});

async function setup(options: { modelInput?: ("text" | "image")[]; persistentSessions?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "coda-application-media-"));
	temporaryDirectories.push(root);
	const runtime = testTimeRuntime(100);
	const faux = fauxProvider({
		runtime,
		models: [{ id: "media-model", input: options.modelInput ?? ["text", "image"] }],
	});
	const models = createModels({ runtime });
	models.setProvider(faux.provider);
	const stdout = new BufferOutput();
	const stderr = new BufferOutput();
	let id = 0;
	const canonicalRoot = await realpath(root);
	const workspace = {
		id: createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 32),
		path: canonicalRoot,
	};
	const sessions = options.persistentSessions
		? new FileSessionManager({
				fileSystem: createNodeFileSystem(),
				homeDirectory: root,
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				owner: { token: "test-owner", pid: 123, processStartedAt: 1, hostname: "test" },
				processInspector: { status: async () => "alive" },
			})
		: undefined;
	const application = createCodingAgentApplication({
		models,
		settings: { load: async () => ({}), save: async () => undefined },
		fileSystem: createNodeFileSystem(),
		processRunner: createNodeProcessRunner({ platform: "darwin" }),
		sessions,
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
		},
	});
	return {
		root,
		faux,
		application,
		stdout,
		stderr,
		sessions,
		workspace,
		model: `${faux.getModel().provider}/${faux.getModel().id}`,
		image: async (name: string, color: string) => {
			const path = join(root, name);
			const format = name.endsWith(".webp") ? "webp" : "png";
			const pipeline = sharp({ create: { width: 32, height: 24, channels: 3, background: color } });
			await writeFile(path, format === "webp" ? await pipeline.webp().toBuffer() : await pipeline.png().toBuffer());
			return path;
		},
	};
}
