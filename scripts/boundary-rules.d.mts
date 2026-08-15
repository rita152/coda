export interface BoundaryViolation {
	readonly rule: string;
	readonly file: string;
	readonly line: number;
	readonly message: string;
}

export const PACKAGE_DEPENDENCY_MATRIX: Readonly<Record<string, readonly string[]>>;
export const RUNTIME_PRIVATE_SUBPATHS: readonly string[];
export const RUNTIME_DENIED_SYMBOLS: readonly string[];
export const RUNTIME_INTERNAL_IMPORTS: Readonly<Record<string, readonly string[]>>;
export const CODING_AGENT_VALUE_IMPORTS: Readonly<Record<string, readonly string[]>>;
export function extractImportSpecifiers(source: string): readonly { readonly specifier: string; readonly index: number }[];
export function lintSource(input: {
	readonly source: string;
	readonly file: string;
	readonly packageName: string;
	readonly packageRoot?: string;
}): readonly BoundaryViolation[];
