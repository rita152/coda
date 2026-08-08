// Portions derived from Pi:
// /packages/ai/src/auth/context.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import type { AuthContext } from "./types.ts";

function getProcessEnv(): Record<string, string | undefined> | undefined {
	const processLike = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
	return processLike?.env;
}

export function defaultProviderAuthContext(): AuthContext {
	return {
		async env(name) {
			const value = getProcessEnv()?.[name];
			return typeof value === "string" && value.trim().length > 0 ? value : undefined;
		},
		async fileExists() {
			return false;
		},
	};
}
