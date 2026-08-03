// CLI re-export of the authoritative analysis used by the native bash capability.

export {
  BASH_ANALYSIS_VERSION,
  analyzeBashCommand,
  analyzeBashPaths,
} from '../integrations/coding-capabilities/bash-analyze.js';
export type {
  BashAnalysis,
  BashFilesystemTarget,
  BashPathAnalysis,
  BashPathTarget,
  FilesystemTarget,
} from '../integrations/coding-capabilities/bash-analyze.js';
