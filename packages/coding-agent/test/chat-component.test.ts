import type { AgentEvent, AgentSeed, MessageId } from "@coda/agent";
import type { ComponentInputContext, KeyInput, MarkdownRenderer, MouseButton } from "@coda/tui";
import { stripAnsi } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import { ChatComponent } from "../src/interactive/chat-component.ts";
import type { UserShellSnapshot, UserShellStatus } from "../src/interactive/user-shell.ts";

describe("ChatComponent terminal input", () => {
	it("routes /approvals to process-local approval management instead of the Model", async () => {
		const onApprovals = vi.fn(async () => undefined);
		const onSubmit = vi.fn();
		const component = new ChatComponent({
			modelLabel: "provider/model",
			reasoning: "off",
			onSubmit,
			onApprovals,
			onAbort: vi.fn(),
			onExit: vi.fn(),
		});
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };

		component.handleInput({ type: "text", text: "/approvals" }, context);
		component.handleInput(key("enter"), context);

		await vi.waitFor(() => expect(onApprovals).toHaveBeenCalledOnce());
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("inserts printable text carried by a normalized KeyInput", () => {
		const component = new ChatComponent({
			modelLabel: "provider/model",
			reasoning: "off",
			onSubmit: vi.fn(),
			onAbort: vi.fn(),
			onExit: vi.fn(),
		});
		const context: ComponentInputContext = {
			requestImmediateRender: vi.fn(),
		};

		component.handleInput(
			{
				type: "key",
				key: "a",
				text: "a",
				shift: false,
				control: false,
				alt: false,
				meta: false,
				action: "press",
			},
			context,
		);

		expect(component.render({ width: 80, height: 24, now: 0 }).at(-3)).toBe("a");
	});

	it("fills the full screen with a fixed header, transcript viewport, and dock", () => {
		const component = createComponent({ workspaceLabel: "coda" });
		const frame = component.render({ width: 80, height: 12, now: 0 });

		expect(frame).toHaveLength(12);
		expect(frame[0]).toContain("Coda");
		expect(frame[0]).toContain("coda");
		expect(frame.at(-4)).toBe("─".repeat(80));
		expect(frame.at(-3)).toBe("");
		expect(frame.at(-2)).toBe("─".repeat(80));
		expect(frame.at(-1)).toContain("Enter sends");
	});

	it("renders a multiline Pi-style editor dock with full-width horizontal borders", () => {
		const component = createComponent({ colorLevel: 0 });
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.handleInput({ type: "text", text: "first" }, context);
		component.handleInput(key("enter", { shift: true }), context);
		component.handleInput({ type: "text", text: "second" }, context);

		const frame = component.render({ width: 40, height: 12, now: 0 });
		expect(frame).toHaveLength(12);
		expect(frame.slice(-5)).toEqual(["─".repeat(40), "first", "second", "─".repeat(40), frame.at(-1)]);
		expect(frame.at(-1)).toContain("Enter sends");
	});

	it("drops optional header and footer hints by priority on a narrow usable screen", () => {
		const component = createComponent({ workspaceLabel: "project", modelLabel: "provider/model-1234" });
		const frame = component.render({ width: 40, height: 10, now: 0 });

		expect(frame[0]).toContain("project");
		expect(frame[0]).toContain("provider/model-1234");
		expect(frame[0]).not.toContain("reasoning");
		expect(frame.at(-1)).toContain("Ctrl-C exits");
		expect(frame.at(-1)).not.toContain("Ctrl-T transcript");
	});

	it("shows an operable static view below the minimum terminal size", () => {
		const component = createComponent();
		const frame = component.render({ width: 30, height: 5, now: 0 });

		expect(frame).toHaveLength(5);
		expect(frame.join("\n")).toContain("Terminal too small");
		expect(frame.join("\n")).toContain("Ctrl-C exits");
	});

	it("keeps manual scroll position, reports unseen updates, and lets Ctrl-End resume tail-follow", () => {
		const component = createComponent();
		for (let index = 1; index <= 12; index++) component.accept(assistantEvent(index, `answer ${index}`));
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.render({ width: 60, height: 10, now: 0 });

		component.handleInput(key("page-up"), context);
		expect(component.render({ width: 60, height: 10, now: 0 }).join("\n")).not.toContain("answer 12");

		component.accept(assistantEvent(13, "answer 13"));
		const scrolled = component.render({ width: 60, height: 10, now: 0 }).join("\n");
		expect(scrolled).not.toContain("answer 13");
		expect(scrolled).toContain("down 1 update");

		component.handleInput(key("end", { control: true }), context);
		const tail = component.render({ width: 60, height: 10, now: 0 }).join("\n");
		expect(tail).toContain("answer 13");
		expect(tail).not.toContain("down 1 update");
		expect(context.requestImmediateRender).toHaveBeenCalled();
	});

	it("scrolls the Timeline when it receives mouse wheel input", () => {
		const component = createComponent();
		for (let index = 1; index <= 16; index++) component.accept(assistantEvent(index, `answer ${index}`));
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.render({ width: 60, height: 10, now: 0 });

		component.handleInput(mouse("press", 20, 4, "wheel-up"), context);

		expect(component.render({ width: 60, height: 10, now: 0 }).join("\n")).not.toContain("answer 16");
		component.handleInput(mouse("press", 20, 4, "wheel-down"), context);
		expect(component.render({ width: 60, height: 10, now: 0 }).join("\n")).toContain("answer 16");
		expect(context.requestImmediateRender).toHaveBeenCalled();
	});

	it("renders User input literally and Assistant Markdown without a Coda label", () => {
		const component = createComponent();
		component.accept(
			event({
				type: "run_start",
				source: "prompt",
				inputMessage: {
					id: "user-1",
					message: { role: "user", content: "**literal user**", timestamp: 1 },
				},
			}),
		);
		component.accept(assistantEvent(2, "**rich assistant**"));
		const plain = stripAnsi(component.render({ width: 60, height: 10, now: 0 }).join("\n"));

		expect(plain).toContain("**literal user**");
		expect(plain).toContain("rich assistant");
		expect(plain).not.toContain("**rich assistant**");
		expect(plain).not.toContain("Coda: rich assistant");
	});

	it("renders a submitted multiline User Prompt in a muted border card without a label", () => {
		const component = createComponent({ colorLevel: 0 });
		component.accept(
			event({
				type: "run_start",
				source: "prompt",
				inputMessage: {
					id: "user-1",
					message: { role: "user", content: "first\nsecond", timestamp: 1 },
				},
			}),
		);

		const plain = stripAnsi(component.render({ width: 40, height: 12, now: 0 }).join("\n"));
		expect(plain).toContain(`${"─".repeat(40)}\nfirst\nsecond\n${"─".repeat(40)}`);
		expect(plain).not.toContain("›");
	});

	it("keeps submitted attachments before text inside the same User Prompt border", () => {
		const component = createComponent({
			colorLevel: 0,
			initialAttachments: [attachment("attachment:one", "photo.png")],
		});
		component.accept(
			event({
				type: "run_start",
				source: "prompt",
				inputMessage: {
					id: "user-1",
					message: { role: "user", content: "describe this", timestamp: 1 },
				},
			}),
		);

		const plain = stripAnsi(component.render({ width: 40, height: 12, now: 0 }).join("\n"));
		expect(plain).toContain(`${"─".repeat(40)}\n[photo.png]\ndescribe this\n${"─".repeat(40)}`);
	});

	it("keeps committed User-card attachments operable by keyboard and mouse", async () => {
		const onOpenAttachment = vi.fn(async () => undefined);
		const component = createComponent({
			initialAttachments: [attachment("attachment:one", "photo.png")],
			imagePreviewSupported: true,
			onOpenAttachment,
		});
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.accept(
			event({
				type: "run_start",
				source: "prompt",
				inputMessage: {
					id: "user-1",
					message: { role: "user", content: "describe this", timestamp: 1 },
				},
			}),
		);
		component.accept(
			event({
				type: "run_end",
				outcome: "success",
			}),
		);

		component.render({ width: 80, height: 20, now: 0 });
		component.handleInput(key("tab"), context);
		const focused = component.render({ width: 80, height: 20, now: 0 }).join("\n");
		expect(focused).toContain("32×24");
		expect(component.imagePlacements({ width: 80, height: 20, now: 0 })).toHaveLength(1);

		const labelRow = component
			.render({ width: 80, height: 20, now: 0 })
			.findIndex((line) => stripAnsi(line).includes("[photo.png]"));
		component.handleInput(mouse("move", 2, labelRow), context);
		expect(component.render({ width: 80, height: 20, now: 0 }).join("\n")).toContain("32×24");

		const external = createComponent({
			initialAttachments: [attachment("attachment:two", "external.png")],
			imagePreviewSupported: false,
			onOpenAttachment,
		});
		external.accept(
			event({
				type: "run_start",
				source: "prompt",
				inputMessage: {
					id: "user-2",
					message: { role: "user", content: "open this", timestamp: 1 },
				},
			}),
		);
		external.accept(event({ type: "run_end", outcome: "success" }));
		const externalFrame = external.render({ width: 80, height: 20, now: 0 });
		const externalRow = externalFrame.findIndex((line) => stripAnsi(line).includes("[external.png]"));
		external.handleInput(mouse("release", 2, externalRow, "left"), context);
		await vi.waitFor(() => expect(onOpenAttachment).toHaveBeenCalledWith("attachment:two"));
	});

	it("does not reinterpret Escape as Run cancellation", () => {
		const onAbort = vi.fn();
		const component = createComponent({ onAbort });
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.accept(
			event({
				type: "run_start",
				source: "prompt",
				inputMessage: { id: "user-1", message: { role: "user", content: "start", timestamp: 1 } },
			}),
		);

		component.handleInput(key("escape"), context);
		expect(onAbort).not.toHaveBeenCalled();

		component.handleInput(key("c", { control: true }), context);
		expect(onAbort).toHaveBeenCalledOnce();
	});

	it("keeps idle Escape as an explicit empty-composer exit", () => {
		const onExit = vi.fn();
		const component = createComponent({ onExit });
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };

		component.handleInput(key("escape"), context);
		expect(onExit).toHaveBeenCalledOnce();

		component.handleInput({ type: "text", text: "draft" }, context);
		component.handleInput(key("escape"), context);
		expect(onExit).toHaveBeenCalledOnce();
	});

	it("relayouts only a changed block after a deterministic 10,000-entry history", () => {
		const render = vi.fn<MarkdownRenderer["render"]>((source) => [source]);
		const seed: AgentSeed = {
			version: 1,
			pendingFollowUps: [],
			messages: Array.from({ length: 10_000 }, (_, index) => ({
				id: `history-${index}` as MessageId,
				message: {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: `line ${index}` }],
					api: "faux",
					provider: "faux",
					model: "faux",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp: index,
				},
			})),
		};
		const component = createComponent({ seed, markdownRenderer: { render } });
		component.render({ width: 80, height: 20, now: 0 });
		expect(render).toHaveBeenCalledTimes(10_000);
		render.mockClear();

		component.accept(assistantEvent(10_001, "new tail"));
		component.render({ width: 80, height: 20, now: 0 });

		expect(render).toHaveBeenCalledOnce();
		expect(render).toHaveBeenCalledWith("new tail", { width: 80, phase: "complete" });
	});

	it("creates one provisional User Prompt card as soon as submission is accepted", async () => {
		const onSubmit = vi.fn(() => undefined);
		const component = createComponent({ colorLevel: 0, onSubmit });
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.handleInput({ type: "text", text: "ship it" }, context);
		component.handleInput(key("enter"), context);

		expect(onSubmit).toHaveBeenCalledWith("ship it", []);
		const plain = stripAnsi(component.render({ width: 40, height: 12, now: 0 }).join("\n"));
		expect(plain).toContain(`${"─".repeat(40)}\nship it\n${"─".repeat(40)}`);
		expect(component.render({ width: 40, height: 12, now: 0 }).at(-3)).toBe("");
	});

	it("replays Prompt history only at visual boundaries and restores the exact draft", () => {
		const component = createComponent({
			colorLevel: 0,
			composerSubmissions: [
				{ id: "composer:1", kind: "prompt", text: "older" },
				{ id: "composer:2", kind: "steering", text: "newer" },
			],
		});
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.handleInput({ type: "text", text: "draft\nsecond" }, context);
		component.render({ width: 40, height: 12, now: 0 });

		component.handleInput(key("up"), context);
		expect(stripAnsi(component.render({ width: 40, height: 12, now: 0 }).join("\n"))).toContain("draft\nsecond");
		component.handleInput(key("up"), context);
		expect(component.render({ width: 40, height: 12, now: 0 }).at(-3)).toBe("newer");

		component.handleInput(key("down"), context);
		component.handleInput({ type: "text", text: "X" }, context);
		expect(stripAnsi(component.render({ width: 40, height: 12, now: 0 }).join("\n"))).toContain("draftX\nsecond");
	});

	it("enters a red Shell mode by absorbing a leading bang and keeps a bare command editable", () => {
		const onUserShell = vi.fn(() => ({ id: "user_shell:1", command: "echo hi" }));
		const component = createComponent({ colorLevel: 1, onUserShell });
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };

		component.handleInput({ type: "text", text: "!" }, context);
		let frame = component.render({ width: 40, height: 12, now: 0 }).join("\n");
		expect(stripAnsi(frame)).toContain("! \n");
		expect(stripAnsi(frame)).toContain("Shell mode");
		expect(frame).toContain(`\x1b[1;31m${"─".repeat(40)}\x1b[0m`);
		expect(frame).toContain("\x1b[1;31m! \x1b[0m");

		component.handleInput(key("enter"), context);
		expect(onUserShell).not.toHaveBeenCalled();
		frame = stripAnsi(component.render({ width: 60, height: 12, now: 0 }).join("\n"));
		expect(frame).toContain("Prefix a command with !");
		expect(frame).toContain("Shell mode");

		component.handleInput(key("backspace"), context);
		expect(stripAnsi(component.render({ width: 40, height: 12, now: 0 }).at(-1) ?? "")).toContain("Enter sends");

		component.handleInput({ type: "text", text: "!echo hi" }, context);
		component.handleInput(key("home"), context);
		component.handleInput(key("backspace"), context);
		frame = stripAnsi(component.render({ width: 40, height: 12, now: 0 }).join("\n"));
		expect(frame).not.toContain("Shell mode");
		expect(frame).toContain("echo hi");
	});

	it("runs a Shell command without consuming staged attachments and can reclaim a queued command", async () => {
		const onUserShell = vi.fn(async (command: string) => ({ id: "user_shell:queued", command }));
		const onReclaimUserShell = vi.fn(async () => undefined);
		const component = createComponent({
			colorLevel: 0,
			onAttach: async () => attachment("attachment:one", "photo.png"),
			onUserShell,
			onReclaimUserShell,
		});
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.handleInput({ type: "text", text: "/attach /tmp/photo.png" }, context);
		component.handleInput(key("enter"), context);
		await vi.waitFor(() =>
			expect(component.render({ width: 60, height: 14, now: 0 }).join("\n")).toContain("[photo.png]"),
		);

		component.handleInput({ type: "paste", text: "!echo queued" }, context);
		component.handleInput(key("enter"), context);
		await vi.waitFor(() => expect(onUserShell).toHaveBeenCalledWith("echo queued"));
		expect(stripAnsi(component.render({ width: 60, height: 14, now: 0 }).join("\n"))).toContain("[photo.png]");

		component.handleInput(key("up", { alt: true }), context);
		await vi.waitFor(() => expect(onReclaimUserShell).toHaveBeenCalledWith("user_shell:queued"));
		const recalled = stripAnsi(component.render({ width: 60, height: 14, now: 0 }).join("\n"));
		expect(recalled).toContain("! echo queued");
		expect(recalled).toContain("Shell mode");
		expect(recalled.match(/\[photo\.png\]/g)).toHaveLength(1);
	});

	it("renders live local output, queues Composer input during Shell execution, and cancels with Ctrl-C", async () => {
		const onFollowUp = vi.fn(() => "queue:after-shell");
		const onAbortUserShell = vi.fn();
		const component = createComponent({ colorLevel: 0, onFollowUp, onAbortUserShell });
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.acceptUserShell(shellSnapshot({ status: "running", output: "first\nsecond" }));

		let plain = stripAnsi(component.render({ width: 60, height: 14, now: 2_000 }).join("\n"));
		expect(plain).toContain("Running printf hello (2.0s)");
		expect(plain).toContain("└ first\n    second");
		component.handleInput({ type: "text", text: "after shell" }, context);
		component.handleInput(key("enter"), context);
		await vi.waitFor(() => expect(onFollowUp).toHaveBeenCalledWith("after shell", []));
		component.handleInput(key("c", { control: true }), context);
		expect(onAbortUserShell).toHaveBeenCalledOnce();

		component.acceptUserShell(shellSnapshot({ status: "success", output: "first\nsecond", durationMs: 2_000 }));
		plain = stripAnsi(component.render({ width: 60, height: 14, now: 2_000 }).join("\n"));
		expect(plain).toContain("You ran printf hello (2.0s)");
	});

	it("resumes a paused mixed queue when its only pending card is a local Shell command", async () => {
		let queuePaused = true;
		const onResumeFollowUps = vi.fn(() => {
			queuePaused = false;
		});
		const component = createComponent({
			colorLevel: 0,
			isQueuePaused: () => queuePaused,
			onResumeFollowUps,
			onUserShell: () => ({ id: "user_shell:live", command: "printf hello" }),
		});
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.handleInput({ type: "text", text: "!printf hello" }, context);
		component.handleInput(key("enter"), context);
		await vi.waitFor(() =>
			expect(stripAnsi(component.render({ width: 60, height: 14, now: 0 }).join("\n"))).toContain("Enter resumes"),
		);

		component.handleInput(key("enter"), context);
		expect(onResumeFollowUps).toHaveBeenCalledOnce();
		component.acceptUserShell(shellSnapshot({ status: "running", output: "" }));
		component.acceptUserShell(shellSnapshot({ status: "success", output: "done" }));
		expect(component.running).toBe(false);
	});

	it("sends an escaped leading bang to the Model and recalls the escape without entering Shell mode", async () => {
		const onSubmit = vi.fn(async () => ({ id: "composer:escaped", kind: "prompt" as const, text: "\\!model" }));
		const component = createComponent({ colorLevel: 0, onSubmit });
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.handleInput({ type: "text", text: "\\!model" }, context);
		component.handleInput(key("enter"), context);
		await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith("!model", [], "\\!model"));

		component.handleInput(key("up"), context);
		const frame = stripAnsi(component.render({ width: 40, height: 12, now: 0 }).join("\n"));
		expect(frame).toContain("\\!model");
		expect(frame).not.toContain("Shell mode");
	});

	it("queues running Enter as Steering and Alt+Enter as a Follow-up", async () => {
		const onSteer = vi.fn(() => "queue:steer");
		const onFollowUp = vi.fn(() => "queue:follow-up");
		const component = createComponent({ colorLevel: 0, onSteer, onFollowUp });
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.accept(
			event({
				type: "run_start",
				source: "prompt",
				inputMessage: { id: "user-1", message: { role: "user", content: "start", timestamp: 1 } },
			}),
		);

		component.handleInput({ type: "text", text: "correct course" }, context);
		component.handleInput(key("enter"), context);
		component.handleInput({ type: "text", text: "afterwards" }, context);
		component.handleInput(key("enter", { alt: true }), context);

		await vi.waitFor(() => expect(onSteer).toHaveBeenCalledWith("correct course", []));
		expect(onFollowUp).toHaveBeenCalledWith("afterwards", []);
		const plain = stripAnsi(component.render({ width: 50, height: 16, now: 0 }).join("\n"));
		expect(plain).toContain("Steering queued");
		expect(plain).toContain("Follow-up queued");
		expect(component.render({ width: 50, height: 16, now: 0 }).at(-3)).toBe("");
	});

	it("marks unconsumed Follow-ups paused when the current Run is aborted", async () => {
		const onResumeFollowUps = vi.fn();
		const component = createComponent({
			colorLevel: 0,
			onFollowUp: () => "queue:paused",
			onResumeFollowUps,
		});
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.accept(
			event({
				type: "run_start",
				source: "prompt",
				inputMessage: { id: "user-1", message: { role: "user", content: "start", timestamp: 1 } },
			}),
		);
		component.handleInput({ type: "text", text: "later" }, context);
		component.handleInput(key("enter", { alt: true }), context);
		await vi.waitFor(() =>
			expect(component.render({ width: 50, height: 14, now: 0 }).join("\n")).toContain("Follow-up queued"),
		);

		component.accept(event({ type: "run_end", outcome: "aborted" }));
		expect(stripAnsi(component.render({ width: 50, height: 14, now: 0 }).join("\n"))).toContain("Paused");
		component.handleInput(key("enter"), context);
		expect(onResumeFollowUps).toHaveBeenCalledOnce();
	});

	it("reconciles consumed Steering and Follow-up cards without duplicate User Prompts", async () => {
		const component = createComponent({
			colorLevel: 0,
			onSteer: () => "queue:steer",
			onFollowUp: () => "queue:follow-up",
		});
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.accept(
			event({
				type: "run_start",
				source: "prompt",
				inputMessage: { id: "user-1", message: { role: "user", content: "start", timestamp: 1 } },
			}),
		);
		component.handleInput({ type: "text", text: "correct course" }, context);
		component.handleInput(key("enter"), context);
		component.handleInput({ type: "text", text: "afterwards" }, context);
		component.handleInput(key("enter", { alt: true }), context);
		await vi.waitFor(() =>
			expect(component.render({ width: 60, height: 20, now: 0 }).join("\n")).toContain("Follow-up queued"),
		);

		component.accept(
			event({
				type: "turn_start",
				turnId: "turn-2",
				steeringMessages: [
					{ id: "user-steer", message: { role: "user", content: "correct course", timestamp: 2 } },
				],
			}),
		);
		component.accept(
			event({
				type: "run_start",
				source: "follow_up",
				queueItemId: "queue:follow-up",
				inputMessage: { id: "user-follow", message: { role: "user", content: "afterwards", timestamp: 3 } },
			}),
		);

		const plain = stripAnsi(component.render({ width: 60, height: 20, now: 0 }).join("\n"));
		expect(plain.match(/correct course/g)).toHaveLength(1);
		expect(plain.match(/afterwards/g)).toHaveLength(1);
		expect(plain).not.toContain("Steering queued");
		expect(plain).not.toContain("Follow-up queued");
	});

	it("renders restored paused Follow-ups, resumes them on empty Enter, and reclaims the newest with Alt+Up", async () => {
		const onResumeFollowUps = vi.fn();
		const onReclaimFollowUp = vi.fn(async () => undefined);
		const queueId = "queue:paused";
		const component = createComponent({
			colorLevel: 0,
			seed: {
				version: 1,
				messages: [],
				pendingFollowUps: [{ id: queueId as never, content: "continue later" }],
			},
			recoverableFollowUps: [{ item: { id: queueId as never, content: "continue later" }, state: "paused" }],
			restoredAttachments: new Map([[queueId, [attachment("attachment:restored", "restored.png")]]]),
			onResumeFollowUps,
			onReclaimFollowUp,
		});
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };

		let plain = stripAnsi(component.render({ width: 50, height: 16, now: 0 }).join("\n"));
		expect(plain).toContain("[restored.png]\ncontinue later");
		expect(plain).toContain("Paused");

		component.handleInput(key("enter"), context);
		expect(onResumeFollowUps).toHaveBeenCalledOnce();

		component.handleInput(key("up", { alt: true }), context);
		await vi.waitFor(() => expect(onReclaimFollowUp).toHaveBeenCalledWith(queueId));
		plain = stripAnsi(component.render({ width: 50, height: 16, now: 0 }).join("\n"));
		expect(plain).not.toContain("Paused");
		expect(plain).toContain("continue later");
		expect(plain.match(/\[restored\.png\]/g)).toHaveLength(1);
	});

	it("annotates a failed restored Follow-up on its original User card and reclaims it for editing", async () => {
		const onReclaimFollowUp = vi.fn(async () => undefined);
		const queueId = "queue:failed";
		const component = createComponent({
			colorLevel: 0,
			seed: {
				version: 1,
				messages: [
					{
						id: "message:failed" as never,
						message: { role: "user", content: "repair me", timestamp: 1 },
					},
				],
				pendingFollowUps: [],
			},
			recoverableFollowUps: [
				{
					item: { id: queueId as never, content: "repair me" },
					state: "failed",
					failure: { kind: "runtime", message: "context too large" },
					messageId: "message:failed" as never,
				},
			],
			onReclaimFollowUp,
		});
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };

		let plain = stripAnsi(component.render({ width: 50, height: 14, now: 0 }).join("\n"));
		expect(plain).toContain("Failed: context too large");

		component.handleInput(key("up", { alt: true }), context);
		await vi.waitFor(() => expect(onReclaimFollowUp).toHaveBeenCalledWith(queueId));
		plain = stripAnsi(component.render({ width: 50, height: 14, now: 0 }).join("\n"));
		expect(plain).not.toContain("Failed:");
		expect(plain.match(/repair me/g)).toHaveLength(2);
	});

	it("distinguishes Thinking by muted color or a NO_COLOR marker", () => {
		const colored = createComponent({ colorLevel: 1 });
		colored.accept(
			assistantContentEvent(1, [
				{ type: "thinking", thinking: "considering" },
				{ type: "text", text: "answer" },
			]),
		);
		const coloredFrame = colored.render({ width: 60, height: 10, now: 0 }).join("\n");
		expect(coloredFrame).toContain("\x1b[2m");
		expect(stripAnsi(coloredFrame)).toContain("considering");

		const noColor = createComponent({ colorLevel: 0 });
		noColor.accept(assistantContentEvent(1, [{ type: "thinking", thinking: "considering" }]));
		const plainFrame = noColor.render({ width: 60, height: 10, now: 0 }).join("\n");
		expect(plainFrame).toContain("Thinking");
		expect(plainFrame).not.toContain("\x1b[");
	});

	it("keeps Thinking muted across Markdown inline styles", () => {
		const component = createComponent({ colorLevel: 1 });
		const thinking = [
			"plain thinking",
			"",
			"1. **Identity:** rest",
			"",
			"- `@coda/ai` — layer",
			"",
			"**outer *inner* outer-tail** final-tail",
			"",
			`**${"wrap ".repeat(8)}wrapped-strong** after-wrap`,
		].join("\n");
		const expectations = [
			{ needle: "plain thinking", state: { muted: true, bold: false } },
			{ needle: "Identity:", state: { muted: true, bold: true } },
			{ needle: "rest", state: { muted: true, bold: false } },
			{ needle: "@coda/ai", state: { muted: true, foreground: 36 } },
			{ needle: "layer", state: { muted: true, foreground: undefined } },
			{ needle: "inner", state: { muted: true, bold: true, italic: true } },
			{ needle: "outer-tail", state: { muted: true, bold: true, italic: false } },
			{ needle: "final-tail", state: { muted: true, bold: false } },
			{ needle: "wrapped-strong", state: { muted: true, bold: true } },
			{ needle: "after-wrap", state: { muted: true, bold: false } },
		] as const;

		const expectThinkingStyles = (phase: "streaming" | "complete") => {
			const lines = component.render({ width: 40, height: 30, now: 0 });
			for (const { needle, state } of expectations) {
				const line = lines.find((candidate) => stripAnsi(candidate).includes(needle));
				if (!line) throw new Error(`Missing ${phase} Thinking text: ${needle}`);
				expect(sgrStateAt(line, needle)).toMatchObject(state);
			}
		};

		component.accept(thinkingDeltaEvent(1, thinking));
		expectThinkingStyles("streaming");
		component.accept(assistantContentEvent(1, [{ type: "thinking", thinking }]));
		expectThinkingStyles("complete");
	});

	it("requests one capability-aware animation interval only for active Tools", () => {
		const full = createComponent({ colorLevel: 3, motion: "full" });
		full.accept(toolStartEvent(1));
		expect(full.animationInterval({ width: 80, height: 24, now: 0 })).toBe(80);
		expect(full.animationInterval({ width: 30, height: 5, now: 0 })).toBeUndefined();

		const reduced = createComponent({ colorLevel: 3, motion: "reduced" });
		reduced.accept(toolStartEvent(1));
		expect(reduced.animationInterval({ width: 80, height: 24, now: 0 })).toBeUndefined();
	});

	it("stages /attach paths as filename chips and submits their stable identities", async () => {
		const onSubmit = vi.fn(async () => undefined);
		const onAttach = vi.fn(async () => attachment("attachment:one", "photo.png"));
		const component = createComponent({ onAttach, onSubmit });
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };

		component.handleInput({ type: "text", text: "/attach /tmp/photo.png" }, context);
		component.handleInput(key("enter"), context);
		await vi.waitFor(() => expect(onAttach).toHaveBeenCalledWith("/tmp/photo.png"));
		await vi.waitFor(() =>
			expect(component.render({ width: 80, height: 12, now: 0 }).join("\n")).toContain("[photo.png]"),
		);

		component.handleInput({ type: "text", text: "describe this" }, context);
		component.handleInput(key("enter"), context);
		await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith("describe this", ["attachment:one"]));
		await vi.waitFor(() => {
			const frame = component.render({ width: 80, height: 12, now: 0 }).join("\n");
			expect(frame.match(/\[photo\.png\]/g)).toHaveLength(1);
			expect(frame).toContain("[photo.png]\ndescribe this");
		});
	});

	it("wraps composer attachments to two rows and reports hidden overflow", async () => {
		let attached = 0;
		const component = createComponent({
			onAttach: async () => attachment(`attachment:${++attached}`, `long-photo-${attached}.png`),
		});
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		for (let index = 0; index < 6; index++) {
			component.handleInput({ type: "text", text: `/attach /tmp/${index}.png` }, context);
			component.handleInput(key("enter"), context);
			await vi.waitFor(() => expect(attached).toBe(index + 1));
		}

		const plain = stripAnsi(component.render({ width: 40, height: 14, now: 0 }).join("\n"));
		expect(plain).toContain("… +3");
		expect(plain.split("\n").filter((line) => line.includes("long-photo-") || line.includes("… +"))).toHaveLength(2);
	});

	it("retains text and attachments when submission is rejected", async () => {
		const onSubmit = vi.fn(async () => {
			throw new Error("Selected Model does not support image input");
		});
		const component = createComponent({
			onAttach: async () => attachment("attachment:one", "photo.png"),
			onSubmit,
		});
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.handleInput({ type: "text", text: "/attach /tmp/photo.png" }, context);
		component.handleInput(key("enter"), context);
		await vi.waitFor(() =>
			expect(component.render({ width: 80, height: 12, now: 0 }).join("\n")).toContain("[photo.png]"),
		);

		component.handleInput({ type: "text", text: "describe this" }, context);
		component.handleInput(key("enter"), context);
		await vi.waitFor(() => {
			const frame = component.render({ width: 80, height: 12, now: 0 }).join("\n");
			expect(frame).toContain("[photo.png]");
			expect(frame).toContain("describe this");
			expect(frame).toContain("does not support image input");
		});
	});

	it("provides keyboard attachment focus, modal preview, and detach", async () => {
		const onDetach = vi.fn(async () => undefined);
		const component = createComponent({
			onAttach: async () => attachment("attachment:one", "photo.png"),
			onDetach,
			imagePreviewSupported: true,
		});
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.handleInput({ type: "text", text: "/attach /tmp/photo.png" }, context);
		component.handleInput(key("enter"), context);
		await vi.waitFor(() =>
			expect(component.render({ width: 80, height: 20, now: 0 }).join("\n")).toContain("[photo.png]"),
		);

		component.handleInput(key("tab"), context);
		let frame = component.render({ width: 80, height: 20, now: 0 }).join("\n");
		expect(frame).toContain("photo.png");
		expect(frame).toContain("32×24");
		expect(component.imagePlacements({ width: 80, height: 20, now: 0 })).toHaveLength(1);

		component.handleInput(key("enter"), context);
		frame = component.render({ width: 80, height: 20, now: 0 }).join("\n");
		expect(frame).toContain("Image preview");

		component.handleInput(key("q"), context);
		component.handleInput(key("delete"), context);
		await vi.waitFor(() => expect(onDetach).toHaveBeenCalledWith("attachment:one"));
		await vi.waitFor(() =>
			expect(component.render({ width: 80, height: 20, now: 0 }).join("\n")).not.toContain("[photo.png]"),
		);
	});

	it("limits mouse hover and click handling to attachment label hit regions", async () => {
		const onOpenAttachment = vi.fn(async () => undefined);
		const component = createComponent({
			onAttach: async () => attachment("attachment:one", "photo.png"),
			onOpenAttachment,
			imagePreviewSupported: false,
		});
		const context: ComponentInputContext = { requestImmediateRender: vi.fn() };
		component.handleInput({ type: "text", text: "/attach /tmp/photo.png" }, context);
		component.handleInput(key("enter"), context);
		await vi.waitFor(() =>
			expect(component.render({ width: 80, height: 20, now: 0 }).join("\n")).toContain("[photo.png]"),
		);

		component.handleInput(mouse("move", 2, 15), context);
		expect(component.render({ width: 80, height: 20, now: 0 }).join("\n")).toContain("32×24");
		component.handleInput(mouse("release", 2, 15, "left"), context);
		await vi.waitFor(() => expect(onOpenAttachment).toHaveBeenCalledWith("attachment:one"));

		component.handleInput(mouse("move", 40, 1), context);
		expect(component.render({ width: 80, height: 20, now: 0 }).join("\n")).not.toContain("32×24");
	});
});

