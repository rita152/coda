import { basename } from "node:path";

const SAFE_COMMANDS = new Set([
	"cat",
	"cd",
	"cut",
	"echo",
	"expr",
	"false",
	"grep",
	"head",
	"id",
	"ls",
	"nl",
	"paste",
	"pwd",
	"rev",
	"seq",
	"stat",
	"tail",
	"tr",
	"true",
	"uname",
	"uniq",
	"wc",
	"which",
	"whoami",
]);

const LINUX_SAFE_COMMANDS = new Set(["numfmt", "tac"]);
const UNSAFE_BASE64_OPTIONS = ["-o", "--output"];
const UNSAFE_FIND_OPTIONS = [
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-delete",
	"-fls",
	"-fprint",
	"-fprint0",
	"-fprintf",
];
const UNSAFE_RIPGREP_OPTIONS_WITH_ARGS = ["--pre", "--hostname-bin"];
const UNSAFE_RIPGREP_OPTIONS_WITHOUT_ARGS = ["--search-zip", "-z"];
const SAFE_GIT_SUBCOMMANDS = ["status", "log", "diff", "show", "branch"];
const GIT_GLOBAL_VALUE_OPTIONS = [
	"-C",
	"-c",
	"--config-env",
	"--exec-path",
	"--git-dir",
	"--namespace",
	"--super-prefix",
	"--work-tree",
];
const SHELL_KEYWORDS = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"do",
	"done",
	"while",
	"until",
	"case",
	"esac",
	"in",
	"function",
]);

const COMMAND_PREFIX_SKIP = new Set([...SHELL_KEYWORDS, "{", "}"]);

function executableName(raw: string): string | undefined {
	const name = basename(raw);
	return name.length > 0 ? name : undefined;
}

function gitHasUnsafeGlobalOption(args: readonly string[]): boolean {
	return args.some((arg) => {
		if (
			arg === "-C" ||
			arg === "-c" ||
			arg === "-p" ||
			arg === "--config-env" ||
			arg === "--exec-path" ||
			arg === "--git-dir" ||
			arg === "--namespace" ||
			arg === "--paginate" ||
			arg === "--super-prefix" ||
			arg === "--work-tree"
		) {
			return true;
		}
		return (
			(arg.startsWith("-C") && arg.length > 2) ||
			(arg.startsWith("-c") && arg.length > 2) ||
			arg.startsWith("--config-env=") ||
			arg.startsWith("--exec-path=") ||
			arg.startsWith("--git-dir=") ||
			arg.startsWith("--namespace=") ||
			arg.startsWith("--super-prefix=") ||
			arg.startsWith("--work-tree=")
		);
	});
}

function gitSubcommandArgsAreReadOnly(args: readonly string[]): boolean {
	return !args.some(
		(arg) =>
			arg === "--output" ||
			arg.startsWith("--output=") ||
			arg === "--ext-diff" ||
			arg === "--textconv" ||
			arg === "--exec" ||
			arg.startsWith("--exec="),
	);
}

function gitBranchIsReadOnly(args: readonly string[]): boolean {
	if (args.length === 0) return true;
	let sawReadOnly = false;
	for (const arg of args) {
		if (
			arg === "--list" ||
			arg === "-l" ||
			arg === "--show-current" ||
			arg === "-a" ||
			arg === "--all" ||
			arg === "-r" ||
			arg === "--remotes" ||
			arg === "-v" ||
			arg === "-vv" ||
			arg === "--verbose" ||
			arg.startsWith("--format=")
		) {
			sawReadOnly = true;
			continue;
		}
		return false;
	}
	return sawReadOnly;
}

function findGitSubcommand(
	command: readonly string[],
	subcommands: readonly string[],
): { readonly index: number; readonly subcommand: string } | undefined {
	if (executableName(command[0] ?? "") !== "git") return undefined;
	let skipNext = false;
	for (let index = 1; index < command.length; index++) {
		const arg = command[index]!;
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (
			arg.startsWith("--config-env=") ||
			arg.startsWith("--exec-path=") ||
			arg.startsWith("--git-dir=") ||
			arg.startsWith("--namespace=") ||
			arg.startsWith("--super-prefix=") ||
			arg.startsWith("--work-tree=") ||
			((arg.startsWith("-C") || arg.startsWith("-c")) && arg.length > 2)
		) {
			continue;
		}
		if (GIT_GLOBAL_VALUE_OPTIONS.includes(arg)) {
			skipNext = true;
			continue;
		}
		if (arg === "--" || arg.startsWith("-")) continue;
		if (subcommands.includes(arg)) return { index, subcommand: arg };
		return undefined;
	}
	return undefined;
}

