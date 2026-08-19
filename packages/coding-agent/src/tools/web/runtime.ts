import { BlockList, isIP } from "node:net";
import { Worker } from "node:worker_threads";
import type { DiagnosticSink } from "@coda/tui";
import type { SettingsStore, WebSearchProviderId } from "../../settings/types.ts";

export interface WebSearchSource {
	readonly title: string;
	readonly url: string;
	readonly summary?: string;
}

export interface WebSearchResponse {
	readonly provider: WebSearchProviderId;
	readonly answer?: string;
	readonly sources: readonly WebSearchSource[];
	readonly attempts: readonly WebSearchProviderId[];
	readonly cache: "hit" | "miss";
	readonly maxCharacters: number;
}

export interface WebRuntime {
	search(
		input: { readonly query: string; readonly provider?: WebSearchProviderId; readonly maxResults?: number },
		signal: AbortSignal,
	): Promise<WebSearchResponse>;
	fetch(
		input: { readonly url: string; readonly raw?: boolean; readonly maxCharacters?: number },
		signal: AbortSignal,
	): Promise<WebFetchResponse>;
}

export type WebHostnameResolver = (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;

/** Performs one HTTP request using only the addresses vetted for that URL hop. */
export type WebPinnedFetch = (url: string, init: RequestInit, addresses: readonly string[]) => Promise<Response>;

export type WebFetchMethod = "raw" | "html" | "json" | "text" | "feed" | "image" | "document";

export interface WebFetchResponse {
	readonly url: string;
	readonly finalUrl: string;
	readonly contentType: string;
	readonly method: WebFetchMethod;
	readonly content: string;
	readonly bytes: number;
	readonly truncated: boolean;
	readonly limitationReason?: "pagination" | "output-overflow";
	readonly cache: "hit" | "miss";
	readonly transformed?: boolean;
	readonly image?: {
		readonly data: string;
		readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
	};
}

interface ProviderResponse {
	readonly answer?: string;
	readonly sources: readonly WebSearchSource[];
}

interface SearchProvider {
	readonly id: WebSearchProviderId;
	isAvailable(config: SearchConfig): boolean;
	search(input: SearchInput): Promise<ProviderResponse>;
}

interface SearchConfig {
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly searxngEndpoint?: string;
	readonly networkPolicy: OutboundDomainPolicy;
}

interface SearchInput {
	readonly query: string;
	readonly maxResults: number;
	readonly signal: AbortSignal;
	readonly fetch: typeof globalThis.fetch;
	readonly pinnedFetch?: WebPinnedFetch;
	readonly resolveHostname?: WebHostnameResolver;
	readonly config: SearchConfig;
}

type JsonSearchProviderId = Exclude<WebSearchProviderId, "duckduckgo">;

const DEFAULT_PROVIDERS: readonly WebSearchProviderId[] = ["brave", "tavily", "searxng", "duckduckgo"];
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_SEARCH_MAX_CHARACTERS = 20_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_CACHE_MAX_ENTRIES = 128;
const DEFAULT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_FETCH_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_FETCH_MAX_CHARACTERS = 120_000;
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_FIELD_CHARACTERS = 20_000;
const PROVIDER_CANDIDATE_MULTIPLIER = 4;
const MAX_STRUCTURED_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PLAIN_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const NON_PUBLIC_IPV4_ADDRESSES = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	// 198.18.0.0/15 is intentionally omitted. Some system-level transparent
	// proxies use that benchmark range for public-host "fake IP" DNS answers.
	// The injected HTTP adapter remains responsible for connecting through the
	// same system resolver/proxy path after the hostname policy check. Literal
	// URLs in that range are still rejected by the separate list below.
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	NON_PUBLIC_IPV4_ADDRESSES.addSubnet(address, prefix, "ipv4");
}
const LITERAL_ONLY_NON_PUBLIC_IPV4_ADDRESSES = new BlockList();
LITERAL_ONLY_NON_PUBLIC_IPV4_ADDRESSES.addSubnet("198.18.0.0", 15, "ipv4");
const NON_PUBLIC_IPV6_ADDRESSES = new BlockList();
for (const [address, prefix] of [
	["::", 96],
	["::ffff:0:0", 96],
	["2001:db8::", 32],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
	["ff00::", 8],
] as const) {
	NON_PUBLIC_IPV6_ADDRESSES.addSubnet(address, prefix, "ipv6");
}

interface CacheEntry<T> {
	readonly expiresAt: number;
	readonly value: T;
	readonly bytes: number;
}

class BoundedWebCache {
	readonly #entries = new Map<string, CacheEntry<unknown>>();
	#bytes = 0;

	#delete(key: string): void {
		const entry = this.#entries.get(key);
		if (!entry) return;
		this.#entries.delete(key);
		this.#bytes -= entry.bytes;
	}

	get<T>(key: string, now: number): T | undefined {
		const entry = this.#entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= now) {
			this.#delete(key);
			return undefined;
		}
		this.#entries.delete(key);
		this.#entries.set(key, entry);
		return entry.value as T;
	}

	set<T>(key: string, value: T, expiresAt: number, bytes: number, maxEntries: number, maxBytes: number): void {
		this.#delete(key);
		if (bytes > maxBytes) return;
		this.#entries.set(key, { value, expiresAt, bytes });
		this.#bytes += bytes;
		while (this.#entries.size > maxEntries || this.#bytes > maxBytes) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#delete(oldest);
		}
	}
}

class WebSearchError extends Error {
	readonly provider: WebSearchProviderId;
	readonly status?: number;

	constructor(provider: WebSearchProviderId, message: string, status?: number) {
		super(message);
		this.name = "WebSearchError";
		this.provider = provider;
		this.status = status;
	}
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const bounded = value.slice(0, MAX_PROVIDER_FIELD_CHARACTERS).trim();
	return bounded.length > 0 ? bounded : undefined;
}

function sourceText(value: unknown): string | undefined {
	return nonEmptyString(value)
		?.replace(/\p{Cc}+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function normalizedSourceUrl(value: unknown): string | undefined {
	const candidate = nonEmptyString(value);
	if (!candidate) return undefined;
	try {
		const url = new URL(candidate);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(1, Math.trunc(value!)));
}

function timeoutSignal(signal: AbortSignal, timeoutMs: number): { readonly signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const abortFromCaller = () => controller.abort(signal.reason);
	if (signal.aborted) abortFromCaller();
	else signal.addEventListener("abort", abortFromCaller, { once: true });
	const timer = setTimeout(() => {
		controller.abort(new DOMException(`Web request timed out after ${timeoutMs}ms`, "TimeoutError"));
	}, timeoutMs);
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abortFromCaller);
		},
	};
}

function settleWithSignal<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		void Promise.resolve(operation).catch(() => undefined);
		return Promise.reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			callback();
		};
		const abort = (): void =>
			finish(() => reject(signal.reason ?? new DOMException("Operation aborted", "AbortError")));
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve(operation).then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

async function requestJson(
	provider: JsonSearchProviderId,
	input: SearchInput,
	url: string,
	init: RequestInit,
): Promise<ProviderResponse> {
	try {
		const loaded = await fetchWithRedirectPolicy({
			fetch: input.fetch,
			...(input.pinnedFetch ? { pinnedFetch: input.pinnedFetch } : {}),
			url: parseWebUrl(url, input.config.networkPolicy),
			init,
			signal: input.signal,
			policy: input.config.networkPolicy,
			...(input.resolveHostname ? { resolveHostname: input.resolveHostname } : {}),
		});
		const response = loaded.response;
		if (!response.ok) {
			discardResponseBody(response);
			throw new WebSearchError(provider, `${provider} search failed with HTTP ${response.status}`, response.status);
		}
		const body = await settleWithSignal(readBoundedBody(response, MAX_SEARCH_RESPONSE_BYTES), input.signal);
		if (body.truncated) throw new WebSearchError(provider, `${provider} response exceeded the 2 MiB limit`);
		try {
			return await parseProviderSearchJsonInWorker(body.bytes, provider, input.maxResults, input.signal);
		} catch {
			if (input.signal.aborted) throw input.signal.reason;
			throw new WebSearchError(provider, `${provider} returned invalid JSON`);
		}
	} catch (error) {
		if (input.signal.aborted) throw input.signal.reason ?? error;
		throw error;
	}
}

