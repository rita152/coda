import type { WorkJournal, WorkJournalRecord, WorkJournalRestore } from "./ports.ts";

export class MemoryWorkJournal implements WorkJournal {
	readonly records: WorkJournalRecord[];
	#closed = false;

	constructor(records: readonly WorkJournalRecord[] = []) {
		this.records = structuredClone([...records]);
	}

	load(): Promise<WorkJournalRestore> {
		if (this.#closed) return Promise.reject(new Error("Work Journal is closed"));
		return Promise.resolve({ records: structuredClone(this.records), diagnostics: [] });
	}

	append(record: WorkJournalRecord): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("Work Journal is closed"));
		this.records.push(structuredClone(record));
		return Promise.resolve();
	}

	flush(): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("Work Journal is closed"));
		return Promise.resolve();
	}

	close(): Promise<void> {
		this.#closed = true;
		return Promise.resolve();
	}
}
