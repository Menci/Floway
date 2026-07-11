// Builds the copyable one-line Agent Setup commands. The gateway never learns
// its own public origin, so each command injects this dashboard's origin into
// the shell that executes the fetched installer body and points the fetch URL at
// that same variable — the origin literal appears exactly once, and the fixed
// installer body reads the origin from there. `scriptPath` is the origin-relative
// `/api/setup/<token>/setup.(sh|ps1)` the lease projection returns.

import { posixShellLiteral, powerShellLiteral } from './shell-literal.ts';

// Bash: the piped `bash` is a child process, so the origin is exported to cross
// the process boundary; `curl` expands that exported variable to fetch the body.
export const buildShellSetupCommand = (origin: string, scriptPath: string): string =>
  `export FLOWAY_BASE_URL=${posixShellLiteral(origin)}; curl -fsSL "$FLOWAY_BASE_URL${scriptPath}" | bash`;

// PowerShell: `iex` runs in this runspace, so the origin is a plain in-process
// variable; `irm` expands it to fetch the body executed in that same scope.
export const buildPowerShellSetupCommand = (origin: string, scriptPath: string): string =>
  `$FlowayBaseUrl = ${powerShellLiteral(origin)}; irm "$FlowayBaseUrl${scriptPath}" | iex`;
