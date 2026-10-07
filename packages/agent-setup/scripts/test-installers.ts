// Isolated integration harness for the fixed Agent Setup installer bodies.
//
// The gateway serves each setup script as a language-native assignment prefix
// (rendered here through the real `render.ts`) plus a fixed checked-in body.
// This harness executes that exact concatenation inside throwaway HOME,
// CLAUDE_CONFIG_DIR, CODEX_HOME, and PATH roots against fake Claude Code and
// Codex CLIs, fake installer hooks, and local HTTP fixtures, then inspects
// files, protocol records, permissions, rollback, and output.
// The full host run exercises more than 90 behavior cases across Bash and
// PowerShell, including a real Codex 0.144.5 app-server smoke when that exact
// CLI is present.
// Individual cases skip only when their host prerequisite is absent or blocks
// isolation: PowerShell, the pinned Codex binary, jq-bootstrap network access,
// or an actually absent Codex at every known global location. The harness never
// touches the user's real config or credentials.
//
// Run the whole suite with `pnpm run test:installers`, or scope it with
// `--agent claude` / `--agent codex`.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type { AgentSetupConfiguration } from '../src/configuration.ts';
import { renderPowerShellPrefix, renderShellPrefix } from '../src/render.ts';
import {
  SETUP_BASH_CLAUDE,
  SETUP_BASH_CODEX,
  SETUP_BASH_COMMON,
  SETUP_BASH_PI,
  SETUP_POWERSHELL_CLAUDE,
  SETUP_POWERSHELL_CODEX,
  SETUP_POWERSHELL_COMMON,
  SETUP_POWERSHELL_PI,
} from '../src/script-assets.generated.ts';
import { type ScriptAgent, SETUP_SCRIPT_BODIES } from '../src/script-assets.ts';

const powerShellLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const AGENT_NAMES: Record<ScriptAgent, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi' };
const shellEntry = (agent: ScriptAgent): string => `main '${AGENT_NAMES[agent]}' "$@"`;
const powerShellEntry = (agent: ScriptAgent): string => `$global:LASTEXITCODE = Main '${AGENT_NAMES[agent]}'`;
const shellBody = (agent: ScriptAgent): string => SETUP_SCRIPT_BODIES[agent].sh;
const powerShellBody = (agent: ScriptAgent): string => SETUP_SCRIPT_BODIES[agent].ps1;
const ALL_BASH_FRAGMENTS = SETUP_BASH_COMMON + SETUP_BASH_CLAUDE + SETUP_BASH_CODEX + SETUP_BASH_PI;
const ALL_POWERSHELL_FRAGMENTS = SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_CLAUDE + SETUP_POWERSHELL_CODEX + SETUP_POWERSHELL_PI;

// A fixed, highly greppable fake credential. Every test asserts this string
// never reaches the installer's stdout/stderr, so a real leak is unmistakable.
const SENTINEL_KEY = 'sk-floway-SENTINEL-Do-Not-Log-9f3c1a7b2e4d6058';

// --- tiny test runner -------------------------------------------------------

class SkipError extends Error {}
const skip: (reason: string) => never = reason => { throw new SkipError(reason); };

interface Assert {
  ok(cond: boolean, message?: string): void;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  includes(haystack: string, needle: string, message?: string): void;
  excludes(haystack: string, needle: string, message?: string): void;
}

const makeAssert = (): Assert => ({
  ok(cond, message) { if (!cond) throw new Error(message ?? 'assertion failed'); },
  equal(actual, expected, message) {
    if (actual !== expected) throw new Error(`${message ?? 'equality failed'}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  },
  notEqual(actual, expected, message) {
    if (actual === expected) throw new Error(`${message ?? 'inequality failed'}\n  expected not to equal: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  },
  includes(haystack, needle, message) {
    if (!haystack.includes(needle)) throw new Error(`${message ?? 'substring missing'}\n  expected to find: ${JSON.stringify(needle)}\n  within: ${JSON.stringify(haystack.slice(0, 4000))}`);
  },
  excludes(haystack, needle, message) {
    if (haystack.includes(needle)) throw new Error(`${message ?? 'unexpected substring'}\n  unexpected substring present: ${JSON.stringify(needle)}`);
  },
});

type TestFn = (t: Assert) => void | Promise<void>;
interface Case { agent: ScriptAgent; name: string; fn: TestFn }
const cases: Case[] = [];
const test = (agent: ScriptAgent, name: string, fn: TestFn): void => { cases.push({ agent, name, fn }); };

// --- shared fixtures --------------------------------------------------------

const HARNESS_ROOT = mkdtempSync(join(tmpdir(), 'floway-installer-harness.'));
const cleanupPaths: string[] = [HARNESS_ROOT];

const hostJqPath = spawnSync('/bin/sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim() || null;
const HOST_JQ_BIN = join(HARNESS_ROOT, 'host-jq-bin');
mkdirSync(HOST_JQ_BIN);
if (hostJqPath) symlinkSync(hostJqPath, join(HOST_JQ_BIN, 'jq'));

// A hermetic tool directory: symlinks to exactly the external commands the
// installer uses — deliberately excluding jq, whose presence each test controls
// through PATH. Building this rather than leaning on `/usr/bin` matters because
// some hosts ship a `/usr/bin/jq`, which would otherwise defeat the
// jq-absent cases.
const SHIM_BIN = join(HARNESS_ROOT, 'shim-bin');
mkdirSync(SHIM_BIN);
const resolveTool = (name: string): string | null => {
  const found = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
  return found || null;
};
for (const tool of ['sh', 'bash', 'env', 'awk', 'cat', 'chmod', 'cmp', 'cp', 'date', 'mkdir', 'mkfifo', 'mktemp', 'mv', 'rm', 'shasum', 'sleep', 'uname', 'curl']) {
  const path = resolveTool(tool);
  if (!path) throw new Error(`required tool ${tool} is not available on the host; cannot run the installer harness`);
  symlinkSync(path, join(SHIM_BIN, tool));
}
for (const tool of ['sha256sum', 'openssl', 'timeout', 'gtimeout', 'node']) {
  const path = resolveTool(tool);
  if (path) symlinkSync(path, join(SHIM_BIN, tool));
}

// Absolute path to a PowerShell interpreter, when one is installed. The
// PowerShell cases parse (always) and — where an interpreter exists — execute
// the same body the gateway serves, so the ConvertFrom/To-Json merge and
// configuration logic is exercised rather than merely syntax-checked.
const hostPwsh = resolveTool('pwsh') ?? resolveTool('powershell');
const NO_TIMEOUT_BIN = join(HARNESS_ROOT, 'no-timeout-bin');
mkdirSync(NO_TIMEOUT_BIN);
for (const tool of readdirSync(SHIM_BIN)) {
  if (tool !== 'timeout' && tool !== 'gtimeout') symlinkSync(join(SHIM_BIN, tool), join(NO_TIMEOUT_BIN, tool));
}
if (hostJqPath) symlinkSync(hostJqPath, join(NO_TIMEOUT_BIN, 'jq'));

// A tool directory without Node.js, for the Pi cases that assert the missing
// prerequisite is reported.
const NO_NODE_BIN = join(HARNESS_ROOT, 'no-node-bin');
mkdirSync(NO_NODE_BIN);
for (const tool of readdirSync(SHIM_BIN)) {
  if (tool !== 'node') symlinkSync(join(SHIM_BIN, tool), join(NO_NODE_BIN, tool));
}
if (hostJqPath) symlinkSync(hostJqPath, join(NO_NODE_BIN, 'jq'));

// The fake `claude` mirrors the only CLI surface setup invokes: `--version`
// prints `<semver> (Claude Code)` and can be delayed for timeout coverage.
const FAKE_CLAUDE = `#!/bin/bash
if [ "\${SETUP_API_KEY+x}" = x ] || [ "\${SetupApiKey+x}" = x ]; then
  printf 'fake claude inherited the setup API key environment variable\\n' >&2
  exit 91
fi
case "$1" in
  --version)
    if [ "\${FAKE_CLAUDE_VERSION_SLEEP:-0}" -gt 0 ]; then sleep "$FAKE_CLAUDE_VERSION_SLEEP"; fi
    printf '%s\\n' "\${FAKE_CLAUDE_VERSION:-9.9.9 (Claude Code)}"
    ;;
  *)
    printf 'fake claude: unhandled args: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`;

// The fake installer drops a `claude` into the user-local native location and
// records that it ran, so tests can assert the installer fires only when absent.
const FAKE_INSTALLER = `#!/bin/bash
set -eu
if [ "\${SETUP_API_KEY+x}" = x ] || [ "\${SetupApiKey+x}" = x ]; then
  printf 'fake installer inherited the setup API key environment variable\\n' >&2
  exit 92
fi
if [ "\${FAKE_INSTALLER_SLEEP:-0}" -gt 0 ]; then
  bash -c '
    sleep "$FAKE_INSTALLER_SLEEP" &
    grandchild=$!
    if [ -n "$FAKE_INSTALLER_CHILD_PID_FILE" ]; then printf "%s\\n" "$grandchild" > "$FAKE_INSTALLER_CHILD_PID_FILE"; fi
    wait "$grandchild"
  ' &
  child=$!
  wait "$child"
fi
target="$HOME/.local/bin"
mkdir -p "$target"
cp "$FAKE_CLAUDE_SRC" "$target/claude"
chmod 755 "$target/claude"
: > "$FAKE_INSTALLER_MARKER"
`;

// The fake `codex` mirrors the real CLI's observable surface for setup:
// `--version` prints a raw version line, and `app-server` speaks the real
// newline-delimited JSON-RPC handshake (initialize -> initialized ->
// config/batchWrite) that the installer drives to write config.toml. It is a
// Node script (shebang points at this run's interpreter) so JSON framing is
// exact. Behavior is steered by FAKE_CODEX_* env vars: response status, an
// injected delay, a malformed line, a JSON-RPC error, or a premature exit
// before answering. It records every received message plus ordering markers to
// FAKE_CODEX_RECORD so tests can assert the exact edits, the handshake order,
// and that stdin stayed open until the batch response was sent. It refuses to
// run if the API key ever reaches it through the environment or a request, and
// exits cleanly on stdin EOF. Newlines are emitted via String.fromCharCode(10)
// to keep the source free of escape hazards inside this template literal.
const FAKE_CODEX = `#!${process.execPath}
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn: spawnChild } = require('child_process');
const NL = String.fromCharCode(10);
const REC = process.env.FAKE_CODEX_RECORD || '';
const rec = (o) => { if (REC) fs.appendFileSync(REC, JSON.stringify(o) + NL); };
const SENTINEL = process.env.FAKE_CODEX_SENTINEL || '';
if (process.env.SETUP_API_KEY !== undefined || process.env.SetupApiKey !== undefined) {
  process.stderr.write('fake codex inherited the setup API key environment variable' + NL);
  process.exit(91);
}
const expectedNonInteractive = process.env.FAKE_CODEX_EXPECT_NON_INTERACTIVE;
const actualNonInteractive = process.env.CODEX_NON_INTERACTIVE;
if ((expectedNonInteractive === undefined && actualNonInteractive !== undefined)
    || (expectedNonInteractive !== undefined && actualNonInteractive !== expectedNonInteractive)) {
  process.stderr.write('fake codex observed unexpected CODEX_NON_INTERACTIVE after installation' + NL);
  process.exit(92);
}
const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === '--version') {
  const sleep = Number(process.env.FAKE_CODEX_VERSION_SLEEP || 0);
  const emit = () => { process.stdout.write((process.env.FAKE_CODEX_VERSION || 'codex-cli 9.9.9') + NL); process.exit(0); };
  if (sleep > 0) setTimeout(emit, sleep * 1000); else emit();
} else if (cmd === 'app-server') {
  const mode = process.env.FAKE_CODEX_APP_SERVER_MODE || 'ok';
  const batchDelay = Number(process.env.FAKE_CODEX_BATCH_DELAY || 0);
  if (process.env.FAKE_CODEX_LARGE_STDERR) process.stderr.write('E'.repeat(300000) + NL);
  const send = (o) => process.stdout.write(JSON.stringify(o) + NL);
  const home = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf(NL)) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim() !== '') handleLine(line);
    }
  });
  process.stdin.on('end', () => { rec({ marker: 'stdin-eof' }); process.exit(0); });
  function handleLine(line) {
    if (SENTINEL && line.indexOf(SENTINEL) >= 0) {
      process.stderr.write('fake codex app-server received the API key in a request' + NL);
      process.exit(93);
    }
    let msg;
    try { msg = JSON.parse(line); } catch (e) { rec({ marker: 'unparseable', line: line }); return; }
    rec({ received: { method: msg.method, id: msg.id, params: msg.params } });
    if (msg.method === 'initialize') {
      if (mode === 'no-initialize-response') return;
      const response = { id: msg.id, result: { userAgent: 'fake-codex/9.9.9', codexHome: home, platformFamily: 'unix', platformOs: 'linux' } };
      if (mode === 'close-request-after-initialize') {
        const payload = JSON.stringify(response) + NL;
        const childCode = 'setTimeout(() => process.stdout.write(' + JSON.stringify(payload) + '), 100)';
        spawnChild(process.execPath, ['-e', childCode], { stdio: ['ignore', 'inherit', 'inherit'] });
        process.exit(0);
      }
      send(response);
      send({ jsonrpc: '2.0', method: 'remoteControl/status/changed', params: { status: 'disabled' } });
      return;
    }
    if (msg.method === 'initialized') { rec({ marker: 'initialized' }); return; }
    if (msg.method === 'config/batchWrite') {
      const respond = () => {
        rec({ marker: 'batch-respond', edits: (msg.params && msg.params.edits) || null });
        if (mode === 'premature-eof') { process.exit(0); }
        if (mode === 'malformed') { process.stdout.write('this-is-not-json for id ' + msg.id + NL); return; }
        if (mode === 'error') { send({ id: msg.id, error: { code: -32000, message: 'batchWrite exploded' } }); return; }
        if (mode === 'okOverridden') {
          send({ id: msg.id, result: { status: 'okOverridden', version: 'sha256:v', filePath: home + '/config.toml', overriddenMetadata: { message: 'Overridden by session flags', overridingLayer: { name: { type: 'sessionFlags' }, version: 'sha256:l' }, effectiveValue: 'shadow-model' } } });
          return;
        }
        send({ id: msg.id, result: { status: 'ok', version: 'sha256:v', filePath: home + '/config.toml', overriddenMetadata: null } });
      };
      if (batchDelay > 0) setTimeout(respond, batchDelay * 1000); else respond();
      return;
    }
    rec({ marker: 'other', method: msg.method });
  }
} else {
  process.stderr.write('fake codex: unhandled args: ' + argv.join(' ') + NL);
  process.exit(2);
}
`;

// The fake Codex installer drops `codex` into the user-local native location
// and records that it ran, mirroring the Claude installer fixture so the shared
// timeout/process-tree assertions apply to either agent-specific script.
const FAKE_CODEX_INSTALLER = `#!/bin/bash
set -eu
if [ "\${SETUP_API_KEY+x}" = x ] || [ "\${SetupApiKey+x}" = x ]; then
  printf 'fake codex installer inherited the setup API key environment variable\\n' >&2
  exit 92
fi
if [ "\${CODEX_NON_INTERACTIVE:-}" != true ]; then
  printf 'fake codex installer did not receive CODEX_NON_INTERACTIVE=true\\n' >&2
  exit 94
fi
if [ -n "\${FAKE_INSTALLER_OBSERVED_NON_INTERACTIVE:-}" ]; then
  printf '%s' "$CODEX_NON_INTERACTIVE" > "$FAKE_INSTALLER_OBSERVED_NON_INTERACTIVE"
fi
if [ "\${FAKE_INSTALLER_SLEEP:-0}" -gt 0 ]; then
  bash -c '
    sleep "$FAKE_INSTALLER_SLEEP" &
    grandchild=$!
    if [ -n "$FAKE_INSTALLER_CHILD_PID_FILE" ]; then printf "%s\\n" "$grandchild" > "$FAKE_INSTALLER_CHILD_PID_FILE"; fi
    wait "$grandchild"
  ' &
  child=$!
  wait "$child"
fi
target="$HOME/.local/bin"
mkdir -p "$target"
cp "$FAKE_CODEX_SRC" "$target/codex"
chmod 755 "$target/codex"
: > "$FAKE_INSTALLER_MARKER"
`;

const FIXTURES = join(HARNESS_ROOT, 'fixtures');
mkdirSync(FIXTURES, { recursive: true });
const FAKE_CLAUDE_SRC = join(FIXTURES, 'claude');
writeFileSync(FAKE_CLAUDE_SRC, FAKE_CLAUDE, { mode: 0o755 });
const FAKE_INSTALLER_SCRIPT = join(FIXTURES, 'install-claude.sh');
writeFileSync(FAKE_INSTALLER_SCRIPT, FAKE_INSTALLER, { mode: 0o755 });
const FAKE_CODEX_SRC = join(FIXTURES, 'codex');
writeFileSync(FAKE_CODEX_SRC, FAKE_CODEX, { mode: 0o755 });
const FAKE_CODEX_INSTALLER_SCRIPT = join(FIXTURES, 'install-codex.sh');
writeFileSync(FAKE_CODEX_INSTALLER_SCRIPT, FAKE_CODEX_INSTALLER, { mode: 0o755 });

// The fake `pi` mirrors the observable CLI surface setup invokes:
// `--version` prints a version line.
const FAKE_PI = `#!/bin/bash
if [ "\${SETUP_API_KEY+x}" = x ] || [ "\${SetupApiKey+x}" = x ]; then
  printf 'fake pi inherited the setup API key environment variable\\n' >&2
  exit 91
fi
case "$1" in
  --version)
    if [ "\${FAKE_PI_VERSION_SLEEP:-0}" -gt 0 ]; then sleep "$FAKE_PI_VERSION_SLEEP"; fi
    printf '%s\\n' "\${FAKE_PI_VERSION:-1.0.4}"
    ;;
  *)
    printf 'fake pi: unhandled args: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`;

const FAKE_PI_INSTALLER = `#!/bin/bash
set -eu
if [ "\${SETUP_API_KEY+x}" = x ] || [ "\${SetupApiKey+x}" = x ]; then
  printf 'fake pi installer inherited the setup API key environment variable\\n' >&2
  exit 92
fi
target="$HOME/.local/bin"
mkdir -p "$target"
cp "$FAKE_PI_SRC" "$target/pi"
chmod 755 "$target/pi"
: > "$FAKE_INSTALLER_MARKER"
`;

const FAKE_PI_SRC = join(FIXTURES, 'pi');
writeFileSync(FAKE_PI_SRC, FAKE_PI, { mode: 0o755 });
const FAKE_PI_INSTALLER_SCRIPT = join(FIXTURES, 'install-pi.sh');
writeFileSync(FAKE_PI_INSTALLER_SCRIPT, FAKE_PI_INSTALLER, { mode: 0o755 });

// --- local HTTP fixtures ----------------------------------------------------

type ModelServerMode =
  | 'ok'
  | 'installer-sh' | 'installer-ps1' | 'installer-html'
  | 'installer-codex-sh' | 'installer-codex-ps1'
  | 'installer-pi-sh' | 'installer-pi-ps1';
interface ModelServer {
  url: string;
  readonly requests: { method: string; path: string }[];
  mode: ModelServerMode;
  reset(): void;
  close(): Promise<void>;
}

const PS1_FAKE_INSTALLER_BODY = (binName: string, src: string): string =>
  `if ($env:SETUP_API_KEY) { throw 'installer inherited secret' }
if ($env:CODEX_NON_INTERACTIVE -ne 'true' -and '${binName}' -eq 'codex') { throw 'codex installer did not receive CODEX_NON_INTERACTIVE=true' }
if ($env:FAKE_INSTALLER_OBSERVED_NON_INTERACTIVE -and '${binName}' -eq 'codex') { [IO.File]::WriteAllText($env:FAKE_INSTALLER_OBSERVED_NON_INTERACTIVE, [string]$env:CODEX_NON_INTERACTIVE) }
if ($env:FAKE_INSTALLER_OBSERVED_COMMAND_LINE -and '${binName}' -eq 'codex') { [IO.File]::WriteAllText($env:FAKE_INSTALLER_OBSERVED_COMMAND_LINE, [Environment]::CommandLine) }
if ([int]$env:FAKE_INSTALLER_SLEEP -gt 0) {
  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = '/bin/sleep'
  $processInfo.Arguments = $env:FAKE_INSTALLER_SLEEP
  $processInfo.UseShellExecute = $false
  $child = New-Object System.Diagnostics.Process
  $child.StartInfo = $processInfo
  [void]$child.Start()
  if ($env:FAKE_INSTALLER_CHILD_PID_FILE) { [IO.File]::WriteAllText($env:FAKE_INSTALLER_CHILD_PID_FILE, [string]$child.Id) }
  $child.WaitForExit()
}
$target = Join-Path $HOME '.local/bin'
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -LiteralPath $env:${src} -Destination (Join-Path $target '${binName}') -Force
& chmod 755 (Join-Path $target '${binName}')
New-Item -ItemType File -Path $env:FAKE_INSTALLER_MARKER -Force | Out-Null
`;

const startModelServer = async (): Promise<ModelServer> => {
  const state = {
    mode: 'ok' as ModelServerMode,
    requests: [] as { method: string; path: string }[],
  };
  const HTML_BODY = '<!DOCTYPE html><HTML><BODY>blocked</BODY></HTML>';
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    state.requests.push({ method: req.method ?? '', path: pathname });
    // Unauthenticated probe bodies for the command-injection-semantics tests:
    // each echoes the base URL the wrapping command injected into the executing
    // shell, so the harness can confirm `export SETUP_ENDPOINT` / `$SetupEndpoint`
    // actually reached the piped `bash` / the `iex` runspace.
    if (pathname === '/probe/setup.sh') {
      res.writeHead(200, { 'content-type': 'text/x-shellscript' });
      res.end('printf \'PROBE_BASE_URL=[%s]\\n\' "${SETUP_ENDPOINT:-UNSET}"\n');
      return;
    }
    if (pathname === '/probe/setup.ps1') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Write-Output "PROBE_BASE_URL=[$(if ($null -eq $SetupEndpoint) { \'UNSET\' } else { $SetupEndpoint })]"\n');
      return;
    }
    if (pathname === '/install.sh' || pathname === '/install-codex.sh' || pathname === '/install-pi.sh') {
      if (state.mode === 'installer-html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(HTML_BODY);
        return;
      }
      if (state.mode === 'installer-sh') {
        res.writeHead(200, { 'content-type': 'text/x-shellscript' });
        res.end(FAKE_INSTALLER);
        return;
      }
      if (state.mode === 'installer-codex-sh') {
        res.writeHead(200, { 'content-type': 'text/x-shellscript' });
        res.end(FAKE_CODEX_INSTALLER);
        return;
      }
      if (state.mode === 'installer-pi-sh') {
        res.writeHead(200, { 'content-type': 'text/x-shellscript' });
        res.end(FAKE_PI_INSTALLER);
        return;
      }
    }
    if (pathname === '/install.ps1' || pathname === '/install-codex.ps1' || pathname === '/install-pi.ps1') {
      if (state.mode === 'installer-html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(HTML_BODY);
        return;
      }
      if (state.mode === 'installer-ps1') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(PS1_FAKE_INSTALLER_BODY('claude', 'FAKE_CLAUDE_SRC'));
        return;
      }
      if (state.mode === 'installer-codex-ps1') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(PS1_FAKE_INSTALLER_BODY('codex', 'FAKE_CODEX_SRC'));
        return;
      }
      if (state.mode === 'installer-pi-ps1') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(PS1_FAKE_INSTALLER_BODY('pi', 'FAKE_PI_SRC'));
        return;
      }
    }
    if (pathname.endsWith('/pi-models.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        models: [
          {
            id: 'floway-pi-model-1',
            name: 'Floway Model 1',
            reasoning: false,
            input: ['text'],
            contextWindow: 128000,
            maxTokens: 16384,
            cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    get requests() { return state.requests; },
    get mode() { return state.mode; },
    set mode(value) { state.mode = value; },
    reset() { state.requests.length = 0; state.mode = 'ok'; },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};

// --- workspace + runner -----------------------------------------------------

interface Workspace { root: string; home: string; binDir: string }
const makeWorkspace = (): Workspace => {
  const root = mkdtempSync(join(HARNESS_ROOT, 'ws.'));
  const home = join(root, 'home');
  const binDir = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  return { root, home, binDir };
};

const placeFakeClaude = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
};

const placeFakeCodex = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'codex'), FAKE_CODEX, { mode: 0o755 });
};