async function requestText(
	provider: WebSearchProviderId,
	input: SearchInput,
	url: string,
	init: RequestInit,
): Promise<string> {
	try {
		const loaded = await fetchWithRedirectPolicy({
			fetch: input.fetch,
			...(input.pinnedFetch ? { pinnedFetch: input.pinnedFetch } : {}),
			url: parseWebUrl(url, input.config.networkPolicy),
			init,
			signal: input.signal,
			policy: input.config.networkPolicy,
			...(input.resolveHostname ? { resolveHostname: input.resolveHostname } : {}),
		});
		const response = loaded.response;
		if (!response.ok) {
			discardResponseBody(response);
			throw new WebSearchError(provider, `${provider} search failed with HTTP ${response.status}`, response.status);
		}
		const body = await settleWithSignal(readBoundedBody(response, MAX_SEARCH_RESPONSE_BYTES), input.signal);
		if (body.truncated) throw new WebSearchError(provider, `${provider} response exceeded the 2 MiB limit`);
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
		} catch {
			throw new WebSearchError(provider, `${provider} returned invalid UTF-8 text`);
		}
	} catch (error) {
		if (input.signal.aborted) throw input.signal.reason ?? error;
		throw error;
	}
}

const braveProvider: SearchProvider = {
	id: "brave",
	isAvailable: ({ environment }) => Boolean(environment.BRAVE_SEARCH_API_KEY ?? environment.BRAVE_API_KEY),
	search: async (input) => {
		const key = input.config.environment.BRAVE_SEARCH_API_KEY ?? input.config.environment.BRAVE_API_KEY;
		if (!key) throw new WebSearchError("brave", "Brave search is not configured");
		const url = new URL("https://api.search.brave.com/res/v1/web/search");
		url.searchParams.set("q", input.query);
		url.searchParams.set("count", String(input.maxResults));
		return await requestJson("brave", input, url.href, {
			headers: { Accept: "application/json", "X-Subscription-Token": key },
		});
	},
};

const tavilyProvider: SearchProvider = {
	id: "tavily",
	isAvailable: ({ environment }) => Boolean(environment.TAVILY_API_KEY),
	search: async (input) => {
		const key = input.config.environment.TAVILY_API_KEY;
		if (!key) throw new WebSearchError("tavily", "Tavily search is not configured");
		return await requestJson("tavily", input, "https://api.tavily.com/search", {
			method: "POST",
			headers: { Accept: "application/json", Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ query: input.query, max_results: input.maxResults, include_answer: true }),
		});
	},
};

const searxngProvider: SearchProvider = {
	id: "searxng",
	isAvailable: ({ searxngEndpoint }) => Boolean(searxngEndpoint),
	search: async (input) => {
		const endpoint = input.config.searxngEndpoint;
		if (!endpoint) throw new WebSearchError("searxng", "SearXNG search is not configured");
		let url: URL;
		try {
			const base = new URL(endpoint);
			url = base.pathname.replace(/\/+$/u, "").endsWith("/search")
				? base
				: new URL("search", `${base.href.replace(/\/+$/u, "")}/`);
		} catch {
			throw new WebSearchError("searxng", "SearXNG endpoint is invalid");
		}
		url.searchParams.set("q", input.query);
		url.searchParams.set("format", "json");
		return await requestJson("searxng", input, url.href, { headers: { Accept: "application/json" } });
	},
};

/** Runs inside the bounded Web Worker; exported only for that Worker entrypoint. */
export async function parseDuckDuckGoHtml(
	html: string,
	pageUrl: string,
	maxResults: number,
): Promise<ProviderResponse> {
	const { JSDOM } = await import("jsdom");
	const document = new JSDOM(html, { url: pageUrl }).window.document;
	const rows = [...document.querySelectorAll(".result")].slice(0, maxResults * PROVIDER_CANDIDATE_MULTIPLIER);
	const sources = rows.flatMap((row): WebSearchSource[] => {
		const link = row.querySelector<HTMLAnchorElement>(".result__a");
		const title = sourceText(link?.textContent);
		const href = link?.getAttribute("href")?.trim();
		if (!title || !href) return [];
		let sourceUrl: string;
		try {
			const redirect = new URL(href, "https://duckduckgo.com");
			sourceUrl = redirect.searchParams.get("uddg") ?? redirect.href;
			const parsed = new URL(sourceUrl);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [];
		} catch {
			return [];
		}
		sourceUrl = normalizedSourceUrl(sourceUrl) ?? "";
		if (!sourceUrl) return [];
		const summary = sourceText(row.querySelector(".result__snippet")?.textContent);
		return [{ title, url: sourceUrl, ...(summary ? { summary } : {}) }];
	});
	return { sources };
}

const duckDuckGoProvider: SearchProvider = {
	id: "duckduckgo",
	isAvailable: () => true,
	search: async (input) => {
		const url = new URL("https://html.duckduckgo.com/html/");
		url.searchParams.set("q", input.query);
		const html = await requestText("duckduckgo", input, url.href, {
			headers: {
				Accept: "text/html,application/xhtml+xml",
				"User-Agent": "Mozilla/5.0 (compatible; Coda/0.1; +https://github.com/)",
			},
		});
		return await parseDuckDuckGoInWorker(html, url.href, input.maxResults, input.signal);
	},
};

const PROVIDERS = new Map<WebSearchProviderId, SearchProvider>(
	[braveProvider, tavilyProvider, searxngProvider, duckDuckGoProvider].map((provider) => [provider.id, provider]),
);

function canonicalSourceKey(value: string): string {
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase().replace(/^www\./u, "");
		const port = url.port ? `:${url.port}` : "";
		const path = url.pathname.replace(/\/+$/u, "") || "/";
		return `${host}${port}${path}${url.search}`;
	} catch {
		return value.trim().toLowerCase();
	}
}

function deduplicateSources(sources: readonly WebSearchSource[], limit: number): readonly WebSearchSource[] {
	const deduplicated = new Map<string, WebSearchSource>();
	for (const source of sources) {
		const key = canonicalSourceKey(source.url);
		const previous = deduplicated.get(key);
		if (!previous) {
			deduplicated.set(key, source);
			continue;
		}
		if ((source.summary?.length ?? 0) > (previous.summary?.length ?? 0)) {
			deduplicated.set(key, { ...previous, summary: source.summary });
		}
	}
	return Object.freeze([...deduplicated.values()].slice(0, limit));
}

interface OutboundDomainPolicy {
	readonly allowedDomains?: readonly string[];
	readonly deniedDomains?: readonly string[];
}

function outboundDomainPolicy(
	sandbox:
		| {
				readonly mode?: "read-only" | "workspace-write" | "danger-full-access";
				readonly enabled?: boolean;
				readonly allowedDomains?: readonly string[];
				readonly deniedDomains?: readonly string[];
		  }
		| undefined,
	effectiveMode?: "read-only" | "workspace-write" | "danger-full-access",
): OutboundDomainPolicy {
	const confinementActive =
		effectiveMode !== undefined
			? effectiveMode !== "danger-full-access"
			: sandbox?.mode
				? sandbox.mode !== "danger-full-access"
				: sandbox?.enabled === true;
	return {
		...(sandbox?.allowedDomains !== undefined
			? { allowedDomains: sandbox.allowedDomains }
			: confinementActive
				? { allowedDomains: [] }
				: {}),
		...(sandbox?.deniedDomains ? { deniedDomains: sandbox.deniedDomains } : {}),
	};
}

function domainPattern(rule: string): { readonly hostname: string; readonly port?: number } {
	const pattern = rule.trim().toLowerCase();
	if (pattern.startsWith("[")) {
		const bracket = pattern.indexOf("]");
		if (bracket < 0) return { hostname: pattern };
		const literal = pattern.slice(1, bracket);
		const hostname = isIP(literal) === 6 ? new URL(`http://[${literal}]/`).hostname.slice(1, -1) : literal;
		const suffix = pattern.slice(bracket + 1);
		if (!suffix) return { hostname };
		const port = /^:([1-9]\d{0,4})$/u.exec(suffix)?.[1];
		return port && Number(port) <= 65_535 ? { hostname, port: Number(port) } : { hostname: pattern };
	}
	const firstColon = pattern.indexOf(":");
	const lastColon = pattern.lastIndexOf(":");
	if (lastColon > 0 && firstColon === lastColon) {
		const port = /^([1-9]\d{0,4})$/u.exec(pattern.slice(lastColon + 1))?.[1];
		if (port && Number(port) <= 65_535) return { hostname: pattern.slice(0, lastColon), port: Number(port) };
	}
	return { hostname: pattern.replace(/\.$/u, "") };
}

function domainMatches(url: URL, rule: string): boolean {
	const hostname = url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/gu, "")
		.replace(/\.$/u, "");
	const pattern = domainPattern(rule);
	const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
	if (pattern.port !== undefined && pattern.port !== port) return false;
	if (pattern.hostname === "*") return true;
	if (pattern.hostname.startsWith("*.")) {
		return isIP(hostname) === 0 && hostname.endsWith(pattern.hostname.slice(1));
	}
	return hostname === pattern.hostname;
}

