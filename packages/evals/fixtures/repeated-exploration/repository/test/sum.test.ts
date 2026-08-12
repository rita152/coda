import { sum } from "../src/sum.js";

if (sum([]) !== 0) throw new Error("empty sums should be zero");