const placeFakePi = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pi'), FAKE_PI, { mode: 0o755 });
};

const placeFakeNpm = (workspace: Workspace): void => {
  writeFileSync(join(workspace.binDir, 'npm'), `#!/bin/bash
if [ "\${SETUP_API_KEY+x}" = x ] || [ "\${SetupApiKey+x}" = x ]; then
  printf 'fake npm inherited the setup API key environment variable\\n' >&2
  exit 91
fi
printf '%s\\n' "$*" > "$FAKE_NPM_RECORD"
case "$*" in
  *'@anthropic-ai/claude-code'*)
    mkdir -p "$HOME/.local/bin"
    cp "$FAKE_CLAUDE_SRC" "$HOME/.local/bin/claude"
    chmod 755 "$HOME/.local/bin/claude"
    ;;
  *'@openai/codex'*)
    mkdir -p "$HOME/.local/bin"
    cp "$FAKE_CODEX_SRC" "$HOME/.local/bin/codex"
    chmod 755 "$HOME/.local/bin/codex"
    ;;
  *'@earendil-works/pi-coding-agent'*)
    mkdir -p "$HOME/.local/bin"
    cp "$FAKE_PI_SRC" "$HOME/.local/bin/pi"
    chmod 755 "$HOME/.local/bin/pi"
    ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
};

type InstallerTestConfiguration = AgentSetupConfiguration & { readonly testAgent: ScriptAgent };

const claudeConfig = (overrides: Partial<AgentSetupConfiguration['claudeCode']> = {}): InstallerTestConfiguration => ({
  testAgent: 'claude',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, modelDiscovery: false, ...overrides,
  },
  codex: { model: null, reasoningEffort: null },
  pi: { model: null },
});

const codexConfig = (overrides: Partial<AgentSetupConfiguration['codex']> = {}): InstallerTestConfiguration => ({
  testAgent: 'codex',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, modelDiscovery: false,
  },
  codex: { model: null, reasoningEffort: null, ...overrides },
  pi: { model: null },
});

const bothConfig = (
  claude: Partial<AgentSetupConfiguration['claudeCode']> = {},
  codex: Partial<AgentSetupConfiguration['codex']> = {},
  pi: Partial<AgentSetupConfiguration['pi']> = {},
): InstallerTestConfiguration => ({
  testAgent: 'claude',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, modelDiscovery: false, ...claude,
  },
  codex: { model: null, reasoningEffort: null, ...codex },
  pi: { model: null, ...pi },
});

const piConfig = (overrides: Partial<AgentSetupConfiguration['pi']> = {}): InstallerTestConfiguration => ({
  testAgent: 'pi',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, modelDiscovery: false,
  },
  codex: { model: null, reasoningEffort: null },
  pi: { model: null, ...overrides },
});

interface RunOptions {
  workspace: Workspace;
  configuration: InstallerTestConfiguration;
  agent?: ScriptAgent;
  baseUrl: string;
  // The wrapping one-line command injects the gateway origin into the executing
  // shell (Bash exports SETUP_ENDPOINT; PowerShell assigns $SetupEndpoint in the
  // iex runspace); the harness mirrors that. `baseUrlOverride` injects a
  // different value than the model-server URL (used for the invalid-origin
  // guard); `omitBaseUrl` injects nothing at all (the missing-origin guard).
  baseUrlOverride?: string;
  omitBaseUrl?: boolean;
  configDir?: string;
  includeJq?: boolean;
  disableJqDownload?: boolean;
  fakeClaudeVersion?: string;
  fakeClaudeVersionSleep?: number;
  withInstallHook?: boolean;
  installerSleep?: number;
  installerUrl?: string;
  timeoutSeconds?: number;
  ambientApiKey?: boolean;
  excludeTimeoutTools?: boolean;
  fakeChmodFailure?: boolean;
  // Shadows `mv` with a shim that fails only the rollback's restore-from-backup
  // rename, to exercise the installer's rollback-failure path.
  fakeRestoreFailure?: boolean;
  // Group-signals the running installer once it is mid Claude install (the fake
  // installer's child-pid file has appeared), to exercise the INT/TERM traps.
  signalDuringInstall?: 'SIGINT' | 'SIGTERM';
  // Codex knobs.
  codexHome?: string;
  fakeCodexVersion?: string;
  fakeCodexVersionSleep?: number;
  fakeCodexAppServerMode?: string;
  fakeCodexBatchDelay?: number;
  fakeCodexLargeStderr?: boolean;
  withCodexInstallHook?: boolean;
  // Pi knobs.
  fakePiVersion?: string;
  fakePiVersionSleep?: number;
  withPiInstallHook?: boolean;
  piInstallerUrl?: string;
  piAgentDir?: string;
  piModelsUrl?: string;
  fakePiFailConfig?: boolean;
  omitNode?: boolean;
  fakeNodeVersion?: string;
  codexInstallerUrl?: string;
  ambientCodexNonInteractive?: string;
  powerShellTimeSeparator?: string;
  // Forces the existing-file branch through File.Replace on non-Windows hosts,
  // exercising PowerShell's real-null interop without a production test hook.
  forcePowerShellWindowsReplacement?: boolean;
  // Output-contract knobs. `forceColor` sets AGENT_SETUP_TEST_FORCE_COLOR so
  // the palette is emitted even though the harness captures (never a TTY);
  // `noColor` sets NO_COLOR; `failRestore` sets AGENT_SETUP_TEST_FAIL_RESTORE
  // so the PowerShell rollback restore rename fails, exercising its recovery
  // guidance the way the Bash `mv` shim does for Bash.
  forceColor?: boolean;
  noColor?: boolean;
  failRestore?: boolean;
}

const targetAgent = (configuration: InstallerTestConfiguration, agent?: ScriptAgent): ScriptAgent =>
  agent ?? configuration.testAgent;
interface RunResult { code: number; stdout: string; stderr: string; combined: string }

// Environment shared by the shell run helpers: Codex fake-binary knobs, the
// install hook, and CODEX_HOME. Callers merge this over the Claude environment
// before running the selected agent.
const codexEnv = (options: RunOptions): Record<string, string> => {
  const env: Record<string, string> = {
    FAKE_CODEX_SRC,
    FAKE_CODEX_SENTINEL: SENTINEL_KEY,
    FAKE_CODEX_RECORD: codexRecordPath(options.workspace),
    FAKE_CODEX_VERSION_SLEEP: String(options.fakeCodexVersionSleep ?? 0),
    FAKE_CODEX_APP_SERVER_MODE: options.fakeCodexAppServerMode ?? 'ok',
    FAKE_CODEX_BATCH_DELAY: String(options.fakeCodexBatchDelay ?? 0),
    FAKE_INSTALLER_OBSERVED_NON_INTERACTIVE: join(options.workspace.root, 'installer-non-interactive.txt'),
    FAKE_INSTALLER_OBSERVED_COMMAND_LINE: join(options.workspace.root, 'installer-command-line.txt'),
  };
  if (options.ambientCodexNonInteractive !== undefined) {
    env.CODEX_NON_INTERACTIVE = options.ambientCodexNonInteractive;
    env.FAKE_CODEX_EXPECT_NON_INTERACTIVE = options.ambientCodexNonInteractive;
  }
  if (options.fakeCodexVersion) env.FAKE_CODEX_VERSION = options.fakeCodexVersion;
  if (options.fakeCodexLargeStderr) env.FAKE_CODEX_LARGE_STDERR = '1';
  if (options.codexHome) env.CODEX_HOME = options.codexHome;
  if (options.withCodexInstallHook !== false) env.AGENT_SETUP_TEST_INSTALL_CODEX_SCRIPT = FAKE_CODEX_INSTALLER_SCRIPT;
  if (options.codexInstallerUrl) env.AGENT_SETUP_TEST_CODEX_URL = options.codexInstallerUrl;
  return env;
};

// Pi fake-binary knobs, the install hook, PI_CODING_AGENT_DIR and the models
// snapshot URL override, merged like codexEnv.
const piEnv = (options: RunOptions): Record<string, string> => {
  const env: Record<string, string> = {
    FAKE_PI_SRC,
  };
  if (options.fakePiVersion) env.FAKE_PI_VERSION = options.fakePiVersion;
  if (options.fakePiVersionSleep !== undefined) env.FAKE_PI_VERSION_SLEEP = String(options.fakePiVersionSleep);
  if (options.withPiInstallHook !== false) env.AGENT_SETUP_TEST_INSTALL_PI_SCRIPT = FAKE_PI_INSTALLER_SCRIPT;
  if (options.piInstallerUrl) env.AGENT_SETUP_TEST_PI_URL = options.piInstallerUrl;
  if (options.piAgentDir) env.PI_CODING_AGENT_DIR = options.piAgentDir;
  if (options.piModelsUrl) env.AGENT_SETUP_TEST_PI_MODELS_URL = options.piModelsUrl;
  if (options.fakePiFailConfig) env.AGENT_SETUP_TEST_FAIL_CONFIG = '1';
  return env;
};

// The origin the wrapping one-line command injects into the executing shell.
const injectedBaseUrlValue = (options: RunOptions): string => options.baseUrlOverride ?? options.baseUrl;

// Bash's downstream `bash` is a child process, so the origin crosses the
// boundary through the exported environment — mirror the `export SETUP_ENDPOINT`
// the copyable command performs. Omitted entirely for the missing-origin guard.
const injectedBaseUrlEnv = (options: RunOptions): Record<string, string> =>
  options.omitBaseUrl ? {} : { SETUP_ENDPOINT: injectedBaseUrlValue(options) };

// PowerShell's `iex` runs in the caller's runspace, so the origin is a plain
// in-process variable assigned ahead of the served body — mirror the
// `$SetupEndpoint = '...'` the copyable command performs.
const powerShellBaseUrlPrelude = (options: RunOptions): string =>
  options.omitBaseUrl ? '' : `$SetupEndpoint = ${powerShellLiteral(injectedBaseUrlValue(options))}\n`;

// Runs asynchronously via `spawn` (not `spawnSync`) so local installer downloads
// can be served by this process's event loop without deadlocking.
const runShellInstaller = (options: RunOptions): Promise<RunResult> => {
  const { workspace, configuration } = options;
  const agent = targetAgent(configuration, options.agent);
  const script = renderShellPrefix({ agent, apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration, token: 'test-lease-token' }) + shellBody(agent);
  const scriptPath = join(workspace.root, 'setup.sh');
  writeFileSync(scriptPath, script);

  if (options.fakeNodeVersion && !options.omitNode) {
    writeFileSync(
      join(workspace.binDir, 'node'),
      `#!/bin/bash\nif [ "$1" = "-v" ]; then echo "${options.fakeNodeVersion}"; exit 0; fi\nexec "${join(SHIM_BIN, 'node')}" "$@"\n`,
      { mode: 0o755 },
    );
  }

  const baseBin = options.omitNode ? NO_NODE_BIN : (options.excludeTimeoutTools ? NO_TIMEOUT_BIN : SHIM_BIN);
  const pathParts = [workspace.binDir, baseBin];
  if (!options.excludeTimeoutTools && options.includeJq !== false && hostJqPath) pathParts.push(HOST_JQ_BIN);

  const env: Record<string, string> = {
    HOME: workspace.home,
    PATH: pathParts.join(':'),
    TMPDIR: workspace.root,
    ...injectedBaseUrlEnv(options),
    FAKE_CLAUDE_VERSION_SLEEP: String(options.fakeClaudeVersionSleep ?? 0),
    FAKE_INSTALLER_SLEEP: String(options.installerSleep ?? 0),
    FAKE_CLAUDE_SRC,
    FAKE_INSTALLER_MARKER: join(workspace.root, 'installer-ran'),
    FAKE_INSTALLER_CHILD_PID_FILE: join(workspace.root, 'installer-child.pid'),
    FAKE_NPM_RECORD: join(workspace.root, 'npm-record.txt'),
    ...codexEnv(options),
    ...piEnv(options),
  };
  if (options.configDir) env.CLAUDE_CONFIG_DIR = options.configDir;
  if (options.fakeClaudeVersion) env.FAKE_CLAUDE_VERSION = options.fakeClaudeVersion;
  if (options.withInstallHook !== false) env.AGENT_SETUP_TEST_INSTALL_CLAUDE_SCRIPT = FAKE_INSTALLER_SCRIPT;
  if (options.installerUrl) env.AGENT_SETUP_TEST_CLAUDE_URL = options.installerUrl;
  if (options.timeoutSeconds !== undefined) env.AGENT_SETUP_TEST_TIMEOUT_SECONDS = String(options.timeoutSeconds);
  if (options.excludeTimeoutTools) env.AGENT_SETUP_TEST_TRACE_TIMEOUT = '1';
  if (options.disableJqDownload) env.AGENT_SETUP_TEST_NO_JQ_DOWNLOAD = '1';
  if (options.forceColor) env.AGENT_SETUP_TEST_FORCE_COLOR = '1';
  if (options.noColor) env.NO_COLOR = '1';

  if (options.fakeRestoreFailure) {
    // A `mv` shim (binDir precedes SHIM_BIN on PATH) that refuses only the
    // rollback's restore rename — its source is the `.floway-backup.` file —
    // and delegates every other rename (staging included) to the real mv.
    writeFileSync(
      join(workspace.binDir, 'mv'),
      '#!/bin/bash\nfor arg in "$@"; do case "$arg" in *.floway-backup.*) exit 1 ;; esac; done\nexec "$SETUP_TEST_REAL_MV" "$@"\n',
      { mode: 0o755 },
    );
    env.SETUP_TEST_REAL_MV = join(SHIM_BIN, 'mv');
  }

  const signal = options.signalDuringInstall;
  return new Promise<RunResult>(resolve => {
    const child = spawn('/bin/bash', [scriptPath], { env, detached: signal !== undefined });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}`, combined: `${stdout}${stderr}${String(error)}` }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: `${stdout}${stderr}` }));
    if (signal !== undefined) {
      // Wait until the fake installer records its child pid (we are mid Claude
      // install), then signal the whole detached process group as a real Ctrl-C
      // would. The deadline keeps a stuck run from hanging the harness.
      const pidFile = join(workspace.root, 'installer-child.pid');
      const deadline = Date.now() + 10_000;
      const poll = setInterval(() => {
        if (existsSync(pidFile) || Date.now() > deadline) {
          clearInterval(poll);
          try { if (child.pid !== undefined) process.kill(-child.pid, signal); } catch { /* group already exited */ }
        }
      }, 25);
    }
  });
};

const runShellInstallerWithAmbientKey = (options: RunOptions): Promise<RunResult> => {
  const { workspace, configuration } = options;
  const agent = targetAgent(configuration, options.agent);
  const script = renderShellPrefix({ agent, apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration, token: 'test-lease-token' }) + shellBody(agent);
  const scriptPath = join(workspace.root, 'setup-ambient-key.sh');
  writeFileSync(scriptPath, script);
  const pathParts = [workspace.binDir, SHIM_BIN];
  if (hostJqPath) pathParts.push(HOST_JQ_BIN);
  const env: Record<string, string> = {
    HOME: workspace.home,
    PATH: pathParts.join(':'),
    TMPDIR: workspace.root,
    ...injectedBaseUrlEnv(options),
    SETUP_API_KEY: SENTINEL_KEY,
    FAKE_CLAUDE_SRC,
    FAKE_INSTALLER_MARKER: join(workspace.root, 'installer-ran'),
    FAKE_INSTALLER_CHILD_PID_FILE: join(workspace.root, 'installer-child.pid'),
    FAKE_NPM_RECORD: join(workspace.root, 'npm-record.txt'),
    AGENT_SETUP_TEST_INSTALL_CLAUDE_SCRIPT: FAKE_INSTALLER_SCRIPT,
    ...piEnv(options),
  };
  if (agent === 'pi') {
    env.AGENT_SETUP_TEST_INSTALL_PI_SCRIPT = FAKE_PI_INSTALLER_SCRIPT;
  }
  return new Promise<RunResult>(resolve => {
    const child = spawn('/bin/bash', [scriptPath], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}`, combined: `${stdout}${stderr}${String(error)}` }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: `${stdout}${stderr}` }));
  });
};

const installerMarker = (workspace: Workspace): string => join(workspace.root, 'installer-ran');
const installerChildPid = (workspace: Workspace): string => join(workspace.root, 'installer-child.pid');
const processExists = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const settingsPathFor = (workspace: Workspace, configDir?: string): string =>
  join(configDir ?? join(workspace.home, '.claude'), 'settings.json');
const readSettings = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const backupFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith('settings.json.floway-backup.')) : [];
const stagedFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter(name => name.includes('.floway-stage.')) : [];

// --- Codex inspection helpers -----------------------------------------------