function privateOrLocalHostname(hostname: string): boolean {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/gu, "")
		.replace(/\.$/u, "");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
	const family = isIP(host);
	return family === 4
		? NON_PUBLIC_IPV4_ADDRESSES.check(host, "ipv4")
		: family === 6
			? NON_PUBLIC_IPV6_ADDRESSES.check(host, "ipv6")
			: false;
}

function privateOrLocalLiteralHostname(hostname: string): boolean {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/gu, "")
		.replace(/\.$/u, "");
	return (
		privateOrLocalHostname(host) || (isIP(host) === 4 && LITERAL_ONLY_NON_PUBLIC_IPV4_ADDRESSES.check(host, "ipv4"))
	);
}

function parseWebUrl(value: string, policy: OutboundDomainPolicy = {}): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("fetch requires a valid absolute URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("fetch supports HTTP and HTTPS URLs only");
	}
	if (url.username || url.password) throw new Error("fetch does not accept URLs with embedded credentials");
	const hostname = url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/gu, "")
		.replace(/\.$/u, "");
	const denied = policy.deniedDomains?.some((rule) => domainMatches(url, rule)) ?? false;
	if (denied) throw new Error(`fetch host ${hostname} is denied by the outbound domain policy`);
	const explicitlyAllowed = policy.allowedDomains?.some((rule) => domainMatches(url, rule)) ?? false;
	if (policy.allowedDomains !== undefined && !explicitlyAllowed) {
		throw new Error(`fetch host ${hostname} is not in sandbox.allowedDomains`);
	}
	if (!explicitlyAllowed && privateOrLocalLiteralHostname(hostname)) {
		throw new Error(`fetch refuses private or local network address ${hostname}`);
	}
	return url;
}

