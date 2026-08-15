import type { AgentInput, Clock } from "@coda/agent";
import {
	CodingCompletionController,
	type CompletionWorkspaceEvidenceProvider,
	createGitWorkspaceEvidenceProvider,
} from "../completion/index.ts";
import type { ApplicationIO } from "../host/application-io.ts";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { MediaLibrary } from "../media/media-library.ts";
import type { AgentRunControlBinding } from "../run-control/index.ts";
import { withRunControlEvidence } from "../run-evidence/run-evidence.ts";
import type { SessionWorkController } from "../runtime/session-work-controller.ts";
import type { Session } from "../session/types.ts";
import type { AttachmentTransaction } from "../ui/input-controller.ts";
import { finalText } from "./argument-parsing.ts";
import { type JsonEventStreamMode, JsonEventWriter } from "./json-event-writer.ts";
import { projectJsonMedia } from "./media-attachments.ts";

export interface PrintRunOptions {
	readonly work: SessionWorkController;
	readonly session: Session;
	readonly input: AgentInput;
	readonly attachmentIds: readonly string[];
	readonly prepareAttachments: (attachmentIds: readonly string[]) => Promise<AttachmentTransaction>;
	readonly mediaLibrary: MediaLibrary;
	readonly output: "json" | "text";
	readonly jsonEventStream: JsonEventStreamMode;
	readonly includeMediaData: boolean;
	readonly io: Pick<ApplicationIO, "stdout" | "stderr">;
	readonly processRunner: ProcessRunner;
	readonly fileSystem: FileSystem;
	readonly workspace: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly clock: Clock;
	readonly completionWorkspaceEvidence?: CompletionWorkspaceEvidenceProvider;
	readonly runControl?: AgentRunControlBinding;
	readonly drainWorkspaceDiffSupplements: (session: Session) => Promise<void>;
}

export async function runPrint(options: PrintRunOptions): Promise<number> {
	const completion = createCompletionController(options);
	options.work.subscribeControl((event) => completion.accept(event));
	const json = createJsonEventWriter(options);
	if (json) subscribeJsonOutput(options, completion, json);

	const initialMedia = await options.prepareAttachments(options.attachmentIds);
	let initialMediaCommitted = false;
	const detachInitialMediaCommit = options.work.subscribe({
		accept: async (event) => {
			if (event.type !== "run_start" || event.source !== "prompt" || initialMediaCommitted) return;
			await initialMedia.commit();
			initialMediaCommitted = true;
		},
		resynchronize: async ({ state }) => {
			if (!initialMediaCommitted && state.activeRun?.source === "prompt") {
				await initialMedia.commit();
				initialMediaCommitted = true;
			}
		},
	});
	let result: Awaited<ReturnType<SessionWorkController["prompt"]>>;
	try {
		result = await options.work.prompt(options.input, options.attachmentIds);
	} finally {
		detachInitialMediaCommit();
		if (!initialMediaCommitted) await initialMedia.rollback();
	}
	if (result.state !== "succeeded" || result.run?.outcome !== "success") {
		const detail =
			result.run?.failure?.message ?? result.diagnostics.at(-1)?.message ?? `Work ended in state ${result.state}`;
		await options.io.stderr.write(`coda: ${detail}\n`);
		return 1;
	}
	const committed = [...options.work.state().messages]
		.reverse()
		.find(({ message }) => message.role === "assistant")?.message;
	if (!committed || committed.role !== "assistant") throw new Error("Final Assistant Message is missing");
	if (options.output === "text") await options.io.stdout.write(`${finalText(committed)}\n`);
	const disposition = completion.get(result.run.runId);
	if (!disposition) {
		throw new Error(`Completion disposition was unavailable after completed Run ${result.run.runId}`);
	}
	if (disposition.disposition !== "verified") {
		if (options.output === "text") {
			await options.io.stderr.write(
				`coda: completion ${disposition.disposition} (${disposition.reasons.join(", ")})\n`,
			);
		}
		return 1;
	}
	return 0;
}

function createCompletionController(options: PrintRunOptions): CodingCompletionController {
	return new CodingCompletionController({
		workspaceEvidence:
			options.completionWorkspaceEvidence ??
			createGitWorkspaceEvidenceProvider({
				processRunner: options.processRunner,
				fileSystem: options.fileSystem,
				workspace: () => options.work.state().activePlacement?.root ?? options.workspace,
				environment: options.environment,
				now: () => options.clock.now(),
			}),
		steer: (message) => options.work.deliver("steering", message),
	});
}

function createJsonEventWriter(options: PrintRunOptions): JsonEventWriter | undefined {
	return options.output === "json"
		? new JsonEventWriter({
				mode: options.jsonEventStream,
				output: options.io.stdout,
				project: (value) => projectJsonMedia(value, options.mediaLibrary, options.includeMediaData),
			})
		: undefined;
}

function subscribeJsonOutput(
	options: PrintRunOptions,
	completion: CodingCompletionController,
	json: JsonEventWriter,
): void {
	options.work.subscribe({
		accept: async (event) => {
			const runControl =
				event.type === "run_start" || event.type === "run_end"
					? options.runControl?.reportForRun(String(event.runId))
					: undefined;
			await json.writeAgentEvent(
				event,
				event.type === "run_start"
					? (() => {
							const prepared = options.work.metadataForRun(String(event.runId));
							if (!prepared) throw new Error(`Prepared Run ${event.runId} is unavailable`);
							return prepared;
						})()
					: undefined,
				options.runControl ? { schemaVersion: 3, ...(runControl ? { runControl } : {}) } : undefined,
			);
		},
		resynchronize: ({ reason, state, seed, toolInvocations }) =>
			json.writeRecord({
				schemaVersion: 2,
				type: "resync_required",
				reason,
				status: state.status,
				sessionId: options.work.sessionId,
				seed,
				toolInvocations,
			}),
	});
	options.work.subscribeResult(async (result) => {
		const runId = result.run?.runId;
		if (!runId) return;
		await options.drainWorkspaceDiffSupplements(options.session);
		const evidence = options.session.runEvidence.at(-1);
		if (!evidence || evidence.runId !== runId) {
			throw new Error(`Run evidence was unavailable after completed Run ${runId}`);
		}
		const runControl = options.runControl?.reportForRun(runId);
		const outputEvidence = runControl ? withRunControlEvidence(evidence, runControl) : evidence;
		await json.writeRecord(outputEvidence);
		const disposition = completion.get(runId);
		if (!disposition) {
			throw new Error(`Completion disposition was unavailable after completed Run ${runId}`);
		}
		await json.writeRecord(disposition);
	});
}