function isSafeGitCommand(command: readonly string[]): boolean {
	const match = findGitSubcommand(command, SAFE_GIT_SUBCOMMANDS);
	if (!match) return false;
	if (gitHasUnsafeGlobalOption(command.slice(1, match.index))) return false;
	const args = command.slice(match.index + 1);
	if (!gitSubcommandArgsAreReadOnly(args)) return false;
	if (match.subcommand === "branch") return gitBranchIsReadOnly(args);
	return true;
}

function isValidSedNArg(arg: string | undefined): boolean {
	if (!arg?.endsWith("p")) return false;
	const parts = arg.slice(0, -1).split(",");
	if (parts.length === 1) return parts[0]!.length > 0 && [...parts[0]!].every((char) => char >= "0" && char <= "9");
	if (parts.length === 2) {
		return parts.every((part) => part.length > 0 && [...part].every((char) => char >= "0" && char <= "9"));
	}
	return false;
}

function isSafeToCallWithExec(command: readonly string[]): boolean {
	const cmd = executableName(command[0] ?? "");
	if (!cmd) return false;
	if (process.platform === "linux" && LINUX_SAFE_COMMANDS.has(cmd)) return true;
	if (SAFE_COMMANDS.has(cmd)) return true;
	if (cmd === "base64") {
		return !command
			.slice(1)
			.some(
				(arg) =>
					UNSAFE_BASE64_OPTIONS.includes(arg) ||
					arg.startsWith("--output=") ||
					(arg.startsWith("-o") && arg !== "-o"),
			);
	}
	if (cmd === "find") return !command.some((arg) => UNSAFE_FIND_OPTIONS.includes(arg));
	if (cmd === "rg") {
		return !command.some(
			(arg) =>
				UNSAFE_RIPGREP_OPTIONS_WITHOUT_ARGS.includes(arg) ||
				UNSAFE_RIPGREP_OPTIONS_WITH_ARGS.some((option) => arg === option || arg.startsWith(`${option}=`)),
		);
	}
	if (cmd === "git") return isSafeGitCommand(command);
	if (cmd === "sed") {
		return command.length <= 4 && command[1] === "-n" && isValidSedNArg(command[2]);
	}
	return false;
}

type Token = { readonly kind: "word"; readonly value: string } | { readonly kind: "op"; readonly value: string };

function tokenizeShell(script: string): Token[] | undefined {
	const tokens: Token[] = [];
	let index = 0;
	const take = (count: number) => {
		const value = script.slice(index, index + count);
		index += count;
		return value;
	};
	while (index < script.length) {
		const char = script[index]!;
		if (/\s/u.test(char)) {
			index++;
			continue;
		}
		if (script.startsWith("&&", index) || script.startsWith("||", index)) {
			tokens.push({ kind: "op", value: take(2) });
			continue;
		}
		if (char === ";" || char === "|") {
			tokens.push({ kind: "op", value: take(1) });
			continue;
		}
		if (char === "'" || char === '"') {
			const quote = char;
			index++;
			let value = "";
			while (index < script.length && script[index] !== quote) {
				if (quote === '"' && (script[index] === "$" || script[index] === "`")) return undefined;
				if (quote === '"' && script[index] === "\\" && index + 1 < script.length) {
					value += script[index + 1];
					index += 2;
					continue;
				}
				value += script[index];
				index++;
			}
			if (script[index] !== quote) return undefined;
			index++;
			tokens.push({ kind: "word", value });
			continue;
		}
		if ("(){}<>`$&".includes(char) || char === "#") return undefined;
		let value = "";
		while (index < script.length) {
			const next = script[index]!;
			if (
				/\s/u.test(next) ||
				next === ";" ||
				next === "|" ||
				script.startsWith("&&", index) ||
				script.startsWith("||", index)
			) {
				break;
			}
			if ("(){}<>`$".includes(next)) return undefined;
			value += next;
			index++;
		}
		if (value.length === 0) return undefined;
		tokens.push({ kind: "word", value });
	}
	return tokens;
}

export function parseWordOnlyCommands(script: string): string[][] | undefined {
	const tokens = tokenizeShell(script);
	if (!tokens || tokens.length === 0) return undefined;
	const commands: string[][] = [];
	let current: string[] = [];
	for (const token of tokens) {
		if (token.kind === "op") {
			if (current.length === 0) return undefined;
			commands.push(current);
			current = [];
			continue;
		}
		current.push(token.value);
	}
	if (current.length === 0) return undefined;
	commands.push(current);
	return commands;
}

