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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, lstatSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type { AgentSetupConfiguration } from '../src/configuration.ts';
import { addressVSCodeModels, projectVSCodeModels, projectZedModels } from '../src/models.ts';
import type { VSCodeApiType } from '../src/models.ts';
import { renderPowerShellPrefix, renderShellPrefix } from '../src/render.ts';
import {
  SETUP_BASH_CLAUDE,
  SETUP_BASH_CODEX,
  SETUP_BASH_COMMON,
  SETUP_BASH_ZED,
  SETUP_POWERSHELL_CLAUDE,
  SETUP_POWERSHELL_CODEX,
  SETUP_POWERSHELL_COMMON,
  SETUP_POWERSHELL_ZED,
} from '../src/script-assets.generated.ts';
import { type ScriptAgent, SETUP_SCRIPT_BODIES } from '../src/script-assets.ts';

const powerShellLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const AGENT_NAMES: Record<ScriptAgent, string> = { claude: 'Claude Code', codex: 'Codex', zed: 'Zed', vscode: 'VS Code' };
const shellEntry = (agent: ScriptAgent): string => `main '${AGENT_NAMES[agent]}' "$@"`;
const powerShellEntry = (agent: ScriptAgent): string => `$global:LASTEXITCODE = Main '${AGENT_NAMES[agent]}'`;
const shellBody = (agent: ScriptAgent): string => SETUP_SCRIPT_BODIES[agent].sh;
const powerShellBody = (agent: ScriptAgent): string => SETUP_SCRIPT_BODIES[agent].ps1;
const ALL_BASH_FRAGMENTS = SETUP_BASH_COMMON + SETUP_BASH_CLAUDE + SETUP_BASH_CODEX + SETUP_BASH_ZED;
const ALL_POWERSHELL_FRAGMENTS = SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_CLAUDE + SETUP_POWERSHELL_CODEX + SETUP_POWERSHELL_ZED;

// A fixed, highly greppable fake credential. Every test asserts this string
// never reaches the installer's stdout/stderr, so a real leak is unmistakable.
const SENTINEL_KEY = 'sk-floway-SENTINEL-Do-Not-Log-9f3c1a7b2e4d6058';

// --- tiny test runner -------------------------------------------------------

class SkipError extends Error {}
const skip: (reason: string) => never = reason => { throw new SkipError(reason); };

interface Assert {
  ok(cond: boolean, message: string): void;
  equal<T>(actual: T, expected: T, message: string): void;
  includes(haystack: string, needle: string, message: string): void;
  excludes(haystack: string, needle: string, message: string): void;
}

