import type { ToolExecutionContext } from "@coda/agent";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { createFetchTool } from "../src/tools/fetch.ts";
import { createWebRuntime, type WebPinnedFetch } from "../src/tools/web/runtime.ts";

function context(signal = new AbortController().signal): ToolExecutionContext {
	return {
		signal,
		runId: "run-fetch" as ToolExecutionContext["runId"],
		turnId: "turn-fetch" as ToolExecutionContext["turnId"],
		invocationId: "invocation-fetch" as ToolExecutionContext["invocationId"],
		resultMessageId: "message-fetch" as ToolExecutionContext["resultMessageId"],
		providerToolCallId: "provider-fetch",
	};
}

function docxFixture(): Uint8Array {
	return zipSync({
		"[Content_Types].xml": strToU8(
			`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
			<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
			<Default Extension="xml" ContentType="application/xml"/>
			<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
			</Types>`,
		),
		"_rels/.rels": strToU8(
			`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
			<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
			</Relationships>`,
		),
		"word/document.xml": strToU8(
			`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
			<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Release Notes</w:t></w:r></w:p>
			<w:p><w:r><w:t>Version 1.0 shipped successfully.</w:t></w:r></w:p>
			</w:body></w:document>`,
		),
	});
}

function pptxFixture(): Uint8Array {
	return zipSync({
		"[Content_Types].xml": strToU8("<Types/>"),
		"ppt/slides/slide1.xml": strToU8(
			`<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
			<p:sp><p:txBody><a:p><a:r><a:t>Launch Plan</a:t></a:r></a:p><a:p><a:r><a:t>Ship in August</a:t></a:r></a:p></p:txBody></p:sp>
			</p:spTree></p:cSld></p:sld>`,
		),
	});
}

function xlsxFixture(): Uint8Array {
	return zipSync({
		"[Content_Types].xml": strToU8("<Types/>"),
		"xl/sharedStrings.xml": strToU8(
			`<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
			<si><t>Item</t></si><si><t>Qty</t></si><si><t>Wire</t></si></sst>`,
		),
		"xl/worksheets/sheet1.xml": strToU8(
			`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
			<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
			<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12</v></c></row>
			</sheetData></worksheet>`,
		),
	});
}

function epubFixture(): Uint8Array {
	return zipSync({
		mimetype: strToU8("application/epub+zip"),
		"META-INF/container.xml": strToU8(
			`<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>
			<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
			</rootfiles></container>`,
		),
		"OEBPS/content.opf": strToU8(
			`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Coda Guide</dc:title></metadata>
			<manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
			<spine><itemref idref="chapter"/></spine></package>`,
		),
		"OEBPS/chapter.xhtml": strToU8(
			`<!doctype html><html><body><article><h1>Getting Started</h1><p>Install Coda and open a Workspace.</p></article></body></html>`,
		),
	});
}

function archiveDeclaringOversizedEntry(): Uint8Array {
	const archive = zipSync({ "ppt/slides/slide1.xml": strToU8("<slide/>") });
	const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
	for (let offset = 0; offset <= archive.byteLength - 28; offset++) {
		if (view.getUint32(offset, true) !== 0x02014b50) continue;
		view.setUint32(offset + 24, 51 * 1024 * 1024, true);
		return archive;
	}
	throw new Error("ZIP fixture is missing its central directory entry");
}