function extractBashScript(command: readonly string[]): string | undefined {
	if (command.length !== 3) return undefined;
	const [shell, flag, script] = command;
	if (flag !== "-lc" && flag !== "-c") return undefined;
	const name = executableName(shell ?? "");
	if (name !== "bash" && name !== "zsh" && name !== "sh") return undefined;
	return script;
}

function normalizeSafeCommand(command: readonly string[]): string[] {
	return command.map((part) => (part === "zsh" ? "bash" : part));
}

export function isKnownSafeCommand(command: readonly string[]): boolean {
	const normalized = normalizeSafeCommand(command);
	if (isSafeToCallWithExec(normalized)) return true;
	const script = extractBashScript(normalized);
	if (script === undefined) return false;
	const commands = parseWordOnlyCommands(script);
	return commands !== undefined && commands.length > 0 && commands.every((entry) => isSafeToCallWithExec(entry));
}

function rmArgsIncludeForce(args: readonly string[]): boolean {
	for (const arg of args) {
		if (arg === "--") return false;
		if (arg === "--force") return true;
		if (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("f")) return true;
	}
	return false;
}

function skipEnvAssignments(command: readonly string[]): readonly string[] {
	let index = 1;
	while (index < command.length) {
		const argument = command[index]!;
		if (argument === "--") return command.slice(index + 1);
		if (argument === "-i" || argument === "--ignore-environment") {
			index++;
			continue;
		}
		const eq = argument.indexOf("=");
		if (eq > 0 && !argument.startsWith("-")) {
			index++;
			continue;
		}
		break;
	}
	return command.slice(index);
}

function isCasePattern(word: string): boolean {
	return /^[A-Za-z0-9_.*@?-]+\)/u.test(word);
}

function skipCaseArm(words: readonly string[]): readonly string[] {
	let index = 1;
	if (index < words.length) index++;
	if (words[index] === "in") index++;
	while (index < words.length && !words[index]!.endsWith(")")) index++;
	if (index < words.length) index++;
	return words.slice(index);
}

function skipLeadingKeywords(command: readonly string[]): readonly string[] {
	let words: readonly string[] = command;
	while (words.length > 0) {
		const first = words[0]!;
		if (first === "case") {
			const next = skipCaseArm(words);
			if (next.length === words.length) break;
			words = next;
			continue;
		}
		if (
			COMMAND_PREFIX_SKIP.has(first) ||
			first.endsWith("{") ||
			first.endsWith("()") ||
			first.endsWith("(){") ||
			isCasePattern(first)
		) {
			words = words.slice(1);
			continue;
		}
		break;
	}
	return words;
}

function extractBalanced(source: string, start: number, open: string, close: string): string | undefined {
	let depth = 1;
	let index = start;
	let quote: string | undefined;
	while (index < source.length) {
		const char = source[index]!;
		if (quote) {
			if (char === "\\" && quote === '"') {
				index += 2;
				continue;
			}
			if (char === quote) quote = undefined;
			index++;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			index++;
			continue;
		}
		if (source.startsWith(open, index)) {
			depth++;
			index += open.length;
			continue;
		}
		if (source.startsWith(close, index)) {
			depth--;
			if (depth === 0) return source.slice(start, index);
			index += close.length;
			continue;
		}
		index++;
	}
	return undefined;
}

function extractSubstitutions(script: string): string[] {
	const inner: string[] = [];
	let index = 0;
	let quote: string | undefined;
	while (index < script.length) {
		const char = script[index]!;
		if (quote === "'") {
			if (char === "'") quote = undefined;
			index++;
			continue;
		}
		if (quote === '"') {
			if (char === "\\") {
				index += 2;
				continue;
			}
			if (char === '"') {
				quote = undefined;
				index++;
				continue;
			}
		} else if (char === "'" || char === '"') {
			quote = char;
			index++;
			continue;
		}
		if (script.startsWith("$(", index)) {
			const body = extractBalanced(script, index + 2, "$(", ")");
			if (body !== undefined) {
				inner.push(body);
				index += body.length + 3;
				continue;
			}
		}
		if (char === "`") {
			const end = script.indexOf("`", index + 1);
			if (end !== -1) {
				inner.push(script.slice(index + 1, end));
				index = end + 1;
				continue;
			}
		}
		index++;
	}
	return inner;
}