const makeAssert = (): Assert => ({
  ok(cond, message) { if (!cond) throw new Error(message); },
  equal(actual, expected, message) {
    if (actual !== expected) throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  },
  includes(haystack, needle, message) {
    if (!haystack.includes(needle)) throw new Error(`${message}\n  expected to find: ${JSON.stringify(needle)}\n  within: ${JSON.stringify(haystack.slice(0, 4000))}`);
  },
  excludes(haystack, needle, message) {
    if (haystack.includes(needle)) throw new Error(`${message}\n  unexpected substring present: ${JSON.stringify(needle)}`);
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
for (const tool of ['sh', 'bash', 'env', 'awk', 'cat', 'chmod', 'cmp', 'cp', 'date', 'grep', 'mkdir', 'mkfifo', 'mktemp', 'mv', 'readlink', 'rm', 'shasum', 'sleep', 'stat', 'uname', 'curl']) {
  const path = resolveTool(tool);
  if (!path) throw new Error(`required tool ${tool} is not available on the host; cannot run the installer harness`);
  symlinkSync(path, join(SHIM_BIN, tool));
}
for (const tool of ['sha256sum', 'openssl', 'timeout', 'gtimeout']) {
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

// --- local HTTP fixtures ----------------------------------------------------

// One row per branch of the Zed projection: an adaptive reasoner that also
// takes images, a budgeted reasoner, a model with no limits at all, and a
// non-chat kind the projection must drop.
const EDITOR_CATALOG = {
  object: 'list',
  data: [
    {
      id: 'claude-opus-4-6', object: 'model', type: 'model', display_name: 'Claude Opus 4.6',
      kind: 'chat', endpoints: { messages: {} },
      limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 64_000 },
      chat: { modalities: { input: ['text', 'image'], output: ['text'] }, reasoning: { adaptive: true, effort: { supported: ['low', 'high'], default: 'high' } } },
    },
    {
      id: 'gpt-5.6', object: 'model', type: 'model', display_name: 'GPT-5.6',
      kind: 'chat', endpoints: { responses: {} },
      limits: { max_context_window_tokens: 400_000, max_output_tokens: 128_000 },
      chat: { modalities: { input: ['text'], output: ['text'] }, reasoning: { budget_tokens: { min: 1024, max: 32_000 } } },
    },
    {
      id: 'plain-chat', object: 'model', type: 'model', display_name: 'Plain',
      kind: 'chat', endpoints: { chatCompletions: {} }, limits: {},
    },
    {
      // Reasoning with no budget at all — the shape every Codex model has. Zed
      // must be left in Default mode rather than sent a null thinking budget.
      id: 'effort-only', object: 'model', type: 'model', display_name: 'Effort Only',
      kind: 'chat', endpoints: { responses: {} },
      limits: { max_prompt_tokens: 120_000 },
      chat: { reasoning: { effort: { supported: ['low', 'high'], default: 'high' } } },
    },
    {
      // A floor with no ceiling — the shape every Claude Code model has.
      id: 'floor-only', object: 'model', type: 'model', display_name: 'Floor Only',
      kind: 'chat', endpoints: { messages: {} },
      limits: { max_context_window_tokens: 200_000 },
      chat: { reasoning: { budget_tokens: { min: 1024 } } },
    },
    {
      // A ceiling with no floor — the fallback arm of the budget selection.
      // Carries an output limit, because the budget has to stay under the
      // max_tokens Zed sends — which is that limit, or 4096 without one.
      id: 'ceiling-only', object: 'model', type: 'model', display_name: 'Ceiling Only',
      kind: 'chat', endpoints: { messages: {} },
      limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 },
      chat: { reasoning: { budget_tokens: { max: 32_000 } } },
    },
    {
      // Zero limits and an empty effort list. A stated 0 is a value, not an
      // absent limit, and it has to survive the projection, the embedding in
      // the script, and both merges.
      id: 'zero-limits', object: 'model', type: 'model', display_name: 'Zero Limits',
      kind: 'chat', endpoints: { chatCompletions: {} },
      limits: { max_context_window_tokens: 0, max_output_tokens: 0 },
      chat: { reasoning: { effort: { supported: [], default: 'low' } } },
    },
    {
      // States a window, a prompt limit and an output limit — the shape Copilot
      // reports. The two editors derive different things from it, so it has to
      // survive the projection and both merges intact.
      id: 'all-three-limits', object: 'model', type: 'model', display_name: 'All Three',
      kind: 'chat', endpoints: { messages: {} },
      limits: { max_context_window_tokens: 216_000, max_prompt_tokens: 128_000, max_output_tokens: 64_000 },
    },
    {
      // Addressable but not listed: the dashboard asks for these to populate
      // its alias combobox, and a setup run must not advertise one.
      id: 'vendor/unlisted-chat', object: 'model', type: 'model', display_name: 'Unlisted',
      kind: 'chat', endpoints: { messages: {} }, limits: {}, unlisted: true,
    },
    {
      id: 'embed-3', object: 'model', type: 'model', display_name: 'Embed',
      kind: 'embedding', endpoints: { embeddings: {} }, limits: {},
    },
  ],
};

type ModelServerMode =
  | 'ok'
  | 'installer-sh' | 'installer-ps1' | 'installer-html'
  | 'installer-codex-sh' | 'installer-codex-ps1';
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
    if (pathname === '/install.sh' || pathname === '/install-codex.sh') {
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
    }
    if (pathname === '/install.ps1' || pathname === '/install-codex.ps1') {
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

const zedCredentialRecord = (workspace: Workspace): string => join(workspace.root, 'credential-calls.txt');
const zedCredentialSecret = (workspace: Workspace): string => join(workspace.root, 'credential-secret.bin');

// Stand-ins for the OS credential stores, which no test host can be asked to
// mutate. Each records its own argument vector, and the secret-tool shim writes
// what it received on stdin to a sibling file, so the assertions see exactly
// what the installer asked the real tool to do. `binDir` precedes SHIM_BIN on
// PATH, and SHIM_BIN carries neither name, so these are what `command -v` and a
// bare invocation resolve to.
//
// The secret goes to its own file rather than into the record: the record is
// newline-delimited, and `cat` is the only byte-preserving tool on the
// harness's hermetic PATH — a pipeline through `od` or `xxd` would silently
// produce nothing there.
// Makes the workspace's `stat` look like stock macOS: no `-c`, only `-f`. On a
// GNU host the `-c` branch answers and the BSD one — the only mode source macOS
// has — would ship unexecuted unless the dialect is forced.
//
// The shim serves the BSD call as well as refusing the GNU one; refusing
// without serving would make the fallback look broken when it is the shim that
// cannot answer. It asks the host's own stat in whichever dialect that stat
// speaks — a macOS runner without coreutils has only `-f`, and hardcoding `-c`
// there would fail this test as a mode regression on the very platform the leg
// exists to model.
// A `stat` that answers neither dialect. Both halves then leave the mode alone
// — and "alone" is a different mode on each: the Bash stage comes from a shell
// redirect under `umask 077`, the PowerShell one from WriteAllText under the
// inherited umask. Widening the operator's file is what the carry-over exists
// to prevent, so neither may fall back to its own umask.
const placeMuteStatShim = (workspace: Workspace): void => {
  writeFileSync(join(workspace.binDir, 'stat'), '#!/bin/bash\nprintf \'stat: unavailable\\n\' >&2\nexit 1\n', { mode: 0o755 });
};

const placeBsdStatShim = (workspace: Workspace): void => {
  const realStat = resolveTool('stat')!;
  writeFileSync(join(workspace.binDir, 'stat'), `#!/bin/bash
fmt=""
target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -c) printf 'stat: illegal option -- c\n' >&2; exit 1 ;;
    -f) fmt=$2; shift ;;
    *) target=$1 ;;
  esac
  shift
done
case "$fmt" in
  '%Lp')
    ${JSON.stringify(realStat)} -c '%a' "$target" 2>/dev/null \
      || ${JSON.stringify(realStat)} -f '%Lp' "$target"
    ;;
  *) printf 'stat: unsupported format\n' >&2; exit 1 ;;
esac
`, { mode: 0o755 });
};

const placeFakeCredentialTools = (workspace: Workspace): void => {
  const record = zedCredentialRecord(workspace);
  writeFileSync(join(workspace.binDir, 'security'), `#!/bin/bash
printf 'security\\t%s\\n' "$*" >> ${JSON.stringify(record)}
`, { mode: 0o755 });
  writeFileSync(join(workspace.binDir, 'secret-tool'), `#!/bin/bash
case "$1" in store) cat > ${JSON.stringify(zedCredentialSecret(workspace))} ;; esac
printf 'secret-tool\\t%s\\n' "$*" >> ${JSON.stringify(record)}
`, { mode: 0o755 });
};

const readCredentialCalls = (workspace: Workspace): string[] => {
  const path = zedCredentialRecord(workspace);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '');
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
  *) exit 64 ;;
esac
`, { mode: 0o755 });
};

type InstallerTestConfiguration = AgentSetupConfiguration & { readonly testAgent: ScriptAgent };

// Every builder starts from the same all-overrides-unset configuration and
// narrows one agent's slice, so a new field on the schema lands in one place.
const baseConfig = (): AgentSetupConfiguration => ({
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, modelDiscovery: false,
  },
  codex: { model: null, reasoningEffort: null },
  zed: { providerName: 'Floway' },
  vscode: { providerName: 'Floway', apiType: 'messages' },
});

const claudeConfig = (overrides: Partial<AgentSetupConfiguration['claudeCode']> = {}): InstallerTestConfiguration => {
  const base = baseConfig();
  return { ...base, testAgent: 'claude', claudeCode: { ...base.claudeCode, ...overrides } };
};

const codexConfig = (overrides: Partial<AgentSetupConfiguration['codex']> = {}): InstallerTestConfiguration => {
  const base = baseConfig();
  return { ...base, testAgent: 'codex', codex: { ...base.codex, ...overrides } };
};

const zedConfig = (overrides: Partial<AgentSetupConfiguration['zed']> = {}): InstallerTestConfiguration => {
  const base = baseConfig();
  return { ...base, testAgent: 'zed', zed: { ...base.zed, ...overrides } };
};

const vscodeConfig = (overrides: Partial<AgentSetupConfiguration['vscode']> = {}): InstallerTestConfiguration => {
  const base = baseConfig();
  return { ...base, testAgent: 'vscode', vscode: { ...base.vscode, ...overrides } };
};

const bothConfig = (
  claude: Partial<AgentSetupConfiguration['claudeCode']> = {},
  codex: Partial<AgentSetupConfiguration['codex']> = {},
): InstallerTestConfiguration => {
  const base = baseConfig();
  return {
    ...base,
    testAgent: 'claude',
    claudeCode: { ...base.claudeCode, ...claude },
    codex: { ...base.codex, ...codex },
  };
};

interface RunOptions {
  workspace: Workspace;
  configuration: InstallerTestConfiguration;
  agent?: ScriptAgent;
  // Where the installer runs from, for the cases where a relative override has
  // to resolve against something the test controls.
  cwd?: string;
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
  codexInstallerUrl?: string;
  ambientCodexNonInteractive?: string;
  powerShellTimeSeparator?: string;
  // Forces the existing-file branch through File.Replace on non-Windows hosts,
  // exercising PowerShell's real-null interop without a production test hook.
  forcePowerShellWindowsReplacement?: boolean;
  // Overrides the catalog the gateway would have projected into the script.
  catalog?: readonly unknown[];
  // Output-contract knobs. `forceColor` sets AGENT_SETUP_TEST_FORCE_COLOR so
  // the palette is emitted even though the harness captures (never a TTY);
  // `noColor` sets NO_COLOR; `failRestore` sets AGENT_SETUP_TEST_FAIL_RESTORE
  // so the PowerShell rollback restore rename fails, exercising its recovery
  // guidance the way the Bash `mv` shim does for Bash.
  forceColor?: boolean;
  noColor?: boolean;
  failRestore?: boolean;
  // Zed knobs. `zedConfigDir` points the installer at a workspace directory
  // instead of the real `~/.config/zed`, and the credential record replaces the
  // OS credential store no test host can be asked to mutate.
  zedConfigDir?: string;
  vscodeUserDir?: string;
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
// What the gateway would embed for this run. A test that wants an empty
// provider list passes its own catalog rather than driving an HTTP fixture.
const editorModelsFor = (agent: ScriptAgent, catalog: readonly unknown[] = EDITOR_CATALOG.data, apiType: VSCodeApiType = 'messages') => {
  if (agent === 'zed') return projectZedModels(catalog as never);
  if (agent === 'vscode') return projectVSCodeModels(catalog as never, apiType);
  return undefined;
};

const runShellInstaller = (options: RunOptions): Promise<RunResult> => {
  const { workspace, configuration } = options;
  const agent = targetAgent(configuration, options.agent);
  const script = renderShellPrefix({ agent, apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration, editorModels: editorModelsFor(agent, options.catalog, configuration.vscode.apiType) }) + shellBody(agent);
  const scriptPath = join(workspace.root, 'setup.sh');
  writeFileSync(scriptPath, script);

  const pathParts = [workspace.binDir, options.excludeTimeoutTools ? NO_TIMEOUT_BIN : SHIM_BIN];
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
  if (options.zedConfigDir) env.AGENT_SETUP_TEST_ZED_CONFIG_DIR = options.zedConfigDir;
  if (options.vscodeUserDir) env.AGENT_SETUP_TEST_VSCODE_USER_DIR = options.vscodeUserDir;

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
    const child = spawn('/bin/bash', [scriptPath], { cwd: options.cwd, env, detached: signal !== undefined });
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
  const script = renderShellPrefix({ agent, apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration, editorModels: editorModelsFor(agent, options.catalog, configuration.vscode.apiType) }) + shellBody(agent);
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
  };
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

const networkReachable = (): boolean => {
  const probe = spawnSync('/usr/bin/curl', ['-fsSL', '-o', '/dev/null', '--max-time', '8', 'https://github.com/jqlang/jq/releases/download/jq-1.8.2/sha256sum.txt'], { encoding: 'utf8' });
  return probe.status === 0;
};

// Each installer replaces an existing managed file atomically, but only on
// Windows — so on every other host that branch would ship unexecuted, and it is
// where a `$null` PowerShell binds as String.Empty aborts the whole install.
// Dropping the platform conjunct runs it here. Keyed per agent and asserted
// rather than chained as .replace calls, because a rewrite that silently
// stopped matching would restore the gap it exists to close.
const WINDOWS_REPLACEMENT_GUARDS: Record<ScriptAgent, string> = {
  claude: 'if ($script:ClaudeSettingsExisted -and $runningOnWindows)',
  codex: 'if ($script:CodexTokenExisted -and $runningOnWindows)',
  vscode: 'if ($script:VSCodeSettingsExisted -and $runningOnWindows)',
  zed: 'if ($script:ZedSettingsExisted -and (Test-SetupIsWindows))',
};

const forceWindowsReplacement = (agent: ScriptAgent, body: string): string => {
  const guard = WINDOWS_REPLACEMENT_GUARDS[agent];
  if (!body.includes(guard)) throw new Error(`${agent}: no Windows replacement guard matching ${guard}`);
  return body.replace(guard, `${guard.slice(0, guard.indexOf(' -and '))})`);
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
  const body = options.forcePowerShellWindowsReplacement ? forceWindowsReplacement(agent, canonicalBody) : canonicalBody;
  const script = powerShellBaseUrlPrelude(options) + renderPowerShellPrefix({ agent, apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration, editorModels: editorModelsFor(agent, options.catalog, configuration.vscode.apiType) }) + culturePrelude + body;
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
  const env: Record<string, string> = {
    HOME: workspace.home,
    PATH: [workspace.binDir, SHIM_BIN].join(':'),
    FAKE_CLAUDE_VERSION_SLEEP: String(options.fakeClaudeVersionSleep ?? 0),
    FAKE_INSTALLER_SLEEP: String(options.installerSleep ?? 0),
    FAKE_CLAUDE_SRC,
    FAKE_INSTALLER_MARKER: join(workspace.root, 'installer-ran'),
    FAKE_INSTALLER_CHILD_PID_FILE: join(workspace.root, 'installer-child.pid'),
    FAKE_NPM_RECORD: join(workspace.root, 'npm-record.txt'),
    ...codexEnv(options),
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
  if (options.zedConfigDir) env.AGENT_SETUP_TEST_ZED_CONFIG_DIR = options.zedConfigDir;
  if (options.vscodeUserDir) env.AGENT_SETUP_TEST_VSCODE_USER_DIR = options.vscodeUserDir;

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
    configuration: claudeConfig({ model: 'claude-opus-x[1m]', defaultFableModel: 'fable-x', defaultOpusModel: 'opus-x', defaultSonnetModel: 'sonnet-x', defaultHaikuModel: 'haiku-x', effortLevel: 'high', cleanupPeriodDays: 365, optOutAiAttribution: true, modelDiscovery: true }),
  });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  const settings = readSettings(settingsPathFor(ws)) as { theme: string; permissions: unknown; effortLevel: string; cleanupPeriodDays: number; attribution: Record<string, unknown>; env: Record<string, string> };
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

// The resolver lives in the shared helper, so every managed document gets it:
// `~/.claude/settings.json` is the one an operator is most likely to have under
// chezmoi or stow, and Codex's `config.toml` and provider token reach the same
// rename through backup and rollback even though the CLI writes the config.
// `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME` all accept a relative
// path, and the resolver rebuilds from the root — so one that is not anchored
// first comes back pointing at the filesystem root while the directory the run
// created stays where the operator meant it.
test('claude', 'honors a relative CLAUDE_CONFIG_DIR', async t => {
  if (process.platform === 'win32') skip('POSIX paths only');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url,
    configDir: 'relative-claude-config', cwd: ws.root,
  });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.ok(existsSync(join(ws.root, 'relative-claude-config', 'settings.json')),
    'settings land under the relative directory, not at the filesystem root');
});

test('claude', 'writes through a symlinked settings file rather than replacing it', async t => {
  if (process.platform === 'win32') skip('symlinks only');
  for (const { which, link } of [{ which: 'bash', link: 'absolute' }, { which: 'powershell', link: 'relative' }] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const ws = makeWorkspace();
    placeFakeClaude(ws.binDir);
    const configDir = join(ws.root, `claude-symlink-${which}`);
    mkdirSync(configDir, { recursive: true });
    const target = join(ws.home, `dotfiles-${which}-claude-settings.json`);
    writeFileSync(target, JSON.stringify({ theme: 'dark' }));
    symlinkSync(link === 'absolute' ? target : relative(configDir, target), join(configDir, 'settings.json'));

    const options = { workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, configDir };
    const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
    t.equal(run.code, 0, `${which} should succeed:\n${run.combined}`);
    t.ok(lstatSync(join(configDir, 'settings.json')).isSymbolicLink(), `${which}/${link} leaves the link in place`);
    t.ok(readFileSync(target, 'utf8').includes('ANTHROPIC_BASE_URL'), `${which}/${link} writes the settings into the linked-to file`);
    t.ok(JSON.parse(readFileSync(target, 'utf8')).theme === 'dark', `${which}/${link} keeps what the operator had there`);
  }
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
    configuration: claudeConfig({ model: 'claude-opus-x[1m]', defaultFableModel: 'fable-x', defaultOpusModel: 'opus-x', defaultSonnetModel: 'sonnet-x', effortLevel: 'high', cleanupPeriodDays: 180, optOutAiAttribution: true, modelDiscovery: true }),
  });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.ok(existsSync(powerShellCallerSurvivalPath(ws)), 'the IEX caller survives a successful setup');
  t.ok(!existsSync(installerMarker(ws)), 'installer must not run when claude is present');
  const settings = readSettings(settingsPathFor(ws)) as { theme: string; effortLevel: string; cleanupPeriodDays: number; attribution: Record<string, unknown>; env: Record<string, string> };
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

// The provider token is the file this installer renames into place itself; the
// config is the CLI's to write, but the backup and the rollback rename are ours
// and would land on the link just the same.
test('codex', 'writes through a symlinked provider token rather than replacing it', async t => {
  if (process.platform === 'win32') skip('symlinks only');
  for (const { which, link } of [{ which: 'bash', link: 'absolute' }, { which: 'powershell', link: 'relative' }] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const ws = makeWorkspace();
    placeFakeCodex(ws.binDir);
    const codexHome = join(ws.root, `codex-symlink-${which}`);
    mkdirSync(codexHome, { recursive: true });
    const target = join(ws.home, `dotfiles-${which}-floway-token`);
    writeFileSync(target, 'previous-token', { mode: 0o600 });
    symlinkSync(link === 'absolute' ? target : relative(codexHome, target), join(codexHome, 'floway-token'));

    const options = { workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, codexHome };
    const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
    t.equal(run.code, 0, `${which} should succeed:\n${run.combined}`);
    t.ok(lstatSync(join(codexHome, 'floway-token')).isSymbolicLink(), `${which}/${link} leaves the link in place`);
    t.equal(readFileSync(target, 'utf8'), SENTINEL_KEY, `${which}/${link} writes the key into the linked-to file`);
    t.equal(statSync(target).mode & 0o777, 0o600, `${which}/${link} keeps the file holding the key owner-only`);
  }
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

// --- Zed cases --------------------------------------------------------------

const zedSettingsPath = (configDir: string): string => join(configDir, 'global_settings.json');

interface ZedModelEntry {
  name: string;
  display_name: string;
  max_tokens: number;
  max_output_tokens?: number;
  capabilities: { tools: boolean; images: boolean; prompt_caching: boolean };
  mode?: { type: string; budget_tokens?: number };
}
interface ZedSettings {
  language_models: { anthropic_compatible: Record<string, { api_url: string; available_models: ZedModelEntry[] }> };
  [key: string]: unknown;
}

// A directory the installer can find; Zed itself is never installed, so its
// presence is the only precondition the fragment checks.
const makeZedConfigDir = (ws: Workspace): string => {
  const dir = join(ws.home, '.config', 'zed');
  mkdirSync(dir, { recursive: true });
  return dir;
};

const runZed = (ws: Workspace, overrides: Partial<RunOptions> = {}) => {
  const configDir = overrides.zedConfigDir ?? makeZedConfigDir(ws);
  placeFakeCredentialTools(ws);
  return runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: zedConfig(),
    zedConfigDir: configDir,
    ...overrides,
  });
};

test('zed', 'projects the catalog into available_models and keeps unrelated settings', async t => {
  const ws = makeWorkspace();
  const configDir = makeZedConfigDir(ws);
  writeFileSync(zedSettingsPath(configDir), JSON.stringify({
    telemetry: { metrics: false },
    language_models: {
      openai_compatible: { Other: { api_url: 'https://other', available_models: [] } },
      anthropic_compatible: { Existing: { api_url: 'https://existing', available_models: [] } },
    },
  }));
  const run = await runZed(ws, { zedConfigDir: configDir });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);

  const settings = readSettings(zedSettingsPath(configDir)) as ZedSettings;
  t.equal(JSON.stringify(settings.telemetry), JSON.stringify({ metrics: false }), 'unrelated top-level key preserved');
  t.ok(
    settings.language_models.anthropic_compatible.Existing?.api_url === 'https://existing',
    'a sibling provider under the same key survives',
  );
  const provider = settings.language_models.anthropic_compatible.Floway!;
  t.equal(provider.api_url, modelServer.url, 'api_url is the bare origin Zed appends /v1/messages to');
  t.equal(provider.available_models.map(entry => entry.name).join(','), 'claude-opus-4-6,gpt-5.6,plain-chat,effort-only,floor-only,ceiling-only,zero-limits,all-three-limits', 'chat models only, in catalog order');
});

test('zed', 'maps limits, modalities, and reasoning onto Zed model fields', async t => {
  const ws = makeWorkspace();
  const configDir = makeZedConfigDir(ws);
  const run = await runZed(ws, { zedConfigDir: configDir });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);

  const settings = readSettings(zedSettingsPath(configDir)) as ZedSettings;
  const models = new Map(settings.language_models.anthropic_compatible.Floway!.available_models.map(entry => [entry.name, entry]));

  const opus = models.get('claude-opus-4-6')!;
  t.equal(opus.max_tokens, 1_000_000, 'context window becomes max_tokens');
  t.equal(opus.max_output_tokens, 64_000, 'output limit is carried through');
  t.equal(JSON.stringify(opus.capabilities), JSON.stringify({ tools: true, images: true, prompt_caching: true }), 'image modality becomes the images capability');
  t.equal(JSON.stringify(opus.mode), JSON.stringify({ type: 'adaptive' }), 'adaptive reasoning becomes adaptive mode');

  const gpt = models.get('gpt-5.6')!;
  // The floor, not the ceiling: Zed sends this verbatim on every request and
  // Anthropic requires it below max_tokens.
  t.equal(JSON.stringify(gpt.mode), JSON.stringify({ type: 'thinking', budget_tokens: 1024 }), 'a budget floor becomes the thinking budget');
  t.equal(gpt.capabilities.images, false, 'a text-only model does not claim images');

  const plain = models.get('plain-chat')!;
  t.equal(plain.max_tokens, 200_000, 'a model with no limits still gets a context window');
  t.ok(plain.max_output_tokens === undefined, 'no output limit is announced when the catalog has none');
  t.ok(plain.mode === undefined, 'a model without reasoning gets no mode');
  t.equal(JSON.stringify(plain.capabilities), JSON.stringify({ tools: true, images: false, prompt_caching: true }), 'all three capability flags are always written');

  // Reasoning with no budget must not produce a thinking mode: Zed would put a
  // null budget on every Messages request and the model would 400.
  const effortOnly = models.get('effort-only')!;
  t.ok(effortOnly.mode === undefined, 'reasoning without a budget stays in default mode');
  // Zed subtracts its output reservation from max_tokens, so a catalog stating
  // only a prompt limit gets a window that leaves exactly that limit behind —
  // 4096 is what Zed assumes when the model announces no output limit.
  t.equal(effortOnly.max_tokens - 4096, 120_000, 'the derived prompt budget is the stated prompt limit');

  // A stated 0 is a value, not an absent limit — asserted on this half too,
  // since the fixture claims to cover both merges and only the VS Code half
  // ever checked it.
  // Zed's `max_tokens` is a required u64 it sends verbatim, so a stated zero is
  // no bound rather than a bound of zero: a 0-token window gets neither
  // compaction nor the callout, and a 0 output limit is a Messages `max_tokens`
  // Anthropic rejects.
  const zero = models.get('zero-limits')!;
  t.equal(zero.max_tokens, 200_000, 'a stated zero window falls through to the default');
  t.equal(zero.max_output_tokens, undefined, 'and a stated zero output limit is not sent at all');

  const floorOnly = models.get('floor-only')!;
  t.equal(JSON.stringify(floorOnly.mode), JSON.stringify({ type: 'thinking', budget_tokens: 1024 }), 'a floor with no ceiling still yields a budget');

  const ceilingOnly = models.get('ceiling-only')!;
  t.equal(JSON.stringify(ceilingOnly.mode), JSON.stringify({ type: 'thinking', budget_tokens: 32_000 }), 'a ceiling stands in when no floor is announced');
});

// The invariant is that the credential store is keyed by the same string the
// settings document names, so both artifacts are read and compared to each
// other rather than each to a harness constant.
test('zed', 'stores the credential against the same api_url the settings name', async t => {
  const ws = makeWorkspace();
  const configDir = makeZedConfigDir(ws);
  const run = await runZed(ws, { zedConfigDir: configDir });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);

  const calls = readCredentialCalls(ws);
  t.equal(calls.length, 1, `exactly one credential tool call:\n${calls.join('\n')}`);
  const [tool, argv] = calls[0]!.split('\t');

  const settings = readSettings(zedSettingsPath(configDir)) as ZedSettings;
  const announced = settings.language_models.anthropic_compatible.Floway!.api_url;
  // The value of the lookup key, not merely its presence somewhere in argv:
  // both tools carry the origin in more than one position, so a substring
  // check would survive a wrong key.
  const words = argv!.split(' ');
  const lookupKey = tool === 'secret-tool' ? words[words.indexOf('url') + 1] : words[words.indexOf('-s') + 1];
  t.equal(lookupKey, announced, `the credential is keyed by the announced api_url:\n${calls[0]}`);

  if (tool === 'secret-tool') {
    // Byte-exact: a shell that pipes rather than writes appends a newline, and
    // secret-tool stores every byte it reads, so the key would come back
    // malformed and Zed would send a broken Authorization header.
    t.equal(readFileSync(zedCredentialSecret(ws), 'utf8'), SENTINEL_KEY, 'exactly the key reaches secret-tool on stdin, with no trailing newline');
    t.ok(argv!.includes('--label=zed-github-account'), 'the label Zed matches on read is written');
    t.ok(!argv!.includes(SENTINEL_KEY), 'the key is absent from argv');
  } else {
    t.ok(argv!.includes(SENTINEL_KEY), 'security takes the key via -w, its only non-interactive route');
  }
  t.ok(words.includes('Bearer'), 'the fixed username Zed looks the item up under is written');
  t.ok(!run.combined.includes(SENTINEL_KEY), 'the key never reaches the output');
});

test('zed', 'a renamed provider writes under the chosen key', async t => {
  const ws = makeWorkspace();
  const configDir = makeZedConfigDir(ws);
  const run = await runZed(ws, { zedConfigDir: configDir, configuration: zedConfig({ providerName: "Ops' box" }) });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);

  const settings = readSettings(zedSettingsPath(configDir)) as ZedSettings;
  t.ok(settings.language_models.anthropic_compatible["Ops' box"] !== undefined, 'a name carrying a quote survives the shell literal encoder');
});

test('zed', 'a missing configuration directory stops before any write', async t => {
  const ws = makeWorkspace();
  const absent = join(ws.home, 'no-zed-here');
  const run = await runZed(ws, { zedConfigDir: absent });
  t.equal(run.code, 1, 'should fail');
  t.includes(run.combined, 'install and launch Zed once', 'the message says what to do about it');
  t.ok(!existsSync(zedSettingsPath(absent)), 'no settings file is created');
});

// A denied read is not a malformed document, and neither half may report it as
// one — awk exits 2 on a file it cannot open, which the scanner's vocabulary
// would call a value jq would rewrite, and ReadAllText raises a framework
// message naming a path the operator already knows.
test('zed', 'both halves name an unreadable settings document as unreadable', async t => {
  if (process.platform === 'win32') skip('POSIX permission bits only');
  for (const which of ['bash', 'powershell'] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const ws = makeWorkspace();
    const configDir = makeZedConfigDir(ws);
    placeFakeCredentialTools(ws);
    const original = JSON.stringify({ telemetry: { metrics: false } });
    writeFileSync(zedSettingsPath(configDir), original);
    chmodSync(zedSettingsPath(configDir), 0o000);
    try {
      const options = { workspace: ws, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: configDir };
      const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
      t.ok(run.code !== 0, `${which} refuses it`);
      t.ok(run.combined.includes('could not be read'), `${which} names it unreadable:\n${run.combined}`);
      t.ok(!run.combined.includes('Exception calling'), `${which} does not leak a framework message`);
    } finally {
      chmodSync(zedSettingsPath(configDir), 0o600);
    }
  }
});

// PowerShell resolves `.language_models` against a `Language_Models` key and
// jq does not, so this half would write the provider into a key Zed never reads
// and report success. Refusing is the answer: a configured provider that does
// not exist is worse than a stop.
// Both keys are reached by the same case-insensitive member access, so both
// need the same guard: a variant of either takes the provider into a key Zed
// never reads, and the staged check reads back through that same access.
for (const { label, document, named } of [
  { label: 'language_models', document: JSON.stringify({ Language_Models: { anthropic_compatible: {} } }), named: 'Language_Models' },
  { label: 'anthropic_compatible', document: JSON.stringify({ language_models: { Anthropic_Compatible: {} } }), named: 'Anthropic_Compatible' },
]) {
  test('zed', `PowerShell refuses a case-variant ${label} key`, async t => {
    if (!hostPwsh) skip('a PowerShell member-access property');
    const ws = makeWorkspace();
    const configDir = makeZedConfigDir(ws);
    placeFakeCredentialTools(ws);
    writeFileSync(zedSettingsPath(configDir), document);

    const run = await runPowerShellInstaller({
      workspace: ws, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: configDir,
    });

    t.ok(run.code !== 0, `the run refuses it:\n${run.combined}`);
    t.ok(run.combined.includes(named), 'and names the key in the way');
    t.equal(readFileSync(zedSettingsPath(configDir), 'utf8'), document, 'leaving the document byte-identical');
  });
}

// With no mode to read, neither half may leave the document wider than the
// operator had it.
test('zed', 'neither half widens the document when stat answers nothing', async t => {
  if (process.platform === 'win32') skip('POSIX modes only');
  for (const which of ['bash', 'powershell'] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const ws = makeWorkspace();
    const configDir = makeZedConfigDir(ws);
    placeFakeCredentialTools(ws);
    placeMuteStatShim(ws);
    writeFileSync(zedSettingsPath(configDir), JSON.stringify({ telemetry: { metrics: false } }), { mode: 0o600 });
    chmodSync(zedSettingsPath(configDir), 0o600);

    const options = { workspace: ws, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: configDir };
    const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
    t.equal(run.code, 0, `${which} should succeed:\n${run.combined}`);
    t.equal(statSync(zedSettingsPath(configDir)).mode & 0o777, 0o600, `${which} leaves it owner-only`);
  }
});

test('zed', 'a malformed settings document is left untouched', async t => {
  const ws = makeWorkspace();
  const configDir = makeZedConfigDir(ws);
  writeFileSync(zedSettingsPath(configDir), '{ this is not json');
  const run = await runZed(ws, { zedConfigDir: configDir });
  t.equal(run.code, 1, 'should fail');
  t.equal(readFileSync(zedSettingsPath(configDir), 'utf8'), '{ this is not json', 'the original bytes survive');
});

test('zed', 'both halves refuse a catalog with nothing to configure rather than write it empty', async t => {
  const empty = EDITOR_CATALOG.data.filter(model => model.kind !== 'chat');
  for (const which of ['bash', 'powershell'] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const ws = makeWorkspace();
    const configDir = makeZedConfigDir(ws);
    placeFakeCredentialTools(ws);
    const options = { workspace: ws, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: configDir, catalog: empty };
    const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
    t.ok(run.code !== 0, `${which} should fail`);
    t.ok(!existsSync(zedSettingsPath(configDir)), `${which} writes no settings file`);
    // The refusal precedes credential storage, so an unusable catalog leaves no
    // orphan entry behind.
    t.equal(readCredentialCalls(ws).length, 0, `${which} stores no credential`);
  }
});

test('zed', 'PowerShell writes the same provider document as Bash', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const existing = JSON.stringify({
    telemetry: { metrics: false },
    language_models: {
      anthropic_compatible: { Existing: { api_url: 'https://existing', available_models: [] } },
    },
  });

  // Both halves run against the same catalog and the same prior document, and
  // the two results are compared to each other rather than to a hand-kept copy
  // of one of them. A restated expectation is the mechanism this design was
  // meant to remove: it can drift from both implementations at once.
  const runHalf = async (which: 'bash' | 'powershell') => {
    const ws = makeWorkspace();
    const configDir = makeZedConfigDir(ws);
    placeFakeCredentialTools(ws);
    writeFileSync(zedSettingsPath(configDir), existing);
    const options = { workspace: ws, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: configDir };
    const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
    t.equal(run.code, 0, `${which} should succeed:\n${run.combined}`);
    t.ok(!run.combined.includes(SENTINEL_KEY), `${which} never prints the key`);
    return { settings: readSettings(zedSettingsPath(configDir)) as ZedSettings, run };
  };

  const bash = await runHalf('bash');
  const powershell = await runHalf('powershell');
  t.equal(
    JSON.stringify(powershell.settings),
    JSON.stringify(bash.settings),
    'the two halves write byte-identical documents, keys and order included',
  );

  // Anchored once so the comparison above cannot pass by both halves being
  // wrong in the same way.
  const provider = bash.settings.language_models.anthropic_compatible.Floway!;
  t.equal(provider.api_url, modelServer.url, 'api_url is the bare origin');
  t.equal(
    provider.available_models.map(entry => entry.name).join(','),
    'claude-opus-4-6,gpt-5.6,plain-chat,effort-only,floor-only,ceiling-only,zero-limits,all-three-limits',
    'chat models only, in catalog order',
  );
  t.equal(bash.settings.language_models.anthropic_compatible.Existing?.api_url, 'https://existing', 'a sibling provider survives the merge');
});

// A lone model must still serialize as an array: ConvertTo-Json unwraps a
// one-element array, and Zed's `available_models` is a Vec — an object there
// fails deserialization and takes the whole provider down. jq's
// `--slurpfile`/`$models[0]` is pinned by the same case.
test('zed', 'a single-model catalog still writes an array in both halves', async t => {
  const single = EDITOR_CATALOG.data.filter(model => model.id === 'plain-chat');
  const runHalf = async (which: 'bash' | 'powershell') => {
    const ws = makeWorkspace();
    const configDir = makeZedConfigDir(ws);
    placeFakeCredentialTools(ws);
    const options = { workspace: ws, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: configDir, catalog: single };
    const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
    t.equal(run.code, 0, `${which} should succeed:\n${run.combined}`);
    return readSettings(zedSettingsPath(configDir)) as ZedSettings;
  };

  const bash = await runHalf('bash');
  t.ok(Array.isArray(bash.language_models.anthropic_compatible.Floway!.available_models), 'Bash writes an array');
  if (!hostPwsh) return;
  const powershell = await runHalf('powershell');
  t.ok(Array.isArray(powershell.language_models.anthropic_compatible.Floway!.available_models), 'PowerShell writes an array');
  t.equal(JSON.stringify(powershell), JSON.stringify(bash), 'and the two documents still match');
});

// Both halves check that the credential tool exists before reaching for it, so
// a host without it gets the installer's own sentence rather than a raw
// command-not-found from the shell or from PowerShell's Stop preference.
test('zed', 'both halves name a missing credential tool instead of crashing', async t => {
  if (process.platform !== 'darwin') skip('the macOS credential arm reaches `security` only there');
  for (const which of ['bash', 'powershell'] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const ws = makeWorkspace();
    const configDir = makeZedConfigDir(ws);
    // No placeFakeCredentialTools: the tool is what is missing.
    const options = { workspace: ws, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: configDir };
    const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
    t.ok(run.code !== 0, `${which} fails`);
    t.ok(run.combined.includes('cannot store the API key'), `${which} names the cause:\n${run.combined}`);
    t.ok(!existsSync(zedSettingsPath(configDir)), `${which} writes no settings`);
  }
});

// A property bag refuses more names than the PSObject ones: an object method
// throws, and so does anything `-NotePropertyName` converts to a PSMemberTypes
// value — "2" does, "2024" does not. The Bash half writes all of them, so the
// refusal has to say what to do rather than surface a raw Add-Member message.
for (const providerName of ['PSObject', 'ToString', '2']) {
  test('zed', `PowerShell refuses the provider name ${providerName} without leaving a backup`, async t => {
    if (!hostPwsh) skip('no PowerShell interpreter on this host');
    const ws = makeWorkspace();
    const configDir = makeZedConfigDir(ws);
    placeFakeCredentialTools(ws);
    const original = JSON.stringify({ telemetry: { metrics: false } });
    writeFileSync(zedSettingsPath(configDir), original);
    const run = await runPowerShellInstaller({
      workspace: ws,
      baseUrl: modelServer.url,
      configuration: zedConfig({ providerName }),
      zedConfigDir: configDir,
    });
    t.ok(run.code !== 0, 'the run fails');
    t.ok(run.combined.includes('cannot use'), `the refusal says what to change:\n${run.combined}`);
    t.equal(readFileSync(zedSettingsPath(configDir), 'utf8'), original, 'the settings are unchanged');
    const leftovers = readdirSync(configDir).filter(name => name.includes('.floway-'));
    t.equal(leftovers.join(','), '', 'and no backup or stage file is left behind');
  });
}

// This document holds no credential — Zed reads the key from the keychain — so
// the run must not narrow permissions the operator chose, on success or on a
// refusal. `umask 077` would otherwise hand back a 0600 file either way.
test('zed', 'preserves the settings file mode through a write and through a refusal', async t => {
  if (process.platform === 'win32') skip('POSIX modes only');
  for (const which of ['bash', 'powershell'] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const written = makeWorkspace();
    const writtenDir = makeZedConfigDir(written);
    placeFakeCredentialTools(written);
    // 0640 because it is a mode neither half produces on its own: a stage that
    // carried none is 0600 under the Bash half's `umask 077` and 0644 under the
    // PowerShell half's inherited umask, so either as the fixture would restate
    // one half's umask instead of observing the preservation.
    writeFileSync(zedSettingsPath(writtenDir), JSON.stringify({ telemetry: { metrics: false } }), { mode: 0o640 });
    chmodSync(zedSettingsPath(writtenDir), 0o640);
    const options = { workspace: written, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: writtenDir };
    const ok = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
    t.equal(ok.code, 0, `${which} should succeed:\n${ok.combined}`);
    t.equal(statSync(zedSettingsPath(writtenDir)).mode & 0o777, 0o640, `${which}: a successful write keeps the operator mode`);
  }

  for (const which of ['bash', 'powershell'] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const refused = makeWorkspace();
    const refusedDir = makeZedConfigDir(refused);
    placeFakeCredentialTools(refused);
    writeFileSync(zedSettingsPath(refusedDir), '', { mode: 0o644 });
    chmodSync(zedSettingsPath(refusedDir), 0o644);
    const refuseOptions = { workspace: refused, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: refusedDir };
    const bad = which === 'bash' ? await runShellInstaller(refuseOptions) : await runPowerShellInstaller(refuseOptions);
    t.ok(bad.code !== 0, 'an empty document is refused');
    t.equal(readFileSync(zedSettingsPath(refusedDir), 'utf8'), '', 'and left byte-identical');
    t.equal(statSync(zedSettingsPath(refusedDir)).mode & 0o777, 0o644, 'and at the mode it had');
    // The refusal has to name the operator's document. Passing this gate and
    // failing later reports a staging fault instead, pointing at our own list
    // rather than at the file they need to fix — and only after a backup existed.
    t.ok(bad.combined.includes('is not a valid Zed settings document'), `the refusal names the document:\n${bad.combined}`);
    t.equal(readdirSync(refusedDir).filter(name => name.includes('.floway-')).join(','), '', 'with no backup left behind');
  }
});

// The shape gate has to refuse everything the merge would abort on, and it has
// to do so before a backup exists — a jq error naming our own list, with the
// operator's file already copied beside itself, is the outcome these cases
// exist to keep from coming back. Both halves must refuse identically: same
// exit, same untouched bytes, same sentence.
for (const { label, document } of [
  { label: 'a language_models that is not an object', document: '{"language_models":5}' },
  { label: 'an anthropic_compatible that is not an object', document: '{"language_models":{"anthropic_compatible":5}}' },
  // Two documents in one file. jq runs a filter once per document on a stream
  // and zero times on empty input, exiting 0 either way, so an unslurped gate
  // would pass this and fail later inside the merge.
  { label: 'a stream of two documents', document: '{"a":1}{"b":2}' },
  { label: 'a truncated object', document: '{"telemetry":' },
  // Newtonsoft takes all three and would write the document back in canonical
  // form, where jq refuses them — so one half would stop and the other rewrite
  // the operator's file. The scanner decides, not the decoder.
  { label: 'a form feed between members', document: '{"a":1,\f"b":2}' },
  { label: 'a non-breaking space between members', document: '{"a":1,\u00A0"b":2}' },
  { label: 'single-quoted strings', document: "{'telemetry':{'metrics':false}}" },
  { label: 'an unquoted key', document: '{telemetry:{"metrics":false}}' },
  // Spelled only from the letters `true`, `false` and `null` are spelled with,
  // which a character-membership gate would let through.
  // `features` is a real Zed top-level key and is spelled only from the letters
  // `true`, `false` and `null` use, which a character-membership gate lets by.
  { label: 'an unquoted key spelled from literal letters', document: '{features:{"a":1}}' },
  // A document carrying both must name the JSONC cause, not whichever offence
  // the scan reaches first.
  { label: 'a lenient construct beside a comment', document: "{'a':1} // and this" },
  // A raw tab inside a string: jq refuses it, both decoders take it.
  { label: 'a raw control character in a string', document: '{"telemetry":{"note":"a\tb"}}' },
  // An unquoted key that is itself a literal or a number: consuming the token
  // is not enough — what follows it decides whether it was a value or a key.
  { label: 'a literal used as an unquoted key', document: '{true:1}' },
  { label: 'a number used as an unquoted key', document: '{123:1}' },
  // An interrupted write or a partial sync leaves one of these. Newtonsoft
  // parses them and would write the document back completed; jq refuses.
  { label: 'an unterminated object', document: '{"telemetry":{"metrics":false}' },
  { label: 'an unterminated string', document: '{"telemetry":{"note":"unclosed}' },
  // jq takes these as extensions and rewrites them — NaN to null, Infinity to
  // 1.797e308 — so accepting them would have the Bash half alter a value it
  // was not asked to touch while the PowerShell half refuses the file.
  { label: 'a NaN value', document: '{"telemetry":{"metrics":NaN}}' },
  { label: 'an Infinity value', document: '{"telemetry":{"metrics":Infinity}}' },
  // jq takes every one of these spellings, so the scanner has to as well.
  { label: 'a lowercase nan value', document: '{"telemetry":{"metrics":nan}}' },
  { label: 'a mixed-case nAn value', document: '{"telemetry":{"metrics":nAn}}' },
  { label: 'a short inf value', document: '{"telemetry":{"metrics":inf}}' },
  { label: 'an INFINITY value', document: '{"telemetry":{"metrics":INFINITY}}' },
  // A magnitude no double can hold: jq rewrites it, 5.1 refuses it, and pwsh 7
  // decodes it to Infinity and writes it back as the string "Infinity" — a
  // changed type reported as success.
  { label: 'a number past the double range', document: '{"telemetry":{"metrics":1e400}}' },
  // Overflow without an exponent over 308: the range ends mid-decade, at
  // 1.797…e308, and a long enough integer needs no exponent at all.
  { label: 'a mantissa past the double range', document: '{"telemetry":{"metrics":9e308}}' },
  { label: 'an integer past the double range', document: `{"telemetry":{"metrics":1${'0'.repeat(309)}}}` },
  // A sign belongs to the number, not to the text before it — treating it as
  // interior hid the whole token from the scan.
  { label: 'a negative number past the double range', document: '{"telemetry":{"metrics":-1e400}}' },
]) {
  test('zed', `both halves refuse ${label}`, async t => {
    const runHalf = async (which: 'bash' | 'powershell') => {
      const ws = makeWorkspace();
      const configDir = makeZedConfigDir(ws);
      placeFakeCredentialTools(ws);
      writeFileSync(zedSettingsPath(configDir), document);
      const options = { workspace: ws, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: configDir };
      const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
      t.ok(run.code !== 0, `${which} refuses it`);
      t.equal(readFileSync(zedSettingsPath(configDir), 'utf8'), document, `${which} leaves it byte-identical`);
      t.equal(readdirSync(configDir).filter(name => name.includes('.floway-')).join(','), '', `${which} leaves no backup or stage behind`);
      return run.combined;
    };

    const bash = await runHalf('bash');
    t.ok(bash.includes('is not a valid Zed settings document') || bash.includes('carries JSONC syntax'),
      `Bash names the document:\n${bash}`);
    if (!hostPwsh) return;
    const powershell = await runHalf('powershell');
    t.ok(powershell.includes('is not a valid Zed settings document') || powershell.includes('is not a JSON object')
      || powershell.includes('carries JSONC syntax'),
    `PowerShell names the document:\n${powershell}`);
  });
}

// A case-only rename must leave exactly one provider, under the new name, in
// both halves. The PowerShell property bag cannot hold `Floway` beside
// `floway`, so keeping the old key is not something the two can agree on —
// and dropping it is the better outcome anyway: a stale entry in the Zed picker
// points at a provider whose credential no longer matches its name.
// jq folds A-Z and nothing else, and the PowerShell half now folds the same
// range rather than leaning on `-ieq`, which folds Unicode case too and made
// the same rename leave two picker entries on one half and one on the other.
for (const { label, existing, chosen, expected } of [
  { label: 'a case-only rename', existing: 'floway', chosen: 'Floway', expected: 'Floway' },
]) {
  test('zed', `${label} lands the same way in both halves`, async t => {
    const runHalf = async (which: 'bash' | 'powershell') => {
      const ws = makeWorkspace();
      const configDir = makeZedConfigDir(ws);
      placeFakeCredentialTools(ws);
      writeFileSync(zedSettingsPath(configDir), JSON.stringify({
        language_models: { anthropic_compatible: { [existing]: { api_url: 'https://stale', available_models: [] } } },
      }));
      const options = {
        workspace: ws,
        baseUrl: modelServer.url,
        configuration: zedConfig({ providerName: chosen }),
        zedConfigDir: configDir,
      };
      const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
      t.equal(run.code, 0, `${which} should succeed:\n${run.combined}`);
      return (readSettings(zedSettingsPath(configDir)) as ZedSettings).language_models.anthropic_compatible;
    };

    const bash = await runHalf('bash');
    t.equal(Object.keys(bash).join(','), expected, `Bash writes ${expected}`);
    if (!hostPwsh) return;
    const powershell = await runHalf('powershell');
    t.equal(Object.keys(powershell).join(','), expected, `PowerShell writes ${expected}`);
  });
}

// Zed reads this file with serde_json_lenient, so a comment and a trailing
// comma are both the operator's own content. jq refuses such a document, while
// PowerShell 7 accepts it and writes it back without the comment or the comma —
// data loss reported as success, and two halves reaching opposite verdicts on
// one file. Both refuse, and neither mistakes a `//` inside a value, or a comma
// that is not trailing, for either.
for (const { label, document } of [
  { label: 'a line comment', document: '{\n  // the operator put this here\n  "telemetry": { "metrics": false }\n}' },
  { label: 'a block comment', document: '{\n  /* the operator put this here */\n  "telemetry": { "metrics": false }\n}' },
  { label: 'a trailing comma before a brace', document: '{\n  "telemetry": { "metrics": false },\n}' },
  { label: 'a trailing comma before a bracket', document: '{\n  "features": [\n    "one",\n  ]\n}' },
]) {
  const cause = 'JSONC syntax';
  test('zed', `both halves refuse a settings document carrying ${label}`, async t => {
    const runHalf = async (which: 'bash' | 'powershell') => {
      const ws = makeWorkspace();
      const configDir = makeZedConfigDir(ws);
      placeFakeCredentialTools(ws);
      writeFileSync(zedSettingsPath(configDir), document);
      const options = { workspace: ws, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: configDir };
      const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
      t.ok(run.code !== 0, `${which} refuses it`);
      // Both halves must name the syntax. Refusing for the wrong stated reason
      // sends the operator looking for an error that is not there.
      t.ok(run.combined.includes(cause), `${which} names the cause "${cause}":\n${run.combined}`);
      t.equal(readFileSync(zedSettingsPath(configDir), 'utf8'), document, `${which} leaves it byte-identical`);
    };

    await runHalf('bash');
    if (hostPwsh) await runHalf('powershell');
  });
}

// A name differing from an existing one only outside ASCII is a document jq can
// write and a PowerShell property bag cannot hold: it is Unicode
// case-insensitive, so `flowäy` and `FLOWÄY` are one key there. The halves
// cannot agree on the outcome, so the PowerShell half refuses and names the
// provider in the way rather than deleting it to make room.
test('zed', 'PowerShell refuses a provider name it cannot keep beside an existing one', async t => {
  if (!hostPwsh) skip('a PowerShell property-bag limitation');
  const ws = makeWorkspace();
  const configDir = makeZedConfigDir(ws);
  placeFakeCredentialTools(ws);
  const document = JSON.stringify({
    language_models: { anthropic_compatible: { 'flowäy': { api_url: 'https://existing', available_models: [] } } },
  });
  writeFileSync(zedSettingsPath(configDir), document);

  const run = await runPowerShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: zedConfig({ providerName: 'FLOWÄY' }), zedConfigDir: configDir,
  });

  t.ok(run.code !== 0, `the run refuses it:\n${run.combined}`);
  t.ok(run.combined.includes('flowäy'), 'and names the provider in the way');
  t.equal(readFileSync(zedSettingsPath(configDir), 'utf8'), document, 'leaving the document byte-identical');
  t.equal(readdirSync(configDir).filter(name => name.includes('.floway-')).join(','), '', 'with no backup or stage behind');
});

