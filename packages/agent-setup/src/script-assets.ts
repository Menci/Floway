import {
  SETUP_BASH_CLAUDE,
  SETUP_BASH_CODEX,
  SETUP_BASH_COMMON,
  SETUP_BASH_OMP,
  SETUP_POWERSHELL_CLAUDE,
  SETUP_POWERSHELL_CODEX,
  SETUP_POWERSHELL_COMMON,
  SETUP_POWERSHELL_OMP,
} from './script-assets.generated.ts';

export type ScriptAgent = 'claude' | 'codex' | 'omp';
export type ScriptLanguage = 'sh' | 'ps1';

export const SETUP_SCRIPT_BODIES = {
  claude: {
    sh: SETUP_BASH_COMMON + SETUP_BASH_CLAUDE,
    ps1: SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_CLAUDE,
  },
  codex: {
    sh: SETUP_BASH_COMMON + SETUP_BASH_CODEX,
    ps1: SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_CODEX,
  },
  omp: {
    sh: SETUP_BASH_COMMON + SETUP_BASH_OMP,
    ps1: SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_OMP,
  },
} as const satisfies Record<ScriptAgent, Record<ScriptLanguage, string>>;