const codexRecordPath = (workspace: Workspace): string => join(workspace.root, 'codex-record.jsonl');
const codexHomeFor = (workspace: Workspace, codexHome?: string): string => codexHome ?? join(workspace.home, '.codex');
const codexConfigPath = (workspace: Workspace, codexHome?: string): string => join(codexHomeFor(workspace, codexHome), 'config.toml');
const codexAuthPath = (workspace: Workspace, codexHome?: string): string => join(codexHomeFor(workspace, codexHome), 'auth.json');
const codexTokenPath = (workspace: Workspace, codexHome?: string): string => join(codexHomeFor(workspace, codexHome), 'floway-token');
interface CodexRecord { received?: { method?: string; id?: number; params?: unknown }; marker?: string; edits?: unknown; line?: string; method?: string }
const readCodexRecord = (workspace: Workspace): CodexRecord[] => {
  const path = codexRecordPath(workspace);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as CodexRecord);
};
interface CodexEdit { keyPath: string; mergeStrategy: string; value: unknown }
// The exact `edits` array the installer sent on config/batchWrite, as the fake
// app-server recorded it. A map from keyPath to value makes leaf assertions
// direct; `mergeStrategy` is asserted separately when it matters.
const codexBatchEdits = (workspace: Workspace): CodexEdit[] => {
  const entry = readCodexRecord(workspace).find(r => r.marker === 'batch-respond');
  return (entry?.edits as CodexEdit[] | undefined) ?? [];
};
const codexEditMap = (workspace: Workspace): Map<string, unknown> =>
  new Map(codexBatchEdits(workspace).map(e => [e.keyPath, e.value]));
const codexBackupFiles = (dir: string, base: 'config.toml' | 'floway-token'): string[] =>
  existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith(`${base}.floway-backup.`)) : [];
const readCodexToken = (workspace: Workspace, codexHome?: string): string =>
  readFileSync(codexTokenPath(workspace, codexHome), 'utf8');
const powerShellCallerSurvivalPath = (workspace: Workspace): string => join(workspace.root, 'powershell-caller-survived');

// --- Pi inspection helpers --------------------------------------------------

const piDirFor = (workspace: Workspace, subPath = '.pi/agent'): string => join(workspace.home, subPath);
const piModelsPath = (workspace: Workspace, subPath = '.pi/agent'): string => join(piDirFor(workspace, subPath), 'models.json');
const piSettingsPath = (workspace: Workspace, subPath = '.pi/agent'): string => join(piDirFor(workspace, subPath), 'settings.json');
const readPiModels = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const readPiSettings = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const piBackupFiles = (dir: string, base: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith(`${base}.floway-backup.`)) : [];
const piStagedFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter(name => name.includes('.floway-stage.')) : [];

const hostPiBin = ((): string | null => {
  // PI_BIN points at a specific Pi CLI; otherwise `pi` is looked up on PATH.
  for (const cmd of [process.env.PI_BIN ?? 'pi']) {
    try {
      const probe = spawnSync('/bin/sh', ['-c', `${cmd} --version`], { encoding: 'utf8' });
      if (probe.status === 0 && probe.stdout.trim().length > 0) return cmd;
    } catch {
      // ignore
    }
  }
  return null;
})();

const networkReachable = (): boolean => {
  const probe = spawnSync('/usr/bin/curl', ['-fsSL', '-o', '/dev/null', '--max-time', '8', 'https://github.com/jqlang/jq/releases/download/jq-1.8.2/sha256sum.txt'], { encoding: 'utf8' });
  return probe.status === 0;
};

// Runs the PowerShell body under a real interpreter, mirroring runShellInstaller
// but rendering the PowerShell prefix. Model-directory traffic is in-process, so
// this too must be async to keep the event loop free.
const runPowerShellInstaller = (options: RunOptions): Promise<RunResult> => {
  const { workspace, configuration } = options;
  const agent = targetAgent(configuration, options.agent);
  const culturePrelude = options.powerShellTimeSeparator === undefined
    ? ''
    : `$culture = [Globalization.CultureInfo]::GetCultureInfo('en-US').Clone()\n$culture.DateTimeFormat.TimeSeparator = '${options.powerShellTimeSeparator.replace(/'/g, "''")}'\n[Threading.Thread]::CurrentThread.CurrentCulture = $culture\n`;
  const canonicalBody = powerShellBody(agent);
  const body = options.forcePowerShellWindowsReplacement
    ? canonicalBody
        .replace('if ($script:ClaudeSettingsExisted -and $runningOnWindows)', 'if ($script:ClaudeSettingsExisted)')
        .replace('if ($script:CodexTokenExisted -and $runningOnWindows)', 'if ($script:CodexTokenExisted)')
        .replace('if ($script:PiModelsExisted -and $runningOnWindows)', 'if ($script:PiModelsExisted)')
        .replace('if ($script:PiSettingsExisted -and $runningOnWindows)', 'if ($script:PiSettingsExisted)')
    : canonicalBody;
  const script = powerShellBaseUrlPrelude(options) + renderPowerShellPrefix({ agent, apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration, token: 'test-lease-token' }) + culturePrelude + body;
  const scriptPath = join(workspace.root, 'setup.ps1');
  const invocationPath = join(workspace.root, 'invoke-setup.ps1');
  writeFileSync(scriptPath, script);
  writeFileSync(invocationPath, [
    `$body = Get-Content -Raw -LiteralPath ${powerShellLiteral(scriptPath)}`,
    '$body | Invoke-Expression',
    '$code = $global:LASTEXITCODE',
    `[System.IO.File]::WriteAllText(${powerShellLiteral(powerShellCallerSurvivalPath(workspace))}, 'alive')`,
    'exit $code',
  ].join('\n'));

  if (options.fakeChmodFailure) {
    writeFileSync(join(workspace.binDir, 'chmod'), '#!/bin/bash\nexit 73\n', { mode: 0o755 });
  }
  if (options.fakeNodeVersion && !options.omitNode) {
    writeFileSync(
      join(workspace.binDir, 'node'),
      `#!/bin/bash\nif [ "$1" = "-v" ]; then echo "${options.fakeNodeVersion}"; exit 0; fi\nexec "${join(SHIM_BIN, 'node')}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  const shimBin = options.omitNode ? NO_NODE_BIN : SHIM_BIN;
  const env: Record<string, string> = {
    HOME: workspace.home,
    PATH: [workspace.binDir, shimBin].join(':'),
    FAKE_CLAUDE_VERSION_SLEEP: String(options.fakeClaudeVersionSleep ?? 0),
    FAKE_INSTALLER_SLEEP: String(options.installerSleep ?? 0),
    FAKE_CLAUDE_SRC,
    FAKE_INSTALLER_MARKER: join(workspace.root, 'installer-ran'),
    FAKE_INSTALLER_CHILD_PID_FILE: join(workspace.root, 'installer-child.pid'),
    FAKE_NPM_RECORD: join(workspace.root, 'npm-record.txt'),
    ...codexEnv(options),
    ...piEnv(options),
  };
  if (options.configDir) env.CLAUDE_CONFIG_DIR = options.configDir;
  if (options.fakeClaudeVersion) env.FAKE_CLAUDE_VERSION = options.fakeClaudeVersion;
  if (options.withInstallHook !== false) env.AGENT_SETUP_TEST_INSTALL_CLAUDE_SCRIPT = FAKE_INSTALLER_SCRIPT;
  if (options.installerUrl) env.AGENT_SETUP_TEST_CLAUDE_URL = options.installerUrl;
  if (options.timeoutSeconds !== undefined) env.AGENT_SETUP_TEST_TIMEOUT_SECONDS = String(options.timeoutSeconds);
  if (options.ambientApiKey) env.SETUP_API_KEY = SENTINEL_KEY;
  if (options.forceColor) env.AGENT_SETUP_TEST_FORCE_COLOR = '1';
  if (options.noColor) env.NO_COLOR = '1';
  if (options.failRestore) env.AGENT_SETUP_TEST_FAIL_RESTORE = '1';

  return new Promise<RunResult>(resolve => {
    const child = spawn(hostPwsh!, ['-NoProfile', '-File', invocationPath], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}`, combined: `${stdout}${stderr}${String(error)}` }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: `${stdout}${stderr}` }));
  });
};

// --- Claude cases -----------------------------------------------------------

let modelServer: ModelServer;

test('claude', 'existing CLI is used and the installer hook is not called', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `installer should succeed:\n${run.combined}`);
  t.ok(!existsSync(installerMarker(ws)), 'the installer hook must not run when claude is already present');
  const settings = readSettings(settingsPathFor(ws)) as { env: Record<string, string> };
  t.equal(settings.env.ANTHROPIC_BASE_URL, modelServer.url, 'base URL is written');
  t.equal(settings.env.ANTHROPIC_AUTH_TOKEN, SENTINEL_KEY, 'auth token is written');
});

test('claude', 'missing CLI triggers the configured installer hook', async t => {
  const ws = makeWorkspace();
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, forceColor: true });
  t.equal(run.code, 0, `installer should succeed after install:\n${run.combined}`);
  t.ok(existsSync(installerMarker(ws)), 'the installer hook must run when claude is absent');
  t.ok(existsSync(join(ws.home, '.local/bin/claude')), 'the installer places claude in the user-local location');
  t.ok(existsSync(settingsPathFor(ws)), 'settings are written after installing');
  const installLine = run.stdout.split(/\r?\n/).find(line => line.includes('Claude Code CLI not found; running the test installer'));
  t.equal(installLine, 'Claude Code CLI not found; running the test installer', 'normal installation information carries no prefix or styling');
});

test('claude', 'npm is preferred over the direct installer when npm is available', async t => {
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, withInstallHook: false });
  t.equal(run.code, 0, `npm installation should succeed:\n${run.combined}`);
  t.equal(readFileSync(join(ws.root, 'npm-record.txt'), 'utf8').trim(), 'install --global @anthropic-ai/claude-code', 'npm receives the official global package');
  t.includes(run.stdout, 'Claude Code CLI not found; installing with npm', 'the selected installation source is reported plainly');
});

test('claude', 'unrelated settings and env keys are preserved', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({
    theme: 'dark',
    permissions: { allow: ['Bash(ls:*)'] },
    attribution: { keep: 'yes' },
    env: { OTHER_TOOL: 'keep-me', USE_BUILTIN_RIPGREP: '0' },
  }));
  const run = await runShellInstaller({
    workspace: ws, baseUrl: modelServer.url,
    configuration: claudeConfig({ model: 'claude-opus-x[1m]', defaultFableModel: 'fable-x', defaultOpusModel: 'opus-x', defaultSonnetModel: 'sonnet-x', defaultHaikuModel: 'haiku-x', effortLevel: 'high', cleanupPeriodDays: 365, optOutAiAttribution: true, disableAutoMemory: true, disableAgentView: true, modelDiscovery: true }),
  });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  const settings = readSettings(settingsPathFor(ws)) as { theme: string; permissions: unknown; effortLevel: string; cleanupPeriodDays: number; autoMemoryEnabled: boolean; disableAgentView: boolean; attribution: Record<string, unknown>; env: Record<string, string> };
  t.equal(settings.theme, 'dark', 'unrelated top-level key preserved');
  t.equal(JSON.stringify(settings.permissions), JSON.stringify({ allow: ['Bash(ls:*)'] }), 'unrelated nested object preserved');
  t.equal(settings.env.OTHER_TOOL, 'keep-me', 'unrelated env key preserved');
  t.equal(settings.env.USE_BUILTIN_RIPGREP, '0', 'unrelated env key preserved');
  t.equal(settings.env.ANTHROPIC_MODEL, 'claude-opus-x[1m]', 'managed model written verbatim');
  t.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'fable-x', 'managed fable default written');
  t.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'opus-x', 'managed opus default written');
  t.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'sonnet-x', 'managed sonnet default written');
  t.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'haiku-x', 'managed haiku default written');
  t.equal(settings.cleanupPeriodDays, 365, 'cleanupPeriodDays maps to the top-level numeric setting');
  t.equal(settings.autoMemoryEnabled, false, 'the auto-memory opt-out maps to autoMemoryEnabled: false');
  t.equal(settings.disableAgentView, true, 'the agent-view opt-out maps to disableAgentView: true');
  t.equal(JSON.stringify(settings.attribution), JSON.stringify({ keep: 'yes', commit: '', pr: '', sessionUrl: false }), 'attribution opt-out values are written without replacing unrelated keys');
});

test('claude', 'optional keys are removed when unset', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({
    effortLevel: 'high',
    cleanupPeriodDays: 180,
    autoMemoryEnabled: false,
    disableAgentView: true,
    attribution: { commit: 'stale-commit', pr: 'stale-pr', sessionUrl: true, keep: 'yes' },
    env: {
      ANTHROPIC_MODEL: 'stale-model',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'stale-fable',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'stale-opus',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'stale-sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'stale-haiku',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      KEEP: 'yes',
    },
  }));
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  const settings = readSettings(settingsPathFor(ws)) as { effortLevel?: string; cleanupPeriodDays?: number; attribution: Record<string, unknown>; env: Record<string, string> };
  t.ok(!('ANTHROPIC_MODEL' in settings.env), 'stale model removed');
  t.ok(!('ANTHROPIC_DEFAULT_FABLE_MODEL' in settings.env), 'stale fable removed');
  t.ok(!('ANTHROPIC_DEFAULT_OPUS_MODEL' in settings.env), 'stale opus removed');
  t.ok(!('ANTHROPIC_DEFAULT_SONNET_MODEL' in settings.env), 'stale sonnet removed');
  t.ok(!('ANTHROPIC_DEFAULT_HAIKU_MODEL' in settings.env), 'stale haiku removed');
  t.ok(!('CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY' in settings.env), 'discovery removed when off');
  t.ok(!('effortLevel' in settings), 'effortLevel removed when unset');
  t.ok(!('cleanupPeriodDays' in settings), 'cleanupPeriodDays removed when unset');
  t.ok(!('autoMemoryEnabled' in settings), 'autoMemoryEnabled removed when the opt-out is off');
  t.ok(!('disableAgentView' in settings), 'disableAgentView removed when the opt-out is off');
  t.equal(JSON.stringify(settings.attribution), JSON.stringify({ keep: 'yes' }), 'managed attribution keys removed while unrelated keys survive');
  t.equal(settings.env.KEEP, 'yes', 'unrelated env key preserved through removal');
});

test('claude', 'effort and discovery map to the documented keys', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig({ effortLevel: 'xhigh', cleanupPeriodDays: 99999, modelDiscovery: true }), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  const settings = readSettings(settingsPathFor(ws)) as { effortLevel: string; cleanupPeriodDays: number; env: Record<string, string> };
  t.equal(settings.effortLevel, 'xhigh', 'effortLevel maps to the top-level key');
  t.equal(settings.cleanupPeriodDays, 99999, 'cleanupPeriodDays remains numeric');
  t.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1', 'discovery maps to the documented env key with value "1"');
});

test('claude', 'written settings file has 0600 permissions and a 0700 config dir', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  const fileMode = statSync(settingsPathFor(ws)).mode & 0o777;
  t.equal(fileMode, 0o600, `settings.json should be 0600, got ${fileMode.toString(8)}`);
  const dirMode = statSync(join(ws.home, '.claude')).mode & 0o777;
  t.equal(dirMode, 0o700, `config dir should be 0700, got ${dirMode.toString(8)}`);
});

test('claude', 'a pre-existing settings file is backed up', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light', env: { KEEP: '1' } });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  const backups = backupFiles(configDir);
  t.equal(backups.length, 1, `exactly one backup expected, found ${backups.join(', ')}`);
  t.equal(readFileSync(join(configDir, backups[0]!), 'utf8'), original, 'backup captures the original bytes');
});

test('claude', 'successful re-runs retain only the latest settings backup', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({ theme: 'original' }));

  const first = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(first.code, 0, `first run should succeed:\n${first.combined}`);
  const firstSettings = readFileSync(settingsPathFor(ws), 'utf8');
  const second = await runShellInstaller({ workspace: ws, configuration: claudeConfig({ effortLevel: 'high' }), baseUrl: modelServer.url });
  t.equal(second.code, 0, `second run should succeed:\n${second.combined}`);

  const backups = backupFiles(configDir);
  t.equal(backups.length, 1, `only the latest backup is retained, found ${backups.join(', ')}`);
  t.equal(readFileSync(join(configDir, backups[0]!), 'utf8'), firstSettings, 'the retained backup is the state before the latest run');
});

test('claude', 'invalid existing JSON fails without mutating the file', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const broken = '{ this is not valid json';
  writeFileSync(settingsPathFor(ws), broken);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.ok(run.code !== 0, 'invalid existing settings must fail the run');
  t.equal(readFileSync(settingsPathFor(ws), 'utf8'), broken, 'the invalid file is left untouched');
  t.equal(backupFiles(configDir).length, 0, 'no backup is created when validation fails before mutation');
  t.equal(stagedFiles(configDir).length, 0, 'no staged file is left behind');
});

test('claude', 'present null env fails closed without mutating the file', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light', env: null });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.ok(run.code !== 0, 'present null env must fail the run');
  t.equal(readFileSync(settingsPathFor(ws), 'utf8'), original, 'the file is left untouched');
  t.equal(backupFiles(configDir).length, 0, 'no backup is created before validation');
});

test('claude', 'an interrupt during the Claude install stops the selected script and cleans up', async t => {
  for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    const ws = makeWorkspace();
    // No fake claude on PATH, so the agent fragment runs the sleeping installer;
    // the signal lands while it is mid-install.
    const run = await runShellInstaller({
      workspace: ws, baseUrl: modelServer.url, configuration: bothConfig(), agent: 'claude',
      installerSleep: 5, signalDuringInstall: signal,
    });
    t.equal(run.code, expectedCode, `${signal} must exit ${expectedCode}, not resume:\n${run.combined}`);
    t.includes(run.combined, 'Claude Code', `${signal}: the run had entered the Claude phase`);
    t.excludes(run.combined, 'Codex', `${signal}: the run must never reach the Codex phase`);
    t.ok(!existsSync(codexConfigPath(ws)), `${signal}: Codex config must not be written`);
    t.ok(!existsSync(codexTokenPath(ws)), `${signal}: Codex provider token must not be written`);
    const remnants = readdirSync(ws.root).filter(name => name.startsWith('agent-setup.'));
    t.equal(remnants.length, 0, `${signal}: the EXIT trap cleaned the private working directory`);
  }
});

test('claude', 'raw claude --version output is displayed', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, fakeClaudeVersion: '2.4.1 (Claude Code)' });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.includes(run.combined, '2.4.1 (Claude Code)', 'the raw version string is surfaced');
});

test('claude', 'multiple installations produce a warning and PATH wins', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  placeFakeClaude(join(ws.home, '.local/bin'));
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.includes(run.combined.toLowerCase(), 'multiple', 'a multiple-installation warning is printed');
  t.ok(!existsSync(installerMarker(ws)), 'no install happens when one is already present');
});

test('claude', 'the API key never appears in stdout or stderr', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws, baseUrl: modelServer.url,
    configuration: claudeConfig({ model: 'claude-opus-x', effortLevel: 'high', modelDiscovery: true }),
  });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.excludes(run.combined, SENTINEL_KEY, 'the API key must never be printed');
  // Sanity: the key really was consumed and written, so the absence above is
  // meaningful rather than the key simply never being used.
  const settings = readSettings(settingsPathFor(ws)) as { env: Record<string, string> };
  t.equal(settings.env.ANTHROPIC_AUTH_TOKEN, SENTINEL_KEY, 'the key was actually written to settings');
});

test('claude', 'ambient exported API key is removed before installer and CLI subprocesses', async t => {
  const ws = makeWorkspace();
  const run = await runShellInstallerWithAmbientKey({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `ambient key must be removed before child processes:\n${run.combined}`);
  t.ok(existsSync(installerMarker(ws)), 'fake installer ran and verified its environment');
});

test('claude', 'setup performs no gateway request', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  modelServer.reset();
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.equal(modelServer.requests.length, 0, 'installation and configuration remain entirely local');
});

test('claude', 'honors an explicit CLAUDE_CONFIG_DIR', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.root, 'custom-config');
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, configDir });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.ok(existsSync(join(configDir, 'settings.json')), 'settings land under CLAUDE_CONFIG_DIR');
  t.ok(!existsSync(join(ws.home, '.claude', 'settings.json')), 'the default location is not used when overridden');
});

test('claude', 'missing jq without a download fails before mutating settings', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light' });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, includeJq: false, disableJqDownload: true });
  t.ok(run.code !== 0, 'a missing JSON parser must fail the run');
  t.includes(run.combined.toLowerCase(), 'jq', 'the failure names the jq requirement');
  t.equal(readFileSync(settingsPathFor(ws), 'utf8'), original, 'settings are left untouched when jq is unavailable');
  t.equal(backupFiles(configDir).length, 0, 'no backup is created before the jq check');
});

test('claude', 'jq is bootstrapped from the pinned release when absent from PATH', async t => {
  if (!networkReachable()) skip('GitHub jq release is unreachable; skipping the online bootstrap test');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig({ modelDiscovery: true }), baseUrl: modelServer.url, includeJq: false });
  t.equal(run.code, 0, `bootstrapped jq should configure successfully:\n${run.combined}`);
  t.includes(run.stderr, 'Warning: jq not found on PATH; fetching the pinned jq-1.8.2 build', 'automatic jq recovery is presented as a non-blocking warning');
  const settings = readSettings(settingsPathFor(ws)) as { env: Record<string, string> };
  t.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1', 'the bootstrapped jq produced correct output');
});