// A `//` inside a value and a comma that separates rather than trails are
// ordinary JSON, and a scanner that flagged them would refuse documents Zed and
// jq both accept.
test('zed', 'neither half mistakes ordinary JSON for JSONC', async t => {
  // 1e308 is representable and must pass; a `NaN` inside a string is text.
  const plain = '{\n  "telemetry": { "metrics": false },\n  "note": "see https://example.com/a,] NaN Infinity",\n  "big": 1e308,\n  "small": 1e-400,\n  "signed": -1e308,\n  "list": ["a", "b"]\n}';
  const runHalf = async (which: 'bash' | 'powershell') => {
    const ws = makeWorkspace();
    const configDir = makeZedConfigDir(ws);
    placeFakeCredentialTools(ws);
    writeFileSync(zedSettingsPath(configDir), plain);
    const options = { workspace: ws, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: configDir };
    const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
    t.equal(run.code, 0, `${which} accepts it:\n${run.combined}`);
    t.equal((readSettings(zedSettingsPath(configDir)) as ZedSettings).note, 'see https://example.com/a,] NaN Infinity', `${which} keeps the value intact`);
  };

  await runHalf('bash');
  if (hostPwsh) await runHalf('powershell');

  // A `//` inside a value is not a comment: refusing that would reject a
  // perfectly ordinary document.
  const ws = makeWorkspace();
  const configDir = makeZedConfigDir(ws);
  placeFakeCredentialTools(ws);
  writeFileSync(zedSettingsPath(configDir), JSON.stringify({ note: 'see https://example.com/docs' }));
  const ok = await runZed(ws, { zedConfigDir: configDir });
  t.equal(ok.code, 0, `a URL in a value is not a comment:\n${ok.combined}`);
});

