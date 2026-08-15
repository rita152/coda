import { describe, expect, it } from "vitest";
import { pastedImagePaths } from "../src/app/media-attachments.ts";

describe("pastedImagePaths", () => {
	it("recognizes absolute image paths emitted by terminal file drops", () => {
		expect(pastedImagePaths("/Users/test/Desktop/reference.png ")).toEqual(["/Users/test/Desktop/reference.png"]);
		expect(pastedImagePaths("/Users/test/Desktop/reference\\ image.JPG ")).toEqual([
			"/Users/test/Desktop/reference image.JPG",
		]);
		expect(pastedImagePaths("'/Users/test/Desktop/quoted image.webp'")).toEqual([
			"/Users/test/Desktop/quoted image.webp",
		]);
		expect(pastedImagePaths("/Users/test/Desktop/unescaped image.gif")).toEqual([
			"/Users/test/Desktop/unescaped image.gif",
		]);
	});

	it("recognizes multiple image paths and file URLs", () => {
		expect(pastedImagePaths("/tmp/one.png /tmp/two.jpeg")).toEqual(["/tmp/one.png", "/tmp/two.jpeg"]);
		expect(pastedImagePaths("file:///tmp/reference%20image.png")).toEqual(["/tmp/reference image.png"]);
	});

	it("leaves prose, relative paths, and non-image paths untouched", () => {
		expect(pastedImagePaths("please inspect /tmp/reference.png")).toBeUndefined();
		expect(pastedImagePaths("./reference.png")).toBeUndefined();
		expect(pastedImagePaths("/tmp/notes.txt")).toBeUndefined();
		expect(pastedImagePaths("/tmp/notes.txt /tmp/reference.png")).toBeUndefined();
	});
});
