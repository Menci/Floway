import {
  SETUP_BASH_CLAUDE,
  SETUP_BASH_CODEX,
  SETUP_BASH_COMMON,
  SETUP_BASH_ZED,
  SETUP_BASH_VSCODE,
  SETUP_POWERSHELL_CLAUDE,
  SETUP_POWERSHELL_CODEX,
  SETUP_POWERSHELL_COMMON,
  SETUP_POWERSHELL_ZED,
  SETUP_POWERSHELL_VSCODE,
} from './script-assets.generated.ts';

export type ScriptAgent = 'claude' | 'codex' | 'zed' | 'vscode';
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
  zed: {
    sh: SETUP_BASH_COMMON + SETUP_BASH_ZED,
    ps1: SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_ZED,
  },
  vscode: {
    sh: SETUP_BASH_COMMON + SETUP_BASH_VSCODE,
    ps1: SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_VSCODE,
  },
} as const satisfies Record<ScriptAgent, Record<ScriptLanguage, string>>;
