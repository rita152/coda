export interface CartLine {
	readonly price: number;
	readonly quantity: number;
}

export function calculateSubtotal(_lines: readonly CartLine[]): number {
	// TODO: implement after the current inspection.
	return 0;
}