// A file this run creates is ours to set. Bash gets owner-only from the
// installer's own umask; PowerShell would otherwise take the ambient one and
// write 0644, so the same fresh install would land two different modes.
test('zed', 'both halves create a new settings file owner-only', async t => {
  if (process.platform === 'win32') skip('POSIX modes only');
  for (const which of ['bash', 'powershell'] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const ws = makeWorkspace();
    const configDir = makeZedConfigDir(ws);
    placeFakeCredentialTools(ws);
    const options = { workspace: ws, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: configDir };
    const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
    t.equal(run.code, 0, `${which} should succeed:\n${run.combined}`);
    t.equal(statSync(zedSettingsPath(configDir)).mode & 0o777, 0o600, `${which} creates it owner-only`);
  }
});

// The atomic replacement Windows takes when the settings file already exists.
// It is the only branch that runs File.Replace, and a `$null` PowerShell binds
// as String.Empty makes that call reject the whole install — so the platform
// conjunct is dropped here to execute it off-Windows.
test('zed', 'the Windows replacement branch keeps unrelated settings and the catalog', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const configDir = makeZedConfigDir(ws);
  placeFakeCredentialTools(ws);
  writeFileSync(zedSettingsPath(configDir), JSON.stringify({ telemetry: { metrics: false } }));
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: zedConfig(),
    zedConfigDir: configDir,
    forcePowerShellWindowsReplacement: true,
  });
  t.equal(run.code, 0, `File.Replace should succeed:\n${run.combined}`);
  const settings = readSettings(zedSettingsPath(configDir)) as ZedSettings;
  t.equal(JSON.stringify(settings.telemetry), JSON.stringify({ metrics: false }), 'the unrelated key survives the replacement');
  t.ok(settings.language_models.anthropic_compatible.Floway!.available_models.length > 0, 'and our provider carries the catalog');
});

