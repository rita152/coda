export type KeyAction = "press" | "repeat" | "release";

export type LetterKey =
	| "a"
	| "b"
	| "c"
	| "d"
	| "e"
	| "f"
	| "g"
	| "h"
	| "i"
	| "j"
	| "k"
	| "l"
	| "m"
	| "n"
	| "o"
	| "p"
	| "q"
	| "r"
	| "s"
	| "t"
	| "u"
	| "v"
	| "w"
	| "x"
	| "y"
	| "z";

export type DigitKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

export type FunctionKey = "f1" | "f2" | "f3" | "f4" | "f5" | "f6" | "f7" | "f8" | "f9" | "f10" | "f11" | "f12";

export type PunctuationKey =
	| "ampersand"
	| "apostrophe"
	| "asterisk"
	| "at"
	| "backslash"
	| "backtick"
	| "caret"
	| "colon"
	| "comma"
	| "dollar"
	| "equals"
	| "exclamation"
	| "greater-than"
	| "hash"
	| "hyphen"
	| "left-brace"
	| "left-bracket"
	| "left-parenthesis"
	| "less-than"
	| "percent"
	| "period"
	| "pipe"
	| "plus"
	| "question"
	| "right-brace"
	| "right-bracket"
	| "right-parenthesis"
	| "semicolon"
	| "slash"
	| "tilde"
	| "underscore";

export type LogicalKey =
	| LetterKey
	| DigitKey
	| FunctionKey
	| PunctuationKey
	| "backspace"
	| "delete"
	| "down"
	| "end"
	| "enter"
	| "escape"
	| "home"
	| "insert"
	| "left"
	| "page-down"
	| "page-up"
	| "right"
	| "space"
	| "tab"
	| "up";

export interface KeyInput {
	readonly type: "key";
	readonly key: LogicalKey;
	readonly text?: string;
	readonly shift: boolean;
	readonly control: boolean;
	readonly alt: boolean;
	readonly meta: boolean;
	readonly action: KeyAction;
}

export interface TextInput {
	readonly type: "text";
	readonly text: string;
}

export interface PasteInput {
	readonly type: "paste";
	readonly text: string;
}

export interface ResizeInput {
	readonly type: "resize";
	readonly columns: number;
	readonly rows: number;
}

export type MouseButton = "left" | "middle" | "none" | "right" | "wheel-down" | "wheel-up";
export type MouseAction = "move" | "press" | "release";

export interface MouseInput {
	readonly type: "mouse";
	readonly action: MouseAction;
	readonly button: MouseButton;
	readonly column: number;
	readonly row: number;
	readonly shift: boolean;
	readonly control: boolean;
	readonly alt: boolean;
}

export type TerminalInput = KeyInput | MouseInput | TextInput | PasteInput | ResizeInput;