// --- PowerShell parse + execution ------------------------------------------

test('claude', 'PowerShell installer body parses without syntax errors', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const body = powerShellBody('claude');
  const entry = powerShellEntry('claude');
  t.ok(body.trimEnd().endsWith(entry), 'the downloaded script starts execution only from its final line');
  t.ok(body.lastIndexOf(entry) > body.indexOf('function Set-SetupAgent {'), 'the entry call follows every agent function');
  const script = renderPowerShellPrefix({
    agent: 'claude',
    apiKey: SENTINEL_KEY,
    apiKeyName: 'Primary key',
    configuration: claudeConfig({ model: 'claude-opus-x', effortLevel: 'high', modelDiscovery: true }),
  }) + body;
  const scriptPath = join(HARNESS_ROOT, 'parse-check.ps1');
  writeFileSync(scriptPath, script);
  const check = `$errs=$null; [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replace(/'/g, "''")}',[ref]$null,[ref]$errs); if($errs -and $errs.Count -gt 0){ $errs | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 } else { exit 0 }`;
  const result = spawnSync(hostPwsh, ['-NoProfile', '-Command', check], { encoding: 'utf8' });
  t.equal(result.status, 0, `PowerShell parse errors:\n${result.stdout}${result.stderr}`);
});

test('claude', 'PowerShell: existing CLI configures and preserves unrelated keys', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({ theme: 'dark', attribution: { keep: 'yes' }, env: { OTHER_TOOL: 'keep-me' } }));
  const run = await runPowerShellInstaller({
    workspace: ws, baseUrl: modelServer.url,
    configuration: claudeConfig({ model: 'claude-opus-x[1m]', defaultFableModel: 'fable-x', defaultOpusModel: 'opus-x', defaultSonnetModel: 'sonnet-x', effortLevel: 'high', cleanupPeriodDays: 180, optOutAiAttribution: true, disableAutoMemory: true, disableAgentView: true, modelDiscovery: true }),
  });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.ok(existsSync(powerShellCallerSurvivalPath(ws)), 'the IEX caller survives a successful setup');
  t.ok(!existsSync(installerMarker(ws)), 'installer must not run when claude is present');
  const settings = readSettings(settingsPathFor(ws)) as { theme: string; effortLevel: string; cleanupPeriodDays: number; autoMemoryEnabled: boolean; disableAgentView: boolean; attribution: Record<string, unknown>; env: Record<string, string> };
  t.equal(settings.theme, 'dark', 'unrelated top-level key preserved');
  t.equal(settings.env.OTHER_TOOL, 'keep-me', 'unrelated env key preserved');
  t.equal(settings.env.ANTHROPIC_BASE_URL, modelServer.url, 'base URL written');
  t.equal(settings.env.ANTHROPIC_AUTH_TOKEN, SENTINEL_KEY, 'auth token written');
  t.equal(settings.env.ANTHROPIC_MODEL, 'claude-opus-x[1m]', 'model written verbatim');
  t.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'fable-x', 'fable default written');
  t.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'opus-x', 'opus default written');
  t.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'sonnet-x', 'sonnet default written');
  t.equal(settings.effortLevel, 'high', 'effortLevel maps to the top-level key');
  t.equal(settings.cleanupPeriodDays, 180, 'cleanupPeriodDays maps to the top-level numeric setting');
  t.equal(settings.autoMemoryEnabled, false, 'the auto-memory opt-out maps to autoMemoryEnabled: false');
  t.equal(settings.disableAgentView, true, 'the agent-view opt-out maps to disableAgentView: true');
  t.equal(JSON.stringify(settings.attribution), JSON.stringify({ keep: 'yes', commit: '', pr: '', sessionUrl: false }), 'attribution opt-out maps to the documented values');
  t.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1', 'discovery maps to the documented env key');
});

test('claude', 'PowerShell: optional keys are removed when unset', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({
    effortLevel: 'high',
    cleanupPeriodDays: 365,
    autoMemoryEnabled: false,
    disableAgentView: true,
    attribution: { commit: 'stale', pr: 'stale', sessionUrl: true, keep: 'yes' },
    env: { ANTHROPIC_MODEL: 'stale', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1', KEEP: 'yes' },
  }));
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  const settings = readSettings(settingsPathFor(ws)) as { effortLevel?: string; cleanupPeriodDays?: number; attribution: Record<string, unknown>; env: Record<string, string> };
  t.ok(!('ANTHROPIC_MODEL' in settings.env), 'stale model removed');
  t.ok(!('CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY' in settings.env), 'discovery removed when off');
  t.ok(!('effortLevel' in settings), 'effortLevel removed when unset');
  t.ok(!('cleanupPeriodDays' in settings), 'cleanupPeriodDays removed when unset');
  t.ok(!('autoMemoryEnabled' in settings), 'autoMemoryEnabled removed when the opt-out is off');
  t.ok(!('disableAgentView' in settings), 'disableAgentView removed when the opt-out is off');
  t.equal(JSON.stringify(settings.attribution), JSON.stringify({ keep: 'yes' }), 'managed attribution keys removed while unrelated keys survive');
  t.equal(settings.env.KEEP, 'yes', 'unrelated env key preserved');
});

test('claude', 'PowerShell: existing permissive settings are replaced with mode 0600 on Unix', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({ theme: 'light', env: { KEEP: '1' } }));
  chmodSync(settingsPathFor(ws), 0o644);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.equal(statSync(settingsPathFor(ws)).mode & 0o777, 0o600, 'replacement settings must be mode 0600');
});

test('claude', 'PowerShell: chmod failure leaves original untouched and no secret stage', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light', env: { KEEP: '1' } });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, fakeChmodFailure: true,
  });
  t.ok(run.code !== 0, 'chmod failure must fail the agent');
  t.equal(readFileSync(settingsPathFor(ws), 'utf8'), original, 'original settings must remain untouched');
  t.equal(stagedFiles(configDir).length, 0, 'failed protected stage must be removed');
  t.equal(backupFiles(configDir).length, 0, 'failed pre-mutation backup must be removed');
  t.excludes(run.combined, SENTINEL_KEY, 'chmod failure logs must not expose the key');
});

test('claude', 'PowerShell: a pre-existing settings file is backed up', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light', env: { KEEP: '1' } });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  const backups = backupFiles(configDir);
  t.equal(backups.length, 1, `exactly one backup expected, found ${backups.join(', ')}`);
  t.equal(readFileSync(join(configDir, backups[0]!), 'utf8'), original, 'backup captures the original bytes');
});

test('claude', 'PowerShell: successful re-runs retain only the latest settings backup', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({ theme: 'original' }));

  const first = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(first.code, 0, `first run should succeed:\n${first.combined}`);
  const firstSettings = readFileSync(settingsPathFor(ws), 'utf8');
  const second = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig({ effortLevel: 'high' }), baseUrl: modelServer.url });
  t.equal(second.code, 0, `second run should succeed:\n${second.combined}`);

  const backups = backupFiles(configDir);
  t.equal(backups.length, 1, `only the latest backup is retained, found ${backups.join(', ')}`);
  t.equal(readFileSync(join(configDir, backups[0]!), 'utf8'), firstSettings, 'the retained backup is the state before the latest run');
});

test('claude', 'PowerShell: existing settings use File.Replace with a real null backup path', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({ theme: 'light' }));
  const run = await runPowerShellInstaller({
    workspace: ws,
    configuration: claudeConfig(),
    baseUrl: modelServer.url,
    forcePowerShellWindowsReplacement: true,
  });
  t.equal(run.code, 0, `File.Replace should succeed:\n${run.combined}`);
  const settings = readSettings(settingsPathFor(ws)) as { env: Record<string, string> };
  t.equal(settings.env.ANTHROPIC_AUTH_TOKEN, SENTINEL_KEY, 'the replacement carries the selected key');
});

test('claude', 'PowerShell: invalid existing JSON fails without mutating the file', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const broken = '{ not valid json';
  writeFileSync(settingsPathFor(ws), broken);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.ok(run.code !== 0, 'invalid existing settings must fail the run');
  t.ok(existsSync(powerShellCallerSurvivalPath(ws)), 'the IEX caller survives a failed setup');
  t.equal(readFileSync(settingsPathFor(ws), 'utf8'), broken, 'the invalid file is left untouched');
  t.equal(backupFiles(configDir).length, 0, 'no backup is created when validation fails before mutation');
});

test('claude', 'PowerShell: present null env fails closed without mutation', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light', env: null });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.ok(run.code !== 0, 'present null env must fail the run');
  t.equal(readFileSync(settingsPathFor(ws), 'utf8'), original, 'the file is left untouched');
  t.equal(backupFiles(configDir).length, 0, 'no backup is created before validation');
});

test('claude', 'PowerShell stages secret data only after protection and hardens Windows replacement targets', async t => {
  const body = powerShellBody('claude');
  const createIndex = body.indexOf('[System.IO.File]::Create($stage).Dispose()');
  const protectStageIndex = body.indexOf('Protect-SetupFile $stage', createIndex);
  const writeIndex = body.indexOf('[System.IO.File]::WriteAllText($stage, $json', protectStageIndex);
  const protectTargetIndex = body.indexOf('Protect-SetupFile $script:ClaudeSettingsPath', writeIndex);
  const replaceIndex = body.indexOf('[System.IO.File]::Replace($stage, $script:ClaudeSettingsPath, [System.Management.Automation.Language.NullString]::Value)', protectTargetIndex);
  t.ok(createIndex >= 0 && createIndex < protectStageIndex, 'stage must be created before protection');
  t.ok(protectStageIndex < writeIndex, 'stage must be protected before secret JSON is written');
  t.ok(protectTargetIndex < replaceIndex, 'existing Windows target must be hardened before File.Replace');
  t.includes(body, '($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows', 'the shared predicate recognizes Windows PowerShell 5.1 without reading an absent $IsWindows');
  t.includes(body, '$runningOnWindows = Test-SetupIsWindows', 'the replacement path uses the shared Windows predicate');
  t.includes(body, "[long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds", 'backup timestamp must support the .NET Framework used by PowerShell 5.1');
  t.excludes(body, 'ToUnixTimeMilliseconds()', 'PowerShell 5.1-incompatible timestamp API must not be used');
  t.includes(body, 'Move-Item -LiteralPath $stage -Destination $script:ClaudeSettingsPath', 'new target must use a same-directory move');
});

test('claude', 'PowerShell Windows file protection writes only an owner DACL', t => {
  const helperStart = SETUP_POWERSHELL_COMMON.indexOf('function Protect-SetupFile');
  const helperEnd = SETUP_POWERSHELL_COMMON.indexOf('\nfunction ', helperStart);
  t.ok(helperStart >= 0, 'Protect-SetupFile function marker exists');
  t.ok(helperEnd >= 0, 'the next function marker exists after Protect-SetupFile');
  const helper = SETUP_POWERSHELL_COMMON.slice(helperStart, helperEnd);
  t.includes(helper, 'New-Object System.Security.AccessControl.FileSecurity', 'a fresh descriptor carries no prior access rules');
  t.includes(helper, "FileSystemAccessRule($identity, 'FullControl', 'Allow')", 'the current user receives the sole allow rule');
  t.includes(helper, '[System.IO.File]::SetAccessControl($Path, $acl)', 'Windows PowerShell 5.1 writes the descriptor directly');
  t.includes(helper, '[System.IO.FileSystemAclExtensions]::SetAccessControl', 'PowerShell 7 writes the descriptor through the .NET extension');
  t.excludes(helper, '\n  Set-Acl ', 'the filesystem provider cannot request an SACL write');
});

test('claude', 'PowerShell: missing CLI triggers the installer', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed after install:\n${run.combined}`);
  t.ok(existsSync(installerMarker(ws)), 'the installer runs when claude is absent');
  t.ok(existsSync(settingsPathFor(ws)), 'settings are written after installing');
});

test('claude', 'PowerShell prefers npm over the direct installer when npm is available', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, withInstallHook: false });
  t.equal(run.code, 0, `npm installation should succeed:\n${run.combined}`);
  t.equal(readFileSync(join(ws.root, 'npm-record.txt'), 'utf8').trim(), 'install --global @anthropic-ai/claude-code', 'npm receives the official global package');
});

test('claude', 'local Bash installer accepts shell content and rejects HTML', async t => {
  const accepted = makeWorkspace();
  modelServer.mode = 'installer-sh';
  const success = await runShellInstaller({
    workspace: accepted, configuration: claudeConfig(), baseUrl: modelServer.url,
    withInstallHook: false, installerUrl: `${modelServer.url}/install.sh`,
  });
  t.equal(success.code, 0, `a local shell installer should be accepted:\n${success.combined}`);
  t.ok(existsSync(installerMarker(accepted)), 'accepted installer executed');

  const rejected = makeWorkspace();
  modelServer.mode = 'installer-html';
  const failure = await runShellInstaller({
    workspace: rejected, configuration: claudeConfig(), baseUrl: modelServer.url,
    withInstallHook: false, installerUrl: `${modelServer.url}/install.sh`,
  });
  t.ok(failure.code !== 0, 'HTML installer response must be rejected');
  t.ok(!existsSync(installerMarker(rejected)), 'HTML response never executes');
});

test('claude', 'local PowerShell installer accepts script content and rejects HTML', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const accepted = makeWorkspace();
  modelServer.mode = 'installer-ps1';
  const success = await runPowerShellInstaller({
    workspace: accepted, configuration: claudeConfig(), baseUrl: modelServer.url,
    withInstallHook: false, installerUrl: `${modelServer.url}/install.ps1`,
  });
  t.equal(success.code, 0, `a local PowerShell installer should be accepted:\n${success.combined}`);
  t.ok(existsSync(installerMarker(accepted)), 'accepted installer executed');

  const rejected = makeWorkspace();
  modelServer.mode = 'installer-html';
  const failure = await runPowerShellInstaller({
    workspace: rejected, configuration: claudeConfig(), baseUrl: modelServer.url,
    withInstallHook: false, installerUrl: `${modelServer.url}/install.ps1`,
  });
  t.ok(failure.code !== 0, 'HTML installer response must be rejected');
  t.ok(!existsSync(installerMarker(rejected)), 'HTML response never executes');
});

test('claude', 'Bash fallback kills the installer process tree', async t => {
  const ws = makeWorkspace();
  const started = Date.now();
  const run = await runShellInstaller({
    workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url,
    installerSleep: 5, timeoutSeconds: 1, excludeTimeoutTools: true,
  });
  t.ok(run.code !== 0, 'timed out installer must fail the agent');
  t.ok(Date.now() - started < 4_000, 'installer deadline must fire before natural completion');
  t.ok(!existsSync(installerMarker(ws)), 'timed-out installer must not reach its marker');
  t.ok(existsSync(installerChildPid(ws)), 'fixture must record a real descendant PID');
  const childPid = Number(readFileSync(installerChildPid(ws), 'utf8').trim());
  t.ok(!processExists(childPid), `timed-out installer descendant ${childPid} must be dead`);
  t.includes(run.combined, 'timeout fallback: process-tree', 'controlled PATH must select the Bash fallback');
});

test('claude', 'Bash claude --version is bounded before configuration', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const started = Date.now();
  const run = await runShellInstaller({
    workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url,
    fakeClaudeVersionSleep: 8, timeoutSeconds: 1, excludeTimeoutTools: true,
  });
  t.ok(run.code !== 0, 'timed out version must fail the agent');
  t.ok(Date.now() - started < 4_000, 'version deadline must fire before natural completion');
  t.ok(!existsSync(settingsPathFor(ws)), 'configuration does not begin after a version timeout');
});

test('claude', 'PowerShell downloaded installer is bounded', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  modelServer.mode = 'installer-ps1';
  const started = Date.now();
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url,
    withInstallHook: false, installerUrl: `${modelServer.url}/install.ps1`, installerSleep: 12, timeoutSeconds: 1,
  });
  t.ok(run.code !== 0, 'timed out installer must fail the agent');
  t.ok(Date.now() - started < 8_000, 'installer deadline must fire well before natural completion');
  t.ok(!existsSync(installerMarker(ws)), 'timed-out installer must not reach its marker');
  t.ok(existsSync(installerChildPid(ws)), 'PowerShell fixture must record a child PID');
  const childPid = Number(readFileSync(installerChildPid(ws), 'utf8').trim());
  t.ok(!processExists(childPid), `timed-out PowerShell installer child ${childPid} must be dead`);
});

test('claude', 'PowerShell claude --version is bounded', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const started = Date.now();
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url,
    fakeClaudeVersionSleep: 12, timeoutSeconds: 1,
  });
  t.ok(run.code !== 0, 'timed out version must fail the agent');
  t.ok(Date.now() - started < 8_000, 'version deadline must fire well before natural completion');
  t.ok(!existsSync(settingsPathFor(ws)), 'configuration does not begin after a version timeout');
});

test('claude', 'PowerShell removes an ambient exported API key before installer and CLI subprocesses', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, ambientApiKey: true,
  });
  t.equal(run.code, 0, `ambient key must be removed before child processes:\n${run.combined}`);
  t.ok(existsSync(installerMarker(ws)), 'fake installer ran and verified its environment');
});

test('claude', 'PowerShell keeps the API key out of output and performs no gateway request', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  modelServer.reset();
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig({ model: 'claude-opus-x', effortLevel: 'high' }), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.excludes(run.combined, SENTINEL_KEY, 'the API key must never be printed');
  const settings = readSettings(settingsPathFor(ws)) as { env: Record<string, string> };
  t.equal(settings.env.ANTHROPIC_AUTH_TOKEN, SENTINEL_KEY, 'the key was actually written to settings');
  t.equal(modelServer.requests.length, 0, 'installation and configuration remain entirely local');
});

// --- Bash 3.2 syntax check --------------------------------------------------

test('claude', 'platform installers prefer Homebrew then npm on macOS and npm then direct scripts elsewhere', t => {
  t.includes(ALL_BASH_FRAGMENTS, 'brew install --cask', 'the Bash installer uses Homebrew on macOS');
  t.includes(ALL_BASH_FRAGMENTS, 'npm install --global "$_inp_package"', 'the Bash installer can install global npm packages');
  t.includes(SETUP_BASH_CLAUDE, "'@anthropic-ai/claude-code'", 'the Claude fragment names its official npm package');
  t.excludes(SETUP_BASH_CLAUDE, '@openai/codex', 'the Claude fragment excludes Codex');
  t.includes(SETUP_BASH_CODEX, "'@openai/codex'", 'the Codex fragment names its official npm package');
  t.excludes(SETUP_BASH_CODEX, '@anthropic-ai/claude-code', 'the Codex fragment excludes Claude Code');
  t.includes(SETUP_BASH_CLAUDE, 'https://downloads.claude.ai/claude-code-releases/bootstrap.sh', 'Claude Linux uses the direct release bootstrap');
  t.includes(SETUP_BASH_CODEX, 'https://raw.githubusercontent.com/openai/codex/refs/heads/main/scripts/install/install.sh', 'Codex Linux uses the GitHub source installer');
  const shClaude = SETUP_BASH_CLAUDE.slice(SETUP_BASH_CLAUDE.indexOf('claude_ensure_installed()'), SETUP_BASH_CLAUDE.indexOf('claude_write_settings()'));
  t.ok(shClaude.indexOf('command -v brew') < shClaude.indexOf('command -v npm'), 'Claude on macOS checks Homebrew before npm');
  t.ok(shClaude.indexOf('command -v npm') < shClaude.indexOf('bootstrap.sh'), 'Claude checks npm before the direct script');
  const shCodex = SETUP_BASH_CODEX.slice(SETUP_BASH_CODEX.indexOf('codex_ensure_installed()'), SETUP_BASH_CODEX.indexOf('codex_backup_files()'));
  t.ok(shCodex.indexOf('command -v brew') < shCodex.indexOf('command -v npm'), 'Codex on macOS checks Homebrew before npm');
  t.ok(shCodex.indexOf('command -v npm') < shCodex.indexOf('install.sh'), 'Codex checks npm before the direct script');
  t.includes(SETUP_POWERSHELL_CLAUDE, "Install-SetupNpmPackage -Package '@anthropic-ai/claude-code'", 'PowerShell can install Claude Code with npm');
  t.includes(SETUP_POWERSHELL_CODEX, "Install-SetupNpmPackage -Package '@openai/codex'", 'PowerShell can install Codex with npm');
  t.includes(SETUP_POWERSHELL_CLAUDE, 'https://downloads.claude.ai/claude-code-releases/bootstrap.ps1', 'Claude Windows uses the direct release bootstrap');
  t.includes(SETUP_POWERSHELL_CODEX, 'https://raw.githubusercontent.com/openai/codex/refs/heads/main/scripts/install/install.ps1', 'Codex Windows uses the GitHub source installer');
  t.includes(ALL_POWERSHELL_FRAGMENTS, 'Get-Command pwsh', 'downloaded PowerShell scripts prefer pwsh when it is installed');
});

test('claude', 'Bash installer body parses under the macOS Bash 3.2 baseline', async t => {
  const body = shellBody('claude');
  const entry = shellEntry('claude');
  t.ok(body.trimEnd().endsWith(entry), 'the downloaded script starts execution only from its final line');
  t.ok(body.lastIndexOf(entry) > body.indexOf('configure_agent() {'), 'the entry call follows every agent function');
  const script = renderShellPrefix({ agent: 'claude', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration: claudeConfig({ model: 'm', effortLevel: 'high', modelDiscovery: true }) }) + body;
  const scriptPath = join(HARNESS_ROOT, 'syntax-check.sh');
  writeFileSync(scriptPath, script);
  const result = spawnSync('/bin/bash', ['-n', scriptPath], { encoding: 'utf8' });
  t.equal(result.status, 0, `/bin/bash -n reported a syntax error:\n${result.stderr}`);
});

test('claude', 'a download that ends before the final main call performs no setup work', t => {
  const ws = makeWorkspace();
  const configuration = claudeConfig();
  const body = shellBody('claude');
  const bodyWithoutEntry = body.slice(0, body.lastIndexOf(shellEntry('claude')));
  const script = renderShellPrefix({ agent: 'claude', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration }) + bodyWithoutEntry;
  const scriptPath = join(ws.root, 'truncated-setup.sh');
  writeFileSync(scriptPath, script);
  const result = spawnSync('/bin/bash', [scriptPath], {
    encoding: 'utf8',
    env: { HOME: ws.home, PATH: [ws.binDir, SHIM_BIN].join(':'), SETUP_ENDPOINT: modelServer.url },
  });
  t.equal(result.status, 0, `definitions-only script should exit cleanly:\n${result.stderr}`);
  t.equal(result.stdout, '', 'definitions-only script prints nothing');
  t.ok(!existsSync(settingsPathFor(ws)), 'definitions-only script writes no Claude settings');
  t.ok(!existsSync(installerMarker(ws)), 'definitions-only script starts no installer');
});

// --- base URL injection -----------------------------------------------------

// A raw shell run of an arbitrary command line, sharing the async model-server
// event loop. Used to exercise the exact copyable command a user pastes, so the
// `export SETUP_ENDPOINT` / `$SetupEndpoint` injection and the `| bash` / `| iex`
// pipeline scoping are verified end to end rather than assumed.
const runCommandLine = (exe: string, args: string[], command: string): Promise<RunResult> =>
  new Promise<RunResult>(resolve => {
    const child = spawn(exe, [...args, command], { env: { PATH: `${SHIM_BIN}:${process.env.PATH ?? ''}` } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}`, combined: `${stdout}${stderr}${String(error)}` }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: `${stdout}${stderr}` }));
  });