// chezmoi and stow both place a symlink where Zed expects its document. Writing
// through a staged file and renaming it into place replaces the link itself, so
// the operator's dotfile stops being what Zed reads and their next edit there
// has no effect — the settings path has to be resolved before anything touches
// it. The mode of the resolved file is the operator's too; on BSD `stat` is the
// only way to read it, since `chmod --reference` does not exist there.
test('zed', 'writes through a symlinked settings file rather than replacing it', async t => {
  if (process.platform === 'win32') skip('POSIX modes and symlinks only');
  for (const which of ['bash', 'powershell'] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    // The stat dialect and the link's own form are independent, so they are
    // paired rather than crossed: stow writes a relative link, chezmoi an
    // absolute one, and both forms have to survive on both dialects.
    for (const { dialect, link } of [{ dialect: 'gnu', link: 'absolute' }, { dialect: 'bsd', link: 'relative' }] as const) {
      const ws = makeWorkspace();
      const configDir = makeZedConfigDir(ws);
      placeFakeCredentialTools(ws);
      if (dialect === 'bsd') placeBsdStatShim(ws);
      // The real document lives elsewhere, at a mode the operator chose; the path
      // Zed reads is a link to it.
      // 0640 because it is a mode neither half produces on its own: a staged
      // file that inherited nothing lands on 0600 under the Bash half's
      // `umask 077` and on 0644 under the PowerShell half's inherited umask, so
      // either of those as the fixture would pass one half without observing it.
      mkdirSync(join(ws.home, 'dotfiles'), { recursive: true });
      const target = join(ws.home, `dotfiles-${which}-zed-settings.json`);
      writeFileSync(target, JSON.stringify({ telemetry: { metrics: false } }), { mode: 0o640 });
      chmodSync(target, 0o640);
      // The absolute leg points through a `..` segment, which is how a dotfile
      // manager may well write it: a path that keeps the segment does not
      // string-match the canonical one the backup prune enumerates, and the
      // prune would then delete the backup it was told to keep. Two places
      // canonicalize — the resolver and the prune's keep-path — so this leg
      // observes the pair rather than either one.
      // Joined by hand, not with `join`, which would normalize the segment away.
      const linkTarget = link === 'absolute'
        ? `${ws.home}/dotfiles/../dotfiles-${which}-zed-settings.json`
        : relative(configDir, target);
      symlinkSync(linkTarget, zedSettingsPath(configDir));
      // A stale backup beside the real document, so the prune has something to
      // get wrong: with a keep-path that is not canonical it matches nothing
      // there and takes this run's own backup along with the stale one.
      const stale = `${target}.floway-backup.19700101000000.1`;
      writeFileSync(stale, '{}');

      const options = { workspace: ws, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: configDir };
      const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
      t.equal(run.code, 0, `${which} should succeed:\n${run.combined}`);
      t.ok(lstatSync(zedSettingsPath(configDir)).isSymbolicLink(), `${which}/${dialect}/${link} leaves the link in place`);
      t.ok(readFileSync(target, 'utf8').includes('anthropic_compatible'), `${which}/${dialect}/${link} writes the provider into the linked-to file`);
      // The reported path is the canonical one on both halves: a `..` segment
      // carried through would name a different file than the other half does
      // for the same link, which is the first thing an operator compares.
      t.ok(run.combined.includes(target) && !run.combined.includes('/dotfiles/..'),
        `${which}/${dialect}/${link} reports the canonical path:\n${run.combined}`);
      t.equal(statSync(target).mode & 0o777, 0o640, `${which}/${dialect}/${link} keeps the mode the operator chose`);
      // The backup and the staged write follow the resolved file, so an
      // operator restoring by hand finds the backup next to their dotfile
      // rather than next to the link.
      t.equal(
        readdirSync(ws.home).filter(name => name.includes('floway-')).map(name => name.replace(/\d+\.\d+$/, '<stamp>')).join(),
        `dotfiles-${which}-zed-settings.json.floway-backup.<stamp>`,
        `${which}/${dialect}/${link} prunes the stale backup and keeps this run's, and leaves no stage`,
      );
      t.ok(!existsSync(stale), `${which}/${dialect}/${link} removed the stale backup`);
      t.equal(readdirSync(configDir).join(), 'global_settings.json', `${which}/${dialect}/${link} leaves nothing beside the link`);
    }
  }
});

// A leftover backup that is a symlink unlinks like any other entry, so both
// halves remove it and the run completes. A dangling one is the case Bash could
// skip forever, since `-e` follows the link before deciding. Only a real
// directory is refused, and that case is the rollback test below.
test('zed', 'both halves clear a symlinked stale backup instead of tripping on it', async t => {
  if (process.platform === 'win32') skip('symlinks only');
  for (const which of ['bash', 'powershell'] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const ws = makeWorkspace();
    const configDir = makeZedConfigDir(ws);
    placeFakeCredentialTools(ws);
    writeFileSync(zedSettingsPath(configDir), JSON.stringify({ telemetry: { metrics: false } }));
    const elsewhere = join(ws.home, `stale-target-${which}`);
    mkdirSync(elsewhere, { recursive: true });
    const toDirectory = `${zedSettingsPath(configDir)}.floway-backup.19700101000000.1`;
    const dangling = `${zedSettingsPath(configDir)}.floway-backup.19700101000000.2`;
    symlinkSync(elsewhere, toDirectory);
    symlinkSync(join(ws.home, 'nothing-is-here'), dangling);

    const options = { workspace: ws, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: configDir };
    const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);

    t.equal(run.code, 0, `${which} should succeed:\n${run.combined}`);
    t.ok(!existsSync(toDirectory) && !lstatSync(dangling, { throwIfNoEntry: false }), `${which} removed both stale links`);
    t.ok(existsSync(elsewhere), `${which} removed the link, not what it pointed at`);
    // The run's own backup is the one that stays.
    t.equal(readdirSync(configDir).filter(name => name.includes('.floway-backup.')).length, 1, `${which} keeps this run's backup`);
  }
});

// The only path that runs zed_rollback_settings, and the only reason `cp -p`
// exists: a rollback must hand the operator's document back at the mode they
// chose. A read-only config directory does not reach it — `cp` fails before the
// backup is made — so the failure is injected downstream instead: a stale
// backup that is a directory makes the prune's `rm -f` fail, which happens
// after the write has already been renamed into place.
test('zed', 'a refusal after the backup restores the file and its mode', async t => {
  if (process.platform === 'win32') skip('POSIX modes only');
  for (const which of ['bash', 'powershell'] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const ws = makeWorkspace();
    const configDir = makeZedConfigDir(ws);
    placeFakeCredentialTools(ws);
    const original = JSON.stringify({ telemetry: { metrics: false } });
    writeFileSync(zedSettingsPath(configDir), original, { mode: 0o640 });
    chmodSync(zedSettingsPath(configDir), 0o640);
    // A stale backup that is a directory: this installer creates only files
    // there, so neither half may remove it, and both fail the prune — which is
    // the only failure that lands after the write has already been renamed
    // into place, and so the only way to reach the rollback from there.
    mkdirSync(`${zedSettingsPath(configDir)}.floway-backup.19700101000000.1`, { recursive: true });

    const options = { workspace: ws, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: configDir };
    const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);

    t.ok(run.code !== 0, `${which}: the run fails`);
    t.equal(readFileSync(zedSettingsPath(configDir), 'utf8'), original, `${which}: the document is restored`);
    t.equal(statSync(zedSettingsPath(configDir)).mode & 0o777, 0o640, `${which}: and at the mode the operator chose`);
  }
});

// ConvertFrom-Json unwraps a top-level one-element array into a bare object, so
// a decoded-value check cannot tell `[{...}]` from `{...}` — it would be
// rewritten as an object with the array silently discarded, while jq refuses
// it. Both halves decide the root from the text.
test('zed', 'both halves refuse an array root', async t => {
  const arrayRoot = '[{"telemetry":{"metrics":false}}]';
  const runHalf = async (which: 'bash' | 'powershell') => {
    const ws = makeWorkspace();
    const configDir = makeZedConfigDir(ws);
    placeFakeCredentialTools(ws);
    writeFileSync(zedSettingsPath(configDir), arrayRoot);
    const options = { workspace: ws, baseUrl: modelServer.url, configuration: zedConfig(), zedConfigDir: configDir };
    const run = which === 'bash' ? await runShellInstaller(options) : await runPowerShellInstaller(options);
    t.ok(run.code !== 0, `${which} refuses it`);
    t.equal(readFileSync(zedSettingsPath(configDir), 'utf8'), arrayRoot, `${which} leaves it byte-identical`);
  };

  await runHalf('bash');
  if (hostPwsh) await runHalf('powershell');
});

test('zed', 'PowerShell leaves an unreadable settings document untouched', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const configDir = makeZedConfigDir(ws);
  placeFakeCredentialTools(ws);
  writeFileSync(zedSettingsPath(configDir), '{ this is not json');
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: zedConfig(),
    zedConfigDir: configDir,
  });
  t.equal(run.code, 1, 'should fail');
  t.equal(readFileSync(zedSettingsPath(configDir), 'utf8'), '{ this is not json', 'the original bytes survive');
});

const vscodeGroupsPath = (profileDir: string): string => join(profileDir, 'chatLanguageModels.json');

interface VSCodeModelEntry {
  id: string;
  name: string;
  url: string;
  toolCalling: boolean;
  vision: boolean;
  maxOutputTokens: number;
  contextWindow: number;
  maxInputTokens?: number;
  requestHeaders: Record<string, string>;
  thinking?: boolean;
  supportsReasoningEffort?: string[];
  reasoningEffortFormat?: string;
}
interface VSCodeGroup {
  vendor: string;
  name: string;
  apiType?: string;
  models?: VSCodeModelEntry[];
  [key: string]: unknown;
}

const readVSCodeGroups = (profileDir: string): VSCodeGroup[] =>
  JSON.parse(readFileSync(vscodeGroupsPath(profileDir), 'utf8')) as VSCodeGroup[];

const ourGroup = (groups: VSCodeGroup[], name = 'Floway'): VSCodeGroup =>
  groups.find(group => group.vendor === 'customendpoint' && group.name === name)!;

// Named so a test needing two independent user directories gets two, rather
// than silently reusing one and leaving the earlier phase's file behind.
const makeVSCodeUserDir = (ws: Workspace, name = 'vscode-user'): string => {
  const dir = join(ws.home, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const runVSCode = (ws: Workspace, overrides: Partial<RunOptions> = {}) => runShellInstaller({
  workspace: ws,
  baseUrl: modelServer.url,
  configuration: vscodeConfig(),
  vscodeUserDir: overrides.vscodeUserDir ?? makeVSCodeUserDir(ws),
  ...overrides,
});

test('vscode', 'enumerates the catalog into one customendpoint group', async t => {
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws);
  const run = await runVSCode(ws, { vscodeUserDir: userDir });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);

  const group = ourGroup(readVSCodeGroups(userDir));
  t.equal(group.apiType, 'messages', 'the group carries the selected API path');
  t.equal(group.models!.map(entry => entry.id).join(','), 'claude-opus-4-6,gpt-5.6,plain-chat,effort-only,floor-only,ceiling-only,zero-limits,all-three-limits', 'chat models only, in catalog order');
  t.equal(group.models![0]!.url, `${modelServer.url}/v1`, 'the model url carries the version segment customendpoint appends a path to');
});

