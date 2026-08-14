export interface ApplicationInput {
	readonly isTTY: boolean;
	readAll(): Promise<string>;
}

export interface ApplicationOutput {
	readonly isTTY: boolean;
	write(chunk: string): void | Promise<void>;
}

export interface ApplicationIO {
	readonly stdin: ApplicationInput;
	readonly stdout: ApplicationOutput;
	readonly stderr: ApplicationOutput;
}
