import { normalizeTag } from "../src/tags.js";

if (normalizeTag(" Feature " ) !== "feature") throw new Error("normalizes tags");