async function validateResolvedDestination(
	url: URL,
	policy: OutboundDomainPolicy,
	resolveHostname: WebHostnameResolver | undefined,
	signal: AbortSignal,
): Promise<readonly string[] | undefined> {
	const hostname = url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/gu, "")
		.replace(/\.$/u, "");
	if (isIP(hostname) !== 0) return Object.freeze([hostname]);
	if (!resolveHostname) return undefined;
	const explicitlyAllowed = policy.allowedDomains?.some((rule) => domainMatches(url, rule)) ?? false;
	let addresses: readonly string[];
	try {
		addresses = await settleWithSignal(resolveHostname(hostname, signal), signal);
	} catch (error) {
		throw new Error(
			`fetch could not resolve host ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (addresses.length === 0) throw new Error(`fetch could not resolve host ${hostname}`);
	const uniqueAddresses = [...new Set(addresses)];
	const invalid = uniqueAddresses.find((address) => isIP(address) === 0);
	if (invalid) throw new Error(`fetch resolver returned invalid address ${invalid} for host ${hostname}`);
	if (!explicitlyAllowed) {
		const blocked = uniqueAddresses.find((address) => privateOrLocalHostname(address));
		if (blocked)
			throw new Error(`fetch refuses ${hostname} because it resolves to private or local address ${blocked}`);
	}
	return Object.freeze(uniqueAddresses);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function discardResponseBody(response: Response): void {
	try {
		void response.body?.cancel("Web response body is not needed").catch(() => undefined);
	} catch {}
}

async function fetchWithRedirectPolicy(input: {
	readonly fetch: typeof globalThis.fetch;
	readonly pinnedFetch?: WebPinnedFetch;
	readonly url: URL;
	readonly init: RequestInit;
	readonly signal: AbortSignal;
	readonly policy: OutboundDomainPolicy;
	readonly resolveHostname?: WebHostnameResolver;
}): Promise<{ readonly response: Response; readonly finalUrl: string }> {
	let current = input.url;
	let requestInit = input.init;
	for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
		const addresses = await validateResolvedDestination(current, input.policy, input.resolveHostname, input.signal);
		const init = { ...requestInit, redirect: "manual" as const, signal: input.signal };
		const response = await settleWithSignal(
			input.pinnedFetch && addresses
				? input.pinnedFetch(current.href, init, addresses)
				: input.fetch(current.href, init),
			input.signal,
		);
		if (response.url) current = parseWebUrl(response.url, input.policy);
		if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current.href };
		const location = response.headers.get("location");
		if (!location) return { response, finalUrl: current.href };
		discardResponseBody(response);
		if (redirectCount === 5) throw new Error("fetch exceeded the 5 redirect limit");
		const redirected = parseWebUrl(new URL(location, current).href, input.policy);
		const headers = new Headers(requestInit.headers);
		if (redirected.origin !== current.origin) {
			for (const name of ["authorization", "proxy-authorization", "cookie", "x-subscription-token"]) {
				headers.delete(name);
			}
		}
		const method = requestInit.method?.toUpperCase() ?? "GET";
		const switchToGet =
			response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST");
		if (switchToGet) {
			headers.delete("content-length");
			headers.delete("content-type");
			requestInit = { ...requestInit, method: "GET", body: null, headers };
		} else {
			requestInit = { ...requestInit, headers };
		}
		current = redirected;
	}
	throw new Error("fetch exceeded the 5 redirect limit");
}

function normalizeContentType(value: string | null): string {
	return value?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function structuredTextContentType(contentType: string): boolean {
	return (
		contentType === "text/html" ||
		contentType === "application/xhtml+xml" ||
		contentType === "application/json" ||
		contentType.endsWith("+json") ||
		contentType.includes("xml") ||
		contentType.includes("rss") ||
		contentType.includes("atom")
	);
}

function responseBodyByteLimit(contentTypeHeader: string | null, configuredLimit: number, raw: boolean): number {
	const contentType = normalizeContentType(contentTypeHeader);
	if (raw && (structuredTextContentType(contentType) || contentType.startsWith("text/"))) {
		return Math.min(configuredLimit, MAX_PLAIN_TEXT_BYTES);
	}
	if (structuredTextContentType(contentType)) return Math.min(configuredLimit, MAX_STRUCTURED_TEXT_BYTES);
	if (contentType.startsWith("text/")) return Math.min(configuredLimit, MAX_PLAIN_TEXT_BYTES);
	return configuredLimit;
}

function contentDispositionFilename(value: string | null): string | undefined {
	if (!value) return undefined;
	const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/iu.exec(value)?.[1];
	if (encoded) {
		try {
			return decodeURIComponent(encoded.trim().replace(/^"|"$/gu, ""));
		} catch {}
	}
	return /filename\s*=\s*"([^"]+)"/iu.exec(value)?.[1] ?? /filename\s*=\s*([^;\s]+)/iu.exec(value)?.[1];
}

function sniffedContentType(declared: string, bytes: Uint8Array, fileHint: string): string {
	if (declared !== "application/octet-stream" && declared !== "binary/octet-stream") return declared;
	if (
		bytes.length >= 8 &&
		bytes.subarray(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])
	) {
		return "image/png";
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	const prefix = new TextDecoder("ascii").decode(bytes.subarray(0, 12));
	if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "image/gif";
	if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") return "image/webp";
	if (prefix.startsWith("%PDF-")) return "application/pdf";
	const hint = fileHint.toLowerCase().split(/[?#]/u, 1)[0] ?? "";
	if (hint.endsWith(".png")) return "image/png";
	if (hint.endsWith(".jpg") || hint.endsWith(".jpeg")) return "image/jpeg";
	if (hint.endsWith(".gif")) return "image/gif";
	if (hint.endsWith(".webp")) return "image/webp";
	if (hint.endsWith(".pdf")) return "application/pdf";
	if (hint.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
	if (hint.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
	if (hint.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
	if (hint.endsWith(".epub")) return "application/epub+zip";
	return declared;
}

function decodeTextBody(bytes: Uint8Array, contentTypeHeader: string | null, truncated: boolean): string {
	const declared = /charset\s*=\s*["']?([^;\s"']+)/iu.exec(contentTypeHeader ?? "")?.[1];
	const byteOrderMark =
		bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
			? "utf-8"
			: bytes[0] === 0xff && bytes[1] === 0xfe
				? "utf-16le"
				: bytes[0] === 0xfe && bytes[1] === 0xff
					? "utf-16be"
					: undefined;
	const htmlPrefix = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 2_048)));
	const meta = /<meta[^>]+charset\s*=\s*["']?([^\s"'/>;]+)/iu.exec(htmlPrefix)?.[1];
	const xml = /<\?xml[^>]+encoding\s*=\s*["']([^"']+)["']/iu.exec(htmlPrefix)?.[1];
	const charset = (declared ?? byteOrderMark ?? xml ?? meta ?? "utf-8").toLowerCase();
	try {
		return new TextDecoder(charset).decode(bytes, { stream: truncated });
	} catch {
		throw new Error(`fetch received an unsupported text charset: ${charset}`);
	}
}

function formatJsonLosslessly(text: string, signal: AbortSignal, maxCharacters: number): string {
	try {
		JSON.parse(text);
	} catch {
		throw new Error("fetch received invalid JSON");
	}
	let formatted = "";
	const limit = maxCharacters + 1;
	const append = (value: string): void => {
		const remaining = limit - formatted.length;
		if (remaining > 0) formatted += value.slice(0, remaining);
	};
	const appendIndent = (depth: number): void => {
		append("\n");
		append("\t".repeat(Math.min(depth, Math.max(0, limit - formatted.length))));
	};
	let depth = 0;
	let inString = false;
	let escaped = false;
	let lastSignificant = "";
	for (let index = 0; index < text.length; index++) {
		if (index % 1_024 === 0) signal.throwIfAborted();
		if (formatted.length >= limit) break;
		const character = text[index]!;
		if (inString) {
			append(character);
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (/\s/u.test(character)) continue;
		if (character === '"') {
			inString = true;
			append(character);
		} else if (character === "{" || character === "[") {
			append(character);
			depth++;
			let next = index + 1;
			while (next < text.length && /\s/u.test(text[next]!)) next++;
			if (text[next] !== (character === "{" ? "}" : "]")) appendIndent(depth);
		} else if (character === "}" || character === "]") {
			depth--;
			if (lastSignificant !== (character === "}" ? "{" : "[")) appendIndent(depth);
			append(character);
		} else if (character === ",") {
			append(",");
			appendIndent(depth);
		} else if (character === ":") {
			append(": ");
		} else {
			append(character);
		}
		lastSignificant = character;
	}
	return formatted;
}

function imageMimeType(format: string | undefined): NonNullable<WebFetchResponse["image"]>["mimeType"] | undefined {
	if (format === "png") return "image/png";
	if (format === "jpeg") return "image/jpeg";
	if (format === "gif") return "image/gif";
	if (format === "webp") return "image/webp";
	return undefined;
}

async function readBoundedBody(
	response: Response,
	maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
	if (!response.body) return { bytes: new Uint8Array(), truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			if (total + next.value.byteLength > maxBytes) {
				const remaining = Math.max(0, maxBytes - total);
				if (remaining > 0) chunks.push(next.value.subarray(0, remaining));
				total += remaining;
				truncated = true;
				await reader.cancel("Web response exceeded the configured byte limit");
				break;
			}
			chunks.push(next.value);
			total += next.value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
}

function absolutizeDocumentLinks(document: Document, baseUrl: string): void {
	for (const element of document.querySelectorAll<HTMLElement>("a[href], img[src]")) {
		const attribute = element.tagName.toLowerCase() === "a" ? "href" : "src";
		const value = element.getAttribute(attribute);
		if (!value) continue;
		try {
			element.setAttribute(attribute, new URL(value, baseUrl).href);
		} catch {}
	}
}

async function htmlToMarkdown(html: string, url: string): Promise<string> {
	const [{ JSDOM }, { Readability }, { default: TurndownService }, { gfm }] = await Promise.all([
		import("jsdom"),
		import("@mozilla/readability"),
		import("turndown"),
		import("turndown-plugin-gfm"),
	]);
	const dom = new JSDOM(html, { url });
	const document = dom.window.document;
	for (const selector of ["script", "style", "noscript", "template", "nav", "footer", "aside", "form", "iframe"]) {
		for (const element of document.querySelectorAll(selector)) element.remove();
	}
	absolutizeDocumentLinks(document, url);
	const article = new Readability(document.cloneNode(true) as Document).parse();
	const fallback = document.querySelector("article, main")?.innerHTML ?? document.body?.innerHTML ?? "";
	const readableHtml = article?.content?.trim() || fallback;
	const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
	turndown.use(gfm);
	let markdown = turndown
		.turndown(readableHtml)
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
	if (article?.title && markdown && !/^#{1,6}\s/u.test(markdown))
		markdown = `# ${article.title.trim()}\n\n${markdown}`;
	return markdown;
}

function firstDirectChild(element: Element, names: readonly string[]): Element | undefined {
	return [...element.children].find((child) => names.includes(child.localName.toLowerCase()));
}

function feedDate(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

async function feedToMarkdown(
	xml: string,
	url: string,
): Promise<{
	readonly content: string;
	readonly truncated: boolean;
	readonly limitationReason?: "pagination" | "output-overflow";
}> {
	const { JSDOM } = await import("jsdom");
	const document = new JSDOM(xml, { contentType: "text/xml", url }).window.document;
	if (document.querySelector("parsererror")) throw new Error("fetch received an invalid Feed");
	const channel = document.querySelector("channel");
	const feed = document.documentElement.localName.toLowerCase() === "feed" ? document.documentElement : null;
	const root = channel ?? feed;
	if (!root) throw new Error("fetch could not find RSS or Atom Feed content");
	const title = firstDirectChild(root, ["title"])?.textContent?.trim() || "Feed";
	const entries = channel ? [...root.querySelectorAll("item")] : [...root.querySelectorAll("entry")];
	const parts = [`# ${title}`];
	let summaryTruncated = false;
	for (const entry of entries.slice(0, 20)) {
		const entryTitle = firstDirectChild(entry, ["title"])?.textContent?.trim() || "Untitled entry";
		const linkElement = firstDirectChild(entry, ["link"]);
		const link = linkElement?.getAttribute("href")?.trim() || linkElement?.textContent?.trim();
		let resolvedLink: string | undefined;
		if (link) {
			try {
				resolvedLink = new URL(link, url).href;
			} catch {}
		}
		parts.push(resolvedLink ? `## [${entryTitle}](${resolvedLink})` : `## ${entryTitle}`);
		const published = feedDate(
			firstDirectChild(entry, ["pubdate", "published", "updated", "date"])?.textContent?.trim(),
		);
		if (published) parts.push(`Published: ${published}`);
		const description = firstDirectChild(entry, [
			"description",
			"summary",
			"content",
			"encoded",
		])?.textContent?.trim();
		if (description) {
			const markdown = await htmlToMarkdown(`<article>${description}</article>`, resolvedLink ?? url);
			if (markdown) {
				summaryTruncated ||= markdown.length > 2_000;
				parts.push(
					markdown.length > 2_000 ? `${markdown.slice(0, 2_000)}\n\n[Feed entry summary truncated]` : markdown,
				);
			}
		}
	}
	const entriesTruncated = entries.length > 20;
	if (entriesTruncated) parts.push(`[Feed entries truncated to the first 20 of ${entries.length}]`);
	return {
		content: parts.join("\n\n"),
		truncated: entriesTruncated || summaryTruncated,
		...(summaryTruncated
			? { limitationReason: "output-overflow" as const }
			: entriesTruncated
				? { limitationReason: "pagination" as const }
				: {}),
	};
}

class MarkdownBudget {
	readonly #chunks: string[] = [];
	readonly #limit: number;
	#characters = 0;

	constructor(limit: number) {
		this.#limit = limit;
	}

	append(value: string, separator = "\n\n"): boolean {
		const candidate = `${this.#chunks.length > 0 ? separator : ""}${value}`;
		const remaining = this.#limit + 1 - this.#characters;
		if (remaining <= 0) return true;
		const bounded = candidate.slice(0, remaining);
		this.#chunks.push(bounded);
		this.#characters += bounded.length;
		return bounded.length < candidate.length || this.#characters > this.#limit;
	}

	toString(): string {
		return this.#chunks.join("");
	}
}

async function pdfToMarkdown(bytes: Uint8Array, signal: AbortSignal, maxCharacters: number): Promise<string> {
	signal.throwIfAborted();
	const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const loading = getDocument({ data: bytes, useSystemFonts: true });
	const document = await loading.promise;
	try {
		signal.throwIfAborted();
		if (document.numPages > 500) throw new Error("PDF exceeds the 500-page extraction limit");
		const pages = new MarkdownBudget(maxCharacters);
		let extracted = false;
		for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
			signal.throwIfAborted();
			const page = await document.getPage(pageNumber);
			const text = await page.getTextContent();
			let content = "";
			for (const item of text.items) {
				if (!("str" in item)) continue;
				content += item.str;
				content += item.hasEOL ? "\n" : " ";
			}
			const normalized = content
				.replace(/[ \t]+\n/gu, "\n")
				.replace(/\n{3,}/gu, "\n\n")
				.trim();
			if (normalized) {
				extracted = true;
				if (pages.append(document.numPages > 1 ? `## Page ${pageNumber}\n\n${normalized}` : normalized)) break;
			}
		}
		if (!extracted) throw new Error("PDF contains no extractable text");
		return pages.toString();
	} finally {
		await loading.destroy();
	}
}

async function docxToMarkdown(
	bytes: Uint8Array,
	url: string,
	signal: AbortSignal,
	maxCharacters: number,
): Promise<string> {
	await preflightArchive(bytes, signal);
	signal.throwIfAborted();
	const mammoth = await import("mammoth");
	const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
	signal.throwIfAborted();
	if (!result.value.trim()) throw new Error("DOCX contains no extractable text");
	return (await htmlToMarkdown(result.value, url)).slice(0, maxCharacters + 1);
}

const MAX_ARCHIVE_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_048;

function archiveEntryFilter(
	extract: boolean,
	signal: AbortSignal,
): (entry: { readonly name: string; readonly originalSize: number }) => boolean {
	let entries = 0;
	let expandedBytes = 0;
	return (entry) => {
		signal.throwIfAborted();
		entries++;
		expandedBytes += entry.originalSize;
		if (entries > MAX_ARCHIVE_ENTRIES) {
			throw new Error(`Document archive exceeds the ${MAX_ARCHIVE_ENTRIES}-entry limit`);
		}
		if (expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
			throw new Error("Document archive exceeds the 50 MiB expanded-size limit");
		}
		if (entry.name.length > 4_096) throw new Error("Document archive contains an overlong entry path");
		return extract;
	};
}

function rethrowArchiveError(error: unknown): never {
	if (error instanceof Error && error.message.startsWith("Document archive")) throw error;
	throw new Error("Document ZIP payload is invalid");
}

async function preflightArchive(bytes: Uint8Array, signal: AbortSignal): Promise<void> {
	const { unzipSync } = await import("fflate");
	try {
		unzipSync(bytes, { filter: archiveEntryFilter(false, signal) });
	} catch (error) {
		if (signal.aborted) throw signal.reason ?? error;
		rethrowArchiveError(error);
	}
}

async function unzipDocument(bytes: Uint8Array, signal: AbortSignal): Promise<Record<string, Uint8Array>> {
	const { unzipSync } = await import("fflate");
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(bytes, { filter: archiveEntryFilter(true, signal) });
	} catch (error) {
		if (signal.aborted) throw signal.reason ?? error;
		rethrowArchiveError(error);
	}
	return files;
}

