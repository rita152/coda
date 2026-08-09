import type { Model } from "@coda/ai";
import { describe, expect, it, vi } from "vitest";
import { resolveModelRuntimeCapabilities } from "../src/model-capabilities.ts";

describe("Coding Agent model runtime capabilities", () => {
	it("fails closed instead of inferring Tool Result images from the wire Api", () => {
		const model = { api: "anthropic-messages" } as Model;

		expect(resolveModelRuntimeCapabilities(model)).toEqual({ toolResultImages: false });
	});

	it("uses the explicitly injected capability independently of Model input media", () => {
		const model = { api: "openai-responses", input: ["text"] } as Model;
		const resolve = vi.fn(() => ({ toolResultImages: true }));

		expect(resolveModelRuntimeCapabilities(model, { resolve })).toEqual({ toolResultImages: true });
		expect(resolve).toHaveBeenCalledWith(model);
	});
});
