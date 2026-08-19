import { parentPort, workerData } from "node:worker_threads";
import { convertFetchedContent, parseDuckDuckGoHtml, type WebWorkerTask } from "./runtime.ts";

if (!parentPort) throw new Error("fetch conversion Worker requires a parent port");

try {
	const task = workerData as WebWorkerTask;
	const result =
		task.kind === "fetch-conversion"
			? await convertFetchedContent(task.input, new AbortController().signal)
			: await parseDuckDuckGoHtml(task.html, task.pageUrl, task.maxResults);
	parentPort.postMessage({ ok: true, result });
} catch (error) {
	parentPort.postMessage({
		ok: false,
		error: {
			name: error instanceof Error ? error.name : "Error",
			message: error instanceof Error ? error.message : String(error),
		},
	});
} finally {
	parentPort.close();
}