function numberedPath(path: string, pattern: RegExp): number {
	const match = pattern.exec(path);
	return match?.[1] ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

async function xmlTextRuns(xml: string, localName: string, signal: AbortSignal): Promise<readonly string[]> {
	signal.throwIfAborted();
	const { JSDOM } = await import("jsdom");
	const document = new JSDOM(xml, { contentType: "text/xml" }).window.document;
	signal.throwIfAborted();
	if (document.querySelector("parsererror")) throw new Error("Document contains invalid XML");
	return [...document.getElementsByTagNameNS("*", localName)]
		.map((element) => element.textContent?.trim())
		.filter((value): value is string => Boolean(value));
}

async function pptxToMarkdown(bytes: Uint8Array, signal: AbortSignal, maxCharacters: number): Promise<string> {
	const { strFromU8 } = await import("fflate");
	const files = await unzipDocument(bytes, signal);
	const slides = Object.keys(files)
		.filter((path) => /^ppt\/slides\/slide\d+\.xml$/u.test(path))
		.sort((left, right) => numberedPath(left, /slide(\d+)\.xml$/u) - numberedPath(right, /slide(\d+)\.xml$/u));
	if (slides.length > 500) throw new Error("PPTX exceeds the 500-slide extraction limit");
	const parts = new MarkdownBudget(maxCharacters);
	let extracted = false;
	for (const [index, path] of slides.entries()) {
		signal.throwIfAborted();
		const file = files[path];
		if (!file) continue;
		const runs = await xmlTextRuns(strFromU8(file), "t", signal);
		if (runs.length > 0) {
			extracted = true;
			if (parts.append(`# Slide ${index + 1}\n\n${runs.join("\n\n")}`)) break;
		}
	}
	if (!extracted) throw new Error("PPTX contains no extractable slide text");
	return parts.toString();
}

function spreadsheetColumn(reference: string | null): number {
	const letters = /^([A-Z]{1,3})[1-9]\d*$/iu.exec(reference ?? "")?.[1]?.toUpperCase();
	if (!letters) throw new Error("XLSX contains an invalid cell reference");
	let column = 0;
	for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
	if (column > 16_384) throw new Error("XLSX cell exceeds the standard 16,384-column limit");
	return Math.max(0, column - 1);
}

function markdownCell(value: string): string {
	return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>").trim();
}

async function xlsxToMarkdown(bytes: Uint8Array, signal: AbortSignal, maxCharacters: number): Promise<string> {
	const [{ strFromU8 }, { JSDOM }] = await Promise.all([import("fflate"), import("jsdom")]);
	const files = await unzipDocument(bytes, signal);
	const sharedStrings: string[] = [];
	const sharedFile = files["xl/sharedStrings.xml"];
	if (sharedFile) {
		signal.throwIfAborted();
		const sharedDocument = new JSDOM(strFromU8(sharedFile), { contentType: "text/xml" }).window.document;
		for (const item of sharedDocument.getElementsByTagNameNS("*", "si")) {
			sharedStrings.push([...item.getElementsByTagNameNS("*", "t")].map((text) => text.textContent ?? "").join(""));
		}
	}
	const sheets = Object.keys(files)
		.filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(path))
		.sort((left, right) => numberedPath(left, /sheet(\d+)\.xml$/u) - numberedPath(right, /sheet(\d+)\.xml$/u));
	if (sheets.length > 256) throw new Error("XLSX exceeds the 256-sheet extraction limit");
	const parts = new MarkdownBudget(maxCharacters);
	let extracted = false;
	let cellCount = 0;
	for (const [sheetIndex, path] of sheets.entries()) {
		signal.throwIfAborted();
		const file = files[path];
		if (!file) continue;
		const document = new JSDOM(strFromU8(file), { contentType: "text/xml" }).window.document;
		const rowElements = [...document.getElementsByTagNameNS("*", "row")];
		if (rowElements.length > 100_000) throw new Error("XLSX exceeds the 100,000-row-per-sheet extraction limit");
		const usedColumns = new Set<number>();
		for (const rowElement of rowElements) {
			signal.throwIfAborted();
			for (const cell of rowElement.getElementsByTagNameNS("*", "c")) {
				cellCount++;
				if (cellCount > 1_000_000) throw new Error("XLSX exceeds the 1,000,000-cell extraction limit");
				usedColumns.add(spreadsheetColumn(cell.getAttribute("r")));
			}
		}
		if (rowElements.length === 0 || usedColumns.size === 0) continue;
		const columns = [...usedColumns].sort((left, right) => left - right);
		if (columns.length > 256) throw new Error("XLSX exceeds the 256-used-column extraction limit");
		const displayedColumns = new Set(columns);
		const rowValues = (row: Element): Map<number, string> => {
			const values = new Map<number, string>();
			for (const cell of row.getElementsByTagNameNS("*", "c")) {
				const column = spreadsheetColumn(cell.getAttribute("r"));
				if (!displayedColumns.has(column)) continue;
				const value = cell.getElementsByTagNameNS("*", "v")[0]?.textContent ?? "";
				const inline = [...cell.getElementsByTagNameNS("*", "t")].map((item) => item.textContent ?? "").join("");
				values.set(
					column,
					cell.getAttribute("t") === "s" ? (sharedStrings[Number(value)] ?? value) : inline || value,
				);
			}
			return values;
		};
		const firstRow = rowElements[0];
		if (!firstRow) continue;
		const firstValues = rowValues(firstRow);
		const header = columns.map((column) => markdownCell(firstValues.get(column) ?? `Column ${column + 1}`));
		extracted = true;
		let full = parts.append(
			`# Sheet ${sheetIndex + 1}\n\n| ${header.join(" | ")} |\n| ${header.map(() => "---").join(" | ")} |`,
		);
		for (const rowElement of rowElements.slice(1)) {
			if (full) break;
			signal.throwIfAborted();
			const values = rowValues(rowElement);
			const row = columns.map((column) => markdownCell(values.get(column) ?? ""));
			full = parts.append(`| ${row.join(" | ")} |`, "\n");
		}
		if (full) break;
	}
	if (!extracted) throw new Error("XLSX contains no extractable worksheet cells");
	return parts.toString();
}

