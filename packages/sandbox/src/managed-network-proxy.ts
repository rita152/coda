import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as connectTcp, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ManagedNetworkProtocol = "http" | "https";

export interface ManagedNetworkDestination {
	readonly environmentId: string;
	readonly host: string;
	readonly protocol: ManagedNetworkProtocol;
	readonly port: number;
	readonly method?: string;
}

export type ManagedNetworkDecision =
	| { readonly action: "allow"; readonly source: string }
	| { readonly action: "deny"; readonly source: string; readonly reason: string };

export interface ManagedNetworkPolicy {
	readonly environmentId: string;
	readonly decide: (
		destination: ManagedNetworkDestination,
	) => ManagedNetworkDecision | Promise<ManagedNetworkDecision>;
}

export interface NetworkSandboxViolation extends ManagedNetworkDestination {
	readonly kind: "network";
	readonly backend: "managed-network-proxy";
	readonly decision: "deny";
	readonly source: string;
	readonly reason: string;
	readonly timestamp: number;
}

export interface ManagedProxyRuntime {
	readonly port?: number;
	readonly socketPath?: string;
	readonly environment: Readonly<Record<string, string>>;
	close(): Promise<void>;
}

export interface ManagedProxyOptions {
	readonly transport?: "tcp" | "unix";
	readonly bridgePort?: number;
}

/** Codex-compatible normalization for exact host policy keys. */
export function normalizeNetworkHost(input: string): string {
	let host = input.trim();
	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		if (end >= 0) {
			const suffix = host.slice(end + 1);
			if (suffix === "" || /^:\d+$/u.test(suffix)) host = host.slice(1, end);
		}
	}
	if ([...host].filter((character) => character === ":").length === 1) {
		const separator = host.lastIndexOf(":");
		const candidate = host.slice(0, separator);
		const port = host.slice(separator + 1);
		if (candidate && /^\d+$/u.test(port)) host = candidate;
	}
	return host.toLowerCase().replace(/\.+$/u, "");
}

function portFor(url: URL): number {
	if (url.port !== "") return Number.parseInt(url.port, 10);
	return url.protocol === "https:" ? 443 : 80;
}

function destinationFor(policy: ManagedNetworkPolicy, url: URL, method?: string): ManagedNetworkDestination {
	return Object.freeze({
		environmentId: policy.environmentId,
		host: normalizeNetworkHost(url.hostname),
		protocol: url.protocol === "https:" ? "https" : "http",
		port: portFor(url),
		method,
	});
}

function blockedViolation(
	destination: ManagedNetworkDestination,
	decision: Extract<ManagedNetworkDecision, { action: "deny" }>,
): NetworkSandboxViolation {
	return Object.freeze({
		kind: "network",
		backend: "managed-network-proxy",
		...destination,
		decision: "deny",
		source: decision.source,
		reason: decision.reason,
		timestamp: Date.now(),
	});
}

function proxyEnvironment(port: number): Readonly<Record<string, string>> {
	const endpoint = `http://127.0.0.1:${port}`;
	return Object.freeze({
		HTTP_PROXY: endpoint,
		HTTPS_PROXY: endpoint,
		ALL_PROXY: endpoint,
		http_proxy: endpoint,
		https_proxy: endpoint,
		all_proxy: endpoint,
		NPM_CONFIG_PROXY: endpoint,
		NPM_CONFIG_HTTP_PROXY: endpoint,
		NPM_CONFIG_HTTPS_PROXY: endpoint,
		NO_PROXY: "",
		no_proxy: "",
	});
}

export async function startManagedNetworkProxy(
	policy: ManagedNetworkPolicy,
	onBlocked: (violation: NetworkSandboxViolation) => void,
	options: ManagedProxyOptions = {},
): Promise<ManagedProxyRuntime> {
	const sockets = new Set<Socket>();
	const server = createHttpServer(async (incoming, response) => {
		try {
			const target = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "invalid"}`);
			if (target.protocol !== "http:" && target.protocol !== "https:") {
				response.writeHead(400).end("Unsupported proxy protocol");
				return;
			}
			const destination = destinationFor(policy, target, incoming.method);
			const decision = await policy.decide(destination);
			if (decision.action === "deny") {
				onBlocked(blockedViolation(destination, decision));
				response.writeHead(403, { "content-type": "text/plain", connection: "close" });
				response.end(`Coda managed network denied ${destination.host}`);
				return;
			}

			const headers = { ...incoming.headers };
			delete headers["proxy-authorization"];
			delete headers["proxy-connection"];
			headers.host = target.host;
			headers.connection = "close";
			const outgoing = (target.protocol === "https:" ? httpsRequest : httpRequest)({
				hostname: target.hostname,
				port: portFor(target),
				method: incoming.method,
				path: `${target.pathname}${target.search}`,
				headers,
				agent: false,
			});
			outgoing.on("response", (upstream) => {
				response.writeHead(upstream.statusCode ?? 502, upstream.headers);
				upstream.pipe(response);
			});
			outgoing.on("error", (error) => {
				if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
				response.end(`Managed proxy upstream error: ${error.message}`);
			});
			incoming.pipe(outgoing);
		} catch (error) {
			response.writeHead(400, { "content-type": "text/plain", connection: "close" });
			response.end(`Invalid proxy request: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.on("connect", async (incoming, client, head) => {
		try {
			const target = new URL(`https://${incoming.url ?? ""}`);
			const destination = destinationFor(policy, target, "CONNECT");
			const decision = await policy.decide(destination);
			if (decision.action === "deny") {
				onBlocked(blockedViolation(destination, decision));
				client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				return;
			}
			const upstream = connectTcp(destination.port, destination.host);
			sockets.add(upstream);
			upstream.once("close", () => sockets.delete(upstream));
			upstream.once("connect", () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length > 0) upstream.write(head);
				client.pipe(upstream);
				upstream.pipe(client);
			});
			upstream.once("error", () => client.destroy());
		} catch {
			client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
		}
	});

	const transport = options.transport ?? "tcp";
	const socketDirectory = transport === "unix" ? await mkdtemp(join(tmpdir(), "coda-managed-proxy-")) : undefined;
	const socketPath = socketDirectory ? join(socketDirectory, "proxy.sock") : undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			const listening = () => {
				server.removeListener("error", reject);
				resolve();
			};
			if (socketPath) server.listen(socketPath, listening);
			else server.listen(0, "127.0.0.1", listening);
		});
	} catch (error) {
		server.close();
		if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
		throw error;
	}
	const address = server.address();
	if (!address || (transport === "tcp" && typeof address === "string")) {
		server.close();
		if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
		throw new Error("Managed proxy did not bind a TCP port");
	}
	const port = typeof address === "string" ? undefined : address.port;
	const environmentPort = transport === "unix" ? options.bridgePort : port;
	if (environmentPort === undefined) throw new Error("Managed proxy bridge port is unavailable");
	return Object.freeze({
		port,
		socketPath,
		environment: proxyEnvironment(environmentPort),
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
			if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
		},
	});
}
