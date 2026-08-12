import { discountedTotal } from "../src/invoice.js";

if (discountedTotal(100, 10) !== 90) throw new Error("expected a ten-percent discount");
