import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: ["test/live/**", "**/node_modules/**", "**/.git/**"],
	},
});
