// Portions derived from Pi:
// /packages/ai/src/api/anthropic-messages.lazy.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { lazyApi } from "../lazy.ts";
import type { ProviderStreams } from "../types.ts";

export const anthropicMessagesApi = (): ProviderStreams => lazyApi(() => import("./anthropic-messages.ts"));
