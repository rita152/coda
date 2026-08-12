import { percentageToRate } from "./discount.js";

export function discountedTotal(subtotal: number, percent: number): number {
	return subtotal * (1 - percentageToRate(percent));
}
