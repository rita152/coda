import { MUTATION_TOOL_NAMES } from "./mutation-contract.ts";

export const BUILT_IN_CODING_TOOL_NAMES = Object.freeze([
	"read_session_history",
	"read",
	"read_tool_output",
	"web_search",
	"fetch",
	"grep",
	"find",
	"ls",
	...MUTATION_TOOL_NAMES,
	"bash",
	"process",
] as const);
