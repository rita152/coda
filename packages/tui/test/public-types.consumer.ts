import {
	type Clock,
	Component,
	createSystemScheduler,
	ProcessTerminal,
	type RenderContext,
	Tui,
} from "../src/index.ts";

class EmptyComponent extends Component {
	render(_context: RenderContext): string[] {
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