function tokenizeLooseStatement(statement: string): string[] {
	const tokens: string[] = [];
	let index = 0;
	while (index < statement.length) {
		const char = statement[index]!;
		if (/\s/u.test(char)) {
			index++;
			continue;
		}
		if (char === ">" || char === "<") {
			index++;
			if (statement[index] === ">") index++;
			while (index < statement.length && /\s/u.test(statement[index]!)) index++;
			if (statement[index] === "'" || statement[index] === '"') {
				const quote = statement[index]!;
				index++;
				while (index < statement.length && statement[index] !== quote) index++;
				if (statement[index] === quote) index++;
			} else {
				while (index < statement.length && !/\s/u.test(statement[index]!)) index++;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			const quote = char;
			index++;
			let value = "";
			while (index < statement.length && statement[index] !== quote) {
				value += statement[index];
				index++;
			}
			if (statement[index] === quote) index++;
			tokens.push(value);
			continue;
		}
		let value = "";
		while (
			index < statement.length &&
			!/\s/u.test(statement[index]!) &&
			statement[index] !== ">" &&
			statement[index] !== "<"
		) {
			value += statement[index];
			index++;
		}
		if (value.length > 0) tokens.push(value);
	}
	return tokens;
}

function splitLooseStatements(script: string): string[] {
	const statements: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (let index = 0; index < script.length; index++) {
		const char = script[index]!;
		if (quote) {
			current += char;
			if (char === "\\" && quote === '"') {
				current += script[index + 1] ?? "";
				index++;
				continue;
			}
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (script.startsWith("&&", index) || script.startsWith("||", index) || script.startsWith(";;", index)) {
			if (current.trim().length > 0) statements.push(current);
			current = "";
			index++;
			continue;
		}
		if (char === ";" || char === "|" || char === "\n") {
			if (current.trim().length > 0) statements.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim().length > 0) statements.push(current);
	return statements;
}

function collectLiteralCommands(script: string, depth = 0): string[][] {
	if (depth > 8) return [];
	const commands: string[][] = [];
	for (const inner of extractSubstitutions(script)) {
		commands.push(...collectLiteralCommands(inner, depth + 1));
	}
	for (const statement of splitLooseStatements(script)) {
		const words = skipLeadingKeywords(tokenizeLooseStatement(statement));
		if (words.length === 0) continue;
		commands.push([...words]);
		const name = executableName(words[0] ?? "");
		if (name === "sudo") commands.push(...collectLiteralCommands(words.slice(1).join(" "), depth + 1));
		if (name === "env") {
			const rest = skipEnvAssignments(words);
			if (rest.length > 0) commands.push([...rest], ...collectLiteralCommands(rest.join(" "), depth + 1));
		}
		if (name === "trap") {
			const action = words[1] === "--" ? words[2] : words[1];
			if (action && !action.startsWith("-")) commands.push(...collectLiteralCommands(action, depth + 1));
		}
		if (
			(name === "bash" || name === "zsh" || name === "sh") &&
			(words[1] === "-c" || words[1] === "-lc") &&
			words[2]
		) {
			commands.push(...collectLiteralCommands(words[2], depth + 1));
		}
	}
	return commands;
}

function dangerousCommandMatchForExec(command: readonly string[], depth: number): boolean {
	if (depth > 8) return false;
	const words = skipLeadingKeywords(command);
	const cmd = executableName(words[0] ?? "");
	if (cmd === "rm") return rmArgsIncludeForce(words.slice(1));
	if (cmd === "sudo") return isDangerousCommand(words.slice(1), depth + 1);
	if (cmd === "env") return isDangerousCommand(skipEnvAssignments(words), depth + 1);
	if (cmd === "trap") {
		const action = words[1] === "--" ? words[2] : words[1];
		if (!action || action.startsWith("-")) return false;
		return isDangerousCommand(["sh", "-c", action], depth + 1);
	}
	return false;
}

export function isDangerousCommand(command: readonly string[], depth = 0): boolean {
	if (depth > 8) return false;
	if (dangerousCommandMatchForExec(command, depth)) return true;
	const script = extractBashScript(command);
	if (script === undefined) return false;
	return collectLiteralCommands(script).some((entry) => dangerousCommandMatchForExec(entry, depth + 1));
}

export function shellCommandForToolInput(toolInput: Readonly<Record<string, unknown>>): string[] | undefined {
	const command = toolInput.command;
	if (typeof command !== "string" || command.trim().length === 0) return undefined;
	return ["bash", "-lc", command];
}
