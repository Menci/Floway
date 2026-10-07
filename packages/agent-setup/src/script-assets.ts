import {
  SETUP_BASH_CLAUDE,
  SETUP_BASH_CODEX,
  SETUP_BASH_COMMON,
  SETUP_BASH_PI,
  SETUP_NODE_JSONC_EDIT,
  SETUP_POWERSHELL_CLAUDE,
  SETUP_POWERSHELL_CODEX,
  SETUP_POWERSHELL_COMMON,
  SETUP_POWERSHELL_PI,
} from './script-assets.generated.ts';

export type ScriptAgent = 'claude' | 'codex' | 'pi';
export type ScriptLanguage = 'sh' | 'ps1';

// The Pi installers edit JSONC config files with an embedded Node helper. The
// served body carries the helper's source and each installer writes it to its
// private temporary directory before use, so no second download is needed.
const BASH_PI_PRELUDE = `
_write_jsonc_editor() {
  cat <<'EOF' > "$SETUP_TMPDIR/jsonc-edit.mjs"
${SETUP_NODE_JSONC_EDIT}
EOF
}
`;

const POWERSHELL_PI_PRELUDE = `
function Write-SetupJsoncEditor {
  $target = Join-Path $script:PiTmpDir 'jsonc-edit.mjs'
  $content = @'
${SETUP_NODE_JSONC_EDIT}
'@
  [System.IO.File]::WriteAllText($target, $content, [System.Text.Encoding]::UTF8)
}
`;

export const SETUP_SCRIPT_BODIES = {
  claude: {
    sh: SETUP_BASH_COMMON + SETUP_BASH_CLAUDE,
    ps1: SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_CLAUDE,
  },
  codex: {
    sh: SETUP_BASH_COMMON + SETUP_BASH_CODEX,
    ps1: SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_CODEX,
  },
  pi: {
    sh: SETUP_BASH_COMMON + BASH_PI_PRELUDE + SETUP_BASH_PI,
    ps1: SETUP_POWERSHELL_COMMON + POWERSHELL_PI_PRELUDE + SETUP_POWERSHELL_PI,
  },
} as const satisfies Record<ScriptAgent, Record<ScriptLanguage, string>>;
