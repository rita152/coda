// Portions derived from Pi:
// /packages/ai/src/models-store.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import type { Api, Model } from "./types.ts";

export interface ModelsStoreEntry {
	models: readonly Model<Api>[];
	lastModified?: number;
	checkedAt?: number;
	etag?: string;
}

export interface ModelsStoreOperationOptions {
	signal?: AbortSignal;
}

export interface ModelsStore {
	read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined>;
	write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void>;
	delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void>;
}