test('claude', 'the copyable Bash command exports the origin into the piped installer body', async t => {
  const origin = modelServer.url;
  const command = `export SETUP_ENDPOINT='${origin.replace(/'/g, "'\\''")}'; curl -fsSL "$SETUP_ENDPOINT/probe/setup.sh" | bash`;
  const run = await runCommandLine('/bin/bash', ['-c'], command);
  t.equal(run.code, 0, `the copyable Bash command should run cleanly:\n${run.combined}`);
  t.includes(run.stdout, `PROBE_BASE_URL=[${origin}]`, 'the exported origin reached the piped bash executing the fetched body');
});

test('claude', 'the copyable PowerShell command assigns the origin into the iex runspace', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const origin = modelServer.url;
  const command = `$SetupEndpoint = ${powerShellLiteral(origin)}; irm "$SetupEndpoint/probe/setup.ps1" | iex`;
  const run = await runCommandLine(hostPwsh, ['-NoProfile', '-Command'], command);
  t.equal(run.code, 0, `the copyable PowerShell command should run cleanly:\n${run.combined}`);
  t.includes(run.stdout, `PROBE_BASE_URL=[${origin}]`, 'the in-process origin reached the iex-executed fetched body');
});

test('claude', 'a missing SETUP_ENDPOINT fails before any mutation', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light' });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, omitBaseUrl: true });
  t.ok(run.code !== 0, 'a missing base URL must fail the run');
  t.includes(run.combined, 'SETUP_ENDPOINT', 'the failure names the required base URL');
  t.equal(readFileSync(settingsPathFor(ws), 'utf8'), original, 'settings are left untouched');
  t.equal(backupFiles(configDir).length, 0, 'no backup is created before the base-URL guard');
});

test('claude', 'a non-http(s) SETUP_ENDPOINT fails before any mutation', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light' });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, baseUrlOverride: 'ftp://not-http' });
  t.ok(run.code !== 0, 'a non-http(s) base URL must fail the run');
  t.includes(run.combined, 'http(s) origin', 'the failure explains the origin requirement');
  t.equal(readFileSync(settingsPathFor(ws), 'utf8'), original, 'settings are left untouched');
  t.equal(backupFiles(configDir).length, 0, 'no backup is created before the base-URL guard');
});

test('claude', 'PowerShell: a missing $SetupEndpoint fails before any mutation', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light' });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, omitBaseUrl: true });
  t.ok(run.code !== 0, 'a missing base URL must fail the run');
  t.includes(run.combined, 'SetupEndpoint', 'the failure names the required endpoint');
  t.equal(readFileSync(settingsPathFor(ws), 'utf8'), original, 'settings are left untouched');
  t.equal(backupFiles(configDir).length, 0, 'no backup is created before the base-URL guard');
});

test('claude', 'PowerShell: a non-http(s) $SetupEndpoint fails before any mutation', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light' });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, baseUrlOverride: 'ftp://not-http' });
  t.ok(run.code !== 0, 'a non-http(s) base URL must fail the run');
  t.includes(run.combined, 'http(s) origin', 'the failure explains the origin requirement');
  t.equal(readFileSync(settingsPathFor(ws), 'utf8'), original, 'settings are left untouched');
  t.equal(backupFiles(configDir).length, 0, 'no backup is created before the base-URL guard');
});

// --- Codex cases ------------------------------------------------------------

// Every fixed leaf the installer must batch-write, independent of model/effort.
const assertCodexBaseEdits = (t: Assert, ws: Workspace, baseUrl: string): void => {
  const edits = codexEditMap(ws);
  const codexBase = `${baseUrl.replace(/\/$/, '')}/azure-api.codex`;
  t.equal(edits.get('model_provider'), 'floway', 'model_provider set to floway');
  t.equal(edits.get('suppress_unstable_features_warning'), true, 'under-development feature warning suppressed');
  t.equal(edits.get('model_providers.floway.name'), 'Floway', 'provider name is Floway');
  t.equal(edits.get('model_providers.floway.base_url'), codexBase, 'provider base_url targets the Codex data-plane path');
  const auth = edits.get('model_providers.floway.auth') as { command?: unknown; args?: unknown };
  t.equal(auth.command, 'sh', 'provider auth uses the host shell on Unix');
  t.equal(JSON.stringify(auth.args), JSON.stringify(['-c', 'cat "${CODEX_HOME:-$HOME/.codex}/floway-token"']), 'provider auth reads the token under the active CODEX_HOME');
  t.equal(edits.get('model_providers.floway.wire_api'), 'responses', 'provider wire_api is responses');
  t.equal(edits.get('model_providers.floway.supports_websockets'), true, 'provider advertises websocket support');
  t.equal(JSON.stringify(edits.get('model_providers.floway.http_headers')), JSON.stringify({ 'x-openai-actor-authorization': '1' }), 'provider carries the actor-authorization marker');
  t.equal(edits.get('features.apps'), false, 'features.apps disabled');
  t.equal(edits.get('features.standalone_web_search'), true, 'client-owned web search enabled');
  t.ok(edits.has('model'), 'the model leaf is always part of the batch');
  t.ok(edits.has('model_reasoning_effort'), 'the effort leaf is always part of the batch');
  t.equal(edits.size, 12, 'the batch contains only the provider, feature-warning, feature, model, and effort leaves managed by Floway');
};

const assertStagedToken = (t: Assert, ws: Workspace, codexHome?: string): void => {
  t.equal(readCodexToken(ws, codexHome), SENTINEL_KEY, 'provider token carries the setup API key byte-for-byte');
};

// The real Codex 0.144.5 binary on the host, used by the end-to-end smoke test.
// It must be exactly 0.144.5 so the wire protocol matches the version the
// installer was built against; any other version self-skips rather than
// asserting against an unverified protocol.
const PINNED_CODEX_VERSION = '0.144.5';
const parseCodexCliVersion = (output: string): string | null =>
  /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)$/.exec(output.trim())?.[1] ?? null;
const hostCodex = ((): string | null => {
  const resolved = resolveTool('codex');
  if (!resolved) return null;
  const probe = spawnSync(resolved, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 && parseCodexCliVersion(probe.stdout) === PINNED_CODEX_VERSION ? resolved : null;
})();

// The two absolute locations `codex_discover` consults beyond $HOME and PATH.
// The install-from-absent tests require discovery to find nothing, so they
// self-skip on a host that already has a system Codex there — the same
// host-condition guarding as the pwsh and network tests.
const GLOBAL_CODEX_LOCATIONS = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'];
const globalCodexPresent = (): boolean => GLOBAL_CODEX_LOCATIONS.some(p => existsSync(p));

test('codex', 'real app-server smoke version guard requires exact codex-cli semantic version', t => {
  t.equal(parseCodexCliVersion('codex-cli 0.144.5'), '0.144.5', 'the pinned output parses exactly');
  t.equal(parseCodexCliVersion('codex-cli 0.144.50'), '0.144.50', 'a longer patch version stays distinct');
  t.ok(parseCodexCliVersion('codex-cli 0.144.50') !== PINNED_CODEX_VERSION, '0.144.50 cannot pass the 0.144.5 guard');
  t.equal(parseCodexCliVersion('codex-cli 0.144.5 extra'), null, 'extra output invalidates the exact version contract');
});

test('codex', 'existing CLI configures via the app-server and stages the provider token', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `codex setup should succeed:\n${run.combined}`);
  t.ok(!existsSync(installerMarker(ws)), 'the installer hook must not run when codex is present');
  t.includes(run.stdout, '==> Agent Setup: Codex\nEndpoint:', 'the header names Codex');
  t.includes(run.stdout, '==> Installing: Codex\nCodex is already installed.\nCodex version:', 'installation reports the existing CLI and its version');
  t.includes(run.stdout, '==> Configuring: Codex\n', 'configuration has its own section');
  t.includes(run.stdout, `Written to \`${codexConfigPath(ws)}\`.`, 'the app-server config path is reported');
  t.includes(run.stdout, `Written to \`${codexTokenPath(ws)}\`.`, 'the provider-token path is reported');
  t.includes(run.stdout, '==> Completed Agent Setup: Codex', 'the final outcome is explicit');
  assertCodexBaseEdits(t, ws, modelServer.url);
  assertStagedToken(t, ws);
});

test('codex', 'the batch clears model and effort when unset', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  const edits = codexEditMap(ws);
  t.equal(edits.get('model'), null, 'unset model clears via JSON null');
  t.equal(edits.get('model_reasoning_effort'), null, 'unset effort clears via JSON null');
});

test('codex', 'the batch sets opaque model and effort verbatim', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws, baseUrl: modelServer.url,
    configuration: codexConfig({ model: 'weird/model:v2', reasoningEffort: 'ultra' }),
  });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  const edits = codexEditMap(ws);
  t.equal(edits.get('model'), 'weird/model:v2', 'opaque model is written verbatim');
  t.equal(edits.get('model_reasoning_effort'), 'ultra', 'opaque effort is written verbatim');
});

test('codex', 'the handshake runs initialize then initialized then config/batchWrite in order', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  const record = readCodexRecord(ws);
  const order = record.map(r => r.received?.method ?? r.marker).filter(Boolean);
  const initialize = order.indexOf('initialize');
  const initialized = order.indexOf('initialized');
  const batch = order.indexOf('config/batchWrite');
  t.ok(initialize >= 0 && initialized > initialize, 'initialized follows initialize');
  t.ok(batch > initialized, 'config/batchWrite follows initialized');
  const initReq = record.find(r => r.received?.method === 'initialize');
  t.ok(initReq !== undefined, 'initialize was received with params');
});

test('codex', 'okOverridden counts as success and reports non-secret override metadata only', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'okOverridden' });
  t.equal(run.code, 0, `okOverridden must be treated as configured:\n${run.combined}`);
  t.includes(run.combined, 'Overridden by session flags', 'the override message is surfaced');
  t.includes(run.combined.toLowerCase(), 'sessionflags', 'the overriding layer is surfaced');
  t.excludes(run.combined, 'shadow-model', 'the overridden effective value is not echoed');
  t.ok(existsSync(codexTokenPath(ws)), 'okOverridden still stages the provider token');
});

test('codex', 'a batchWrite JSON-RPC error fails codex and rolls back the provider token', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const configDir = codexHomeFor(ws);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(codexTokenPath(ws), 'old-provider-token');
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'error' });
  t.ok(run.code !== 0, 'a protocol error must fail codex');
  t.equal(readCodexToken(ws), 'old-provider-token', 'prior provider token is restored on rollback');
});

test('codex', 'a malformed app-server response fails codex', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'malformed' });
  t.ok(run.code !== 0, 'a malformed response line must fail codex');
  t.ok(!existsSync(codexTokenPath(ws)), 'the staged provider token is rolled back after a malformed batch response');
});

test('codex', 'an app-server exit between handshake writes rolls back the provider token', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'close-request-after-initialize' });
  t.ok(run.code !== 0, 'a broken app-server request pipe must fail codex');
  t.ok(!existsSync(codexTokenPath(ws)), 'SIGPIPE cannot bypass provider-token rollback');
});

test('codex', 'a premature app-server exit before responding fails codex', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'premature-eof' });
  t.ok(run.code !== 0, 'a premature EOF must fail codex');
  t.ok(!existsSync(codexTokenPath(ws)), 'the staged provider token is rolled back when the app-server exits early');
});

test('codex', 'a delayed batch response within the deadline succeeds because stdin stays open', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    fakeCodexAppServerMode: 'ok', fakeCodexBatchDelay: 2, timeoutSeconds: 30,
  });
  t.equal(run.code, 0, `a response delayed under the deadline must still succeed:\n${run.combined}`);
  const record = readCodexRecord(ws);
  const respondIdx = record.findIndex(r => r.marker === 'batch-respond');
  const eofIdx = record.findIndex(r => r.marker === 'stdin-eof');
  t.ok(respondIdx >= 0, 'the batch response was produced');
  t.ok(eofIdx === -1 || respondIdx < eofIdx, 'stdin remained open until the batch response was sent');
});

test('codex', 'a batch response past the deadline times out, kills the tree, and rolls back', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const started = Date.now();
  const run = await runShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    fakeCodexAppServerMode: 'ok', fakeCodexBatchDelay: 8, timeoutSeconds: 1, excludeTimeoutTools: true,
  });
  t.ok(run.code !== 0, 'a batch response past the deadline must fail codex');
  t.ok(Date.now() - started < 5_000, 'the deadline fires well before the fake would respond');
  t.ok(!existsSync(codexTokenPath(ws)), 'a timed-out app-server rolls back the provider token');
});

test('codex', 'a missing initialize response times out and fails', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const started = Date.now();
  const run = await runShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    fakeCodexAppServerMode: 'no-initialize-response', timeoutSeconds: 1, excludeTimeoutTools: true,
  });
  t.ok(run.code !== 0, 'a missing initialize response must fail codex');
  t.ok(Date.now() - started < 5_000, 'the deadline bounds the missing-response wait');
});

test('codex', 'a large app-server stderr stream does not deadlock the exchange', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexLargeStderr: true });
  t.equal(run.code, 0, `a chatty stderr must not block the JSON-RPC exchange:\n${run.combined.slice(0, 2000)}`);
  assertCodexBaseEdits(t, ws, modelServer.url);
});

test('codex', 'honors an explicit CODEX_HOME for config and provider token', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const codexHome = join(ws.root, 'custom-codex-home');
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, codexHome });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.ok(existsSync(codexTokenPath(ws, codexHome)), 'provider token lands under CODEX_HOME');
  t.ok(!existsSync(codexTokenPath(ws)), 'the default ~/.codex is not used when overridden');
  assertStagedToken(t, ws, codexHome);
});

test('codex', 'missing CLI triggers the configured installer hook', async t => {
  if (globalCodexPresent()) skip('a system Codex is installed at a known location; cannot simulate an absent CLI');
  const ws = makeWorkspace();
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `codex setup should succeed after install:\n${run.combined}`);
  t.ok(existsSync(installerMarker(ws)), 'the installer hook must run when codex is absent');
  t.ok(existsSync(join(ws.home, '.local/bin/codex')), 'the installer places codex in the user-local location');
  assertCodexBaseEdits(t, ws, modelServer.url);
});

test('codex', 'npm is preferred over the direct installer when npm is available', async t => {
  if (globalCodexPresent()) skip('a system Codex is installed at a known location; cannot simulate an absent CLI');
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, withCodexInstallHook: false });
  t.equal(run.code, 0, `npm installation should succeed:\n${run.combined}`);
  t.equal(readFileSync(join(ws.root, 'npm-record.txt'), 'utf8').trim(), 'install --global @openai/codex', 'npm receives the official global package');
  t.includes(run.stdout, 'Codex CLI not found; installing with npm', 'the selected installation source is reported plainly');
});

test('codex', 'the staged provider token is mode 0600', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  const mode = statSync(codexTokenPath(ws)).mode & 0o777;
  t.equal(mode, 0o600, `floway-token should be 0600, got ${mode.toString(8)}`);
});

test('codex', 'successful re-runs retain one config backup and no provider-token backup', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  const priorConfig = 'model_provider = "old"\nkeep_me = "yes"\n';
  const priorAuth = '{"tokens":{"access_token":"official-account-token"}}';
  writeFileSync(codexConfigPath(ws), priorConfig);
  writeFileSync(codexTokenPath(ws), 'old-provider-token');
  writeFileSync(codexAuthPath(ws), priorAuth);

  const first = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.equal(first.code, 0, `first run should succeed:\n${first.combined}`);
  const second = await runShellInstaller({ workspace: ws, configuration: codexConfig({ reasoningEffort: 'high' }), baseUrl: modelServer.url });
  t.equal(second.code, 0, `second run should succeed:\n${second.combined}`);

  t.equal(codexBackupFiles(home, 'config.toml').length, 1, 'only the latest config.toml backup is retained');
  t.equal(codexBackupFiles(home, 'floway-token').length, 0, 'provider-token backups are removed after each successful commit');
  t.equal(readFileSync(codexAuthPath(ws), 'utf8'), priorAuth, 'official account auth remains byte-for-byte unchanged');
  t.equal(readdirSync(home).filter(name => name.startsWith('auth.json.floway-backup.')).length, 0, 'account auth is not backed up because it is not managed');
});

test('codex', 'configuration failure restores prior config and provider token without touching auth.json', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  const priorConfig = 'model_provider = "old"\nkeep_me = "yes"\n';
  const priorToken = 'old-provider-token';
  const priorAuth = '{"tokens":{"access_token":"official-account-token"}}';
  writeFileSync(codexConfigPath(ws), priorConfig);
  writeFileSync(codexTokenPath(ws), priorToken);
  writeFileSync(codexAuthPath(ws), priorAuth);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'error' });
  t.ok(run.code !== 0, 'an app-server configuration error must fail setup');
  t.equal(readFileSync(codexConfigPath(ws), 'utf8'), priorConfig, 'config.toml restored to the original');
  t.equal(readCodexToken(ws), priorToken, 'provider token restored to the original');
  t.equal(readFileSync(codexAuthPath(ws), 'utf8'), priorAuth, 'auth.json remains byte-for-byte unchanged');
  t.equal(stagedFiles(home).length, 0, 'no staged file is left behind');
});

test('codex', 'provider-token staging failure leaves config and auth.json untouched', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  const priorConfig = 'model_provider = "old"\nkeep_me = "yes"\n';
  const priorAuth = '{"tokens":{"access_token":"official-account-token"}}';
  writeFileSync(codexConfigPath(ws), priorConfig);
  writeFileSync(codexAuthPath(ws), priorAuth);
  writeFileSync(join(ws.binDir, 'chmod'), '#!/bin/bash\nexit 73\n', { mode: 0o755 });
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.ok(run.code !== 0, 'a provider-token staging failure must fail codex');
  t.equal(readFileSync(codexConfigPath(ws), 'utf8'), priorConfig, 'config remains unchanged because token staging precedes the app-server write');
  t.equal(readFileSync(codexAuthPath(ws), 'utf8'), priorAuth, 'auth.json remains unchanged');
  t.equal(stagedFiles(home).length, 0, 'the failed token stage is removed');
});