function createComponent(overrides: Partial<ConstructorParameters<typeof ChatComponent>[0]> = {}): ChatComponent {
	return new ChatComponent({
		modelLabel: "provider/model",
		reasoning: "off",
		onSubmit: vi.fn(),
		onAbort: vi.fn(),
		onExit: vi.fn(),
		...overrides,
	});
}

function assistantEvent(sequence: number, text: string): AgentEvent {
	return assistantContentEvent(sequence, [{ type: "text", text }]);
}

function assistantContentEvent(sequence: number, content: unknown[]): AgentEvent {
	return event({
		type: "message_end",
		turnId: "turn",
		attemptId: `attempt-${sequence}`,
		message: {
			id: `message-${sequence}`,
			message: { role: "assistant", content },
		},
		sequence,
	});
}

function thinkingDeltaEvent(sequence: number, thinking: string): AgentEvent {
	return event({
		type: "message_update",
		turnId: "turn",
		attemptId: `attempt-${sequence}`,
		messageId: `message-${sequence}`,
		delta: { type: "thinking_delta", contentIndex: 0, delta: thinking },
		sequence,
	});
}

interface SgrState {
	bold: boolean;
	muted: boolean;
	italic: boolean;
	strikethrough: boolean;
	foreground?: number;
}

function sgrStateAt(line: string, needle: string): SgrState {
	const offset = line.indexOf(needle);
	if (offset < 0) throw new Error(`Missing terminal text: ${needle}`);
	const state: SgrState = { bold: false, muted: false, italic: false, strikethrough: false };
	// biome-ignore lint/complexity/useRegexLiterals: a literal is rejected because it contains the ESC control character.
	const sgr = new RegExp("\\x1b\\[([0-9;]*)m", "g");
	for (const match of line.slice(0, offset).matchAll(sgr)) {
		const codes = (match[1] || "0").split(";").map(Number);
		for (const code of codes) {
			if (code === 0) {
				state.bold = false;
				state.muted = false;
				state.italic = false;
				state.strikethrough = false;
				state.foreground = undefined;
			} else if (code === 1) state.bold = true;
			else if (code === 2) state.muted = true;
			else if (code === 3) state.italic = true;
			else if (code === 9) state.strikethrough = true;
			else if (code === 22) {
				state.bold = false;
				state.muted = false;
			} else if (code === 23) state.italic = false;
			else if (code === 29) state.strikethrough = false;
			else if (code === 39) state.foreground = undefined;
			else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.foreground = code;
		}
	}
	return state;
}

