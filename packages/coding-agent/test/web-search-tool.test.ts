import type { ToolExecutionContext } from "@coda/agent";
import { describe, expect, it, vi } from "vitest";
import { createWebRuntime, type WebPinnedFetch } from "../src/tools/web/runtime.ts";
import { createWebSearchTool } from "../src/tools/web-search.ts";

function context(signal = new AbortController().signal): ToolExecutionContext {
	return {
		signal,
		runId: "run-web" as ToolExecutionContext["runId"],
		turnId: "turn-web" as ToolExecutionContext["turnId"],
		invocationId: "invocation-web" as ToolExecutionContext["invocationId"],
		resultMessageId: "message-web" as ToolExecutionContext["resultMessageId"],
		providerToolCallId: "provider-web",
	};
}

describe("web_search Tool", () => {
	it("treats an empty Provider response as a failure and falls back to SearXNG", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(Response.json({ answer: null, results: [] }))
			.mockResolvedValueOnce(
				Response.json({
					answers: ["The current release is 1.0."],
					results: [
						{ title: "Release page", url: "https://example.test/releases/1.0", content: "Published today." },
					],
				}),
			);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({
					web: {
						search: {
							providers: ["tavily", "searxng"],
							searxngEndpoint: "https://search.example.test/",
						},
					},
				}),
				save: async () => undefined,
			},
			environment: { TAVILY_API_KEY: "tavily-test" },
		});
		const result = await createWebSearchTool(web).execute({ query: "current release" }, context());

		expect(result.observation).toMatchObject({
			status: "ok",
			facts: {
				provider: "searxng",
				resultCount: 1,
				runEvidence: { completeness: "windowed", limitationReason: "pagination" },
			},
		});
		expect(result.content).toContain("The current release is 1.0.");
		expect(result.content).toContain("Published today.");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[1]?.[0]).toBe("https://search.example.test/search?q=current+release&format=json");
	});

	it("treats an explicit Provider as preferred while retaining automatic fallback", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
			.mockResolvedValueOnce(
				Response.json({
					results: [{ title: "Fallback", url: "https://example.test/fallback", content: "Recovered." }],
				}),
			);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({
					web: { search: { providers: ["searxng"], searxngEndpoint: "https://search.example.test/" } },
				}),
				save: async () => undefined,
			},
			environment: { TAVILY_API_KEY: "tavily-test" },
		});

		const result = await createWebSearchTool(web).execute(
			{ query: "preferred provider", provider: "tavily" },
			context(),
		);

		expect(result.observation).toMatchObject({ status: "ok", facts: { provider: "searxng" } });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("uses credential-free DuckDuckGo search and extracts result titles, URLs, and summaries", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					`<!doctype html><html><body>
					<div class="result">
						<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.test%2Frelease">Release docs</a>
						<a class="result__snippet">Stable release documentation and migration notes.</a>
					</div>
				</body></html>`,
					{ headers: { "Content-Type": "text/html; charset=utf-8" } },
				),
		);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({ web: { search: { providers: ["duckduckgo"] } } }),
				save: async () => undefined,
			},
			environment: {},
		});

		const result = await createWebSearchTool(web).execute({ query: "release docs" }, context());

		expect(result.observation).toMatchObject({
			status: "ok",
			facts: { provider: "duckduckgo", resultCount: 1 },
		});
		expect(result.content).toContain("Release docs");
		expect(result.content).toContain("https://docs.example.test/release");
		expect(result.content).toContain("Stable release documentation and migration notes.");
	});

	it("filters unsafe source URLs and escapes Provider-controlled Markdown labels", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({
				results: [
					{ title: "Unsafe", url: "javascript:alert(1)", content: "Drop me." },
					{
						title: "Release ] notes\n2. [forged",
						url: "https://example.test/release_(1)",
						content: "Trusted summary.",
					},
				],
			}),
		);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({ web: { search: { providers: ["tavily"] } } }),
				save: async () => undefined,
			},
			environment: { TAVILY_API_KEY: "tavily-test" },
		});

		const result = await createWebSearchTool(web).execute({ query: "safe sources" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { resultCount: 1 } });
		expect(result.content).not.toContain("javascript:");
		expect(result.content).toContain("Release \\] notes 2. \\[forged");
		expect(result.content).toContain("https://example.test/release_\\(1\\)");
	});

	it("shares successful search results across Tool instances through the bounded Web cache", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({
				answer: "Version 1.0 is current.",
				results: [{ title: "Versions", url: "https://example.test/versions", content: "Current versions." }],
			}),
		);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({
					web: {
						search: { providers: ["tavily"] },
						cache: { ttlMs: 60_000, maxEntries: 8 },
					},
				}),
				save: async () => undefined,
			},
			environment: { TAVILY_API_KEY: "tavily-test" },
			clock: { now: () => 1_000 },
		});

		const first = await createWebSearchTool(web).execute({ query: "current version" }, context());
		const second = await createWebSearchTool(web).execute({ query: "current version" }, context());

		expect(first.observation?.status).toBe("ok");
		expect(second.observation).toMatchObject({ status: "ok", facts: { cache: "hit" } });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("bounds model-visible search content and records Unicode-safe truncation", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({
				answer: `Current answer ${"🚀".repeat(100)}`,
				results: [{ title: "Long result", url: "https://example.test/long", content: "summary ".repeat(100) }],
			}),
		);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({
					web: { search: { providers: ["tavily"], maxCharacters: 160 } },
				}),
				save: async () => undefined,
			},
			environment: { TAVILY_API_KEY: "tavily-test" },
		});

		const result = await createWebSearchTool(web).execute({ query: "long answer" }, context());

		expect(result.observation).toMatchObject({ status: "ok", truncated: true });
		expect(result.content).toContain("[Search output truncated]");
		expect(String(result.content).length).toBeLessThanOrEqual(160);
		expect(result.content).not.toContain("�");
		expect(/[\uD800-\uDBFF]$/u.test(String(result.content))).toBe(false);
		expect(result.details).toMatchObject({ provider: "tavily", resultCount: 1, cache: "miss" });
		expect(JSON.stringify(result.details)).not.toContain("🚀");
	});

	it("times out a stalled Provider and falls back to the next configured Provider", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementationOnce(
				async (_input, init) =>
					await new Promise<Response>((_resolve, reject) => {
						const signal = init?.signal;
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					}),
			)
			.mockResolvedValueOnce(
				Response.json({
					results: [{ title: "Fallback result", url: "https://example.test/fallback", content: "Recovered." }],
				}),
			);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({
					web: {
						search: {
							providers: ["tavily", "searxng"],
							timeoutMs: 50,
							searxngEndpoint: "https://search.example.test/",
						},
					},
				}),
				save: async () => undefined,
			},
			environment: { TAVILY_API_KEY: "tavily-test" },
		});

		const result = await createWebSearchTool(web).execute({ query: "latest fallback" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { provider: "searxng" } });
		expect(result.content).toContain("Fallback result");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("times out CPU-bound Provider response parsing and falls back", async () => {
		const html = `<!doctype html><html><body>${'<div class="result"><a class="result__a" href="https://example.test/slow">Slow</a></div>'.repeat(20_000)}</body></html>`;
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response(html, { headers: { "Content-Type": "text/html" } }))
			.mockResolvedValueOnce(
				Response.json({
					results: [{ title: "Parsed fallback", url: "https://example.test/parsed", content: "Recovered." }],
				}),
			);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({ web: { search: { providers: ["duckduckgo", "tavily"], timeoutMs: 100 } } }),
				save: async () => undefined,
			},
			environment: { TAVILY_API_KEY: "tavily-test" },
		});

		const outcome = await Promise.race([
			createWebSearchTool(web).execute({ query: "conversion fallback" }, context()),
			new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 1_000)),
		]);

		expect(outcome).not.toBe("still-pending");
		expect(outcome).toMatchObject({ observation: { status: "ok", facts: { provider: "tavily" } } });
		expect(JSON.stringify(outcome)).toContain("Parsed fallback");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("propagates caller cancellation without falling back", async () => {
		const controller = new AbortController();
		const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
			controller.abort(new DOMException("caller cancelled", "AbortError"));
			throw init?.signal?.reason;
		});
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({
					web: {
						search: {
							providers: ["tavily", "searxng"],
							searxngEndpoint: "https://search.example.test/",
						},
					},
				}),
				save: async () => undefined,
			},
			environment: { TAVILY_API_KEY: "tavily-test" },
		});

		await expect(
			createWebSearchTool(web).execute({ query: "cancelled search" }, context(controller.signal)),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("returns a recoverable failure when every configured Provider fails and retries later", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
			.mockResolvedValueOnce(
				Response.json({
					results: [{ title: "Recovered", url: "https://example.test/recovered", content: "Available again." }],
				}),
			);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({ web: { search: { providers: ["tavily"] }, cache: { ttlMs: 60_000 } } }),
				save: async () => undefined,
			},
			environment: { TAVILY_API_KEY: "tavily-test" },
			clock: { now: () => 1_000 },
		});

		const failed = await createWebSearchTool(web).execute({ query: "retry search" }, context());
		const recovered = await createWebSearchTool(web).execute({ query: "retry search" }, context());

		expect(failed.observation).toMatchObject({ status: "error", facts: { code: "web_search_failed" } });
		expect(failed.content).toContain("All Web Search Providers failed");
		expect(recovered.observation).toMatchObject({ status: "ok", facts: { cache: "miss" } });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("enforces a hard Provider deadline when the HTTP adapter ignores AbortSignal", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementationOnce(async () => await new Promise<Response>(() => undefined))
			.mockResolvedValueOnce(
				Response.json({
					results: [{ title: "Hard fallback", url: "https://example.test/hard", content: "Recovered." }],
				}),
			);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({
					web: {
						search: {
							providers: ["tavily", "searxng"],
							timeoutMs: 50,
							searxngEndpoint: "https://search.example.test/",
						},
					},
				}),
				save: async () => undefined,
			},
			environment: { TAVILY_API_KEY: "tavily-test" },
		});

		const outcome = await Promise.race([
			createWebSearchTool(web).execute({ query: "hard timeout" }, context()),
			new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 100)),
		]);

		expect(outcome).not.toBe("still-pending");
		expect(outcome).toMatchObject({ observation: { status: "ok", facts: { provider: "searxng" } } });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("times out a stalled DNS resolver and falls back to the next Provider", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({
				results: [{ title: "DNS fallback", url: "https://example.test/dns", content: "Recovered." }],
			}),
		);
		const resolveHostname = vi.fn(async (hostname: string) => {
			if (hostname === "api.tavily.com") return await new Promise<readonly string[]>(() => undefined);
			return ["93.184.216.34"];
		});
		const web = createWebRuntime({
			fetch,
			pinnedFetch: async (url, init) => fetch(url, init),
			resolveHostname,
			settings: {
				load: async () => ({
					web: {
						search: {
							providers: ["tavily", "searxng"],
							timeoutMs: 50,
							searxngEndpoint: "https://search.example.test/",
						},
					},
				}),
				save: async () => undefined,
			},
			environment: { TAVILY_API_KEY: "tavily-test" },
		});

		const result = await createWebSearchTool(web).execute({ query: "DNS timeout" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { provider: "searxng" } });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("uses the Provider host address vetted by the resolver", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const pinnedFetch = vi.fn<WebPinnedFetch>(async () =>
			Response.json({
				results: [{ title: "Pinned", url: "https://example.test/pinned", content: "Safe route." }],
			}),
		);
		const web = createWebRuntime({
			fetch,
			pinnedFetch,
			resolveHostname: async () => ["1.1.1.1"],
			settings: {
				load: async () => ({ web: { search: { providers: ["tavily"] } } }),
				save: async () => undefined,
			},
			environment: { TAVILY_API_KEY: "tavily-test" },
		});

		const result = await createWebSearchTool(web).execute({ query: "pinned provider" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { provider: "tavily" } });
		expect(pinnedFetch).toHaveBeenCalledWith(
			"https://api.tavily.com/search",
			expect.objectContaining({ redirect: "manual" }),
			["1.1.1.1"],
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("falls back when a Provider response exceeds the search body limit", async () => {
		const oversized = JSON.stringify({ answer: "x".repeat(2 * 1024 * 1024 + 1), results: [] });
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response(oversized, { headers: { "Content-Type": "application/json" } }))
			.mockResolvedValueOnce(
				Response.json({
					results: [{ title: "Bounded", url: "https://example.test/bounded", content: "Small response." }],
				}),
			);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({
					web: {
						search: {
							providers: ["tavily", "searxng"],
							searxngEndpoint: "https://search.example.test/",
						},
					},
				}),
				save: async () => undefined,
			},
			environment: { TAVILY_API_KEY: "tavily-test" },
		});

		const result = await createWebSearchTool(web).execute({ query: "bounded response" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { provider: "searxng" } });
		expect(result.content).toContain("Bounded");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("prunes amplified Provider objects before returning results to the main runtime", async () => {
		const amplified = `{"results":[{"title":"Kept","url":"https://example.test/kept","content":"Bounded summary."},${"{},".repeat(500_000)}{}]}`;
		expect(Buffer.byteLength(amplified)).toBeLessThan(2 * 1024 * 1024);
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(amplified, { headers: { "Content-Type": "application/json" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({
					web: {
						search: {
							providers: ["searxng"],
							searxngEndpoint: "https://search.example.test/",
							timeoutMs: 2_000,
						},
					},
				}),
				save: async () => undefined,
			},
			environment: {},
		});

		const outcome = await Promise.race([
			createWebSearchTool(web).execute({ query: "amplified" }, context()),
			new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 1_000)),
		]);

		expect(outcome).not.toBe("still-pending");
		expect(outcome).toMatchObject({
			observation: { status: "ok", facts: { provider: "searxng", resultCount: 1 } },
		});
		expect(JSON.stringify(outcome)).toContain("Bounded summary.");
	});

	it("isolates DiagnosticSink failures from Provider fallback", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
			.mockResolvedValueOnce(
				Response.json({
					results: [{ title: "Diagnostic fallback", url: "https://example.test/diag", content: "Recovered." }],
				}),
			);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({
					web: {
						search: {
							providers: ["tavily", "searxng"],
							searxngEndpoint: "https://search.example.test/",
						},
					},
				}),
				save: async () => undefined,
			},
			environment: { TAVILY_API_KEY: "tavily-test" },
			diagnostics: async () => {
				throw new Error("diagnostic sink failed");
			},
		});

		const result = await createWebSearchTool(web).execute({ query: "diagnostic fallback" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { provider: "searxng" } });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("revalidates every Provider redirect against the outbound domain policy", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/search" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({
					web: {
						search: { providers: ["searxng"], searxngEndpoint: "https://search.example.test/" },
					},
				}),
				save: async () => undefined,
			},
			environment: {},
		});

		const result = await createWebSearchTool(web).execute({ query: "redirected search" }, context());

		expect(result.observation).toMatchObject({ status: "error", facts: { code: "web_search_failed" } });
		expect(result.content).toContain("private or local network address");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("strips Provider credentials before following a cross-origin redirect", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 307,
					headers: { Location: "https://redirect.example.test/search" },
				}),
			)
			.mockImplementationOnce(async (_input, init) => {
				const headers = new Headers(init?.headers);
				expect(headers.has("authorization")).toBe(false);
				expect(headers.has("x-subscription-token")).toBe(false);
				return Response.json({
					results: [{ title: "Redirected", url: "https://example.test/result", content: "Safe." }],
				});
			});
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({
					sandbox: { allowedDomains: ["api.tavily.com", "redirect.example.test"] },
					web: { search: { providers: ["tavily"] } },
				}),
				save: async () => undefined,
			},
			environment: { TAVILY_API_KEY: "must-not-leak" },
		});

		const result = await createWebSearchTool(web).execute({ query: "safe redirect" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { provider: "tavily" } });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("applies the outbound domain policy to configured SearXNG endpoints", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({
					sandbox: { deniedDomains: ["search.example.test"] },
					web: {
						search: { providers: ["searxng"], searxngEndpoint: "https://search.example.test/" },
					},
				}),
				save: async () => undefined,
			},
			environment: {},
		});

		const result = await createWebSearchTool(web).execute({ query: "blocked endpoint" }, context());

		expect(result.observation).toMatchObject({ status: "error", facts: { code: "web_search_failed" } });
		expect(result.content).toContain("denied by the outbound domain policy");
		expect(fetch).not.toHaveBeenCalled();
	});
});