test('codex', 'a restore failure during rollback preserves the provider-token backup and warns instead of silently claiming success', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  writeFileSync(codexTokenPath(ws), 'old-provider-token');

  // Configuration fails (rollback is attempted) and the restore-from-backup mv
  // itself fails. The original provider token must not be reported as restored.
  const run = await runShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    fakeCodexAppServerMode: 'error', fakeRestoreFailure: true,
  });
  t.ok(run.code !== 0, 'an app-server configuration error must fail setup');
  t.includes(run.combined, 'could not restore', 'a rollback-failure warning is printed');
  t.includes(run.combined, codexTokenPath(ws), 'the warning names the provider-token path');
  const backups = codexBackupFiles(home, 'floway-token');
  t.equal(backups.length, 1, 'the provider-token backup is preserved for manual recovery');
  t.equal(readCodexToken(ws), SENTINEL_KEY, 'the managed token remains in place because restore failed');
});

test('codex', 'configuration failure with no prior files removes the created provider token', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'error' });
  t.ok(run.code !== 0, 'an app-server configuration error must fail setup');
  t.ok(!existsSync(codexTokenPath(ws)), 'the freshly staged provider token is removed on rollback');
  t.equal(codexBackupFiles(codexHomeFor(ws), 'floway-token').length, 0, 'no provider-token backup exists when none pre-existed');
});

test('codex', 'raw codex --version output is displayed', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexVersion: 'codex-cli 0.144.1' });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.includes(run.combined, 'codex-cli 0.144.1', 'the raw version string is surfaced');
});

test('codex', 'a codex --version timeout is bounded before configuration', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const started = Date.now();
  const run = await runShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    fakeCodexVersionSleep: 8, timeoutSeconds: 1, excludeTimeoutTools: true,
  });
  t.ok(run.code !== 0, 'a timed-out version must fail codex');
  t.ok(Date.now() - started < 5_000, 'the version deadline fires before natural completion');
  t.ok(!existsSync(codexTokenPath(ws)), 'configuration does not begin after a version timeout');
});

test('codex', 'the API key never appears in output and never reaches the app-server', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws, baseUrl: modelServer.url,
    configuration: codexConfig({ model: 'gpt-5-codex', reasoningEffort: 'high' }),
  });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.excludes(run.combined, SENTINEL_KEY, 'the API key must never be printed');
  t.excludes(run.combined, 'received the API key', 'the app-server must never observe the key in a request');
  // Sanity: the key really was written to the token file so the absence above is meaningful.
  t.equal(readCodexToken(ws), SENTINEL_KEY, 'the key was actually staged into floway-token');
});

test('codex', 'setup performs no gateway request', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  modelServer.reset();
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.equal(modelServer.requests.length, 0, 'installation and configuration remain entirely local');
});

test('codex', 'a Codex script never configures Claude when Codex fails', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: bothConfig(), agent: 'codex',
    fakeCodexAppServerMode: 'error',
  });
  t.ok(run.code !== 0, 'a Codex failure must exit nonzero');
  t.excludes(run.combined, 'Summary', 'single-agent scripts do not print a redundant summary');
  t.excludes(run.combined, 'Claude Code', 'the Codex script does not mention the unselected agent');
  t.ok(!existsSync(settingsPathFor(ws)), 'the Codex script never writes Claude settings');
});

test('codex', 'the two agent-specific scripts configure independently against one configuration', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  placeFakeCodex(ws.binDir);
  const claude = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: bothConfig(), agent: 'claude' });
  t.equal(claude.code, 0, `Claude should configure:\n${claude.combined}`);
  const codex = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: bothConfig(), agent: 'codex' });
  t.equal(codex.code, 0, `Codex should configure:\n${codex.combined}`);
  assertCodexBaseEdits(t, ws, modelServer.url);
  t.ok(existsSync(settingsPathFor(ws)), 'Claude settings written');
});

test('codex', 'local Bash installer accepts shell content and rejects HTML for codex', async t => {
  if (globalCodexPresent()) skip('a system Codex is installed at a known location; cannot simulate an absent CLI');
  const accepted = makeWorkspace();
  modelServer.mode = 'installer-codex-sh';
  const success = await runShellInstaller({
    workspace: accepted, configuration: codexConfig(), baseUrl: modelServer.url,
    withCodexInstallHook: false, codexInstallerUrl: `${modelServer.url}/install-codex.sh`,
  });
  t.equal(success.code, 0, `a local codex shell installer should be accepted:\n${success.combined}`);
  t.ok(existsSync(installerMarker(accepted)), 'accepted codex installer executed');

  const rejected = makeWorkspace();
  modelServer.mode = 'installer-html';
  const failure = await runShellInstaller({
    workspace: rejected, configuration: codexConfig(), baseUrl: modelServer.url,
    withCodexInstallHook: false, codexInstallerUrl: `${modelServer.url}/install-codex.sh`,
  });
  t.ok(failure.code !== 0, 'HTML codex installer response must be rejected');
  t.ok(!existsSync(installerMarker(rejected)), 'HTML response never executes');
});

test('codex', 'multiple installations produce a warning and PATH wins', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  placeFakeCodex(join(ws.home, '.local/bin'));
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.includes(run.combined.toLowerCase(), 'multiple', 'a multiple-installation warning is printed');
  t.ok(!existsSync(installerMarker(ws)), 'no install happens when one is already present');
});

// --- Codex PowerShell parse + execution -------------------------------------

test('codex', 'PowerShell: existing CLI configures via the app-server and stages the provider token', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig({ model: 'gpt-5-codex', reasoningEffort: 'high' }), baseUrl: modelServer.url });
  t.equal(run.code, 0, `codex setup should succeed:\n${run.combined}`);
  t.ok(!existsSync(installerMarker(ws)), 'installer must not run when codex is present');
  t.includes(run.stdout, `Written to \`${codexConfigPath(ws)}\`.`, 'the app-server config path is reported');
  t.includes(run.stdout, `Written to \`${codexTokenPath(ws)}\`.`, 'the provider-token path is reported');
  assertCodexBaseEdits(t, ws, modelServer.url);
  const edits = codexEditMap(ws);
  t.equal(edits.get('model'), 'gpt-5-codex', 'model written verbatim');
  t.equal(edits.get('model_reasoning_effort'), 'high', 'effort written verbatim');
  assertStagedToken(t, ws);
});

test('codex', 'PowerShell: successful setup removes the provider-token backup', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  writeFileSync(codexConfigPath(ws), 'model_provider = "old"\n');
  writeFileSync(codexTokenPath(ws), 'old-provider-token');

  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `codex setup should succeed:\n${run.combined}`);
  t.equal(codexBackupFiles(home, 'config.toml').length, 1, 'the latest config backup remains available');
  t.equal(codexBackupFiles(home, 'floway-token').length, 0, 'the provider-token rollback copy is removed after commit');
});

test('codex', 'PowerShell: provider token is UTF-8 without a BOM under a non-default culture', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    powerShellTimeSeparator: '.',
  });
  t.equal(run.code, 0, `culture-independent provider-token staging should succeed:\n${run.combined}`);
  const token = readFileSync(codexTokenPath(ws));
  t.equal(token.toString('utf8'), SENTINEL_KEY, 'provider token decodes to the exact API key');
  t.ok(!(token[0] === 0xef && token[1] === 0xbb && token[2] === 0xbf), 'provider token has no UTF-8 BOM');
});

test('codex', 'PowerShell: the batch clears model and effort when unset', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  const edits = codexEditMap(ws);
  t.equal(edits.get('model'), null, 'unset model clears via JSON null');
  t.equal(edits.get('model_reasoning_effort'), null, 'unset effort clears via JSON null');
});

test('codex', 'PowerShell: okOverridden counts as success and reports non-secret metadata only', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'okOverridden' });
  t.equal(run.code, 0, `okOverridden must be treated as configured:\n${run.combined}`);
  t.includes(run.combined, 'Overridden by session flags', 'the override message is surfaced');
  t.excludes(run.combined, 'shadow-model', 'the overridden effective value is not echoed');
});

test('codex', 'PowerShell: Windows provider-token replacement and rollback preserve owner-only ACL ordering', async t => {
  const tokenFnStart = SETUP_POWERSHELL_CODEX.indexOf('function Write-SetupCodexToken');
  const tokenFnEnd = SETUP_POWERSHELL_CODEX.indexOf('function Write-SetupCodexVersion', tokenFnStart);
  const tokenBody = SETUP_POWERSHELL_CODEX.slice(tokenFnStart, tokenFnEnd);
  const createStage = tokenBody.indexOf('[System.IO.File]::Create($stage).Dispose()');
  const protectStage = tokenBody.indexOf('Protect-SetupFile $stage', createStage);
  const writeSecret = tokenBody.indexOf('[System.IO.File]::WriteAllText($stage, $SetupApiKey', protectStage);
  const protectTarget = tokenBody.indexOf('Protect-SetupFile $script:CodexTokenPath', writeSecret);
  const replaceTarget = tokenBody.indexOf('[System.IO.File]::Replace($stage, $script:CodexTokenPath, [System.Management.Automation.Language.NullString]::Value)', protectTarget);
  t.ok(tokenFnStart >= 0, 'Write-SetupCodexToken marker exists');
  t.ok(tokenFnEnd >= 0, 'Write-SetupCodexVersion marker exists after token function');
  t.ok(createStage >= 0, 'Codex provider-token stage creation marker exists');
  t.ok(protectStage >= 0, 'Codex provider-token stage protection marker exists');
  t.ok(writeSecret >= 0, 'Codex provider-token secret-write marker exists');
  t.ok(protectTarget >= 0, 'Codex provider-token target protection marker exists');
  t.ok(replaceTarget >= 0, 'Codex provider-token File.Replace marker exists');
  t.ok(createStage < protectStage, 'Codex provider-token stage is created before protection');
  t.ok(protectStage < writeSecret, 'Codex provider-token stage is protected before the secret is written');
  t.ok(protectTarget < replaceTarget, 'existing Windows provider-token target is hardened before File.Replace');

  const restoreHelperStart = SETUP_POWERSHELL_COMMON.indexOf('function Restore-SetupManagedFile');
  const restoreHelperEnd = SETUP_POWERSHELL_COMMON.indexOf('# --- run', restoreHelperStart);
  const restoreHelperBody = SETUP_POWERSHELL_COMMON.slice(restoreHelperStart, restoreHelperEnd);
  const restoreMove = restoreHelperBody.indexOf('Move-Item -LiteralPath $Backup -Destination $Path -Force');
  t.ok(restoreHelperStart >= 0, 'Restore-SetupManagedFile marker exists');
  t.ok(restoreHelperEnd >= 0, 'common run marker exists after restore helper');
  t.ok(restoreMove >= 0, 'managed rollback move marker exists');
  t.excludes(restoreHelperBody, 'Protect-SetupFile $Path', 'rollback keeps the already-protected backup inode instead of adding a fallible post-move step');

  const restoreStart = SETUP_POWERSHELL_CODEX.indexOf('function Restore-SetupCodexFiles');
  const restoreEnd = SETUP_POWERSHELL_CODEX.indexOf('function Invoke-SetupCodexAppServerBatchWrite', restoreStart);
  t.ok(restoreStart >= 0, 'Restore-SetupCodexFiles marker exists');
  t.ok(restoreEnd >= 0, 'app-server function marker exists after restore function');
});

test('codex', 'PowerShell: existing provider token uses File.Replace with a real null backup path', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  writeFileSync(codexTokenPath(ws), 'old-provider-token');
  const run = await runPowerShellInstaller({
    workspace: ws,
    configuration: codexConfig(),
    baseUrl: modelServer.url,
    forcePowerShellWindowsReplacement: true,
  });
  t.equal(run.code, 0, `File.Replace should succeed:\n${run.combined}`);
  assertStagedToken(t, ws);
});

test('codex', 'PowerShell: a batchWrite error fails codex and rolls back the provider token', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  writeFileSync(codexTokenPath(ws), 'old-provider-token');
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'error' });
  t.ok(run.code !== 0, 'a protocol error must fail codex');
  t.equal(readCodexToken(ws), 'old-provider-token', 'prior provider token is restored on rollback');
});

test('codex', 'PowerShell: a provider-token backup protection failure removes the unsafe backup and leaves the original intact', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  if (process.platform === 'win32') skip('the chmod-based protection-failure injection is Unix-only');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  const priorToken = 'old-provider-token';
  const priorAuth = '{"tokens":{"access_token":"official-account-token"}}';
  writeFileSync(codexTokenPath(ws), priorToken);
  writeFileSync(codexAuthPath(ws), priorAuth);

  // chmod fails, so Protect-SetupFile throws while hardening the token backup —
  // the first protected copy in the Codex flow, before any mutation.
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeChmodFailure: true,
  });
  t.ok(run.code !== 0, 'a backup-protection failure must fail codex');
  t.equal(codexBackupFiles(home, 'floway-token').length, 0, 'the unprotected provider-token backup is removed');
  t.equal(readCodexToken(ws), priorToken, 'the original provider token is unchanged');
  t.equal(readFileSync(codexAuthPath(ws), 'utf8'), priorAuth, 'account auth remains unchanged');
  t.excludes(run.combined, SENTINEL_KEY, 'the API key must never be printed');
});

test('codex', 'PowerShell: a malformed response fails codex', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'malformed' });
  t.ok(run.code !== 0, 'a malformed response must fail codex');
  t.ok(!existsSync(codexTokenPath(ws)), 'the staged provider token is rolled back on a malformed response');
});

test('codex', 'PowerShell: a premature app-server exit fails codex', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'premature-eof' });
  t.ok(run.code !== 0, 'a premature EOF must fail codex');
  t.ok(!existsSync(codexTokenPath(ws)), 'the staged provider token is rolled back on premature EOF');
});

test('codex', 'PowerShell: a batch response past the deadline times out and rolls back', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const started = Date.now();
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    fakeCodexAppServerMode: 'ok', fakeCodexBatchDelay: 8, timeoutSeconds: 1,
  });
  t.ok(run.code !== 0, 'a batch response past the deadline must fail codex');
  t.ok(Date.now() - started < 6_000, 'the deadline fires before the fake would respond');
  t.ok(!existsSync(codexTokenPath(ws)), 'a timed-out app-server rolls back the provider token');
});

test('codex', 'PowerShell: honors an explicit CODEX_HOME', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const codexHome = join(ws.root, 'custom-codex-home');
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, codexHome });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.ok(existsSync(codexTokenPath(ws, codexHome)), 'provider token lands under CODEX_HOME');
  t.ok(!existsSync(codexTokenPath(ws)), 'the default ~/.codex is not used when overridden');
});

test('codex', 'PowerShell: the API key never appears in output and never reaches the app-server', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig({ model: 'gpt-5-codex' }), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.excludes(run.combined, SENTINEL_KEY, 'the API key must never be printed');
  t.excludes(run.combined, 'received the API key', 'the app-server must never observe the key in a request');
  t.equal(readCodexToken(ws), SENTINEL_KEY, 'the key was actually staged into floway-token');
});

test('codex', 'PowerShell: missing CLI triggers the documented remote installer invocation', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  modelServer.mode = 'installer-codex-ps1';
  try {
    const run = await runPowerShellInstaller({
      workspace: ws,
      configuration: codexConfig(),
      baseUrl: modelServer.url,
      withCodexInstallHook: false,
      codexInstallerUrl: `${modelServer.url}/install-codex.ps1`,
    });
    t.equal(run.code, 0, `should succeed after install:\n${run.combined}`);
    t.ok(existsSync(installerMarker(ws)), 'the installer runs when codex is absent');
    const installerCommandLine = readFileSync(join(ws.root, 'installer-command-line.txt'), 'utf8');
    t.includes(installerCommandLine, '-ExecutionPolicy Bypass', 'the Codex installer subprocess matches the documented process-scoped execution-policy override');
    assertCodexBaseEdits(t, ws, modelServer.url);
  } finally {
    modelServer.mode = 'ok';
  }
});

test('codex', 'PowerShell: CODEX_NON_INTERACTIVE is scoped to installer invocation and removed afterward', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `missing CLI should install without leaking CODEX_NON_INTERACTIVE to codex:\n${run.combined}`);
  t.equal(readFileSync(join(ws.root, 'installer-non-interactive.txt'), 'utf8'), 'true', 'the installer itself receives CODEX_NON_INTERACTIVE=true');
  t.excludes(run.combined, 'unexpected CODEX_NON_INTERACTIVE', 'app-server and version subprocesses see no new ambient value');
});

test('codex', 'PowerShell: a pre-existing CODEX_NON_INTERACTIVE value is restored after installation', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    ambientCodexNonInteractive: 'caller-value',
  });
  t.equal(run.code, 0, `missing CLI should restore the caller's environment value:\n${run.combined}`);
  t.equal(readFileSync(join(ws.root, 'installer-non-interactive.txt'), 'utf8'), 'true', 'the installer receives the required temporary true value');
  t.excludes(run.combined, 'unexpected CODEX_NON_INTERACTIVE', 'app-server and version subprocesses see the restored caller value');
});

test('codex', 'PowerShell: a Codex script never configures Claude when Codex fails', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: bothConfig(), agent: 'codex', fakeCodexAppServerMode: 'error' });
  t.ok(run.code !== 0, 'a Codex failure must exit nonzero');
  t.excludes(run.combined, 'Summary', 'single-agent scripts do not print a redundant summary');
  t.excludes(run.combined, 'Claude Code', 'the Codex script does not mention the unselected agent');
  t.ok(!existsSync(settingsPathFor(ws)), 'the Codex script never writes Claude settings');
});

// --- Codex real-binary smoke test -------------------------------------------

test('codex', 'end-to-end against the real pinned Codex 0.144.5 app-server writes config.toml', async t => {
  if (!hostCodex) skip('real Codex 0.144.5 is not installed on this host');
  const ws = makeWorkspace();
  symlinkSync(hostCodex, join(ws.binDir, 'codex'));
  const codexHome = join(ws.root, 'real-codex-home');
  const run = await runShellInstaller({
    workspace: ws, baseUrl: modelServer.url,
    configuration: codexConfig({ model: 'gpt-5-codex', reasoningEffort: 'high' }),
    codexHome, withCodexInstallHook: false,
  });
  t.equal(run.code, 0, `real codex app-server configuration should succeed:\n${run.combined}`);
  const configText = readFileSync(codexConfigPath(ws, codexHome), 'utf8');
  const codexBase = `${modelServer.url.replace(/\/$/, '')}/azure-api.codex`;
  t.includes(configText, 'model_provider = "floway"', 'real config.toml carries the provider selection');
  t.includes(configText, 'wire_api = "responses"', 'real config.toml carries the wire_api');
  t.includes(configText, 'supports_websockets = true', 'real config.toml carries websocket support');
  t.includes(configText, 'x-openai-actor-authorization', 'real config.toml carries the actor-authorization marker');
  t.includes(configText, 'standalone_web_search = true', 'real config.toml enables client-owned web search');
  t.includes(configText, 'suppress_unstable_features_warning = true', 'real config.toml suppresses the paired under-development warning');
  t.includes(configText, `base_url = "${codexBase}"`, 'real config.toml carries the provider base_url');
  t.includes(configText, 'model = "gpt-5-codex"', 'real config.toml carries the selected model');
  assertStagedToken(t, ws, codexHome);
});

// --- output contract --------------------------------------------------------

// VT control sequences are stripped and CRLF normalized; each line is right-trimmed
// and trailing blank lines dropped. Interior blank lines remain part of the
// heading/status output contract.
const normalizeLines = (text: string): string =>
  stripVTControlCharacters(text).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
const normalizeWorkspace = (text: string, workspace: Workspace): string =>
  normalizeLines(text).replaceAll(workspace.root, '<workspace>');
const hasVTControlCharacters = (text: string): boolean => stripVTControlCharacters(text) !== text;

test('claude', 'output normalization strips VT controls and preserves control-like text', t => {
  const decorated = [
    '\u001B[31mred\u001B[0m',
    '\u001B[2A\u001B[3Ccursor',
    '\u001B]8;;https://floway.dev\u0007link\u001B]8;;\u0007',
  ].join(' ');
  t.equal(normalizeLines(decorated), 'red cursor link', 'SGR, cursor CSI, and OSC hyperlink sequences are stripped');
  t.ok(hasVTControlCharacters(decorated), 'VT detection agrees with native stripping');

  const plain = 'literal [31m, [2A, and ]8;;https://floway.dev text';
  t.equal(normalizeLines(plain), plain, 'control-like ordinary text is unchanged');
  t.ok(!hasVTControlCharacters(plain), 'control-like ordinary text is not reported as VT control data');
});

// A hermetic single-agent run needs the harness to fully control discovery. The
// Codex CLI is discovered at absolute paths the sandbox cannot hide, so a host
// with a system Codex would emit a legitimate "multiple installations" warning;
// Claude's absolute candidates are absent here, so the clean-stderr contract is
// asserted through the Claude phase and guarded against a stray global Claude.
const GLOBAL_CLAUDE_LOCATIONS = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
const globalClaudePresent = (): boolean => GLOBAL_CLAUDE_LOCATIONS.some(p => existsSync(p));

