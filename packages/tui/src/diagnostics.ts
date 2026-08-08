export interface Diagnostic {
	readonly code: string;
	readonly message: string;
	readonly details?: Readonly<Record<string, unknown>>;
}

export type DiagnosticSink = (diagnostic: Diagnostic) => void | Promise<void>;
