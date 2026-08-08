import { type Clock, Component, createSystemScheduler, ProcessTerminal, Tui } from "../src/index.ts";

class EmptyComponent extends Component {
	render(_width: number): string[] {
		return [];
	}
}

export function composeWithNodeStreams(clock: Clock): Tui {
	const terminal = new ProcessTerminal({
		environment: process.env,
		input: process.stdin,
		output: process.stdout,
		scheduler: createSystemScheduler(),
	});
	return new Tui({
		clock,
		keybindings: [],
		root: new EmptyComponent(),
		scheduler: createSystemScheduler(),
		terminal,
	});
}