function resolveArchivePath(baseFile: string, relativePath: string): string {
	const path = relativePath.split(/[?#]/u, 1)[0] ?? "";
	let decoded: string;
	try {
		decoded = decodeURIComponent(path);
	} catch {
		throw new Error("EPUB contains an invalid encoded path");
	}
	const resolved = decoded.startsWith("/") ? [] : baseFile.split("/").slice(0, -1);
	for (const segment of decoded.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (resolved.length === 0) throw new Error("EPUB chapter path escapes the archive root");
			resolved.pop();
			continue;
		}
		resolved.push(segment);
	}
	return resolved.join("/");
}

async function epubToMarkdown(
	bytes: Uint8Array,
	url: string,
	signal: AbortSignal,
	maxCharacters: number,
): Promise<string> {
	const [{ strFromU8 }, { JSDOM }] = await Promise.all([import("fflate"), import("jsdom")]);
	const files = await unzipDocument(bytes, signal);
	const container = files["META-INF/container.xml"];
	if (!container) throw new Error("EPUB is missing META-INF/container.xml");
	const containerDocument = new JSDOM(strFromU8(container), { contentType: "text/xml" }).window.document;
	if (containerDocument.querySelector("parsererror")) throw new Error("EPUB container XML is invalid");
	const packagePath = containerDocument.getElementsByTagNameNS("*", "rootfile")[0]?.getAttribute("full-path")?.trim();
	if (!packagePath) throw new Error("EPUB container does not identify a package document");
	const packageFile = files[packagePath];
	if (!packageFile) throw new Error("EPUB package document is missing");
	const packageDocument = new JSDOM(strFromU8(packageFile), { contentType: "text/xml" }).window.document;
	if (packageDocument.querySelector("parsererror")) throw new Error("EPUB package document is invalid");

	const manifest = new Map<string, string>();
	for (const item of packageDocument.getElementsByTagNameNS("*", "item")) {
		const id = item.getAttribute("id")?.trim();
		const href = item.getAttribute("href")?.trim();
		const mediaType = item.getAttribute("media-type")?.trim().toLowerCase();
		if (id && href && (mediaType === "application/xhtml+xml" || /\.x?html?(?:[?#]|$)/iu.test(href))) {
			manifest.set(id, resolveArchivePath(packagePath, href));
		}
	}
	const itemRefs = [...packageDocument.getElementsByTagNameNS("*", "itemref")];
	if (itemRefs.length > 500) throw new Error("EPUB exceeds the 500-chapter extraction limit");
	const chapters = new MarkdownBudget(maxCharacters);
	const title = packageDocument.getElementsByTagNameNS("*", "title")[0]?.textContent?.trim();
	if (title) chapters.append(`# ${title}`);
	let extracted = false;
	for (const itemRef of itemRefs) {
		signal.throwIfAborted();
		const id = itemRef.getAttribute("idref")?.trim();
		const chapterPath = id ? manifest.get(id) : undefined;
		const chapter = chapterPath ? files[chapterPath] : undefined;
		if (!chapter || !chapterPath) continue;
		const chapterUrl = new URL(chapterPath, `${url.replace(/[^/]*$/u, "")}`).href;
		const markdown = await htmlToMarkdown(strFromU8(chapter), chapterUrl);
		if (markdown) {
			extracted = true;
			if (chapters.append(markdown)) break;
		}
	}
	if (!extracted) throw new Error("EPUB contains no extractable spine chapters");
	return chapters.toString();
}

function truncateContent(
	content: string,
	maxCharacters: number,
	marker: string,
): { readonly content: string; readonly truncated: boolean } {
	if (content.length <= maxCharacters) return { content, truncated: false };
	const available = Math.max(0, maxCharacters - marker.length);
	let prefix = content.slice(0, available);
	if (prefix.length > 0 && /[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
	return {
		content: `${prefix}${marker.slice(0, Math.max(0, maxCharacters - prefix.length))}`,
		truncated: true,
	};
}

export interface WebFetchConversionInput {
	readonly bytes: Uint8Array;
	readonly bodyTruncated: boolean;
	readonly contentTypeHeader: string | null;
	readonly contentType: string;
	readonly fileHint: string;
	readonly finalUrl: string;
	readonly raw: boolean;
	readonly maxCharacters: number;
}

export interface WebFetchConversionResult {
	readonly contentType: string;
	readonly method: WebFetchMethod;
	readonly content: string;
	readonly truncated: boolean;
	readonly limitationReason?: WebFetchResponse["limitationReason"];
	readonly transformed?: boolean;
	readonly image?: NonNullable<WebFetchResponse["image"]>;
}

/** Runs inside the bounded conversion Worker; exported only for that Worker entrypoint. */
export async function convertFetchedContent(
	input: WebFetchConversionInput,
	signal: AbortSignal,
): Promise<WebFetchConversionResult> {
	const { bytes, bodyTruncated, contentType, fileHint, finalUrl, maxCharacters } = input;
	if (contentType.startsWith("image/")) {
		if (bodyTruncated) throw new Error("Fetched image exceeds the configured byte limit");
		const { default: sharp } = await import("sharp");
		let imageBytes: Buffer<ArrayBufferLike> = Buffer.from(bytes);
		let imageType = contentType;
		let transformed = false;
		let metadata = await sharp(imageBytes, { animated: true, limitInputPixels: 16_000_000 })
			.metadata()
			.catch(() => {
				throw new Error(`fetch received invalid ${contentType} image data`);
			});
		signal.throwIfAborted();
		const decodedImageType = imageMimeType(metadata.format);
		if (decodedImageType) imageType = decodedImageType;
		const frames = metadata.pages ?? 1;
		const frameHeight = metadata.pageHeight ?? metadata.height ?? 0;
		if (frames > 64 || (metadata.width ?? 0) * frameHeight * frames > 16_000_000) {
			throw new Error("Fetched image exceeds the 64-frame or 16-megapixel decoded limit");
		}
		if (
			decodedImageType === undefined ||
			!INLINE_IMAGE_TYPES.has(imageType) ||
			imageBytes.byteLength > MAX_INLINE_IMAGE_BYTES ||
			(metadata.width ?? 0) > 4_096 ||
			(metadata.height ?? 0) > 4_096
		) {
			transformed = true;
			imageBytes = await sharp(imageBytes, { limitInputPixels: 16_000_000 })
				.resize({ width: 2_048, height: 2_048, fit: "inside", withoutEnlargement: true })
				.png()
				.toBuffer();
			imageType = "image/png";
			metadata = await sharp(imageBytes).metadata();
		}
		signal.throwIfAborted();
		if (imageBytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
			throw new Error("Fetched image is too large to return after resizing");
		}
		const mimeType = imageType as NonNullable<WebFetchResponse["image"]>["mimeType"];
		return Object.freeze({
			contentType: mimeType,
			method: "image" as const,
			content: `Fetched image (${mimeType}, ${metadata.width ?? "?"}×${metadata.height ?? "?"}, ${imageBytes.byteLength} bytes${transformed ? ", transformed to fit model limits" : ""}).`,
			truncated: transformed,
			...(transformed ? { limitationReason: "output-overflow" as const, transformed: true } : {}),
			image: { data: imageBytes.toString("base64"), mimeType },
		});
	}

	let method: WebFetchMethod;
	let content: string;
	let conversionLimitation: WebFetchResponse["limitationReason"];
	if (contentType === "application/pdf" || fileHint.endsWith(".pdf")) {
		if (bodyTruncated) throw new Error("Fetched PDF exceeds the configured byte limit");
		method = "document";
		content = await pdfToMarkdown(bytes, signal, maxCharacters);
	} else if (contentType.includes("wordprocessingml") || fileHint.endsWith(".docx")) {
		if (bodyTruncated) throw new Error("Fetched DOCX exceeds the configured byte limit");
		method = "document";
		content = await docxToMarkdown(bytes, finalUrl, signal, maxCharacters);
	} else if (contentType.includes("presentationml") || fileHint.endsWith(".pptx")) {
		if (bodyTruncated) throw new Error("Fetched PPTX exceeds the configured byte limit");
		method = "document";
		content = await pptxToMarkdown(bytes, signal, maxCharacters);
	} else if (contentType.includes("spreadsheetml") || fileHint.endsWith(".xlsx")) {
		if (bodyTruncated) throw new Error("Fetched XLSX exceeds the configured byte limit");
		method = "document";
		content = await xlsxToMarkdown(bytes, signal, maxCharacters);
	} else if (contentType === "application/epub+zip" || fileHint.endsWith(".epub")) {
		if (bodyTruncated) throw new Error("Fetched EPUB exceeds the configured byte limit");
		method = "document";
		content = await epubToMarkdown(bytes, finalUrl, signal, maxCharacters);
	} else {
		const text = decodeTextBody(bytes, input.contentTypeHeader, bodyTruncated);
		method = input.raw ? "raw" : "text";
		content = text;
		if (!input.raw && (contentType === "text/html" || contentType === "application/xhtml+xml")) {
			method = "html";
			content = await htmlToMarkdown(text, finalUrl);
			if (!content.trim()) throw new Error("fetch found no readable HTML content");
		} else if (!input.raw && (contentType === "application/json" || contentType.endsWith("+json"))) {
			method = "json";
			content = formatJsonLosslessly(text, signal, maxCharacters);
		} else if (
			!input.raw &&
			(contentType.includes("rss") ||
				contentType.includes("atom") ||
				((contentType.includes("xml") || contentType === "text/plain") && /<(?:rss|feed)[\s>]/iu.test(text)))
		) {
			method = "feed";
			const feed = await feedToMarkdown(text, finalUrl);
			content = feed.content;
			conversionLimitation = feed.limitationReason;
		}
		if (bodyTruncated) content = `${content}\n\n[Fetch response truncated at byte limit]`;
	}
	signal.throwIfAborted();
	const bounded = truncateContent(content, maxCharacters, "\n\n[Fetch output truncated]");
	const limitationReason = bodyTruncated || bounded.truncated ? ("output-overflow" as const) : conversionLimitation;
	return Object.freeze({
		contentType,
		method,
		content: bounded.content,
		truncated: bodyTruncated || bounded.truncated || limitationReason !== undefined,
		...(limitationReason ? { limitationReason } : {}),
	});
}

export type WebWorkerTask =
	| { readonly kind: "fetch-conversion"; readonly input: WebFetchConversionInput }
	| {
			readonly kind: "duckduckgo-html";
			readonly html: string;
			readonly pageUrl: string;
			readonly maxResults: number;
	  };

interface WebWorkerMessage {
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: { readonly name: string; readonly message: string };
}

async function runWebWorker<T>(task: WebWorkerTask, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	const sourceRuntime = import.meta.url.endsWith(".ts");
	const transferable = task.kind === "fetch-conversion" ? task.input.bytes.buffer : undefined;
	const worker = new Worker(
		new URL(sourceRuntime ? "./conversion-worker.ts" : "./conversion-worker.js", import.meta.url),
		{
			workerData: task,
			...(transferable instanceof ArrayBuffer ? { transferList: [transferable] } : {}),
			resourceLimits: {
				maxOldGenerationSizeMb: 256,
				maxYoungGenerationSizeMb: 32,
				codeRangeSizeMb: 16,
				stackSizeMb: 4,
			},
			// Do not inherit host-only flags such as --input-type or inspector ports.
			execArgv: sourceRuntime ? ["--import", "tsx"] : [],
		},
	);
	return await settleWebWorker<T>(worker, signal);
}

async function settleWebWorker<T>(worker: Worker, signal: AbortSignal): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			worker.removeAllListeners();
			callback();
		};
		const abort = (): void => {
			void worker.terminate();
			finish(() => reject(signal.reason ?? new DOMException("Operation aborted", "AbortError")));
		};
		signal.addEventListener("abort", abort, { once: true });
		worker.once("message", (message: WebWorkerMessage) => {
			if (message.ok) finish(() => resolve(message.result as T));
			else {
				const error = new Error(message.error?.message ?? "Web Worker failed");
				error.name = message.error?.name ?? "Error";
				finish(() => reject(error));
			}
		});
		worker.once("error", (error) => finish(() => reject(error)));
		worker.once("exit", (code) => {
			finish(() =>
				reject(
					new Error(
						code === 0 ? "Web Worker exited before returning a result" : `Web Worker exited with code ${code}`,
					),
				),
			);
		});
	});
}

function convertFetchedContentInWorker(
	input: WebFetchConversionInput,
	signal: AbortSignal,
): Promise<WebFetchConversionResult> {
	return runWebWorker<WebFetchConversionResult>({ kind: "fetch-conversion", input }, signal);
}

function parseProviderSearchJsonInWorker(
	bytes: Uint8Array,
	provider: JsonSearchProviderId,
	maxResults: number,
	signal: AbortSignal,
): Promise<ProviderResponse> {
	signal.throwIfAborted();
	const worker = new Worker(
		String.raw`const { parentPort, workerData } = require("node:worker_threads");
		const FIELD_LIMIT = 20000;
		const TITLE_LIMIT = 1000;
		const URL_LIMIT = 8192;
		const SUMMARY_LIMIT = 4000;
		const CANDIDATE_MULTIPLIER = 4;
		const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
		const clean = (value, limit) => {
			if (typeof value !== "string") return undefined;
			const characters = [];
			for (const character of value.slice(0, limit)) {
				const code = character.codePointAt(0);
				characters.push(code <= 31 || code === 127 ? " " : character);
			}
			const bounded = characters.join("").replace(/\s+/gu, " ").trim();
			return bounded.length > 0 ? bounded : undefined;
		};
		const safeUrl = (value) => {
			const candidate = clean(value, URL_LIMIT);
			if (!candidate) return undefined;
			try {
				const url = new URL(candidate);
				if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
				return url.href;
			} catch { return undefined; }
		};
		const sources = (rows, summaryFields) => {
			if (!Array.isArray(rows)) return [];
			return rows.slice(0, workerData.maxResults * CANDIDATE_MULTIPLIER).flatMap((row) => {
				const item = record(row);
				const title = clean(item?.title, TITLE_LIMIT);
				const url = safeUrl(item?.url);
				if (!title || !url) return [];
				const summary = summaryFields.map((field) => clean(item?.[field], SUMMARY_LIMIT)).find(Boolean);
				return [{ title, url, ...(summary ? { summary } : {}) }];
			});
		};
		try {
			const payload = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(workerData.bytes)));
			let result;
			if (workerData.provider === "brave") {
				result = { sources: sources(record(payload?.web)?.results, ["description"]) };
			} else if (workerData.provider === "tavily") {
				const answer = clean(payload?.answer, FIELD_LIMIT);
				result = { ...(answer ? { answer } : {}), sources: sources(payload?.results, ["content"]) };
			} else {
				const answers = Array.isArray(payload?.answers) ? payload.answers.slice(0, workerData.maxResults) : [];
				const answer = answers
					.map((value) => clean(value, FIELD_LIMIT) ?? clean(record(value)?.answer, FIELD_LIMIT))
					.filter(Boolean).join("\n").slice(0, FIELD_LIMIT).trim();
				result = { ...(answer ? { answer } : {}), sources: sources(payload?.results, ["content", "snippet"]) };
			}
			parentPort.postMessage({ ok: true, result });
		} catch (error) {
			parentPort.postMessage({ ok: false, error: { name: error.name, message: error.message } });
		} finally { parentPort.close(); }`,
		{
			eval: true,
			workerData: { bytes, provider, maxResults },
			...(bytes.buffer instanceof ArrayBuffer ? { transferList: [bytes.buffer] } : {}),
			execArgv: [],
			resourceLimits: {
				maxOldGenerationSizeMb: 128,
				maxYoungGenerationSizeMb: 16,
				codeRangeSizeMb: 8,
				stackSizeMb: 2,
			},
		},
	);
	return settleWebWorker<ProviderResponse>(worker, signal);
}

function parseDuckDuckGoInWorker(
	html: string,
	pageUrl: string,
	maxResults: number,
	signal: AbortSignal,
): Promise<ProviderResponse> {
	return runWebWorker<ProviderResponse>({ kind: "duckduckgo-html", html, pageUrl, maxResults }, signal);
}

export function createWebRuntime(options: {
	readonly fetch: typeof globalThis.fetch;
	readonly pinnedFetch?: WebPinnedFetch;
	readonly resolveHostname?: WebHostnameResolver;
	readonly settings: SettingsStore;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly diagnostics?: DiagnosticSink;
	readonly clock?: { now(): number };
	readonly sandboxMode?: () => "read-only" | "workspace-write" | "danger-full-access" | undefined;
}): WebRuntime {
	if ((options.resolveHostname === undefined) !== (options.pinnedFetch === undefined)) {
		throw new Error("Web Runtime requires resolveHostname and pinnedFetch to be provided together");
	}
	const cache = new BoundedWebCache();
	const clock = options.clock ?? { now: () => Date.now() };
	const runtime: WebRuntime = {
		search: async (input, signal) => {
			signal.throwIfAborted();
			const userSettings = await options.settings.load();
			signal.throwIfAborted();
			const webSettings = userSettings.web;
			const settings = webSettings?.search;
			const providerOrder = settings?.providers ?? DEFAULT_PROVIDERS;
			const configured = input.provider
				? [input.provider, ...providerOrder.filter((provider) => provider !== input.provider)]
				: providerOrder;
			const maxResults = boundedInteger(input.maxResults ?? settings?.maxResults, DEFAULT_MAX_RESULTS, 20);
			const maxCharacters = boundedInteger(settings?.maxCharacters, DEFAULT_SEARCH_MAX_CHARACTERS, 100_000);
			const timeoutMs = boundedInteger(settings?.timeoutMs, DEFAULT_TIMEOUT_MS, 120_000);
			const cacheTtlMs = boundedInteger(webSettings?.cache?.ttlMs, DEFAULT_CACHE_TTL_MS, 24 * 60 * 60_000);
			const cacheMaxEntries = boundedInteger(webSettings?.cache?.maxEntries, DEFAULT_CACHE_MAX_ENTRIES, 1_024);
			const cacheMaxBytes = boundedInteger(webSettings?.cache?.maxBytes, DEFAULT_CACHE_MAX_BYTES, 64 * 1024 * 1024);
			const config: SearchConfig = {
				environment: options.environment,
				networkPolicy: outboundDomainPolicy(userSettings.sandbox, options.sandboxMode?.()),
				...(settings?.searxngEndpoint ? { searxngEndpoint: settings.searxngEndpoint } : {}),
			};
			const cacheKey = JSON.stringify({
				kind: "search",
				query: input.query.trim().replace(/\s+/gu, " ").toLowerCase(),
				providers: configured,
				maxResults,
				maxCharacters,
				searxngEndpoint: config.searxngEndpoint ?? null,
				allowedDomains: config.networkPolicy.allowedDomains ?? [],
				deniedDomains: config.networkPolicy.deniedDomains ?? [],
			});
			const cached = cache.get<WebSearchResponse>(cacheKey, clock.now());
			if (cached) return Object.freeze({ ...cached, cache: "hit" as const });
			const failures: string[] = [];
			const attempts: WebSearchProviderId[] = [];
			for (const id of configured) {
				const provider = PROVIDERS.get(id);
				if (!provider || !provider.isAvailable(config)) continue;
				attempts.push(id);
				const timed = timeoutSignal(signal, timeoutMs);
				try {
					const response = await settleWithSignal(
						provider.search({
							query: input.query,
							maxResults,
							signal: timed.signal,
							fetch: options.fetch,
							...(options.pinnedFetch ? { pinnedFetch: options.pinnedFetch } : {}),
							...(options.resolveHostname ? { resolveHostname: options.resolveHostname } : {}),
							config,
						}),
						timed.signal,
					);
					const sources = deduplicateSources(response.sources, maxResults);
					if (sources.length === 0 && !response.answer) throw new WebSearchError(id, `${id} returned no results`);
					const result = Object.freeze({
						...response,
						provider: id,
						sources,
						attempts: Object.freeze([...attempts]),
						cache: "miss" as const,
						maxCharacters,
					});
					cache.set(
						cacheKey,
						result,
						clock.now() + cacheTtlMs,
						Buffer.byteLength(JSON.stringify(result)),
						cacheMaxEntries,
						cacheMaxBytes,
					);
					return result;
				} catch (error) {
					if (signal.aborted) throw signal.reason ?? error;
					const message = error instanceof Error ? error.message : String(error);
					failures.push(`${id}: ${message}`);
					try {
						void Promise.resolve(
							options.diagnostics?.({
								code: "web.search-provider-failed",
								message,
								details: { provider: id },
							}),
						).catch(() => undefined);
					} catch {}
				} finally {
					timed.dispose();
				}
			}
			if (attempts.length === 0) throw new Error("No configured Web Search Provider is available");
			throw new Error(`All Web Search Providers failed: ${failures.join("; ")}`);
		},
		fetch: async (input, signal) => {
			signal.throwIfAborted();
			const userSettings = await options.settings.load();
			signal.throwIfAborted();
			const networkPolicy = outboundDomainPolicy(userSettings.sandbox, options.sandboxMode?.());
			const url = parseWebUrl(input.url, networkPolicy);
			const webSettings = userSettings.web;
			const settings = webSettings?.fetch;
			const timeoutMs = boundedInteger(settings?.timeoutMs, DEFAULT_FETCH_TIMEOUT_MS, 120_000);
			const maxBytes = boundedInteger(settings?.maxBytes, DEFAULT_FETCH_MAX_BYTES, 50 * 1024 * 1024);
			const maxCharacters = boundedInteger(
				input.maxCharacters ?? settings?.maxCharacters,
				DEFAULT_FETCH_MAX_CHARACTERS,
				500_000,
			);
			const cacheTtlMs = boundedInteger(webSettings?.cache?.ttlMs, DEFAULT_CACHE_TTL_MS, 24 * 60 * 60_000);
			const cacheMaxEntries = boundedInteger(webSettings?.cache?.maxEntries, DEFAULT_CACHE_MAX_ENTRIES, 1_024);
			const cacheMaxBytes = boundedInteger(webSettings?.cache?.maxBytes, DEFAULT_CACHE_MAX_BYTES, 64 * 1024 * 1024);
			const cacheKey = JSON.stringify({
				kind: "fetch",
				url: url.href,
				raw: input.raw ?? false,
				maxBytes,
				maxCharacters,
			});
			const cached = cache.get<WebFetchResponse>(cacheKey, clock.now());
			if (cached) {
				// A cache hit performs no network I/O, so reapply the current hostname
				// policy without blocking on a DNS resolver that is not needed.
				parseWebUrl(cached.finalUrl, networkPolicy);
				return Object.freeze({ ...cached, cache: "hit" as const });
			}
			const cacheResult = (result: WebFetchResponse): WebFetchResponse => {
				if (!result.truncated && result.method !== "image" && result.method !== "document") {
					cache.set(
						cacheKey,
						result,
						clock.now() + cacheTtlMs,
						Buffer.byteLength(result.content),
						cacheMaxEntries,
						cacheMaxBytes,
					);
				}
				return result;
			};
			const timed = timeoutSignal(signal, timeoutMs);
			try {
				const loaded = await fetchWithRedirectPolicy({
					fetch: options.fetch,
					...(options.pinnedFetch ? { pinnedFetch: options.pinnedFetch } : {}),
					url,
					init: {
						headers: {
							Accept:
								"text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.5",
							"User-Agent": "Coda/0.1 Web Fetch",
						},
					},
					signal: timed.signal,
					policy: networkPolicy,
					...(options.resolveHostname ? { resolveHostname: options.resolveHostname } : {}),
				});
				const response = loaded.response;
				if (!response.ok) {
					discardResponseBody(response);
					throw new Error(`fetch failed with HTTP ${response.status}`);
				}
				const contentTypeHeader = response.headers.get("content-type");
				const bodyLimit = responseBodyByteLimit(contentTypeHeader, maxBytes, input.raw ?? false);
				const body = await settleWithSignal(readBoundedBody(response, bodyLimit), timed.signal);
				// Some document parsers transfer/detach the supplied Uint8Array. Capture
				// the downloaded size before dispatch so result metadata stays truthful.
				const downloadedBytes = body.bytes.byteLength;
				const finalUrl = loaded.finalUrl;
				const dispositionFilename = contentDispositionFilename(response.headers.get("content-disposition"));
				const finalPath = new URL(finalUrl).pathname.toLowerCase();
				const fileHint = dispositionFilename ?? finalPath;
				const contentType = sniffedContentType(normalizeContentType(contentTypeHeader), body.bytes, fileHint);
				if (!input.raw && body.truncated && structuredTextContentType(contentType)) {
					throw new Error(`Fetched ${contentType} exceeds the ${bodyLimit}-byte structured content limit`);
				}
				const conversion = await convertFetchedContentInWorker(
					{
						bytes: body.bytes,
						bodyTruncated: body.truncated,
						contentTypeHeader,
						contentType,
						fileHint,
						finalUrl,
						raw: input.raw ?? false,
						maxCharacters,
					},
					timed.signal,
				);
				return cacheResult(
					Object.freeze({
						url: url.href,
						finalUrl,
						...conversion,
						bytes: downloadedBytes,
						cache: "miss" as const,
					}),
				);
			} catch (error) {
				if (signal.aborted) throw signal.reason ?? error;
				throw error;
			} finally {
				timed.dispose();
			}
		},
	};
	return Object.freeze(runtime);
}

export const unavailableWebRuntime: WebRuntime = Object.freeze({
	search: async () => {
		throw new Error("Web access is unavailable in this host");
	},
	fetch: async () => {
		throw new Error("Web access is unavailable in this host");
	},
});
