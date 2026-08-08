// Portions derived from Pi:
// /packages/ai/src/providers/opencode-go.models.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { flattenModelCatalog, type ModelCatalog } from "../model-catalog.ts";
import values from "./data/opencode-go.json" with { type: "json" };

// This wrapper stays hand-written; models:update only replaces the reviewed JSON snapshot.
export const OPENCODE_GO_MODELS: ModelCatalog<typeof values, "opencode-go"> = flattenModelCatalog(
	"opencode-go",
	values,
);
