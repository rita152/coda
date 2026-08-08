import { describe, expect, test } from "vitest";

import { ModelsError } from "../src/index.ts";

describe("ModelsError", () => {
	test("preserves a stable code and useful cause detail", () => {
		const cause = new Error("socket closed");
		const error = new ModelsError("stream", "Request failed", { cause });

		expect(error).toMatchObject({
			name: "ModelsError",
			code: "stream",
			message: "Request failed: socket closed",
			cause,
		});
	});
});
