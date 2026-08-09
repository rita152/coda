import { basename, isAbsolute, normalize } from "node:path";
import type { CommandPolicy, CommandRule, CommandRulePatternToken, HostExecutable } from "./command-policy.ts";
import { matchingCommandRules } from "./command-policy.ts";

type StarlarkValue = string | readonly StarlarkValue[];

interface ParsedCall {
	readonly name: string;
	readonly line: number;
	readonly positional: readonly StarlarkValue[];
	readonly named: ReadonlyMap<string, StarlarkValue>;
}

interface PendingExamples {
	readonly line: number;
	readonly rule: CommandRule;
	readonly match: readonly (readonly string[])[];
	readonly notMatch: readonly (readonly string[])[];
}

class RuleSyntaxError extends Error {
	constructor(path: string, line: number, message: string) {
		super(`Invalid Command Rule at ${path}:${line}: ${message}`);
		this.name = "RuleSyntaxError";
	}
}

class StarlarkCallParser {
	readonly #contents: string;
	readonly #path: string;
	#index = 0;
	#line = 1;

	constructor(contents: string, path: string) {
		this.#contents = contents;
		this.#path = path;
	}

	parse(): readonly ParsedCall[] {
		const calls: ParsedCall[] = [];
		this.#skipTrivia();
		while (!this.#eof()) {
			calls.push(this.#call());
			this.#skipTrivia();
		}
		return Object.freeze(calls);
	}

	#call(): ParsedCall {
		const line = this.#line;
		const name = this.#identifier();
		this.#skipTrivia();
		this.#expect("(");
		this.#skipTrivia();
		const positional: StarlarkValue[] = [];
		const named = new Map<string, StarlarkValue>();
		let sawNamed = false;
		while (!this.#consume(")")) {
			const start = this.#index;
			let argumentName: string | undefined;
			if (this.#identifierStart(this.#peek())) {
				argumentName = this.#identifier();
				this.#skipTrivia();
				if (!this.#consume("=")) {
					this.#index = start;
					argumentName = undefined;
				}
			}
			this.#skipTrivia();
			const value = this.#value();
			if (argumentName === undefined) {
				if (sawNamed) this.#fail("positional argument cannot follow a named argument");
				positional.push(value);
			} else {
				sawNamed = true;
				if (named.has(argumentName)) this.#fail(`duplicate argument ${argumentName}`);
				named.set(argumentName, value);
			}
			this.#skipTrivia();
			if (this.#consume(")")) break;
			this.#expect(",");
			this.#skipTrivia();
			if (this.#consume(")")) break;
		}
		return Object.freeze({ name, line, positional: Object.freeze(positional), named });
	}

	#value(): StarlarkValue {
		const character = this.#peek();
		if (character === '"' || character === "'") return this.#string();
		if (character === "[") return this.#list();
		this.#fail("expected a string or list literal");
	}

	#list(): readonly StarlarkValue[] {
		this.#expect("[");
		this.#skipTrivia();
		const values: StarlarkValue[] = [];
		while (!this.#consume("]")) {
			values.push(this.#value());
			this.#skipTrivia();
			if (this.#consume("]")) break;
			this.#expect(",");
			this.#skipTrivia();
			if (this.#consume("]")) break;
		}
		return Object.freeze(values);
	}

	#string(): string {
		const quote = this.#peek();
		this.#advance();
		let value = "";
		while (!this.#eof()) {
			const character = this.#peek();
			this.#advance();
			if (character === quote) return value;
			if (character === "\n" || character === "\r") this.#fail("unterminated string literal");
			if (character !== "\\") {
				value += character;
				continue;
			}
			if (this.#eof()) this.#fail("unterminated string escape");
			const escaped = this.#peek();
			this.#advance();
			const simple: Readonly<Record<string, string>> = {
				"\\": "\\",
				"'": "'",
				'"': '"',
				n: "\n",
				r: "\r",
				t: "\t",
				b: "\b",
				f: "\f",
			};
			if (escaped in simple) {
				value += simple[escaped];
				continue;
			}
			if (escaped === "u" || escaped === "x") {
				const length = escaped === "u" ? 4 : 2;
				const digits = this.#contents.slice(this.#index, this.#index + length);
				if (!new RegExp(`^[a-fA-F0-9]{${length}}$`, "u").test(digits)) this.#fail("invalid string escape");
				this.#index += length;
				value += String.fromCodePoint(Number.parseInt(digits, 16));
				continue;
			}
			this.#fail(`unsupported string escape \\${escaped}`);
		}
		this.#fail("unterminated string literal");
	}

	#identifier(): string {
		if (!this.#identifierStart(this.#peek())) this.#fail("expected an identifier");
		const start = this.#index;
		this.#advance();
		while (/[A-Za-z0-9_]/u.test(this.#peek())) this.#advance();
		return this.#contents.slice(start, this.#index);
	}

	#identifierStart(character: string): boolean {
		return /[A-Za-z_]/u.test(character);
	}

	#skipTrivia(): void {
		for (;;) {
			while (/\s/u.test(this.#peek())) this.#advance();
			if (this.#peek() !== "#") return;
			while (!this.#eof() && this.#peek() !== "\n") this.#advance();
		}
	}

	#consume(character: string): boolean {
		if (this.#peek() !== character) return false;
		this.#advance();
		return true;
	}

	#expect(character: string): void {
		if (!this.#consume(character)) this.#fail(`expected ${character}`);
	}

	#peek(): string {
		return this.#contents[this.#index] ?? "";
	}

	#advance(): void {
		if (this.#contents[this.#index] === "\n") this.#line++;
		this.#index++;
	}

	#eof(): boolean {
		return this.#index >= this.#contents.length;
	}

	#fail(message: string): never {
		throw new RuleSyntaxError(this.#path, this.#line, message);
	}
}

function callArguments(call: ParsedCall, names: readonly string[], path: string): ReadonlyMap<string, StarlarkValue> {
	if (call.positional.length > names.length)
		throw new RuleSyntaxError(path, call.line, "too many positional arguments");
	const arguments_ = new Map(call.named);
	for (const [index, value] of call.positional.entries()) {
		const name = names[index]!;
		if (arguments_.has(name)) throw new RuleSyntaxError(path, call.line, `duplicate argument ${name}`);
		arguments_.set(name, value);
	}
	for (const name of arguments_.keys()) {
		if (!names.includes(name)) throw new RuleSyntaxError(path, call.line, `unknown argument ${name}`);
	}
	return arguments_;
}

function stringValue(value: StarlarkValue | undefined, label: string, path: string, line: number): string {
	if (typeof value !== "string") throw new RuleSyntaxError(path, line, `${label} must be a string`);
	return value;
}

function listValue(
	value: StarlarkValue | undefined,
	label: string,
	path: string,
	line: number,
): readonly StarlarkValue[] {
	if (!Array.isArray(value)) throw new RuleSyntaxError(path, line, `${label} must be a list`);
	return value;
}

function nonEmptyString(value: StarlarkValue, label: string, path: string, line: number): string {
	const parsed = stringValue(value, label, path, line);
	if (parsed.length === 0) throw new RuleSyntaxError(path, line, `${label} cannot be empty`);
	return parsed;
}

function patternValue(
	value: StarlarkValue | undefined,
	path: string,
	line: number,
): readonly CommandRulePatternToken[] {
	const input = listValue(value, "pattern", path, line);
	if (input.length === 0) throw new RuleSyntaxError(path, line, "pattern cannot be empty");
	return Object.freeze(
		input.map((token, index) => {
			if (typeof token === "string") return nonEmptyString(token, `pattern[${index}]`, path, line);
			if (token.length === 0) throw new RuleSyntaxError(path, line, `pattern[${index}] cannot be empty`);
			return Object.freeze(
				token.map((alternative) => nonEmptyString(alternative, `pattern[${index}] alternative`, path, line)),
			);
		}),
	);
}

function splitShellExample(value: string, path: string, line: number): readonly string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	let started = false;
	for (const character of value) {
		if (escaping) {
			current += character;
			escaping = false;
			started = true;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaping = true;
			started = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			started = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/u.test(character)) {
			if (started) {
				words.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += character;
		started = true;
	}
	if (quote || escaping) throw new RuleSyntaxError(path, line, "example string has invalid shell syntax");
	if (started) words.push(current);
	if (words.length === 0) throw new RuleSyntaxError(path, line, "example cannot be empty");
	return Object.freeze(words);
}

function exampleValues(
	value: StarlarkValue | undefined,
	label: string,
	path: string,
	line: number,
): readonly (readonly string[])[] {
	if (value === undefined) return Object.freeze([]);
	return Object.freeze(
		listValue(value, label, path, line).map((example, index) => {
			if (typeof example === "string") return splitShellExample(example, path, line);
			if (example.length === 0) throw new RuleSyntaxError(path, line, `${label}[${index}] cannot be empty`);
			return Object.freeze(example.map((token) => nonEmptyString(token, `${label}[${index}] token`, path, line)));
		}),
	);
}

function parsePrefixRule(
	call: ParsedCall,
	path: string,
): { readonly rule: CommandRule; readonly examples: PendingExamples } {
	const arguments_ = callArguments(call, ["pattern", "decision", "match", "not_match", "justification"], path);
	const pattern = patternValue(arguments_.get("pattern"), path, call.line);
	const decision = arguments_.has("decision")
		? stringValue(arguments_.get("decision"), "decision", path, call.line)
		: "allow";
	if (decision !== "allow" && decision !== "prompt" && decision !== "forbidden") {
		throw new RuleSyntaxError(path, call.line, `unknown decision ${decision}`);
	}
	const rawJustification = arguments_.get("justification");
	const justification =
		rawJustification === undefined ? undefined : stringValue(rawJustification, "justification", path, call.line);
	if (justification?.trim() === "") {
		throw new RuleSyntaxError(path, call.line, "justification cannot be empty");
	}
	return {
		rule: Object.freeze({ pattern, decision, ...(justification ? { justification } : {}) }),
		examples: Object.freeze({
			line: call.line,
			rule: Object.freeze({ pattern, decision, ...(justification ? { justification } : {}) }),
			match: exampleValues(arguments_.get("match"), "match", path, call.line),
			notMatch: exampleValues(arguments_.get("not_match"), "not_match", path, call.line),
		}),
	};
}

function parseHostExecutable(call: ParsedCall, path: string): HostExecutable {
	const arguments_ = callArguments(call, ["name", "paths"], path);
	const name = nonEmptyString(arguments_.get("name")!, "name", path, call.line);
	if (basename(name) !== name || name === "." || name === "..") {
		throw new RuleSyntaxError(path, call.line, "host executable name must be a basename");
	}
	const paths = listValue(arguments_.get("paths"), "paths", path, call.line).map((entry) => {
		const executable = nonEmptyString(entry, "host executable path", path, call.line);
		if (!isAbsolute(executable) || normalize(executable) !== executable || basename(executable) !== name) {
			throw new RuleSyntaxError(path, call.line, `host executable path must be canonical and end in ${name}`);
		}
		return executable;
	});
	return Object.freeze({ name, paths: Object.freeze([...new Set(paths)]) });
}

export function parseCommandPolicy(contents: string, path: string): CommandPolicy {
	const calls = new StarlarkCallParser(contents, path).parse();
	const rules: CommandRule[] = [];
	const examples: PendingExamples[] = [];
	const hostExecutables = new Map<string, HostExecutable>();
	for (const call of calls) {
		if (call.name === "prefix_rule") {
			const parsed = parsePrefixRule(call, path);
			rules.push(parsed.rule);
			examples.push(parsed.examples);
			continue;
		}
		if (call.name === "host_executable") {
			const host = parseHostExecutable(call, path);
			hostExecutables.set(host.name, host);
			continue;
		}
		throw new RuleSyntaxError(path, call.line, `unknown rule function ${call.name}`);
	}
	const hosts = Object.freeze([...hostExecutables.values()]);
	for (const pending of examples) {
		for (const command of pending.match) {
			if (matchingCommandRules([pending.rule], hosts, command).length === 0) {
				throw new RuleSyntaxError(path, pending.line, `example did not match: ${command.join(" ")}`);
			}
		}
		for (const command of pending.notMatch) {
			if (matchingCommandRules([pending.rule], hosts, command).length > 0) {
				throw new RuleSyntaxError(path, pending.line, `not_match example matched: ${command.join(" ")}`);
			}
		}
	}
	return Object.freeze({ rules: Object.freeze(rules), hostExecutables: hosts });
}
