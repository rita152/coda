import { isExpired } from "../src/cache.js";

if (isExpired(0, 500, 60)) throw new Error("a sixty-second entry should remain valid after 500ms");