// The projection omits the endpoint and the credential because the merge
// attaches them, and a pasted snippet has no merge — so both go through
// `addressVSCodeModels`. This asserts the installers implement that same rule:
// what a run writes must equal what the shared rule produces, which is what the
// dashboard pastes.
test('vscode', 'both halves write what the shared addressing rule produces', async t => {
  for (const apiType of ['messages', 'responses', 'chat-completions'] as const) {
    const configuration = vscodeConfig({ apiType });
    const expected = {
      vendor: 'customendpoint',
      name: 'Floway',
      apiType,
      models: addressVSCodeModels(
        projectVSCodeModels(EDITOR_CATALOG.data as never, apiType),
        modelServer.url,
        SENTINEL_KEY,
      ),
    };

    const bashWs = makeWorkspace();
    const bashDir = makeVSCodeUserDir(bashWs, `vscode-rule-sh-${apiType}`);
    const bashRun = await runVSCode(bashWs, { vscodeUserDir: bashDir, configuration });
    t.equal(bashRun.code, 0, `${apiType} Bash should succeed:\n${bashRun.combined}`);
    t.equal(JSON.stringify(ourGroup(readVSCodeGroups(bashDir))), JSON.stringify(expected), `${apiType}: Bash matches the shared rule`);

    if (!hostPwsh) continue;
    const psWs = makeWorkspace();
    const psDir = makeVSCodeUserDir(psWs, `vscode-rule-ps1-${apiType}`);
    const psRun = await runPowerShellInstaller({ workspace: psWs, baseUrl: modelServer.url, configuration, vscodeUserDir: psDir });
    t.equal(psRun.code, 0, `${apiType} PowerShell should succeed:\n${psRun.combined}`);
    t.equal(JSON.stringify(ourGroup(readVSCodeGroups(psDir))), JSON.stringify(expected), `${apiType}: PowerShell matches the shared rule`);
  }
});

test('vscode', 'maps limits, modalities, and reasoning onto the required fields', async t => {
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws);
  const run = await runVSCode(ws, { vscodeUserDir: userDir });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);

  const models = new Map(ourGroup(readVSCodeGroups(userDir)).models!.map(entry => [entry.id, entry]));

  const opus = models.get('claude-opus-4-6')!;
  t.equal(opus.contextWindow, 1_000_000, 'context window is carried through');
  t.equal(opus.maxOutputTokens, 64_000, 'output limit is carried through');
  t.equal(opus.vision, true, 'image modality becomes vision');
  t.equal(opus.toolCalling, true, 'tool calling is always declared');
  t.equal(opus.thinking, true, 'a reasoning model declares thinking');
  t.equal(opus.supportsReasoningEffort?.join(','), 'low,high', 'discrete effort levels are offered');
  t.equal(opus.reasoningEffortFormat, 'messages', 'the effort format follows the group API path');

  const gpt = models.get('gpt-5.6')!;
  t.equal(gpt.vision, false, 'a text-only model does not claim vision');
  t.equal(gpt.thinking, true, 'a budget-only reasoner still declares thinking');
  t.ok(gpt.supportsReasoningEffort === undefined, 'no effort picker without discrete levels');

  const plain = models.get('plain-chat')!;
  t.equal(plain.contextWindow, 128_000, 'a model with no limits still gets a context window');
  t.equal(plain.maxOutputTokens, 8192, 'a model with no output limit still gets one');
  t.ok(plain.thinking === undefined, 'a model without reasoning does not declare thinking');

  // A stated 0 is a value, not an absent limit; the fallbacks belong to models
  // that announce nothing. Truthiness tests cannot tell the two apart.
  // Both limits have to reach the written document: the window for planning,
  // the prompt budget so VS Code does not derive a larger one than the upstream
  // accepts.
  const allThree = models.get('all-three-limits')!;
  t.equal(allThree.contextWindow, 216_000, 'the window reaches the document');
  t.equal(allThree.maxInputTokens, 128_000, 'and so does the stated prompt limit');

  const zero = models.get('zero-limits')!;
  // A stated zero is no bound at VS Code's wire either: a zero window is a
  // model that can never be prompted, and on the Messages path the output
  // limit is sent as the wire `max_tokens`, which the upstream rejects at zero.
  t.equal(zero.contextWindow, 128_000, 'a stated zero context window falls through to the default');
  t.equal(zero.maxOutputTokens, 8192, 'and a stated zero output limit to the fallback');
  // Verbatim rather than dropped by truthiness — the distinction the projection
  // draws is between an absent list and a stated one. VS Code itself makes no
  // picker from either, returning early on a zero-length list.
  // Ref: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/vscode-node/byokModelInfo.ts#L17-L19
  t.equal(JSON.stringify(zero.supportsReasoningEffort), '[]', 'a stated empty effort list survives the projection');
});

// The group's own `apiKey` is declared `secret`, so VS Code runs its
// `${input:...}` decoder over a literal and lands on a secret-storage miss.
test('vscode', 'carries the key in requestHeaders rather than the secret apiKey property', async t => {
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws);
  const run = await runVSCode(ws, { vscodeUserDir: userDir });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);

  const group = ourGroup(readVSCodeGroups(userDir));
  t.ok(group.apiKey === undefined, 'the group declares no apiKey');
  t.equal(group.models![0]!.requestHeaders.authorization, `Bearer ${SENTINEL_KEY}`, 'the key rides in the per-model authorization header');
  t.ok(!run.combined.includes(SENTINEL_KEY), 'the key never reaches the output');
});

test('vscode', 'replaces only its own group and leaves every other one intact', async t => {
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws);
  writeFileSync(vscodeGroupsPath(userDir), JSON.stringify([
    { vendor: 'customendpoint', name: 'Other gateway', apiType: 'responses', models: [] },
    { vendor: 'anthropic', name: 'Direct', apiKey: '${input:chat.lm.secret.abc}' },
    { vendor: 'customendpoint', name: 'Floway', apiType: 'chat-completions', models: [{ id: 'stale' }] },
  ]));
  const run = await runVSCode(ws, { vscodeUserDir: userDir });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);

  const groups = readVSCodeGroups(userDir);
  t.equal(groups.length, 3, 'the group count is unchanged — ours is replaced, not appended');
  t.equal(ourGroup(groups, 'Other gateway').apiType, 'responses', 'a sibling customendpoint gateway survives');
  t.equal(String(groups.find(group => group.vendor === 'anthropic')!.apiKey), '${input:chat.lm.secret.abc}', 'another vendor keeps its secret placeholder');
  t.ok(!ourGroup(groups).models!.some(entry => entry.id === 'stale'), 'our previous models are gone');
});

// `profiles/builtin` is a container, not a profile: the agents window's profile
// lives at `profiles/builtin/agents`, and its language models resolve to the
// default profile's file. So a document written at `profiles/builtin` carries
// the key into a file nothing reads, and skipping it loses nothing.
test('vscode', 'neither half writes into the builtin profile directory', async t => {
  for (const which of ['bash', 'powershell'] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const ws = makeWorkspace();
    const userDir = makeVSCodeUserDir(ws, `vscode-builtin-${which}`);
    const builtin = join(userDir, 'profiles', 'builtin', 'a1b2c3');
    mkdirSync(builtin, { recursive: true });
    const named = join(userDir, 'profiles', 'd4e5f6');
    mkdirSync(named, { recursive: true });

    const run = which === 'bash'
      ? await runVSCode(ws, { vscodeUserDir: userDir })
      : await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir });

    t.equal(run.code, 0, `${which} should succeed:\n${run.combined}`);
    t.ok(existsSync(vscodeGroupsPath(userDir)), `${which} configures the default profile`);
    t.ok(existsSync(vscodeGroupsPath(named)), `${which} configures a named profile`);
    t.ok(!existsSync(vscodeGroupsPath(join(userDir, 'profiles', 'builtin'))), `${which} writes nothing into builtin`);
    t.ok(!existsSync(vscodeGroupsPath(builtin)), `${which} writes nothing below builtin`);
  }
});

test('vscode', 'writes every profile of the user directory', async t => {
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws);
  const namedProfile = join(userDir, 'profiles', 'a1b2c3');
  mkdirSync(namedProfile, { recursive: true });
  const run = await runVSCode(ws, { vscodeUserDir: userDir });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);

  t.ok(existsSync(vscodeGroupsPath(userDir)), 'the default profile is configured');
  t.ok(existsSync(vscodeGroupsPath(namedProfile)), 'a named profile is configured too');
  t.equal(
    ourGroup(readVSCodeGroups(namedProfile)).models!.length,
    ourGroup(readVSCodeGroups(userDir)).models!.length,
    'both profiles receive the same catalog',
  );
});

test('vscode', 'the written document is owner-only because it carries the key', async t => {
  if (process.platform === 'win32') skip('POSIX modes only');
  for (const which of ['bash', 'powershell'] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const ws = makeWorkspace();
    const userDir = makeVSCodeUserDir(ws, `vscode-owner-${which}`);
    const run = which === 'bash'
      ? await runVSCode(ws, { vscodeUserDir: userDir })
      : await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir });
    t.equal(run.code, 0, `${which} should succeed:\n${run.combined}`);
    // The PowerShell half inherits a 022 umask, so this observes its explicit
    // restriction; the Bash half runs under `umask 077`, which reaches the same
    // mode on its own, and there the assertion cannot separate the two.
    t.equal(statSync(vscodeGroupsPath(userDir)).mode & 0o777, 0o600, `${which}: mode is 0600`);
  }
});

// chezmoi and stow both place a symlink where VS Code expects its provider
// list. Renaming a staged file onto that path replaces the link itself, so the
// operator's dotfile stops being what VS Code reads. Unlike Zed's document this
// one carries the key, so the resolved file is restricted rather than given the
// mode it had.
test('vscode', 'writes through a symlinked provider list rather than replacing it', async t => {
  if (process.platform === 'win32') skip('POSIX modes and symlinks only');
  // stow writes a relative link, chezmoi an absolute one; both have to survive.
  for (const { which, link } of [{ which: 'bash', link: 'absolute' }, { which: 'powershell', link: 'relative' }] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const ws = makeWorkspace();
    const userDir = makeVSCodeUserDir(ws, `vscode-symlink-${which}`);
    const target = join(ws.home, `dotfiles-${which}-chatLanguageModels.json`);
    writeFileSync(target, '[]', { mode: 0o644 });
    chmodSync(target, 0o644);
    symlinkSync(link === 'absolute' ? target : relative(userDir, target), vscodeGroupsPath(userDir));

    const run = which === 'bash'
      ? await runVSCode(ws, { vscodeUserDir: userDir })
      : await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir });
    t.equal(run.code, 0, `${which} should succeed:\n${run.combined}`);
    t.ok(lstatSync(vscodeGroupsPath(userDir)).isSymbolicLink(), `${which}/${link} leaves the link in place`);
    t.equal(ourGroup(JSON.parse(readFileSync(target, 'utf8'))).vendor, 'customendpoint', `${which}/${link} writes the group into the linked-to file`);
    t.equal(statSync(target).mode & 0o777, 0o600, `${which}/${link} restricts the file that now holds the key`);
    t.equal(
      readdirSync(ws.home).filter(name => name.includes('floway-')).map(name => name.replace(/\d+\.\d+$/, '<stamp>')).join(),
      `dotfiles-${which}-chatLanguageModels.json.floway-backup.<stamp>`,
      `${which}/${link} leaves one backup beside the target and no stage`,
    );
    // The backup is a copy of a document that may already hold the key.
    const backup = readdirSync(ws.home).find(name => name.includes('floway-backup'))!;
    t.equal(statSync(join(ws.home, backup)).mode & 0o777, 0o600, `${which}/${link} restricts the backup too`);
  }
});

test('vscode', 'a renamed provider writes under the chosen name', async t => {
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws);
  const run = await runVSCode(ws, { vscodeUserDir: userDir, configuration: vscodeConfig({ providerName: "Ops' box" }) });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.ok(ourGroup(readVSCodeGroups(userDir), "Ops' box") !== undefined, 'a name carrying a quote survives the shell literal encoder');
});

test('vscode', 'the selected API path reaches both the group and the effort format', async t => {
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws);
  const run = await runVSCode(ws, { vscodeUserDir: userDir, configuration: vscodeConfig({ apiType: 'responses' }) });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);

  const group = ourGroup(readVSCodeGroups(userDir));
  t.equal(group.apiType, 'responses', 'the group carries the selection');
  t.equal(group.models!.find(entry => entry.id === 'claude-opus-4-6')!.reasoningEffortFormat, 'responses', 'the effort format follows it');
});

// A denied read is not a malformed document, and neither half may report it as
// one — awk exits 2 on a file it cannot open, and ReadAllText raises a
// framework message naming a path the operator already knows.
test('vscode', 'both halves name an unreadable provider list as unreadable', async t => {
  if (process.platform === 'win32') skip('POSIX permission bits only');
  for (const which of ['bash', 'powershell'] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const ws = makeWorkspace();
    const userDir = makeVSCodeUserDir(ws, `vscode-unreadable-${which}`);
    const original = '[{"vendor":"other","name":"Keep"}]';
    writeFileSync(vscodeGroupsPath(userDir), original);
    chmodSync(vscodeGroupsPath(userDir), 0o000);
    try {
      const run = which === 'bash'
        ? await runVSCode(ws, { vscodeUserDir: userDir })
        : await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir });
      t.ok(run.code !== 0, `${which} refuses it`);
      t.ok(run.combined.includes('could not be read'), `${which} names it unreadable:\n${run.combined}`);
      t.ok(!run.combined.includes('Exception calling'), `${which} does not leak a framework message`);
    } finally {
      chmodSync(vscodeGroupsPath(userDir), 0o600);
    }
  }
});

test('vscode', 'a non-array root is left untouched', async t => {
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws);
  writeFileSync(vscodeGroupsPath(userDir), '{"vendor":"customendpoint"}');
  const run = await runVSCode(ws, { vscodeUserDir: userDir });
  t.equal(run.code, 1, 'should fail');
  t.equal(readFileSync(vscodeGroupsPath(userDir), 'utf8'), '{"vendor":"customendpoint"}', 'a non-array root is refused and the bytes survive');
});

test('vscode', 'both halves refuse a catalog with no chat models rather than write it empty', async t => {
  const empty = EDITOR_CATALOG.data.filter(model => model.kind !== 'chat');
  for (const which of ['bash', 'powershell'] as const) {
    if (which === 'powershell' && !hostPwsh) continue;
    const ws = makeWorkspace();
    const userDir = makeVSCodeUserDir(ws, `vscode-nochat-${which}`);
    const existing = '[{"vendor":"other","name":"Keep","models":[]}]';
    writeFileSync(vscodeGroupsPath(userDir), existing);
    const run = which === 'bash'
      ? await runVSCode(ws, { vscodeUserDir: userDir, catalog: empty })
      : await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir, catalog: empty });
    t.ok(run.code !== 0, `${which} should fail`);
    // The message, not merely the exit: the staged assertion downstream also
    // refuses this and rolls back, so byte-identity and a missing backup alone
    // cannot tell the early gate from the late one — and only the early gate
    // names a cause the operator can act on.
    t.ok(run.combined.includes('advertises no chat models'), `${which} names the cause:\n${run.combined}`);
    // Refused before anything is touched, so an existing list survives whole
    // and no backup is left beside it.
    t.equal(readFileSync(vscodeGroupsPath(userDir), 'utf8'), existing, `${which} leaves the document byte-identical`);
    t.equal(readdirSync(userDir).filter(name => name.includes('.floway-')).join(','), '', `${which} leaves no backup or stage behind`);
  }
});

