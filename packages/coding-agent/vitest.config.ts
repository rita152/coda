import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: ["**/node_modules/**", "**/.git/**"],
		fileParallelism: false,
		// Git-backed integration tests share process and filesystem capacity across workers.
		testTimeout: 30_000,
	},
});
