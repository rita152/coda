// Static CLI compatibility re-export. The authoritative implementation belongs to the
// versioned legacy-coding-tools binding so Runtime policy/freshness never uses a second parser.

export {
  LEGACY_BASH_ANALYSIS_VERSION,
  analyzeBashCommand,
  analyzeBashPaths,
} from '../integrations/legacy-coding-tools/bash-analyze.js';
export type {
  BashAnalysis,
  BashPathAnalysis,
  BashPathTarget,
  LegacyBashFilesystemTarget,
  LegacyFilesystemTarget,
} from '../integrations/legacy-coding-tools/bash-analyze.js';
