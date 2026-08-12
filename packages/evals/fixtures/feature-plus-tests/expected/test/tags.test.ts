import { normalizeTag, uniqueTags } from "../src/tags.js";

if (normalizeTag(" Feature " ) !== "feature") throw new Error("normalizes tags");

const actual = uniqueTags(["Bug", " feature ", "bug"]);
if (actual.join(",") !== "bug,feature") throw new Error("preserves first-seen order");
