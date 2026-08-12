import { calculateSubtotal } from "../src/cart.js";

const subtotal = calculateSubtotal([
	{ price: 5, quantity: 2 },
	{ price: 3, quantity: 1 },
]);
if (subtotal !== 13) throw new Error("expected line prices multiplied by quantity");
