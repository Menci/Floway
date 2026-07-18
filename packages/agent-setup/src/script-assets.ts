import {
  SETUP_BASH_CLAUDE,
  SETUP_BASH_CODEX,
  SETUP_BASH_COMMON_HELPERS,
  SETUP_BASH_COMMON_MAIN,
  SETUP_BASH_COMMON_OUTPUT,
  SETUP_POWERSHELL_CLAUDE,
  SETUP_POWERSHELL_CODEX,
  SETUP_POWERSHELL_COMMON_HELPERS,
  SETUP_POWERSHELL_COMMON_MAIN,
  SETUP_POWERSHELL_COMMON_OUTPUT,
} from './script-assets.generated.ts';

export type ScriptAgent = 'claude' | 'codex';
export type ScriptLanguage = 'sh' | 'ps1';

const bashCommon = SETUP_BASH_COMMON_OUTPUT + SETUP_BASH_COMMON_HELPERS + SETUP_BASH_COMMON_MAIN;
const powerShellCommon = SETUP_POWERSHELL_COMMON_OUTPUT + SETUP_POWERSHELL_COMMON_HELPERS + SETUP_POWERSHELL_COMMON_MAIN;

export const SETUP_SCRIPT_BODIES = {
  claude: {
    sh: bashCommon + SETUP_BASH_CLAUDE,
    ps1: powerShellCommon + SETUP_POWERSHELL_CLAUDE,
  },
  codex: {
    sh: bashCommon + SETUP_BASH_CODEX,
    ps1: powerShellCommon + SETUP_POWERSHELL_CODEX,
  },
} as const satisfies Record<ScriptAgent, Record<ScriptLanguage, string>>;
