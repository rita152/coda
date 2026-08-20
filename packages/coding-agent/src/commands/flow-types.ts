export interface CommandFlowNavigation {
	push(screen: CommandFlowScreen): void;
	replace?(screen: CommandFlowScreen): void;
	back(): void;
	close(): void;
}

export interface CommandFlowMenuItem {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly status?: string;
	readonly disabledReason?: string;
	readonly onSelect?: (navigation: CommandFlowNavigation) => Promise<void> | void;
}

export interface CommandFlowMenu {
	readonly id: string;
	readonly title: string;
	/** Called when this frame is popped, replaced, or closed. */
	readonly onDismiss?: () => void;
	readonly filterable?: boolean;
	readonly presentation?: "default" | "sessions";
	readonly emptyMessage?: string;
	readonly items: readonly CommandFlowMenuItem[];
}

export interface CommandFlowPrompt {
	readonly id: string;
	readonly title: string;
	/** Called when this frame is popped, replaced, or closed. */
	readonly onDismiss?: () => void;
	readonly label: string;
	readonly placeholder?: string;
	readonly secret?: boolean;
	readonly initialValue?: string;
	readonly onSubmit: (value: string, navigation: CommandFlowNavigation) => Promise<void> | void;
}

export type CommandFlowScreen = CommandFlowMenu | CommandFlowPrompt;

export interface CommandFlowOpener {
	open(screen: CommandFlowScreen): void;
}

export interface CommandFlowViewItem extends CommandFlowMenuItem {
	readonly selected: boolean;
}

export interface CommandFlowView {
	readonly breadcrumb: readonly string[];
	readonly menuId: string;
	readonly presentation?: CommandFlowMenu["presentation"];
	readonly emptyMessage?: string;
	readonly query?: string;
	readonly items: readonly CommandFlowViewItem[];
	readonly prompt?: {
		readonly label: string;
		readonly placeholder?: string;
		readonly displayValue: string;
		readonly secret: boolean;
	};
}

export type CommandFlowInputResult = { readonly type: "handled" } | { readonly type: "unhandled" };