describe("fetch Tool", () => {
	it("turns the readable part of HTML into clean Markdown with absolute links", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					`<!doctype html>
				<html><head><title>Example article</title><style>.hidden { display: none }</style></head>
				<body>
					<nav>Site navigation</nav>
					<main><article><h1>Useful title</h1><p>Read the <a href="/docs">documentation</a>.</p></article></main>
					<script>window.secret = "ignore me"</script><footer>Legal boilerplate</footer>
				</body></html>`,
					{ headers: { "Content-Type": "text/html; charset=utf-8" } },
				),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/article" }, context());

		expect(result.observation).toMatchObject({
			status: "ok",
			truncated: false,
			facts: { method: "html", contentType: "text/html" },
		});
		expect(result.content).toContain("# Useful title");
		expect(result.content).toContain("[documentation](https://example.test/docs)");
		expect(result.content).not.toContain("Site navigation");
		expect(result.content).not.toContain("window.secret");
		expect(result.content).not.toContain("Legal boilerplate");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("formats JSON responses for model consumption", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response('{"release":{"version":"1.0","stable":true}}', {
					headers: { "Content-Type": "application/json" },
				}),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://api.example.test/release" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { method: "json" } });
		expect(result.content).toBe(`{
	"release": {
		"version": "1.0",
		"stable": true
	}
}`);
	});

	it("formats JSON without rounding integers beyond JavaScript's safe range", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response('{"id":9007199254740993,"items":[]}', {
					headers: { "Content-Type": "application/json" },
				}),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://api.example.test/identifier" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { method: "json" } });
		expect(result.content).toContain("9007199254740993");
		expect(result.content).not.toContain("9007199254740992");
	});

	it("bounds deeply nested JSON while formatting", async () => {
		const nested = `${"[".repeat(3_000)}0${"]".repeat(3_000)}`;
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(nested, { headers: { "Content-Type": "application/json" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute(
			{ url: "https://api.example.test/nested", maxCharacters: 80 },
			context(),
		);

		expect(result.observation).toMatchObject({ status: "ok", truncated: true });
		expect(String(result.content).length).toBeLessThanOrEqual(80);
	});

	it("rejects oversized structured JSON before Worker parsing", async () => {
		const json = `[${"{},".repeat(700_000)}null]`;
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(json, { headers: { "Content-Type": "application/json" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({ web: { fetch: { maxBytes: 10 * 1024 * 1024 } } }),
				save: async () => undefined,
			},
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://api.example.test/oversized" }, context());

		expect(result.observation).toMatchObject({ status: "error", facts: { code: "fetch_failed" } });
		expect(result.content).toContain("structured content limit");
	});

	it("turns RSS feeds into linked Markdown entries", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					`<?xml version="1.0"?><rss version="2.0"><channel>
					<title>Release Feed</title>
					<item><title>Version 1.0 shipped</title><link>https://example.test/releases/1.0</link>
					<pubDate>Wed, 19 Aug 2026 08:00:00 GMT</pubDate>
					<description><![CDATA[<p>Highlights are <strong>available now</strong>.</p>]]></description></item>
				</channel></rss>`,
					{ headers: { "Content-Type": "application/rss+xml" } },
				),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/feed.xml" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { method: "feed" } });
		expect(result.content).toContain("# Release Feed");
		expect(result.content).toContain("## [Version 1.0 shipped](https://example.test/releases/1.0)");
		expect(result.content).toContain("2026-08-19T08:00:00.000Z");
		expect(result.content).toContain("Highlights are **available now**.");
		expect(result.content).not.toContain("<rss");
	});

	it("honors an XML declaration when decoding a Feed charset", async () => {
		const xml = `<?xml version="1.0" encoding="iso-8859-1"?><rss><channel><title>Café</title>
			<item><title>Résumé</title><link>https://example.test/resume</link></item></channel></rss>`;
		const latin1 = Uint8Array.from([...xml].map((character) => character.charCodeAt(0)));
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(latin1, { headers: { "Content-Type": "application/rss+xml" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/latin1.xml" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { method: "feed" } });
		expect(result.content).toContain("# Café");
		expect(result.content).toContain("[Résumé](https://example.test/resume)");
	});

	it("marks a bounded Feed entry window as pagination rather than complete evidence", async () => {
		const items = Array.from(
			{ length: 21 },
			(_, index) => `<item><title>Entry ${index + 1}</title><link>https://example.test/${index + 1}</link></item>`,
		).join("");
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(`<rss><channel><title>Busy Feed</title>${items}</channel></rss>`, {
					headers: { "Content-Type": "application/rss+xml" },
				}),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/busy.xml" }, context());

		expect(result.observation).toMatchObject({
			status: "ok",
			truncated: true,
			facts: { runEvidence: { completeness: "windowed", limitationReason: "pagination" } },
		});
		expect(result.content).toContain("Entry 20");
		expect(result.content).not.toContain("Entry 21");
	});

	it("returns supported images as model-native image content", async () => {
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2NDWQAAAABJRU5ErkJggg==",
			"base64",
		);
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(png, { headers: { "Content-Type": "application/octet-stream" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/pixel.png" }, context());
		const second = await createFetchTool(web).execute({ url: "https://example.test/pixel.png" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { method: "image", contentType: "image/png" } });
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("Fetched image") }),
			{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
		]);
		expect(result.details).toMatchObject({
			url: "https://example.test/pixel.png",
			contentType: "image/png",
			method: "image",
			bytes: png.byteLength,
		});
		expect(JSON.stringify(result.details)).not.toContain(png.toString("base64"));
		expect(second.observation).toMatchObject({ status: "ok", facts: { cache: "miss" } });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("uses decoded image metadata instead of a mismatched declared MIME type", async () => {
		const { default: sharp } = await import("sharp");
		const jpeg = await sharp({
			create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 255 } },
		})
			.jpeg()
			.toBuffer();
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(new Uint8Array(jpeg), { headers: { "Content-Type": "image/png" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/mislabeled.png" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { contentType: "image/jpeg" } });
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text" }),
			{ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
		]);
	});

	it("transcodes a supported-but-non-inline decoded image despite a misleading inline MIME type", async () => {
		const { default: sharp } = await import("sharp");
		const tiff = await sharp({
			create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 255, b: 0 } },
		})
			.tiff()
			.toBuffer();
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(new Uint8Array(tiff), { headers: { "Content-Type": "image/png" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/mislabeled.png" }, context());

		expect(result.observation).toMatchObject({ status: "ok", truncated: true, facts: { contentType: "image/png" } });
		expect(result.details).toMatchObject({ transformed: true });
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text" }),
			expect.objectContaining({ type: "image", mimeType: "image/png", data: expect.stringMatching(/^iVBOR/u) }),
		]);
	});

	it("reports oversized image downsampling as lossy evidence", async () => {
		const { default: sharp } = await import("sharp");
		const source = await sharp({
			create: { width: 5_000, height: 1, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
		})
			.png()
			.toBuffer();
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(new Uint8Array(source), { headers: { "Content-Type": "image/png" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/wide.png" }, context());

		expect(result.observation).toMatchObject({
			status: "ok",
			truncated: true,
			facts: { runEvidence: { completeness: "lossy-overflow", limitationReason: "output-overflow" } },
		});
		expect(result.details).toMatchObject({ transformed: true });
	});

	it("extracts readable text from PDF documents", async () => {
		const pdf = Buffer.from(
			"JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNDAxID4+CnN0cmVhbQpCVCAvRjEgMTYgVGYgNzIgNzMwIFRkIChJbmxpbmUgaW1hZ2UgdG9rZW5pemVyIHJlcHJvIGlzc3VlKSBUaiBFVApxCkJJCi9XIDUgL0ggMSAvQ1MgL0RldmljZUdyYXkgL0JQQyA4CklEChEjPjVHCkVJClEKMC41IHcKMTAwIDY1MCBtIDI2MCA2NTAgbCBTCjEwMCA2MjAgbSAyNjAgNjIwIGwgUwoxMDAgNTkwIG0gMjYwIDU5MCBsIFMKMTAwIDY1MCBtIDEwMCA1OTAgbCBTCjE4MCA2NTAgbSAxODAgNTkwIGwgUwoyNjAgNjUwIG0gMjYwIDU5MCBsIFMKQlQgL0YxIDEwIFRmIDExNSA2MzMgVGQgKE5hbWUpIFRqIEVUCkJUIC9GMSAxMCBUZiAxOTUgNjMzIFRkIChRdHkpIFRqIEVUCkJUIC9GMSAxMCBUZiAxMTUgNjAzIFRkIChXaXJlKSBUaiBFVApCVCAvRjEgMTAgVGYgMTk1IDYwMyBUZCAoMTIpIFRqIEVUCgplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNzYzCiUlRU9GCg==",
			"base64",
		);
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(pdf, {
					headers: {
						"Content-Type": "application/octet-stream",
						"Content-Disposition": 'attachment; filename="report.pdf"',
					},
				}),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/download?id=report" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { method: "document" } });
		expect(result.details).toMatchObject({ bytes: pdf.byteLength });
		expect(result.content).toContain("Inline image tokenizer repro issue");
		expect(result.content).toContain("Name");
		expect(result.content).toContain("Wire");
		expect(result.content).not.toContain("%PDF-1.4");
	});

	it("converts DOCX documents into Markdown", async () => {
		const docx = docxFixture();
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(Buffer.from(docx), {
					headers: {
						"Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					},
				}),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/release.docx" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { method: "document" } });
		expect(result.content).toContain("# Release Notes");
		expect(result.content).toContain("Version 1.0 shipped successfully.");
	});

	it("extracts slide text from PPTX documents", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(Buffer.from(pptxFixture()), {
					headers: {
						"Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
					},
				}),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/launch.pptx" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { method: "document" } });
		expect(result.content).toContain("# Slide 1");
		expect(result.content).toContain("Launch Plan");
		expect(result.content).toContain("Ship in August");
	});

	it("converts XLSX worksheets into Markdown tables", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(Buffer.from(xlsxFixture()), {
					headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
				}),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/inventory.xlsx" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { method: "document" } });
		expect(result.content).toContain("# Sheet 1");
		expect(result.content).toContain("| Item | Qty |");
		expect(result.content).toContain("| Wire | 12 |");
	});

	it("rejects XLSX cells beyond the standard 16,384-column limit", async () => {
		const xlsx = zipSync({
			"[Content_Types].xml": strToU8("<Types/>"),
			"xl/worksheets/sheet1.xml": strToU8(
				`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
				<row r="1"><c r="XFE1"><v>1</v></c></row></sheetData></worksheet>`,
			),
		});
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(Buffer.from(xlsx), {
					headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
				}),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/wide.xlsx" }, context());

		expect(result.observation).toMatchObject({ status: "error", facts: { code: "fetch_failed" } });
		expect(result.content).toContain("16,384-column limit");
	});

	it("renders sparse XLSX rows without expanding every unused column", async () => {
		const xlsx = zipSync({
			"[Content_Types].xml": strToU8("<Types/>"),
			"xl/worksheets/sheet1.xml": strToU8(
				`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
				<row r="1"><c r="XFD1" t="inlineStr"><is><t>Far edge</t></is></c></row></sheetData></worksheet>`,
			),
		});
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(Buffer.from(xlsx), {
					headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
				}),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute(
			{ url: "https://example.test/sparse.xlsx", maxCharacters: 200 },
			context(),
		);

		expect(result.observation).toMatchObject({ status: "ok", facts: { method: "document" } });
		expect(result.content).toContain("Far edge");
		expect(String(result.content).length).toBeLessThanOrEqual(200);
	});

	it("rejects an oversized archive from central-directory metadata before document extraction", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(Buffer.from(archiveDeclaringOversizedEntry()), {
					headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
				}),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/bomb.pptx" }, context());

		expect(result.observation).toMatchObject({ status: "error", facts: { code: "fetch_failed" } });
		expect(result.content).toContain("expanded-size limit");
	});

	it("reads EPUB chapters in spine order", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(Buffer.from(epubFixture()), { headers: { "Content-Type": "application/epub+zip" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/guide.epub" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { method: "document" } });
		expect(result.content).toContain("# Coda Guide");
		expect(result.content).toContain("# Getting Started");
		expect(result.content).toContain("Install Coda and open a Workspace.");
	});

	it("returns HTML unchanged in raw mode", async () => {
		const html = "<!doctype html><html><body><nav>Keep me</nav><p>Raw <strong>HTML</strong></p></body></html>";
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(html, { headers: { "Content-Type": "text/html" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/raw", raw: true }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { method: "raw" } });
		expect(result.content).toBe(html);
	});

	it("keeps raw structured text bounded without applying the shaping-only MIME cap", async () => {
		const json = `{"payload":"${"x".repeat(2_100_000)}"}`;
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(json, { headers: { "Content-Type": "application/json" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({ web: { fetch: { maxBytes: 3 * 1024 * 1024 } } }),
				save: async () => undefined,
			},
			environment: {},
		});

		const result = await createFetchTool(web).execute(
			{ url: "https://example.test/raw-large.json", raw: true, maxCharacters: 100 },
			context(),
		);

		expect(result.observation).toMatchObject({ status: "ok", truncated: true, facts: { method: "raw" } });
		expect(result.content).toContain("[Fetch output truncated]");
	});

	it("keeps the configured binary limit when raw mode is requested", async () => {
		const { default: sharp } = await import("sharp");
		const png = await sharp(Buffer.alloc(2_200 * 1_000 * 3), {
			raw: { width: 2_200, height: 1_000, channels: 3 },
		})
			.png({ compressionLevel: 0 })
			.toBuffer();
		expect(png.byteLength).toBeGreaterThan(5 * 1024 * 1024);
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({ web: { fetch: { maxBytes: 8 * 1024 * 1024 } } }),
				save: async () => undefined,
			},
			environment: {},
		});

		const result = await createFetchTool(web).execute(
			{ url: "https://example.test/raw-large.png", raw: true },
			context(),
		);

		expect(result.observation).toMatchObject({ status: "ok", facts: { method: "image" } });
		expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image" })]));
	});

	it("shares complete responses across Tool instances through the bounded Web cache", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response("stable response", { headers: { "Content-Type": "text/plain" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({ web: { cache: { ttlMs: 60_000, maxEntries: 8 } } }),
				save: async () => undefined,
			},
			environment: {},
			clock: { now: () => 1_000 },
		});

		const first = await createFetchTool(web).execute({ url: "https://example.test/stable" }, context());
		const second = await createFetchTool(web).execute({ url: "https://example.test/stable" }, context());

		expect(first.observation).toMatchObject({ status: "ok", facts: { cache: "miss" } });
		expect(second.observation).toMatchObject({ status: "ok", facts: { cache: "hit" } });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("returns a cache hit without waiting on an unnecessary DNS lookup", async () => {
		let resolverShouldStall = false;
		const resolveHostname = vi.fn(async () =>
			resolverShouldStall ? await new Promise<readonly string[]>(() => undefined) : (["93.184.216.34"] as const),
		);
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response("cached response", { headers: { "Content-Type": "text/plain" } }),
		);
		const web = createWebRuntime({
			fetch,
			pinnedFetch: async (url, init) => fetch(url, init),
			resolveHostname,
			settings: { load: async () => ({ web: { cache: { ttlMs: 60_000 } } }), save: async () => undefined },
			environment: {},
		});

		await createFetchTool(web).execute({ url: "https://example.test/cached" }, context());
		resolverShouldStall = true;
		const outcome = await Promise.race([
			createFetchTool(web).execute({ url: "https://example.test/cached" }, context()),
			new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 100)),
		]);

		expect(outcome).not.toBe("still-pending");
		expect(outcome).toMatchObject({ observation: { status: "ok", facts: { cache: "hit" } } });
		expect(resolveHostname).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("expires cached responses and evicts least-recent entries by the shared byte budget", async () => {
		let now = 1_000;
		const fetch = vi.fn<typeof globalThis.fetch>(
			async (input) =>
				new Response(String(input).endsWith("/a") ? "aaaa" : "bbbb", {
					headers: { "Content-Type": "text/plain" },
				}),
		);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({ web: { cache: { ttlMs: 100, maxEntries: 8, maxBytes: 7 } } }),
				save: async () => undefined,
			},
			environment: {},
			clock: { now: () => now },
		});

		await createFetchTool(web).execute({ url: "https://example.test/a" }, context());
		await createFetchTool(web).execute({ url: "https://example.test/b" }, context());
		const evicted = await createFetchTool(web).execute({ url: "https://example.test/a" }, context());
		const hit = await createFetchTool(web).execute({ url: "https://example.test/a" }, context());
		now += 101;
		const expired = await createFetchTool(web).execute({ url: "https://example.test/a" }, context());

		expect(evicted.observation).toMatchObject({ status: "ok", facts: { cache: "miss" } });
		expect(hit.observation).toMatchObject({ status: "ok", facts: { cache: "hit" } });
		expect(expired.observation).toMatchObject({ status: "ok", facts: { cache: "miss" } });
		expect(fetch).toHaveBeenCalledTimes(4);
	});

	it("turns request timeouts into recoverable Tool failures", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async (_input, init) =>
				await new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({ web: { fetch: { timeoutMs: 5 } } }),
				save: async () => undefined,
			},
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/slow" }, context());

		expect(result.observation).toMatchObject({ status: "error", facts: { code: "fetch_failed" } });
		expect(result.content).toContain("timed out");
	});

	it("enforces a hard fetch deadline when the HTTP adapter ignores AbortSignal", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => await new Promise<Response>(() => undefined));
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({ web: { fetch: { timeoutMs: 5 } } }),
				save: async () => undefined,
			},
			environment: {},
		});

		const outcome = await Promise.race([
			createFetchTool(web).execute({ url: "https://example.test/hard-timeout" }, context()),
			new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 100)),
		]);

		expect(outcome).not.toBe("still-pending");
		expect(outcome).toMatchObject({ observation: { status: "error", facts: { code: "fetch_failed" } } });
	});

	it("enforces the fetch deadline while CPU-bound content conversion is running", async () => {
		const html = `<!doctype html><html><body><article><h1>Large page</h1><p>${"content ".repeat(20_000)}</p></article></body></html>`;
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(html, { headers: { "Content-Type": "text/html" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({ web: { fetch: { timeoutMs: 5, maxBytes: 1024 * 1024 } } }),
				save: async () => undefined,
			},
			environment: {},
		});

		const outcome = await Promise.race([
			createFetchTool(web).execute({ url: "https://example.test/conversion-timeout" }, context()),
			new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 500)),
		]);

		expect(outcome).not.toBe("still-pending");
		expect(outcome).toMatchObject({ observation: { status: "error", facts: { code: "fetch_failed" } } });
		expect(JSON.stringify(outcome)).toContain("timed out");
	});

	it("enforces the fetch deadline when the DNS resolver ignores AbortSignal", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const web = createWebRuntime({
			fetch,
			pinnedFetch: async (url, init) => fetch(url, init),
			resolveHostname: async () => await new Promise<readonly string[]>(() => undefined),
			settings: {
				load: async () => ({ web: { fetch: { timeoutMs: 5 } } }),
				save: async () => undefined,
			},
			environment: {},
		});

		const outcome = await Promise.race([
			createFetchTool(web).execute({ url: "https://example.test/dns-timeout" }, context()),
			new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 100)),
		]);

		expect(outcome).not.toBe("still-pending");
		expect(outcome).toMatchObject({ observation: { status: "error", facts: { code: "fetch_failed" } } });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("propagates caller cancellation instead of converting it into a Tool failure", async () => {
		const controller = new AbortController();
		controller.abort(new DOMException("caller cancelled", "AbortError"));
		const fetch = vi.fn<typeof globalThis.fetch>();
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		await expect(
			createFetchTool(web).execute({ url: "https://example.test/cancelled" }, context(controller.signal)),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("bounds model-visible text without splitting a Unicode surrogate pair", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(`Release ${"🚀".repeat(100)}`, { headers: { "Content-Type": "text/plain" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute(
			{ url: "https://example.test/long", maxCharacters: 80 },
			context(),
		);

		expect(result.observation).toMatchObject({ status: "ok", truncated: true });
		expect(result.content).toContain("[Fetch output truncated]");
		expect(String(result.content).length).toBeLessThanOrEqual(80);
		expect(result.content).not.toContain("�");
		expect(/[\uD800-\uDBFF]$/u.test(String(result.content))).toBe(false);
	});

	it("marks byte-limited UTF-8 content without emitting a replacement character", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response("A🚀B", { headers: { "Content-Type": "text/plain" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({ web: { fetch: { maxBytes: 4 } } }),
				save: async () => undefined,
			},
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/bytes" }, context());

		expect(result.observation).toMatchObject({ status: "ok", truncated: true });
		expect(result.content).toContain("[Fetch response truncated at byte limit]");
		expect(result.content).not.toContain("�");
	});

	it("decodes declared legacy text charsets", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), {
					headers: { "Content-Type": "text/plain; charset=iso-8859-1" },
				}),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/latin1" }, context());

		expect(result.observation).toMatchObject({ status: "ok", facts: { method: "text" } });
		expect(result.content).toBe("café");
	});

	it("rejects HTML pages with no readable content instead of caching an empty success", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					"<!doctype html><html><body><nav>Menu</nav><div id=app></div><script>boot()</script></body></html>",
					{
						headers: { "Content-Type": "text/html" },
					},
				),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/app" }, context());

		expect(result.observation).toMatchObject({ status: "error", facts: { code: "fetch_failed" } });
		expect(result.content).toContain("no readable HTML content");
	});

	it("does not cache an HTTP failure", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
			.mockResolvedValueOnce(new Response("recovered", { headers: { "Content-Type": "text/plain" } }));
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({ web: { cache: { ttlMs: 60_000 } } }), save: async () => undefined },
			environment: {},
			clock: { now: () => 1_000 },
		});

		const failed = await createFetchTool(web).execute({ url: "https://example.test/retry" }, context());
		const recovered = await createFetchTool(web).execute({ url: "https://example.test/retry" }, context());

		expect(failed.observation).toMatchObject({ status: "error", facts: { code: "fetch_failed" } });
		expect(recovered.observation).toMatchObject({ status: "ok", facts: { cache: "miss" } });
		expect(recovered.content).toBe("recovered");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("rejects incomplete DNS-pinning transport configuration", () => {
		expect(() =>
			createWebRuntime({
				fetch: vi.fn<typeof globalThis.fetch>(),
				resolveHostname: async () => ["93.184.216.34"],
				settings: { load: async () => ({}), save: async () => undefined },
				environment: {},
			}),
		).toThrow("requires resolveHostname and pinnedFetch to be provided together");
	});

	it.each([
		"http://169.254.169.254/latest/meta-data",
		"http://198.18.0.1/private",
		"http://198.19.255.254/private",
		"http://[::ffff:7f00:1]/private",
		"http://[::7f00:1]/private",
	])("rejects private-network URL %s before making a request", async (url) => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url }, context());

		expect(result.observation).toMatchObject({ status: "error", facts: { code: "fetch_failed" } });
		expect(result.content).toContain("private or local network address");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects public hostnames that resolve to a private address", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const resolveHostname = vi.fn(async () => ["127.0.0.1"]);
		const web = createWebRuntime({
			fetch,
			pinnedFetch: async (url, init) => fetch(url, init),
			resolveHostname,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://public.example.test/private" }, context());

		expect(result.observation).toMatchObject({ status: "error", facts: { code: "fetch_failed" } });
		expect(result.content).toContain("resolves to private or local address 127.0.0.1");
		expect(resolveHostname).toHaveBeenCalledWith("public.example.test", expect.any(AbortSignal));
		expect(fetch).not.toHaveBeenCalled();
	});

	it("pins the vetted DNS result for every redirect hop", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const resolveHostname = vi.fn(async (hostname: string) =>
			hostname === "example.test" ? (["93.184.216.34"] as const) : (["1.1.1.1"] as const),
		);
		const pinnedFetch = vi
			.fn<WebPinnedFetch>()
			.mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { Location: "https://cdn.example.test/final" } }),
			)
			.mockResolvedValueOnce(new Response("pinned", { headers: { "Content-Type": "text/plain" } }));
		const web = createWebRuntime({
			fetch,
			pinnedFetch,
			resolveHostname,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/start" }, context());

		expect(result.observation).toMatchObject({ status: "ok" });
		expect(result.content).toBe("pinned");
		expect(resolveHostname.mock.calls.map(([hostname]) => hostname)).toEqual(["example.test", "cdn.example.test"]);
		expect(pinnedFetch).toHaveBeenNthCalledWith(
			1,
			"https://example.test/start",
			expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }),
			["93.184.216.34"],
		);
		expect(pinnedFetch).toHaveBeenNthCalledWith(
			2,
			"https://cdn.example.test/final",
			expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }),
			["1.1.1.1"],
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("still resolves and pins an explicitly allowed private destination", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const resolveHostname = vi.fn(async () => ["127.0.0.1"] as const);
		const pinnedFetch = vi.fn<WebPinnedFetch>(
			async () => new Response("allowed", { headers: { "Content-Type": "text/plain" } }),
		);
		const web = createWebRuntime({
			fetch,
			pinnedFetch,
			resolveHostname,
			settings: {
				load: async () => ({ sandbox: { allowedDomains: ["internal.example.test"] } }),
				save: async () => undefined,
			},
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://internal.example.test/data" }, context());

		expect(result.observation).toMatchObject({ status: "ok" });
		expect(resolveHostname).toHaveBeenCalledWith("internal.example.test", expect.any(AbortSignal));
		expect(pinnedFetch).toHaveBeenCalledWith("https://internal.example.test/data", expect.any(Object), ["127.0.0.1"]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("revalidates every redirect against the outbound domain policy", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private" } }),
		);
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});

		const result = await createFetchTool(web).execute({ url: "https://example.test/redirect" }, context());

		expect(result.observation).toMatchObject({ status: "error", facts: { code: "fetch_failed" } });
		expect(result.content).toContain("private or local network address");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("keeps the requested URL as the stable Run Evidence target after a redirect", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { Location: "https://cdn.example.test/final" } }),
			)
			.mockResolvedValueOnce(new Response("redirected", { headers: { "Content-Type": "text/plain" } }));
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({}), save: async () => undefined },
			environment: {},
		});
		const requestedUrl = "https://example.test/original";

		const result = await createFetchTool(web).execute({ url: requestedUrl }, context());

		expect(result.observation).toMatchObject({
			status: "ok",
			facts: { runEvidence: { resolutionTarget: { kind: "opaque", value: requestedUrl } } },
		});
		expect(result.details).toMatchObject({ finalUrl: "https://cdn.example.test/final" });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("applies existing allowed and denied domain settings to direct Web reads", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const web = createWebRuntime({
			fetch,
			settings: {
				load: async () => ({
					sandbox: { allowedDomains: ["docs.example.test"], deniedDomains: ["blocked.example.test"] },
				}),
				save: async () => undefined,
			},
			environment: {},
		});

		const denied = await createFetchTool(web).execute({ url: "https://blocked.example.test/a" }, context());
		const notAllowed = await createFetchTool(web).execute({ url: "https://other.example.test/a" }, context());
		const unlistedSubdomain = await createFetchTool(web).execute(
			{ url: "https://sub.docs.example.test/a" },
			context(),
		);

		expect(denied.content).toContain("denied by the outbound domain policy");
		expect(notAllowed.content).toContain("not in sandbox.allowedDomains");
		expect(unlistedSubdomain.content).toContain("not in sandbox.allowedDomains");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("supports wildcard, port-scoped, empty, and deny-all sandbox domain rules", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response("allowed", { headers: { "Content-Type": "text/plain" } }),
		);
		let sandbox: { allowedDomains?: string[]; deniedDomains?: string[] } = {
			allowedDomains: ["*.example.test:443"],
		};
		const web = createWebRuntime({
			fetch,
			settings: { load: async () => ({ sandbox }), save: async () => undefined },
			environment: {},
		});

		const allowed = await createFetchTool(web).execute({ url: "https://sub.example.test/a" }, context());
		const apex = await createFetchTool(web).execute({ url: "https://example.test/a" }, context());
		const wrongPort = await createFetchTool(web).execute({ url: "http://sub.example.test/a" }, context());
		sandbox = { allowedDomains: [] };
		const empty = await createFetchTool(web).execute({ url: "https://anything.example/a" }, context());
		sandbox = { deniedDomains: ["*"] };
		const deniedAll = await createFetchTool(web).execute({ url: "https://anything.example/a" }, context());
		sandbox = { deniedDomains: ["[2001:4860:4860:0:0:0:0:8888]"] };
		const canonicalIpv6 = await createFetchTool(web).execute({ url: "http://[2001:4860:4860::8888]/" }, context());

		expect(allowed.observation).toMatchObject({ status: "ok" });
		expect(apex.content).toContain("not in sandbox.allowedDomains");
		expect(wrongPort.content).toContain("not in sandbox.allowedDomains");
		expect(empty.content).toContain("not in sandbox.allowedDomains");
		expect(deniedAll.content).toContain("denied by the outbound domain policy");
		expect(canonicalIpv6.content).toContain("denied by the outbound domain policy");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
