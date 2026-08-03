// Explorer 工具的紧凑 presentation 投影：只归并只读浏览，不承载工具执行或 Runtime 事实。

/** 内置只读探索工具的稳定名称集合。 */
export type ExplorationToolName = 'ls' | 'glob' | 'grep' | 'read';

/** 单次探索工具调用的、可被各终端 surface 共用的展示投影。 */
export interface ExplorationCall {
  readonly toolName: ExplorationToolName;
  readonly label: 'List' | 'Read' | 'Search';
  readonly target: string;
}

/** Explored 块中的一行；相邻 read 已经被归并。 */
export interface ExplorationRow {
  readonly toolName: ExplorationToolName;
  readonly label: ExplorationCall['label'];
  readonly target: string;
}

/** 将内置只读浏览工具的已校验参数投影为面向用户的短标签。 */
export function explorationCall(name: string, args: unknown): ExplorationCall | undefined {
  const input = asRecord(args);
  switch (name) {
    case 'read': {
      const extras: string[] = [];
      if (typeof input['offset'] === 'number') extras.push(`offset=${input['offset']}`);
      if (typeof input['limit'] === 'number') extras.push(`limit=${input['limit']}`);
      return {
        toolName: name,
        label: 'Read',
        target: `${stringField(input['path']) ?? '(unknown path)'}` +
          (extras.length === 0 ? '' : ` [${extras.join(' ')}]`),
      };
    }
    case 'ls':
      return {
        toolName: name,
        label: 'List',
        target: stringField(input['path']) ?? '.',
      };
    case 'glob':
      return {
        toolName: name,
        label: 'List',
        target: withSearchPath(
          stringField(input['pattern']) ?? '(unknown pattern)',
          stringField(input['path']),
        ),
      };
    case 'grep': {
      const limit = typeof input['limit'] === 'number' ? ` (limit ${input['limit']})` : '';
      return {
        toolName: name,
        label: 'Search',
        target: `${withSearchPath(
          stringField(input['pattern']) ?? '(unknown pattern)',
          stringField(input['path']),
        )}${limit}`,
      };
    }
    default:
      return undefined;
  }
}

/**
 * 仅合并相邻 read，保留 List/Search 的顺序和每一次独立查询。
 * 这样既能得到 “Read a, b, c”，也不会掩盖探索过程中的不同命令。
 */
export function explorationRows(calls: readonly ExplorationCall[]): readonly ExplorationRow[] {
  const rows: ExplorationRow[] = [];
  let adjacentReadTargets: Set<string> | undefined;
  for (const call of calls) {
    const previous = rows.at(-1);
    if (call.toolName === 'read' && previous?.toolName === 'read') {
      if (!adjacentReadTargets?.has(call.target)) {
        rows[rows.length - 1] = {
          ...previous,
          target: `${previous.target}, ${call.target}`,
        };
        adjacentReadTargets?.add(call.target);
      }
    } else {
      rows.push({ ...call });
      adjacentReadTargets = call.toolName === 'read' ? new Set([call.target]) : undefined;
    }
  }
  return rows;
}

/** 生成不含树状缩进的单行文字，调用方负责终端清洗和着色。 */
export function formatExplorationRow(row: ExplorationRow): string {
  return row.target === '' ? row.label : `${row.label} ${row.target}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function withSearchPath(query: string, path: string | undefined): string {
  return path === undefined || path.trim() === '' ? query : `${query} in ${path}`;
}
