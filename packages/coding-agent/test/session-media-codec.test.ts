import { describe, expect, it } from "vitest";
import { sessionMediaExtension } from "../src/session/media-codec.ts";

describe("Session media paths", () => {
	it("preserves every supported rendition MIME extension", () => {
		expect([
			sessionMediaExtension("image/png"),
			sessionMediaExtension("image/jpeg"),
			sessionMediaExtension("image/gif"),
			sessionMediaExtension("image/webp"),
		]).toEqual(["png", "jpg", "gif", "webp"]);
	});
});