test('claude', 'Bash and PowerShell emit an identical happy-path stdout line sequence', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const bashWs = makeWorkspace();
  placeFakeClaude(bashWs.binDir);
  placeFakeCodex(bashWs.binDir);
  const bash = await runShellInstaller({ workspace: bashWs, baseUrl: modelServer.url, configuration: bothConfig(), agent: 'claude' });
  t.equal(bash.code, 0, `Bash happy path should succeed:\n${bash.combined}`);

  modelServer.reset();
  const psWs = makeWorkspace();
  placeFakeClaude(psWs.binDir);
  placeFakeCodex(psWs.binDir);
  const ps = await runPowerShellInstaller({ workspace: psWs, baseUrl: modelServer.url, configuration: bothConfig(), agent: 'claude' });
  t.equal(ps.code, 0, `PowerShell happy path should succeed:\n${ps.combined}`);

  t.equal(normalizeWorkspace(ps.stdout, psWs), normalizeWorkspace(bash.stdout, bashWs), 'the two installers must print the same stdout structure');
  t.includes(normalizeLines(bash.stdout), '==> Agent Setup: Claude Code\nEndpoint:', 'the header identifies the agent and endpoint');
  t.includes(normalizeLines(bash.stdout), '\nAPI Key: Primary key\n', 'the header identifies the selected API key');
  t.includes(normalizeLines(bash.stdout), '\n==> Installing: Claude Code\n', 'the installation section is explicit');
  t.includes(normalizeLines(bash.stdout), '\nClaude Code is already installed.\n', 'an existing CLI is reported');
  t.includes(normalizeLines(bash.stdout), '\n==> Configuring: Claude Code\n', 'the configuration section is explicit');
  t.includes(normalizeLines(bash.stdout), `Written to \`${settingsPathFor(bashWs)}\`.`, 'the settings path is reported');
  t.excludes(normalizeLines(bash.stdout), '\n\n', 'setup-owned sections do not insert blank separator lines');
  t.equal(normalizeLines(bash.stdout).match(/^==> /gm)?.length, 4, 'the output has exactly the header, installation, configuration, and completion notices');
  t.includes(normalizeLines(bash.stdout), '==> Completed Agent Setup: Claude Code', 'the successful result is explicit');
  t.excludes(normalizeLines(bash.stdout), 'Summary', 'a single-agent script has no redundant summary');
});

test('claude', 'a fully successful run keeps stderr empty and emits no escape codes when captured', async t => {
  if (globalClaudePresent()) skip('a system Claude Code is installed at a known location; discovery is not hermetic');
  const bashWs = makeWorkspace();
  placeFakeClaude(bashWs.binDir);
  const bash = await runShellInstaller({ workspace: bashWs, baseUrl: modelServer.url, configuration: claudeConfig() });
  t.equal(bash.code, 0, `should succeed:\n${bash.combined}`);
  t.equal(bash.stderr.trim(), '', 'a clean Bash run writes nothing to stderr');
  t.ok(!hasVTControlCharacters(bash.combined), 'captured Bash output carries no VT control sequences');

  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  modelServer.reset();
  const psWs = makeWorkspace();
  placeFakeClaude(psWs.binDir);
  const ps = await runPowerShellInstaller({ workspace: psWs, baseUrl: modelServer.url, configuration: claudeConfig() });
  t.equal(ps.code, 0, `should succeed:\n${ps.combined}`);
  t.equal(ps.stderr.trim(), '', 'a clean PowerShell run writes nothing to stderr');
  t.ok(!hasVTControlCharacters(ps.combined), 'captured PowerShell output carries no VT control sequences');
});

test('claude', 'Bash styles agent notices while leaving metadata plain', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const forced = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: claudeConfig(), forceColor: true });
  t.equal(forced.code, 0, `forced-color run should succeed:\n${forced.combined}`);
  t.includes(forced.stdout, '[34m==>[0m [1mAgent Setup: Claude Code[0m', 'the setup title uses the notice style');
  t.includes(forced.stdout, 'Endpoint: ', 'the Endpoint metadata remains visible');
  t.includes(forced.stdout, 'API Key: Primary key', 'the API Key metadata remains visible');
  t.excludes(forced.stdout, '[1mEndpoint:', 'the Endpoint label is not styled');
  t.excludes(forced.stdout, '[1mAPI Key:', 'the API Key label is not styled');
  t.includes(forced.stdout, '[34m==>[0m [1mInstalling: Claude Code[0m', 'the installation section uses the notice style');
  t.includes(forced.stdout, '[34m==>[0m [1mConfiguring: Claude Code[0m', 'the configuration section uses the notice style');
  t.includes(forced.stdout, '[34m==>[0m [1mCompleted Agent Setup: Claude Code[0m', 'the successful result uses the notice style');
  t.excludes(forced.stdout, '[92m', 'success does not use green ANSI styling');
  t.ok(!hasVTControlCharacters(forced.stderr), 'a successful run leaves stderr free of VT controls even under forced color');

  const suppressed = makeWorkspace();
  placeFakeClaude(suppressed.binDir);
  const noColor = await runShellInstaller({ workspace: suppressed, baseUrl: modelServer.url, configuration: claudeConfig(), forceColor: true, noColor: true });
  t.equal(noColor.code, 0, `NO_COLOR run should succeed:\n${noColor.combined}`);
  t.ok(!hasVTControlCharacters(noColor.combined), 'NO_COLOR wins over forced color on both streams');
  t.includes(noColor.stdout, 'Claude Code', 'the plain heading is still present without color');
});

test('claude', 'Bash routes errors to stderr with a red label', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), '{ invalid json');
  const run = await runShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: claudeConfig(),
    forceColor: true,
  });
  t.ok(run.code !== 0, 'invalid settings must fail the agent');
  t.includes(run.stderr, '[91mError:[0m ', 'the error label is painted red on stderr');
  t.includes(run.stderr, 'is not valid Claude settings; leaving it untouched.', 'the error retains its diagnostic body');
  t.excludes(run.stdout, 'is not valid Claude settings', 'the error does not leak onto stdout');
});

test('claude', 'PowerShell colors stderr under forced color, keeps stdout escape-free, and honors NO_COLOR', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), '{ invalid json');
  const forced = await runPowerShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: claudeConfig(),
    forceColor: true,
  });
  t.ok(forced.code !== 0, 'invalid settings must fail the agent');
  t.ok(!hasVTControlCharacters(forced.stdout), 'host-colored stdout never carries VT controls even under forced color');
  t.includes(forced.stderr, '[91mError:[0m ', 'stderr colors the primary error label');

  const suppressed = makeWorkspace();
  placeFakeClaude(suppressed.binDir);
  mkdirSync(join(suppressed.home, '.claude'), { recursive: true });
  writeFileSync(settingsPathFor(suppressed), '{ invalid json');
  const noColor = await runPowerShellInstaller({
    workspace: suppressed, baseUrl: modelServer.url, configuration: claudeConfig(),
    forceColor: true, noColor: true,
  });
  t.ok(noColor.code !== 0, 'the failure still occurs');
  t.ok(!hasVTControlCharacters(noColor.combined), 'NO_COLOR wins over forced color on stderr too');
  t.includes(noColor.stderr, 'Error: ', 'the plain error is still on stderr');
});

test('claude', 'a multiple-installation warning is a stderr line on both installers', async t => {
  const bashWs = makeWorkspace();
  placeFakeClaude(bashWs.binDir);
  placeFakeClaude(join(bashWs.home, '.local/bin'));
  const bash = await runShellInstaller({ workspace: bashWs, baseUrl: modelServer.url, configuration: claudeConfig(), forceColor: true });
  t.equal(bash.code, 0, `should succeed:\n${bash.combined}`);
  t.includes(bash.stderr, '[93mWarning:[0m multiple Claude Code installations detected;', 'Bash colors only the warning label');
  t.excludes(bash.stdout, 'multiple Claude Code installations detected', 'the warning is not on stdout');

  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  modelServer.reset();
  const psWs = makeWorkspace();
  placeFakeClaude(psWs.binDir);
  placeFakeClaude(join(psWs.home, '.local/bin'));
  const ps = await runPowerShellInstaller({ workspace: psWs, baseUrl: modelServer.url, configuration: claudeConfig(), forceColor: true });
  t.equal(ps.code, 0, `should succeed:\n${ps.combined}`);
  t.includes(ps.stderr, '[93mWarning:[0m multiple Claude Code installations detected;', 'PowerShell colors only the warning label');
  t.excludes(ps.stdout, 'multiple Claude Code installations detected', 'the warning is not on stdout');
});

test('claude', 'PowerShell surfaces one primary error without a double wrapper', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  mkdirSync(join(ws.home, '.claude'), { recursive: true });
  writeFileSync(settingsPathFor(ws), '{ invalid json');
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: claudeConfig() });
  t.ok(run.code !== 0, 'invalid settings must fail the agent');
  t.excludes(run.combined, 'setup failed', 'the removed double-wrapper phrasing must not return');
  const errorCount = run.stderr.split('\n').filter(line => line.includes('is not valid JSON; leaving it untouched.')).length;
  t.equal(errorCount, 1, 'the primary error is printed exactly once');
  t.excludes(run.stdout, 'is not valid JSON', 'the error stays off stdout');
});

test('codex', 'PowerShell rollback restore failure preserves the Codex provider-token backup', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  writeFileSync(codexTokenPath(ws), 'old-provider-token');
  const run = await runPowerShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: codexConfig(),
    fakeCodexAppServerMode: 'error', failRestore: true,
  });
  t.ok(run.code !== 0, 'an app-server configuration error must fail setup');
  t.includes(run.stderr, 'Warning: could not restore', 'a rollback-failure warning is printed to stderr');
  t.includes(run.stderr, 'provider token', 'the warning names the preserved provider token');
  t.includes(run.stderr, 'restore it by hand', 'the warning names the manual action');
  const backups = codexBackupFiles(home, 'floway-token');
  t.equal(backups.length, 1, 'the provider-token backup is preserved for manual recovery');
});

// --- pi test cases ----------------------------------------------------------

test('pi', 'fresh install writes models.json with 0600 mode and exact JSON shape, without settings.json', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  modelServer.reset();
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  t.equal(run.code, 0, `fresh install should succeed:\n${run.combined}`);
  t.includes(run.stdout, '==> Completed Agent Setup: Pi', 'completion notice emitted');
  t.includes(run.stdout, 'Models configured as a static snapshot; re-run this setup command at any time to refresh the model list.', 'snapshot hint emitted');
  const modelsFile = piModelsPath(ws);
  t.ok(existsSync(modelsFile), 'models.json exists');
  t.equal(statSync(modelsFile).mode & 0o777, 0o600, 'models.json permissions are 0600');
  const settingsFile = piSettingsPath(ws);
  t.ok(!existsSync(settingsFile), 'settings.json does not exist when no default model is configured');
  const models = readPiModels(modelsFile) as { providers: Record<string, any> };
  t.ok(models.providers?.floway !== undefined, 'floway provider exists');
  t.equal(models.providers.floway.name, 'Floway');
  t.equal(models.providers.floway.baseUrl, `${modelServer.url}/v1`);
  t.equal(models.providers.floway.api, 'openai-responses');
  t.equal(models.providers.floway.apiKey, SENTINEL_KEY);
  t.equal(models.providers.floway.models?.length, 1);
  t.equal(models.providers.floway.models[0].id, 'floway-pi-model-1');
  const snapshotReq = modelServer.requests.find(r => r.path.endsWith('/pi-models.json'));
  t.ok(snapshotReq !== undefined, 'snapshot request made to modelServer');
});

test('pi', 'model set, changed, and cleared updates settings.json', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const settingsFile = piSettingsPath(ws);

  // 1. Model set
  const run1 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  t.equal(run1.code, 0, `setting model should succeed:\n${run1.combined}`);
  t.ok(existsSync(settingsFile), 'settings.json created');
  t.equal(statSync(settingsFile).mode & 0o777, 0o600, 'settings.json permissions are 0600');
  let settings = readPiSettings(settingsFile);
  t.equal(settings.defaultProvider, 'floway');
  t.equal(settings.defaultModel, 'floway-pi-model-1');

  // 2. Model changed
  const run2 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'model-2' }) });
  t.equal(run2.code, 0, `changing model should succeed:\n${run2.combined}`);
  settings = readPiSettings(settingsFile);
  t.equal(settings.defaultProvider, 'floway');
  t.equal(settings.defaultModel, 'model-2');

  // 3. Model cleared
  const run3 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: null }) });
  t.equal(run3.code, 0, `clearing model should succeed:\n${run3.combined}`);
  settings = readPiSettings(settingsFile);
  t.equal(settings.defaultProvider, undefined, 'defaultProvider removed on clear');
  t.equal(settings.defaultModel, undefined, 'defaultModel removed on clear');
});

test('pi', 'unrelated defaultProvider preserved when model is cleared', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const dir = piDirFor(ws);
  mkdirSync(dir, { recursive: true });
  const settingsFile = piSettingsPath(ws);
  writeFileSync(settingsFile, JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-3-opus' }, null, 2));

  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: null }) });
  t.equal(run.code, 0, `clearing with unrelated provider should succeed:\n${run.combined}`);
  const settings = readPiSettings(settingsFile);
  t.equal(settings.defaultProvider, 'anthropic', 'unrelated defaultProvider preserved');
  t.equal(settings.defaultModel, 'claude-3-opus', 'unrelated defaultModel preserved');
});

test('pi', 'idempotent re-run produces no diff and prunes backups', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run1 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  t.equal(run1.code, 0, `first run should succeed:\n${run1.combined}`);
  const models1 = readFileSync(piModelsPath(ws), 'utf8');
  const settings1 = readFileSync(piSettingsPath(ws), 'utf8');

  const run2 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  t.equal(run2.code, 0, `second run should succeed:\n${run2.combined}`);
  t.equal(readFileSync(piModelsPath(ws), 'utf8'), models1, 'models.json identical');
  t.equal(readFileSync(piSettingsPath(ws), 'utf8'), settings1, 'settings.json identical');
  t.equal(piBackupFiles(piDirFor(ws), 'models.json').length, 0, 'no models backups remain');
  t.equal(piBackupFiles(piDirFor(ws), 'settings.json').length, 0, 'no settings backups remain');
});

test('pi', 'preserves unrelated providers, comments, CRLF, and trailing comma', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  mkdirSync(piDirFor(ws), { recursive: true });

  const priorModels = '// Header comment\r\n{\r\n  // Provider comment\r\n  "providers": {\r\n    "anthropic": {\r\n      "name": "Anthropic",\r\n      "apiKey": "ant-key",\r\n    },\r\n  },\r\n}';
  const priorSettings = '// Settings comment\r\n{\r\n  /* theme block */\r\n  "theme": "dark",\r\n}';
  writeFileSync(piModelsPath(ws), priorModels);
  writeFileSync(piSettingsPath(ws), priorSettings);

  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  t.equal(run.code, 0, `setup should succeed:\n${run.combined}`);

  const modelsText = readFileSync(piModelsPath(ws), 'utf8');
  t.includes(modelsText, '// Header comment', 'header comment preserved');
  t.includes(modelsText, '// Provider comment', 'provider comment preserved');
  t.includes(modelsText, '"anthropic":', 'unrelated provider preserved');
  t.includes(modelsText, '"floway":', 'floway provider present');
  t.ok(modelsText.includes('\r\n'), 'CRLF preserved in models.json');

  const settingsText = readFileSync(piSettingsPath(ws), 'utf8');
  t.includes(settingsText, '// Settings comment', 'settings comment preserved');
  t.includes(settingsText, '/* theme block */', 'theme block comment preserved');
  t.includes(settingsText, '"theme": "dark"', 'unrelated setting preserved');
  t.includes(settingsText, '"defaultProvider": "floway"', 'defaultProvider set');
  t.includes(settingsText, '"defaultModel": "floway-pi-model-1"', 'defaultModel set');
  t.ok(settingsText.includes('\r\n'), 'CRLF preserved in settings.json');
});

test('pi', 'refuses unparseable models.json without modifying file', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  mkdirSync(piDirFor(ws), { recursive: true });
  const badContent = '{\n  "providers": {\n';
  writeFileSync(piModelsPath(ws), badContent);

  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  t.notEqual(run.code, 0, 'installer should fail on unparseable models.json');
  t.equal(readFileSync(piModelsPath(ws), 'utf8'), badContent, 'models.json remains untouched');
});

test('pi', 'refuses unparseable settings.json without modifying file', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  mkdirSync(piDirFor(ws), { recursive: true });
  const badSettings = '{\n  "theme": "dark"';
  writeFileSync(piSettingsPath(ws), badSettings);

  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  t.notEqual(run.code, 0, 'installer should fail on unparseable settings.json');
  t.equal(readFileSync(piSettingsPath(ws), 'utf8'), badSettings, 'settings.json remains untouched');
});

test('pi', 'refuses non-object root or duplicate keys without modifying file', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  mkdirSync(piDirFor(ws), { recursive: true });
  const badContent = '["array-root"]\n';
  writeFileSync(piModelsPath(ws), badContent);

  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  t.notEqual(run.code, 0, 'installer should fail on non-object root');
  t.equal(readFileSync(piModelsPath(ws), 'utf8'), badContent, 'models.json remains untouched');
});

test('pi', 'rollback restores original models.json and settings.json on failure', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  mkdirSync(piDirFor(ws), { recursive: true });
  const priorModels = '{\n  "providers": {\n    "anthropic": {}\n  }\n}\n';
  const priorSettings = '{\n  "theme": "light"\n}\n';
  writeFileSync(piModelsPath(ws), priorModels);
  writeFileSync(piSettingsPath(ws), priorSettings);

  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: piConfig({ model: 'floway-pi-model-1' }),
    fakePiFailConfig: true,
  });
  t.notEqual(run.code, 0, 'setup must fail when simulated failure occurs');
  t.equal(readFileSync(piModelsPath(ws), 'utf8'), priorModels, 'original models.json restored');
  t.equal(readFileSync(piSettingsPath(ws), 'utf8'), priorSettings, 'original settings.json restored');
  t.equal(piStagedFiles(piDirFor(ws)).length, 0, 'no staged files remain');
});

test('pi', 'missing node aborts with clear error message', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), omitNode: true });
  t.notEqual(run.code, 0, 'installer should fail when node is missing');
  t.includes(run.combined, 'Node.js (>= 22.19) is required to run Pi but was not found on PATH. Install Node.js (>= 22.19) and re-run.');
  t.ok(!existsSync(piModelsPath(ws)), 'models.json not created when node check fails');
});

test('pi', 'older node warns but continues', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), fakeNodeVersion: 'v20.10.0' });
  t.equal(run.code, 0, `setup should succeed even with older node:\n${run.combined}`);
  t.includes(run.combined, 'Pi requires Node.js >= 22.19.', 'warning emitted for older node');
  t.ok(existsSync(piModelsPath(ws)), 'models.json created');
});

test('pi', 'resolves agent directory from PI_CODING_AGENT_DIR', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const customDir = join(ws.home, 'custom-pi-agent');
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), piAgentDir: customDir });
  t.equal(run.code, 0, `setup should succeed with custom agent dir:\n${run.combined}`);
  t.ok(existsSync(join(customDir, 'models.json')), 'models.json written to custom PI_CODING_AGENT_DIR');
});

test('pi', 'API key is never printed to stdout or stderr during setup', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  t.equal(run.code, 0, `setup should succeed:\n${run.combined}`);
  t.excludes(run.combined, SENTINEL_KEY, 'sentinel key must never be printed to stdout or stderr');
});

test('pi', 'ambient SETUP_API_KEY is not inherited by fake pi CLI', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runShellInstallerWithAmbientKey({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  t.equal(run.code, 0, `ambient key must not cause fake pi to exit 91:\n${run.combined}`);
});

test('pi', 'CLI not found runs test installer hook and installs pi', async t => {
  const ws = makeWorkspace();
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  t.equal(run.code, 0, `installer should succeed after install:\n${run.combined}`);
  t.ok(existsSync(join(ws.home, '.local/bin/pi')), 'pi CLI installed to .local/bin/pi');
  t.ok(existsSync(piModelsPath(ws)), 'models.json written after installing pi');
});

test('pi', 'CLI not found installs via npm when npm is available', async t => {
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), withPiInstallHook: false });
  t.equal(run.code, 0, `npm install should succeed:\n${run.combined}`);
  t.equal(readFileSync(join(ws.root, 'npm-record.txt'), 'utf8').trim(), 'install --global @earendil-works/pi-coding-agent');
});

