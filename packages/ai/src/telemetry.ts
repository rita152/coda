export type TelemetryAttributeValue =
	| string
	| number
	| boolean
	| readonly string[]
	| readonly number[]
	| readonly boolean[];

export interface TelemetryAttributes {
	[name: string]: TelemetryAttributeValue | undefined;
}

export interface TelemetrySpanOptions {
	name: string;
	attributes?: TelemetryAttributes;
}

export type TelemetrySpanStatus = { status: "ok" } | { status: "error"; error?: { name: string; message: string } };

export interface TelemetryContext {
	startSpan<T>(options: TelemetrySpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}

export interface TelemetrySpan extends TelemetryContext {
	addEvent(name: string, attributes?: TelemetryAttributes): void;
	setAttributes(attributes: TelemetryAttributes): void;
	setStatus(status: TelemetrySpanStatus): void;
}