function toolStartEvent(sequence: number): AgentEvent {
	return event({
		type: "tool_execution_start",
		turnId: "turn",
		sequence,
		invocation: {
			id: "tool-1",
			resultMessageId: "result-1",
			providerToolCallId: "provider-1",
			toolName: "bash",
			arguments: { command: "sleep 1" },
			sourceIndex: 0,
		},
	});
}

function event(payload: Record<string, unknown>): AgentEvent {
	return { runId: "run", sequence: 1, timestamp: 1, ...payload } as unknown as AgentEvent;
}

function key(keyName: KeyInput["key"], overrides: Partial<KeyInput> = {}): KeyInput {
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

function attachment(id: string, filename: string) {
	return {
		id,
		filename,
		mimeType: "image/png",
		width: 32,
		height: 24,
		bytes: 128,
		preview: {
			png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
			generation: "digest",
			width: 32,
			height: 24,
		},
	};
}

function shellSnapshot(overrides: {
	readonly status: UserShellStatus;
	readonly output: string;
	readonly durationMs?: number;
}): UserShellSnapshot {
	return {
		id: "user_shell:live",
		command: "printf hello",
		cwd: "/workspace",
		startedAt: 0,
		truncated: false,
		omittedBytes: 0,
		omittedLines: 0,
		...overrides,
	};
}

function mouse(action: "move" | "press" | "release", column: number, row: number, button: MouseButton = "none") {
	return {
		type: "mouse" as const,
		action,
		button,
		column,
		row,
		shift: false,
		control: false,
		alt: false,
	};
}
