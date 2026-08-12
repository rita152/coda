export interface CartLine {
	readonly price: number;
	readonly quantity: number;
}

export function calculateSubtotal(lines: readonly CartLine[]): number {
	return lines.reduce((total, line) => total + line.price * line.quantity, 0);
}