test('vscode', 'PowerShell writes the same provider group as Bash', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const existing = JSON.stringify([{ vendor: 'customendpoint', name: 'Other gateway', apiType: 'responses', models: [] }]);

  // Both halves run over the same catalog and the same prior document, and the
  // results are compared to each other rather than to a restated copy of one:
  // a hand-kept expectation can drift from both implementations at once.
  const runHalf = async (which: 'bash' | 'powershell') => {
    const ws = makeWorkspace();
    const userDir = makeVSCodeUserDir(ws, `vscode-parity-${which}`);
    writeFileSync(vscodeGroupsPath(userDir), existing);
    const run = which === 'bash'
      ? await runVSCode(ws, { vscodeUserDir: userDir })
      : await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir });
    t.equal(run.code, 0, `${which} should succeed:\n${run.combined}`);
    t.ok(!run.combined.includes(SENTINEL_KEY), `${which} never prints the key`);
    return readVSCodeGroups(userDir);
  };

  const bash = await runHalf('bash');
  const powershell = await runHalf('powershell');
  t.equal(JSON.stringify(powershell), JSON.stringify(bash), 'the two halves write byte-identical documents, keys and order included');

  // Anchored once so the comparison cannot pass by both halves being wrong the
  // same way.
  const group = ourGroup(bash);
  t.equal(group.apiType, 'messages', 'the group carries the selected API path');
  t.equal(ourGroup(bash, 'Other gateway').apiType, 'responses', 'a sibling gateway survives');
  t.equal(group.models![0]!.url, `${modelServer.url}/v1`, 'the model url carries the version segment');
});

// A `User` path that is a file, or a `profiles` entry that is a file, is not a
// directory to walk into — Bash asks `[ -d ]`, so PowerShell asks for a
// container too.
test('vscode', 'a file where a directory belongs is skipped by both halves', async t => {
  const ws = makeWorkspace();
  const notADir = join(ws.home, 'vscode-user-is-a-file');
  writeFileSync(notADir, 'not a directory');
  const bash = await runVSCode(ws, { vscodeUserDir: notADir });
  t.ok(bash.combined.includes('no VS Code user directory found'), `Bash names it:\n${bash.combined}`);
  if (!hostPwsh) return;
  const ps = await runPowerShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: notADir,
  });
  // Not just a non-zero exit: the broken version also exits non-zero, via a raw
  // `Exception calling "Create"` instead of the reason Bash gives.
  t.ok(ps.combined.includes('no VS Code user directory found'), `PowerShell names it:\n${ps.combined}`);
});

test('vscode', 'PowerShell replaces only its own group', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws);
  writeFileSync(vscodeGroupsPath(userDir), JSON.stringify([
    { vendor: 'customendpoint', name: 'Other gateway', apiType: 'responses', models: [] },
    { vendor: 'customendpoint', name: 'Floway', apiType: 'chat-completions', models: [{ id: 'stale' }] },
  ]));
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: vscodeConfig(),
    vscodeUserDir: userDir,
  });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);

  const groups = readVSCodeGroups(userDir);
  t.equal(groups.length, 2, 'the group count is unchanged');
  t.equal(ourGroup(groups, 'Other gateway').apiType, 'responses', 'a sibling gateway survives');
  t.ok(!ourGroup(groups).models!.some(entry => entry.id === 'stale'), 'our previous models are gone');
});

// A lone group must still round-trip as an array. `ConvertTo-Json`'s pipeline
// form unwraps a one-element array on both versions and `-AsArray` does not
// exist on the 5.1 baseline, so the serialization goes through `-InputObject`,
// which keeps the brackets on both — this is what says it stays that way.
test('vscode', 'PowerShell writes an array even when ours is the only group', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws);
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: vscodeConfig(),
    vscodeUserDir: userDir,
  });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.ok(readFileSync(vscodeGroupsPath(userDir), 'utf8').trimStart().startsWith('['), 'the document root is an array');
  t.equal(readVSCodeGroups(userDir).length, 1, 'and it holds exactly our group');
});

// The atomic replacement Windows takes when the file already exists. Every
// operator who has opened Manage Models once, and everyone on a second run,
// goes through it.
test('vscode', 'PowerShell replaces an existing provider list atomically', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws);
  writeFileSync(vscodeGroupsPath(userDir), JSON.stringify([
    { vendor: 'customendpoint', name: 'Other gateway', apiType: 'responses', models: [] },
  ]));
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: vscodeConfig(),
    vscodeUserDir: userDir,
    forcePowerShellWindowsReplacement: true,
  });
  t.equal(run.code, 0, `File.Replace should succeed:\n${run.combined}`);
  const groups = readVSCodeGroups(userDir);
  t.equal(groups.length, 2, 'the sibling gateway survives the replacement');
  t.ok(ourGroup(groups).models!.length > 0, 'and our group carries the catalog');
});

// ConvertFrom-Json decodes `[]` to $null and unwraps a one-element array into a
// bare object, so the PowerShell installer decides the root shape from the text
// as jq does. Both directions are asserted: an empty list is a valid list VS
// Code itself writes, and an object root is not a list at all.
test('vscode', 'PowerShell accepts an empty provider list and refuses an object root', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const emptyDir = makeVSCodeUserDir(ws, 'vscode-empty-root');
  writeFileSync(vscodeGroupsPath(emptyDir), '[]');
  const accepted = await runPowerShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: emptyDir,
  });
  t.equal(accepted.code, 0, `an empty list is a valid list:\n${accepted.combined}`);
  t.equal(readVSCodeGroups(emptyDir).length, 1, 'and our group is written into it');

  const objectDir = makeVSCodeUserDir(ws, 'vscode-object-root');
  writeFileSync(vscodeGroupsPath(objectDir), '{"vendor":"customendpoint","name":"Floway"}');
  const refused = await runPowerShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: objectDir,
  });
  t.ok(refused.code !== 0, 'an object root is refused');
  t.equal(readFileSync(vscodeGroupsPath(objectDir), 'utf8'), '{"vendor":"customendpoint","name":"Floway"}', 'and the file is left byte-identical');
});

test('vscode', 'Bash accepts an empty provider list and refuses an object root', async t => {
  const ws = makeWorkspace();
  const emptyDir = makeVSCodeUserDir(ws, 'vscode-empty-root');
  writeFileSync(vscodeGroupsPath(emptyDir), '[]');
  const accepted = await runVSCode(ws, { vscodeUserDir: emptyDir });
  t.equal(accepted.code, 0, `an empty list is a valid list:\n${accepted.combined}`);
  t.equal(readVSCodeGroups(emptyDir).length, 1, 'and our group is written into it');

  const objectDir = makeVSCodeUserDir(ws, 'vscode-object-root');
  writeFileSync(vscodeGroupsPath(objectDir), '{"vendor":"customendpoint","name":"Floway"}');
  const refused = await runVSCode(ws, { vscodeUserDir: objectDir });
  t.ok(refused.code !== 0, 'an object root is refused');
  t.equal(readFileSync(vscodeGroupsPath(objectDir), 'utf8'), '{"vendor":"customendpoint","name":"Floway"}', 'and the file is left byte-identical');
});

// An empty file is not a provider list, and each half must say so by name
// rather than passing the shape gate and failing later as a staging error (jq
// runs a filter zero times on empty input and still exits 0) or dying on a null
// dereference (Get-Content -Raw yields $null). One test per half, so a host
// without PowerShell reports a skip rather than a pass that asserted nothing.
test('vscode', 'Bash refuses an empty provider list file by name', async t => {
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws, 'vscode-empty-file-sh');
  writeFileSync(vscodeGroupsPath(userDir), '');
  const run = await runVSCode(ws, { vscodeUserDir: userDir });
  t.ok(run.code !== 0, 'it is refused');
  t.ok(run.combined.includes('is not a provider list'), `the file is named, not a later stage:\n${run.combined}`);
});

test('vscode', 'PowerShell refuses an empty provider list file by name', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws, 'vscode-empty-file-ps1');
  writeFileSync(vscodeGroupsPath(userDir), '');
  const run = await runPowerShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir,
  });
  t.ok(run.code !== 0, 'it is refused');
  t.ok(run.combined.includes('is not a provider list'), `the file is named, not a null dereference:\n${run.combined}`);
});

// A list holding a non-object element is not a provider list. jq's merge
// indexes `.vendor` on every element and aborts on a scalar, so without a gate
// the same document would be rewritten by PowerShell and refused by Bash.
// A collection element is enumerated out of a PowerShell pipeline, so a piped
// type check sees the inner object and passes while jq refuses the document —
// and an element that is an empty array disappears before the check runs.
test('vscode', 'neither half flattens a provider list nested one level deep', async t => {
  for (const { label, document } of [
    { label: 'a nested array', document: '[[{"vendor":"other","name":"Keep"}]]' },
    { label: 'an empty array element', document: '[[],{"vendor":"other","name":"Keep"}]' },
  ]) {
    for (const which of ['bash', 'powershell'] as const) {
      if (which === 'powershell' && !hostPwsh) continue;
      const ws = makeWorkspace();
      const userDir = makeVSCodeUserDir(ws, `vscode-nested-${which}-${label.replaceAll(' ', '-')}`);
      writeFileSync(vscodeGroupsPath(userDir), document);
      const run = which === 'bash'
        ? await runVSCode(ws, { vscodeUserDir: userDir })
        : await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir });
      t.ok(run.code !== 0, `${which} refuses ${label}`);
      t.equal(readFileSync(vscodeGroupsPath(userDir), 'utf8'), document, `${which} leaves ${label} byte-identical`);
    }
  }
});

test('vscode', 'Bash refuses a provider list holding a non-object element', async t => {
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws, 'vscode-scalar-sh');
  const original = '["stray",{"vendor":"customendpoint","name":"Other gateway"}]';
  writeFileSync(vscodeGroupsPath(userDir), original);
  const run = await runVSCode(ws, { vscodeUserDir: userDir });
  t.ok(run.code !== 0, 'it is refused');
  t.ok(run.combined.includes('is not a provider list'), `the operator's file is named:\n${run.combined}`);
  t.equal(readFileSync(vscodeGroupsPath(userDir), 'utf8'), original, 'and left byte-identical');
});

test('vscode', 'PowerShell refuses a provider list holding a non-object element', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws, 'vscode-scalar-ps1');
  const original = '["stray",{"vendor":"customendpoint","name":"Other gateway"}]';
  writeFileSync(vscodeGroupsPath(userDir), original);
  const run = await runPowerShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir,
  });
  t.ok(run.code !== 0, 'it is refused');
  t.ok(run.combined.includes('is not a provider list'), `the operator's file is named:\n${run.combined}`);
  t.equal(readFileSync(vscodeGroupsPath(userDir), 'utf8'), original, 'and left byte-identical');
});

// `[null]` is an array whose element is not a provider group. It matters
// because ConvertFrom-Json yields nothing for `[]` and a literal $null here, so
// a decode-based emptiness test would confuse a list VS Code writes with one it
// never would.
test('vscode', 'Bash refuses a provider list of nulls', async t => {
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws, 'vscode-null-sh');
  writeFileSync(vscodeGroupsPath(userDir), '[null]');
  const run = await runVSCode(ws, { vscodeUserDir: userDir });
  t.ok(run.code !== 0, 'it is refused');
  t.equal(readFileSync(vscodeGroupsPath(userDir), 'utf8'), '[null]', 'and left byte-identical');
});

test('vscode', 'PowerShell refuses a provider list of nulls', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws, 'vscode-null-ps1');
  writeFileSync(vscodeGroupsPath(userDir), '[null]');
  const run = await runPowerShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir,
  });
  t.ok(run.code !== 0, 'it is refused');
  t.equal(readFileSync(vscodeGroupsPath(userDir), 'utf8'), '[null]', 'and left byte-identical');
});

// The prune runs inside the same transaction as the write, so a backup that
// cannot be removed rolls the operator's file back rather than leaving it
// rewritten under a failing exit code.
test('vscode', 'a failed backup prune rolls the settings back', async t => {
  if (process.platform === 'win32') skip('the chflags-based prune-failure injection is Unix-only');
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws, 'vscode-prune');
  const original = '[{"vendor":"customendpoint","name":"Other gateway","apiType":"responses","models":[]}]';
  writeFileSync(vscodeGroupsPath(userDir), original);
  const stale = `${vscodeGroupsPath(userDir)}.floway-backup.19700101000000.1`;
  writeFileSync(stale, '[]');
  if (spawnSync('chflags', ['uchg', stale]).status !== 0) skip('chflags is unavailable on this host');
  try {
    const run = await runVSCode(ws, { vscodeUserDir: userDir });
    t.ok(run.code !== 0, 'the run fails');
    t.equal(readFileSync(vscodeGroupsPath(userDir), 'utf8'), original, "and the operator's file is rolled back");
  } finally {
    spawnSync('chflags', ['nouchg', stale]);
  }
});

test('vscode', 'PowerShell rolls back when the backup prune fails', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  if (process.platform === 'win32') skip('the chflags-based prune-failure injection is Unix-only');
  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws, 'vscode-prune-ps1');
  const original = '[{"vendor":"customendpoint","name":"Other gateway","apiType":"responses","models":[]}]';
  writeFileSync(vscodeGroupsPath(userDir), original);
  const stale = `${vscodeGroupsPath(userDir)}.floway-backup.19700101000000.1`;
  writeFileSync(stale, '[]');
  if (spawnSync('chflags', ['uchg', stale]).status !== 0) skip('chflags is unavailable on this host');
  try {
    const run = await runPowerShellInstaller({
      workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir,
    });
    t.ok(run.code !== 0, 'the run fails');
    t.equal(readFileSync(vscodeGroupsPath(userDir), 'utf8'), original, "and the operator's file is rolled back");
  } finally {
    spawnSync('chflags', ['nouchg', stale]);
  }
});