test('pi', 'CLI not found fails when installer download fails', async t => {
  const ws = makeWorkspace();
  modelServer.mode = 'installer-html';
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: piConfig(),
    withPiInstallHook: false,
    piInstallerUrl: `${modelServer.url}/install-pi.sh`,
  });
  t.ok(run.code !== 0, 'downloading HTML instead of shell script should fail');
  t.includes(run.combined, 'the installer download was HTML');
});

test('pi', 'fails when pi --version times out', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: piConfig(),
    fakePiVersionSleep: 5,
    timeoutSeconds: 1,
  });
  t.notEqual(run.code, 0, 'setup must fail when version times out');
  t.includes(run.combined, 'timed out');
});

test('pi', 'Bash installer body parses under the macOS Bash 3.2 baseline', t => {
  const probe = spawnSync('/bin/bash', ['-n', '-c', ALL_BASH_FRAGMENTS], { encoding: 'utf8' });
  t.equal(probe.status, 0, `all Bash fragments must parse without syntax errors: ${probe.stderr}`);
  t.excludes(SETUP_BASH_PI, 'echo ', 'echo must not be used in Bash installer; use printf instead');
});

test('pi', 'a download that ends before the final main call performs no setup work', t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const fullScript = renderShellPrefix({ agent: 'pi', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration: piConfig(), token: 'test-lease-token' }) + shellBody('pi');
  const truncatedScript = fullScript.slice(0, fullScript.lastIndexOf(shellEntry('pi')));
  const scriptPath = join(ws.root, 'truncated.sh');
  writeFileSync(scriptPath, truncatedScript);
  const probe = spawnSync('/bin/bash', [scriptPath], {
    env: { HOME: ws.home, PATH: [ws.binDir, SHIM_BIN].join(':'), TMPDIR: ws.root, SETUP_ENDPOINT: modelServer.url },
    encoding: 'utf8',
  });
  t.equal(probe.status, 0, 'truncated script defines functions and exits without executing main');
  t.ok(!existsSync(piModelsPath(ws)), 'no models.json created');
});

// --- PowerShell Pi Cases ---

test('pi', 'PowerShell: fresh install writes models.json with 0600 mode and exact JSON shape, without settings.json', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  modelServer.reset();
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  t.equal(run.code, 0, `fresh install should succeed:\n${run.combined}`);
  t.includes(run.stdout, '==> Completed Agent Setup: Pi', 'completion notice emitted');
  t.includes(run.stdout, 'Models configured as a static snapshot; re-run this setup command at any time to refresh the model list.', 'snapshot hint emitted');
  const modelsFile = piModelsPath(ws);
  t.ok(existsSync(modelsFile), 'models.json exists');
  t.equal(statSync(modelsFile).mode & 0o777, 0o600, 'models.json permissions are 0600');
  const settingsFile = piSettingsPath(ws);
  t.ok(!existsSync(settingsFile), 'settings.json does not exist when no default model is configured');
  const models = readPiModels(modelsFile) as { providers: Record<string, any> };
  t.ok(models.providers?.floway !== undefined, 'floway provider exists');
  t.equal(models.providers.floway.name, 'Floway');
  t.equal(models.providers.floway.baseUrl, `${modelServer.url}/v1`);
  t.equal(models.providers.floway.api, 'openai-responses');
  t.equal(models.providers.floway.apiKey, SENTINEL_KEY);
  t.equal(models.providers.floway.models?.length, 1);
  t.equal(models.providers.floway.models[0].id, 'floway-pi-model-1');
});

test('pi', 'PowerShell: model set, changed, and cleared updates settings.json', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const settingsFile = piSettingsPath(ws);

  // 1. Model set
  const run1 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  t.equal(run1.code, 0, `setting model should succeed:\n${run1.combined}`);
  t.ok(existsSync(settingsFile), 'settings.json created');
  t.equal(statSync(settingsFile).mode & 0o777, 0o600, 'settings.json permissions are 0600');
  let settings = readPiSettings(settingsFile);
  t.equal(settings.defaultProvider, 'floway');
  t.equal(settings.defaultModel, 'floway-pi-model-1');

  // 2. Model changed
  const run2 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'model-2' }) });
  t.equal(run2.code, 0, `changing model should succeed:\n${run2.combined}`);
  settings = readPiSettings(settingsFile);
  t.equal(settings.defaultProvider, 'floway');
  t.equal(settings.defaultModel, 'model-2');

  // 3. Model cleared
  const run3 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: null }) });
  t.equal(run3.code, 0, `clearing model should succeed:\n${run3.combined}`);
  settings = readPiSettings(settingsFile);
  t.equal(settings.defaultProvider, undefined, 'defaultProvider removed on clear');
  t.equal(settings.defaultModel, undefined, 'defaultModel removed on clear');
});

test('pi', 'PowerShell: unrelated defaultProvider preserved when model is cleared', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const dir = piDirFor(ws);
  mkdirSync(dir, { recursive: true });
  const settingsFile = piSettingsPath(ws);
  writeFileSync(settingsFile, JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-3-opus' }, null, 2));

  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: null }) });
  t.equal(run.code, 0, `clearing with unrelated provider should succeed:\n${run.combined}`);
  const settings = readPiSettings(settingsFile);
  t.equal(settings.defaultProvider, 'anthropic', 'unrelated defaultProvider preserved');
  t.equal(settings.defaultModel, 'claude-3-opus', 'unrelated defaultModel preserved');
});

test('pi', 'PowerShell: idempotent re-run produces no diff and prunes backups', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run1 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  t.equal(run1.code, 0, `first run should succeed:\n${run1.combined}`);
  const models1 = readFileSync(piModelsPath(ws), 'utf8');
  const settings1 = readFileSync(piSettingsPath(ws), 'utf8');

  const run2 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  t.equal(run2.code, 0, `second run should succeed:\n${run2.combined}`);
  t.equal(readFileSync(piModelsPath(ws), 'utf8'), models1, 'models.json identical');
  t.equal(readFileSync(piSettingsPath(ws), 'utf8'), settings1, 'settings.json identical');
  t.equal(piBackupFiles(piDirFor(ws), 'models.json').length, 0, 'no models backups remain');
  t.equal(piBackupFiles(piDirFor(ws), 'settings.json').length, 0, 'no settings backups remain');
});

test('pi', 'PowerShell: preserves unrelated providers, comments, CRLF, and trailing comma', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  mkdirSync(piDirFor(ws), { recursive: true });

  const priorModels = '// Header comment\r\n{\r\n  // Provider comment\r\n  "providers": {\r\n    "anthropic": {\r\n      "name": "Anthropic",\r\n      "apiKey": "ant-key",\r\n    },\r\n  },\r\n}';
  const priorSettings = '// Settings comment\r\n{\r\n  /* theme block */\r\n  "theme": "dark",\r\n}';
  writeFileSync(piModelsPath(ws), priorModels);
  writeFileSync(piSettingsPath(ws), priorSettings);

  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  t.equal(run.code, 0, `setup should succeed:\n${run.combined}`);

  const modelsText = readFileSync(piModelsPath(ws), 'utf8');
  t.includes(modelsText, '// Header comment', 'header comment preserved');
  t.includes(modelsText, '// Provider comment', 'provider comment preserved');
  t.includes(modelsText, '"anthropic":', 'unrelated provider preserved');
  t.includes(modelsText, '"floway":', 'floway provider present');
  t.ok(modelsText.includes('\r\n'), 'CRLF preserved in models.json');

  const settingsText = readFileSync(piSettingsPath(ws), 'utf8');
  t.includes(settingsText, '// Settings comment', 'settings comment preserved');
  t.includes(settingsText, '/* theme block */', 'theme block comment preserved');
  t.includes(settingsText, '"theme": "dark"', 'unrelated setting preserved');
  t.includes(settingsText, '"defaultProvider": "floway"', 'defaultProvider set');
  t.includes(settingsText, '"defaultModel": "floway-pi-model-1"', 'defaultModel set');
  t.ok(settingsText.includes('\r\n'), 'CRLF preserved in settings.json');
});

test('pi', 'PowerShell: refuses unparseable models.json without modifying file', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  mkdirSync(piDirFor(ws), { recursive: true });
  const badContent = '{\n  "providers": {\n';
  writeFileSync(piModelsPath(ws), badContent);

  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  t.notEqual(run.code, 0, 'installer should fail on unparseable models.json');
  t.equal(readFileSync(piModelsPath(ws), 'utf8'), badContent, 'models.json remains untouched');
});

test('pi', 'PowerShell: refuses unparseable settings.json without modifying file', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  mkdirSync(piDirFor(ws), { recursive: true });
  const badSettings = '{\n  "theme": "dark"';
  writeFileSync(piSettingsPath(ws), badSettings);

  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  t.notEqual(run.code, 0, 'installer should fail on unparseable settings.json');
  t.equal(readFileSync(piSettingsPath(ws), 'utf8'), badSettings, 'settings.json remains untouched');
});

test('pi', 'PowerShell: rollback restores original models.json and settings.json on failure', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  mkdirSync(piDirFor(ws), { recursive: true });
  const priorModels = '{\n  "providers": {\n    "anthropic": {}\n  }\n}\n';
  const priorSettings = '{\n  "theme": "light"\n}\n';
  writeFileSync(piModelsPath(ws), priorModels);
  writeFileSync(piSettingsPath(ws), priorSettings);

  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: piConfig({ model: 'floway-pi-model-1' }),
    fakePiFailConfig: true,
  });
  t.notEqual(run.code, 0, 'setup must fail when simulated failure occurs');
  t.equal(readFileSync(piModelsPath(ws), 'utf8'), priorModels, 'original models.json restored');
  t.equal(readFileSync(piSettingsPath(ws), 'utf8'), priorSettings, 'original settings.json restored');
  t.equal(piStagedFiles(piDirFor(ws)).length, 0, 'no staged files remain');
});

test('pi', 'PowerShell: missing node aborts with clear error message', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), omitNode: true });
  t.notEqual(run.code, 0, 'installer should fail when node is missing');
  t.includes(run.combined, 'Node.js (>= 22.19) is required to run Pi but was not found on PATH. Install Node.js (>= 22.19) and re-run.');
  t.ok(!existsSync(piModelsPath(ws)), 'models.json not created when node check fails');
});

test('pi', 'PowerShell: older node warns but continues', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), fakeNodeVersion: 'v20.10.0' });
  t.equal(run.code, 0, `setup should succeed even with older node:\n${run.combined}`);
  t.includes(run.combined, 'Pi requires Node.js >= 22.19.', 'warning emitted for older node');
  t.ok(existsSync(piModelsPath(ws)), 'models.json created');
});

test('pi', 'PowerShell: resolves agent directory from PI_CODING_AGENT_DIR', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const customDir = join(ws.home, 'custom-pi-agent');
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), piAgentDir: customDir });
  t.equal(run.code, 0, `setup should succeed with custom agent dir:\n${run.combined}`);
  t.ok(existsSync(join(customDir, 'models.json')), 'models.json written to custom PI_CODING_AGENT_DIR');
});

test('pi', 'PowerShell: API key is never printed to stdout or stderr during setup', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  t.equal(run.code, 0, `setup should succeed:\n${run.combined}`);
  t.excludes(run.combined, SENTINEL_KEY, 'sentinel key must never be printed to stdout or stderr');
});

test('pi', 'PowerShell: ambient SETUP_API_KEY is not inherited by fake pi CLI', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), ambientApiKey: true });
  t.equal(run.code, 0, `ambient key must not cause fake pi to exit 91:\n${run.combined}`);
});

test('pi', 'PowerShell: CLI not found runs test installer hook and installs pi', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  t.equal(run.code, 0, `installer should succeed after install:\n${run.combined}`);
  t.ok(existsSync(join(ws.home, '.local/bin/pi')), 'pi CLI installed to .local/bin/pi');
  t.ok(existsSync(piModelsPath(ws)), 'models.json written after installing pi');
});

test('pi', 'PowerShell prefers npm over the direct installer when npm is available', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), withPiInstallHook: false });
  t.equal(run.code, 0, `npm install should succeed:\n${run.combined}`);
  t.equal(readFileSync(join(ws.root, 'npm-record.txt'), 'utf8').trim(), 'install --global @earendil-works/pi-coding-agent');
});

test('pi', 'PowerShell: CLI not found fails when installer download fails', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  modelServer.mode = 'installer-html';
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: piConfig(),
    withPiInstallHook: false,
    piInstallerUrl: `${modelServer.url}/install-pi.ps1`,
  });
  t.ok(run.code !== 0, 'downloading HTML instead of script should fail');
  t.includes(run.combined, 'the installer download was HTML or empty');
});

test('pi', 'PowerShell: fails when pi --version times out', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: piConfig(),
    fakePiVersionSleep: 5,
    timeoutSeconds: 1,
  });
  t.notEqual(run.code, 0, 'setup must fail when version times out');
  t.includes(run.combined, '`pi --version` timed out');
});

test('pi', 'local PowerShell installer accepts script content and rejects HTML', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const accepted = makeWorkspace();
  modelServer.mode = 'installer-pi-ps1';
  const success = await runPowerShellInstaller({
    workspace: accepted,
    configuration: piConfig(),
    baseUrl: modelServer.url,
    withPiInstallHook: false,
    piInstallerUrl: `${modelServer.url}/install-pi.ps1`,
  });
  t.equal(success.code, 0, `a local PowerShell installer should be accepted:\n${success.combined}`);
  t.ok(existsSync(installerMarker(accepted)), 'accepted installer executed');

  const rejected = makeWorkspace();
  modelServer.mode = 'installer-html';
  const failure = await runPowerShellInstaller({
    workspace: rejected,
    configuration: piConfig(),
    baseUrl: modelServer.url,
    withPiInstallHook: false,
    piInstallerUrl: `${modelServer.url}/install-pi.ps1`,
  });
  t.notEqual(failure.code, 0, 'HTML installer response must be rejected');
  t.ok(!existsSync(installerMarker(rejected)), 'HTML response never executes');
});

test('pi', 'PowerShell: timed-out installer terminates cleanly', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  modelServer.mode = 'installer-pi-ps1';
  const started = Date.now();
  const run = await runPowerShellInstaller({
    workspace: ws,
    configuration: piConfig(),
    baseUrl: modelServer.url,
    withPiInstallHook: false,
    piInstallerUrl: `${modelServer.url}/install-pi.ps1`,
    installerSleep: 12,
    timeoutSeconds: 1,
  });
  t.notEqual(run.code, 0, 'timed out installer must fail the agent');
  t.ok(Date.now() - started < 8_000, 'installer deadline must fire well before natural completion');
  t.ok(!existsSync(installerMarker(ws)), 'timed-out installer must not reach its marker');
});

test('pi', 'PowerShell installer body parses without syntax errors', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const body = powerShellBody('pi');
  const entry = powerShellEntry('pi');
  t.ok(body.trimEnd().endsWith(entry), 'the downloaded script starts execution only from its final line');
  t.ok(body.lastIndexOf(entry) > body.indexOf('function Set-SetupAgent {'), 'the entry call follows every agent function');
  const script = renderPowerShellPrefix({
    agent: 'pi',
    apiKey: SENTINEL_KEY,
    apiKeyName: 'Primary key',
    configuration: piConfig({ model: 'm' }),
    token: 'test-lease-token',
  }) + body;
  const scriptPath = join(HARNESS_ROOT, 'pi-parse-check.ps1');
  writeFileSync(scriptPath, script);
  const check = `$errs=$null; [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replace(/'/g, "''")}',[ref]$null,[ref]$errs); if($errs -and $errs.Count -gt 0){ $errs | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 } else { exit 0 }`;
  const result = spawnSync(hostPwsh, ['-NoProfile', '-Command', check], { encoding: 'utf8' });
  t.equal(result.status, 0, `PowerShell parse errors:\n${result.stdout}${result.stderr}`);
});

test('pi', 'PowerShell: a download that ends before the final Main call performs no setup work', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const configuration = piConfig();
  const body = powerShellBody('pi');
  const bodyWithoutEntry = body.slice(0, body.lastIndexOf(powerShellEntry('pi')));
  const script = renderPowerShellPrefix({ agent: 'pi', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration, token: 'test-lease-token' }) + bodyWithoutEntry;
  const scriptPath = join(ws.root, 'truncated-pi-setup.ps1');
  writeFileSync(scriptPath, script);
  const result = spawnSync(hostPwsh, ['-NoProfile', '-File', scriptPath], {
    encoding: 'utf8',
    env: { HOME: ws.home, PATH: [ws.binDir, SHIM_BIN].join(':'), SETUP_ENDPOINT: modelServer.url },
  });
  t.equal(result.status, 0, `definitions-only script should exit cleanly:\n${result.stderr}`);
  t.ok(!existsSync(piModelsPath(ws)), 'no models.json created');
});

test('pi', 'PowerShell stages secret data only after protection and hardens Windows replacement targets', t => {
  const body = SETUP_POWERSHELL_PI;
  t.excludes(body, 'ToUnixTimeMilliseconds()', 'PowerShell 5.1-incompatible timestamp API must not be used');
  t.includes(body, 'Move-Item -LiteralPath $script:PiModelsStage -Destination $script:PiModelsPath', 'new target must use a same-directory move');
});

test('pi', 'installer scripts embed expected URLs and command sequences', t => {
  t.includes(SETUP_POWERSHELL_PI, '@earendil-works/pi-coding-agent', 'PowerShell can install pi with npm');
  t.includes(SETUP_POWERSHELL_PI, 'https://pi.dev/install.sh', 'PowerShell uses official install.sh URL');
  t.includes(SETUP_BASH_PI, '@earendil-works/pi-coding-agent', 'Bash installer specifies the npm package name');
  t.includes(SETUP_BASH_PI, 'https://pi.dev/install.sh', 'Bash installer specifies the official install.sh URL');
});

test('pi', 'real pi smoke: models.json loads cleanly in real pi CLI', async t => {
  if (!hostPiBin) skip('real pi is not available or --version failed');
  const cmd = hostPiBin;
  // `--list-models` makes the real CLI parse the generated models.json and
  // print the registered Floway snapshot, so a schema mismatch fails here.
  const listModels = (home: string) => spawnSync('/bin/sh', ['-c', `${cmd} --list-models floway-pi-model-1`], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });

  const ws = makeWorkspace();
  writeFileSync(join(ws.binDir, 'pi'), `#!/bin/sh\nexec ${cmd} "$@"\n`, { mode: 0o755 });
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: piConfig({ model: 'floway-pi-model-1' }),
    withPiInstallHook: false,
  });
  t.equal(run.code, 0, `pi installer should succeed: ${run.combined}`);
  const probe = listModels(ws.home);
  t.equal(probe.status, 0, `pi --list-models failed: ${probe.stderr}\n${probe.stdout}`);
  t.includes(probe.stdout, 'floway', 'real pi lists the Floway provider');
  t.includes(probe.stdout, 'floway-pi-model-1', 'real pi lists the snapshot model');

  if (hostPwsh) {
    const psWs = makeWorkspace();
    writeFileSync(join(psWs.binDir, 'pi'), `#!/bin/sh\nexec ${cmd} "$@"\n`, { mode: 0o755 });
    modelServer.reset();
    const psRun = await runPowerShellInstaller({
      workspace: psWs,
      baseUrl: modelServer.url,
      configuration: piConfig({ model: 'floway-pi-model-1' }),
      withPiInstallHook: false,
    });
    t.equal(psRun.code, 0, `pi PowerShell installer should succeed: ${psRun.combined}`);
    const psProbe = listModels(psWs.home);
    t.equal(psProbe.status, 0, `pi --list-models failed after PowerShell install: ${psProbe.stderr}\n${psProbe.stdout}`);
    t.includes(psProbe.stdout, 'floway-pi-model-1', 'real pi lists the snapshot model after the PowerShell install');
  }
});

// --- run --------------------------------------------------------------------

const parseAgentFilter = (): ScriptAgent | 'all' => {
  const index = process.argv.indexOf('--agent');
  if (index === -1) return 'all';
  const value = process.argv[index + 1];
  if (value === 'claude' || value === 'codex' || value === 'pi') return value;
  throw new Error(`--agent must be "claude", "codex" or "pi", got ${JSON.stringify(value)}`);
};

const main = async (): Promise<void> => {
  const filter = parseAgentFilter();
  modelServer = await startModelServer();

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: string[] = [];

  try {
    for (const testCase of cases) {
      if (filter !== 'all' && testCase.agent !== filter) continue;
      modelServer.reset();
      const assert = makeAssert();
      const label = `[${testCase.agent}] ${testCase.name}`;
      try {
        await testCase.fn(assert);
        passed += 1;
        console.log(`  PASS ${label}`);
      } catch (error) {
        if (error instanceof SkipError) {
          skipped += 1;
          console.log(`  SKIP ${label} — ${error.message}`);
          continue;
        }
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${label}\n${message}`);
        console.log(`  FAIL ${label}`);
      }
    }
  } finally {
    await modelServer.close();
    for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
  }

  console.log(`\nagent-setup installers: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const failure of failures) console.error(`\n${failure}`);
    process.exit(1);
  }
};

await main();
