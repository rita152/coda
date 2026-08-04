// Low-level implementations for the built-in coding capabilities. Registration metadata,
// schemas and policy bindings are composed atomically by integrations/coding-capabilities.

export {
  BASH_DESCRIPTION,
  BASH_PROMPT_SNIPPET,
  bashParameters,
  executeBash,
  type BashArgs,
  type BashDetails,
} from './bash.js';
export {
  EDIT_DESCRIPTION,
  EDIT_PROMPT_SNIPPET,
  editParameters,
  executeEdit,
  prepareEditArguments,
  type EditArgs,
  type EditDetails,
} from './edit.js';
export {
  GLOB_DESCRIPTION,
  executeGlob,
  globParameters,
  type GlobArgs,
} from './glob.js';
export {
  GREP_DESCRIPTION,
  executeGrep,
  grepParameters,
  type GrepArgs,
  type GrepDetails,
} from './grep.js';
export {
  LS_DESCRIPTION,
  executeLs,
  lsParameters,
  type LsArgs,
} from './ls.js';
export {
  PLAN_DESCRIPTION,
  PLAN_PROMPT_SNIPPET,
  executePlan,
  planParameters,
  type PlanArgs,
  type PlanDetails,
} from './plan.js';
export {
  READ_DESCRIPTION,
  READ_PROMPT_SNIPPET,
  executeRead,
  readParameters,
  type ReadArgs,
  type ReadDetails,
} from './read.js';
export {
  WRITE_DESCRIPTION,
  executeWrite,
  writeParameters,
  type WriteArgs,
  type WriteDetails,
} from './write.js';
export type {
  ToolContext,
  ToolExecutionInput,
  ToolOutput,
} from './types.js';