// One hand-edited profile must not cost the operator every other profile and
// build. Each profile is its own transaction, so the corrupt one is refused and
// left byte-identical while the healthy ones are configured, and the run still
// exits non-zero.
const profileFailureCases = [
  { half: 'Bash', run: (ws: Workspace, userDir: string) => runVSCode(ws, { vscodeUserDir: userDir }) },
  {
    half: 'PowerShell',
    run: (ws: Workspace, userDir: string) => runPowerShellInstaller({
      workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir,
    }),
  },
] as const;

for (const { half, run } of profileFailureCases) {
  test('vscode', `${half} configures healthy profiles despite a corrupt one`, async t => {
    if (half === 'PowerShell' && !hostPwsh) skip('no PowerShell interpreter on this host');
    const ws = makeWorkspace();
    const userDir = makeVSCodeUserDir(ws, `vscode-partial-${half}`);
    const corrupt = join(userDir, 'profiles', 'aaa');
    const healthy = join(userDir, 'profiles', 'bbb');
    mkdirSync(corrupt, { recursive: true });
    mkdirSync(healthy, { recursive: true });
    writeFileSync(vscodeGroupsPath(corrupt), '{ this is not json');

    const result = await run(ws, userDir);
    t.ok(result.code !== 0, 'the run reports failure');
    t.equal(readFileSync(vscodeGroupsPath(corrupt), 'utf8'), '{ this is not json', 'the corrupt profile is untouched');
    t.equal(readVSCodeGroups(healthy).length, 1, 'a later profile is still configured');
    t.equal(readVSCodeGroups(userDir).length, 1, 'and so is the default one');
  });
}

// VS Code reads this file with its JSONC-tolerant scanner, and its parse
// options set `allowTrailingComma`, so both a comment and a comma before a
// closing bracket are syntax the editor accepts. jq refuses such a document
// while ConvertFrom-Json takes it and drops what it cannot represent — data
// loss on one half and a refusal on the other, for one file. Both refuse and
// name the cause.
for (const { label, document, cause } of [
  // A block comment and a trailing one, not just a line-leading `//`: a
  // pattern that matches only the latter refuses these for the wrong stated
  // reason, which is the whole point of naming the cause — so each case
  // carries the sentence it must produce.
  { label: 'comments', document: '[ /* mine */\n  {"vendor":"customendpoint","name":"Other gateway"} // and this\n]', cause: 'JSONC syntax' },
  { label: 'a trailing comma', document: '[\n  {"vendor":"customendpoint","name":"Other gateway"},\n]', cause: 'JSONC syntax' },
  // Newtonsoft takes these and would write the document back in canonical
  // form, where jq refuses them — so one half would stop and the other rewrite
  // the operator's file. The scanner decides, not the decoder.
  { label: 'single-quoted strings', document: "[{'vendor':'other','name':'Keep'}]", cause: 'is not a provider list' },
  { label: 'an unquoted key', document: '[{vendor:"other","name":"Keep"}]', cause: 'is not a provider list' },
  { label: 'a form feed between members', document: '[{"vendor":"other",\f"name":"Keep"}]', cause: 'is not a provider list' },
  // An interrupted write or a partial sync leaves one of these. Newtonsoft
  // parses them and would write the document back completed; jq refuses.
  { label: 'an unterminated array', document: '[{"vendor":"other","name":"Keep"}', cause: 'is not a provider list' },
  { label: 'an unterminated array after a comma', document: '[{"vendor":"other","name":"Keep"},', cause: 'is not a provider list' },
  // jq takes these as extensions and rewrites them, changing a value inside a
  // foreign group; the PowerShell half refuses them outright.
  { label: 'a NaN value in a foreign group', document: '[{"vendor":"other","name":"Keep","x":NaN}]', cause: 'is not a provider list' },
  { label: 'an Infinity value in a foreign group', document: '[{"vendor":"other","name":"Keep","x":Infinity}]', cause: 'is not a provider list' },
  // Two documents in one file. jq runs a filter once per document on a stream,
  // so an unslurped gate would pass this and rewrite the operator's file.
  { label: 'a stream of two provider lists', document: '[{"vendor":"other","name":"Keep"}]\n[{"vendor":"other","name":"Second"}]\n', cause: 'is not a provider list' },
]) {
  test('vscode', `both halves refuse a provider list carrying ${label}`, async t => {
    const runHalf = async (which: 'bash' | 'powershell') => {
      const ws = makeWorkspace();
      const userDir = makeVSCodeUserDir(ws, `vscode-jsonc-${which}-${label.replaceAll(' ', '-')}`);
      writeFileSync(vscodeGroupsPath(userDir), document);
      const run = which === 'bash'
        ? await runVSCode(ws, { vscodeUserDir: userDir })
        : await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir });
      t.ok(run.code !== 0, `${which} refuses it`);
      t.ok(run.combined.includes(cause), `${which} names the cause "${cause}":\n${run.combined}`);
      t.equal(readFileSync(vscodeGroupsPath(userDir), 'utf8'), document, `${which} leaves it byte-identical`);
    };

    await runHalf('bash');
    if (hostPwsh) await runHalf('powershell');
  });
}

// One profile whose backup cannot even be written must not cost the operator
// every remaining profile. The Bash half counts any write failure as one
// profile; the PowerShell half has to treat an unexpected fault the same way,
// or a denied backup aborts the whole run with a raw .NET message.
test('vscode', 'a profile whose backup fails does not stop the others', async t => {
  if (process.platform === 'win32') skip('POSIX permission bits only');
  const runHalf = async (which: 'bash' | 'powershell') => {
    const ws = makeWorkspace();
    const userDir = makeVSCodeUserDir(ws, `vscode-backupfail-${which}`);
    // The default profile holds a file whose directory denies new entries, so
    // the backup cannot be created; a named profile beside it is writable.
    writeFileSync(vscodeGroupsPath(userDir), '[{"vendor":"customendpoint","name":"Other gateway"}]');
    const healthy = join(userDir, 'profiles', 'bbb');
    mkdirSync(healthy, { recursive: true });
    chmodSync(userDir, 0o555);
    try {
      const run = which === 'bash'
        ? await runVSCode(ws, { vscodeUserDir: userDir })
        : await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir });
      t.ok(run.code !== 0, `${which} reports failure`);
      t.ok(run.combined.includes('profile(s) could not be configured'), `${which} summarizes the failure:\n${run.combined}`);
      t.equal(readVSCodeGroups(healthy).length, 1, `${which} still configures the writable profile`);
    } finally {
      chmodSync(userDir, 0o755);
    }
  };

  await runHalf('bash');
  if (hostPwsh) await runHalf('powershell');
});

// `-ceq` against an array is a filter, and a non-empty result is truthy, so a
// group whose `vendor` is an array would match our own and be deleted. jq keeps
// it, because a non-string is not equal to a string.
// jq compares `.vendor != "customendpoint"` and `.name != $providerName`, both
// of which are true of a non-string, so it keeps the group. PowerShell's `-ceq`
// against an array is true when any element matches, so without the type test
// it would delete a group jq keeps. Both fields carry the same rule and both
// need a case.
// A soft hyphen, a zero-width space and an NFD accent all carry no collation
// weight in ICU, so a culture-aware comparison calls these names equal to ours
// while jq, which compares code points, does not. A name pasted with a stray
// invisible, or typed on a keyboard that composes accents, is the realistic
// way in — and the cost is another gateway's group being deleted by one half
// and kept by the other.
test('vscode', 'neither half claims a group whose name only collates as ours', async t => {
  const lookalikes = [
    { label: 'soft hyphen', name: 'Floway\u00AD' },
    { label: 'zero-width space', name: 'Floway\u200B' },
    { label: 'NFD accent', name: 'Flowa\u0301y' },
  ];
  const foreign = JSON.stringify([
    ...lookalikes.map(({ name }) => ({ vendor: 'customendpoint', name, apiType: 'responses', models: [] })),
    // Mis-cased keys: PowerShell member access resolves `.vendor` against
    // `Vendor` where jq's does not, so this group would be claimed by one half
    // and left by the other. VS Code cannot read it either way.
    { Vendor: 'customendpoint', Name: 'Floway', models: [] },
  ]);
  const runHalf = async (which: 'bash' | 'powershell') => {
    const ws = makeWorkspace();
    const userDir = makeVSCodeUserDir(ws, `vscode-collate-${which}`);
    writeFileSync(vscodeGroupsPath(userDir), foreign);
    const run = which === 'bash'
      ? await runVSCode(ws, { vscodeUserDir: userDir })
      : await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir });
    t.equal(run.code, 0, `${which} should succeed:\n${run.combined}`);
    return readVSCodeGroups(userDir);
  };

  const bash = await runHalf('bash');
  t.equal(bash.length, lookalikes.length + 2, 'Bash keeps every look-alike and the mis-cased group, and adds ours');
  if (!hostPwsh) return;
  const powershell = await runHalf('powershell');
  t.equal(JSON.stringify(powershell), JSON.stringify(bash), 'and PowerShell writes the same document');
});

test('vscode', 'neither half deletes a group whose vendor or name is not a string', async t => {
  const foreign = '[{"vendor":["customendpoint"],"name":"Floway","models":[]},{"vendor":"customendpoint","name":["Floway"],"models":[]},{"vendor":"other","name":"Keep"}]';
  const runHalf = async (which: 'bash' | 'powershell') => {
    const ws = makeWorkspace();
    const userDir = makeVSCodeUserDir(ws, `vscode-arrayvendor-${which}`);
    writeFileSync(vscodeGroupsPath(userDir), foreign);
    const run = which === 'bash'
      ? await runVSCode(ws, { vscodeUserDir: userDir })
      : await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir });
    t.equal(run.code, 0, `${which} should succeed:\n${run.combined}`);
    return readVSCodeGroups(userDir);
  };

  const bash = await runHalf('bash');
  t.equal(bash.length, 4, 'Bash keeps all three foreign groups and adds ours');
  if (!hostPwsh) return;
  const powershell = await runHalf('powershell');
  t.equal(JSON.stringify(powershell), JSON.stringify(bash), 'and PowerShell writes the same document');
});

// ConvertTo-Json stops at -Depth and emits what it could not reach as the
// literal string "@{k=}", with a warning and no error. A sibling gateway's
// group nested deeper than the serializer goes would be silently flattened into
// that string — someone else's provider, destroyed quietly. `-WarningAction
// Stop` is what turns it into a refusal, and nothing else in the suite nests
// anything deep enough to reach it.
test('vscode', 'a foreign group too deep to serialize is refused, not flattened', async t => {
  if (!hostPwsh) skip('the depth limit is a PowerShell serializer property');
  // 120 levels, past ConvertTo-Json's -Depth 100.
  let nested: unknown = 'leaf';
  for (let i = 0; i < 120; i++) nested = { k: nested };
  const foreign = JSON.stringify([{ vendor: 'other', name: 'Deep gateway', models: [], extra: nested }]);

  const ws = makeWorkspace();
  const userDir = makeVSCodeUserDir(ws, 'vscode-deep');
  writeFileSync(vscodeGroupsPath(userDir), foreign);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDir });

  t.ok(run.code !== 0, `the run refuses it:\n${run.combined}`);
  t.equal(readFileSync(vscodeGroupsPath(userDir), 'utf8'), foreign, 'and leaves the document byte-identical');
  t.ok(!readFileSync(vscodeGroupsPath(userDir), 'utf8').includes('@{k='), 'nothing was flattened into place');
});

// A `profiles/` the run cannot enter yields nothing from the glob, which reads
// as "no named profiles" — both halves have to say so rather than report a
// clean install of the default profile alone.
// A `profiles/` the run cannot enter must cost that build its named profiles
// and nothing else: the default profile beside it is still writable, and so is
// every other build the operator has installed.
test('vscode', 'a profiles directory it cannot read costs that build alone', async t => {
  if (process.platform === 'win32') skip('POSIX permission bits only');
  const runHalf = async (which: 'bash' | 'powershell') => {
    const ws = makeWorkspace();
    const blocked = makeVSCodeUserDir(ws, `vscode-warnprofiles-${which}`);
    const profiles = join(blocked, 'profiles');
    mkdirSync(profiles, { recursive: true });
    chmodSync(profiles, 0o000);
    // A second build, entirely healthy, reached only after the first one warns.
    const healthy = makeVSCodeUserDir(ws, `vscode-healthy-${which}`);
    const healthyProfile = join(healthy, 'profiles', 'a1b2c3');
    mkdirSync(healthyProfile, { recursive: true });
    try {
      const userDirs = `${blocked}\n${healthy}`;
      const run = which === 'bash'
        ? await runVSCode(ws, { vscodeUserDir: userDirs })
        : await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: vscodeConfig(), vscodeUserDir: userDirs });
      // The exact sentence, not merely the word "warning": other output
      // mentions profiles, and a bare /warn/i would be satisfied by anything.
      t.equal(run.code, 0, `${which} still succeeds overall:\n${run.combined}`);
      t.ok(run.combined.includes('could not list profiles'), `${which} says which directory it could not read:\n${run.combined}`);
      t.equal(readVSCodeGroups(blocked).length, 1, `${which} still configures the blocked build's default profile`);
      t.ok(existsSync(vscodeGroupsPath(healthy)), `${which} still reaches the next build's default profile`);
      t.ok(existsSync(vscodeGroupsPath(healthyProfile)), `${which} still reaches the next build's named profile`);
    } finally {
      chmodSync(profiles, 0o755);
    }
  };

  await runHalf('bash');
  if (hostPwsh) await runHalf('powershell');
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

// --- run --------------------------------------------------------------------

const parseAgentFilter = (): ScriptAgent | 'all' => {
  const index = process.argv.indexOf('--agent');
  if (index === -1) return 'all';
  const value = process.argv[index + 1];
  const agents = Object.keys(AGENT_NAMES) as ScriptAgent[];
  const match = agents.find(agent => agent === value);
  if (match !== undefined) return match;
  throw new Error(`--agent must be one of ${agents.join(', ')}, got ${JSON.stringify(value)}`);
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
