// Isolated integration harness for the fixed Agent Setup installer bodies.
//
// The gateway serves each setup script as a language-native assignment prefix
// (rendered here through the real `render.ts`) plus a fixed checked-in body.
// This harness executes that exact concatenation inside throwaway HOME,
// CLAUDE_CONFIG_DIR, CODEX_HOME, and PATH roots against fake Claude Code and
// Codex CLIs, fake package managers, and local HTTP fixtures, then inspects
// files, protocol records, permissions, rollback, and output.
// The full host run exercises more than 90 behavior cases across Bash and
// PowerShell, including a real Codex 0.144.5 app-server smoke when that exact
// CLI is present.
// Individual cases skip only when their host prerequisite is absent or blocks
// isolation: PowerShell, the pinned Codex binary, jq-bootstrap network access,
// or an actually absent Codex at every known global location. The harness never
// touches the user's real config or credentials.
//
// Run the whole suite with `pnpm run test:agent-setup-installers`, or scope it
// with `--agent claude` / `--agent codex` and `--match <name substring>`.

import { AsyncLocalStorage } from 'node:async_hooks';
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
  SETUP_POWERSHELL_CLAUDE,
  SETUP_POWERSHELL_CODEX,
  SETUP_POWERSHELL_COMMON,
} from '../src/script-assets.generated.ts';
import { type ScriptAgent, SETUP_SCRIPT_BODIES } from '../src/script-assets.ts';

const powerShellLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const AGENT_NAMES: Record<ScriptAgent, string> = { claude: 'Claude Code', codex: 'Codex' };
const shellEntry = (agent: ScriptAgent): string => `main '${AGENT_NAMES[agent]}' "$@"`;
const powerShellEntry = (agent: ScriptAgent): string => `$global:LASTEXITCODE = Main '${AGENT_NAMES[agent]}'`;
const shellBody = (agent: ScriptAgent): string => SETUP_SCRIPT_BODIES[agent].sh;
const powerShellBody = (agent: ScriptAgent): string => SETUP_SCRIPT_BODIES[agent].ps1;
const ALL_BASH_FRAGMENTS = SETUP_BASH_COMMON + SETUP_BASH_CLAUDE + SETUP_BASH_CODEX;
const ALL_POWERSHELL_FRAGMENTS = SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_CLAUDE + SETUP_POWERSHELL_CODEX;

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
type CaseLane = 'general' | 'powershell' | 'exclusive';
interface Case { agent: ScriptAgent; name: string; fn: TestFn; lane: CaseLane }
const cases: Case[] = [];
const test = (agent: ScriptAgent, name: string, fn: TestFn): void => { cases.push({ agent, name, fn, lane: 'general' }); };
const powerShellTest = (agent: ScriptAgent, name: string, fn: TestFn): void => { cases.push({ agent, name, fn, lane: 'powershell' }); };
const exclusiveTest = (agent: ScriptAgent, name: string, fn: TestFn): void => { cases.push({ agent, name, fn, lane: 'exclusive' }); };

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
for (const tool of ['sh', 'bash', 'env', 'awk', 'cat', 'chmod', 'cmp', 'cp', 'date', 'mkdir', 'mkfifo', 'mktemp', 'mv', 'rm', 'rmdir', 'shasum', 'sleep', 'uname', 'curl', 'wc']) {
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
    if [ -n "\${FAKE_CLI_GATE_MARKER:-}" ]; then printf 'ready' > "$FAKE_CLI_GATE_MARKER"; fi
    while [ -n "\${FAKE_CLI_GATE:-}" ] && [ ! -e "$FAKE_CLI_GATE" ]; do sleep 0.01; done
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
// and that stdin stayed open until the batch response was sent. A response
// materializes those edits into the config path first, making rollback tests
// observe a real mutation. It refuses to run if the API key ever reaches it
// through the environment or a request, and exits cleanly on stdin EOF.
// Newlines are emitted via String.fromCharCode(10) to keep the source free of
// escape hazards inside this template literal.
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
  const awaitGate = () => {
    if (!process.env.FAKE_CLI_GATE || fs.existsSync(process.env.FAKE_CLI_GATE)) emit();
    else setTimeout(awaitGate, 10);
  };
  if (process.env.FAKE_CLI_GATE_MARKER) fs.writeFileSync(process.env.FAKE_CLI_GATE_MARKER, 'ready');
  if (sleep > 0) setTimeout(awaitGate, sleep * 1000); else awaitGate();
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
        const edits = (msg.params && msg.params.edits) || [];
        const configPath = home + '/config.toml';
        rec({ marker: 'batch-respond', edits: edits });
        if (mode === 'premature-eof') { process.exit(0); }
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(Object.fromEntries(edits.map((edit) => [edit.keyPath, edit.value]))) + NL);
        if (mode === 'missing-backups-error') {
          for (const name of fs.readdirSync(home)) {
            if (name.indexOf('.floway-backup.') >= 0) fs.unlinkSync(path.join(home, name));
          }
          send({ id: msg.id, error: { code: -32000, message: 'batchWrite removed rollback backups' } });
          return;
        }
        if (mode === 'malformed') { process.stdout.write('this-is-not-json for id ' + msg.id + NL); return; }
        if (mode === 'error') { send({ id: msg.id, error: { code: -32000, message: 'batchWrite exploded' } }); return; }
        if (mode === 'okOverridden') {
          send({ id: msg.id, result: { status: 'okOverridden', version: 'sha256:v', filePath: configPath, overriddenMetadata: { message: 'Overridden by session flags', overridingLayer: { name: { type: 'sessionFlags' }, version: 'sha256:l' }, effectiveValue: 'shadow-model' } } });
          return;
        }
        send({ id: msg.id, result: { status: 'ok', version: 'sha256:v', filePath: configPath, overriddenMetadata: null } });
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
const FAKE_CODEX_SRC = join(FIXTURES, 'codex');
writeFileSync(FAKE_CODEX_SRC, FAKE_CODEX, { mode: 0o755 });

// --- local HTTP fixtures ----------------------------------------------------

type ModelServerMode =
  | 'ok'
  | 'installer-sh' | 'installer-ps1' | 'installer-oversized-ps1' | 'installer-html' | 'installer-banner-html'
  | 'installer-unsupported-charset'
  | 'installer-codex-sh' | 'installer-codex-ps1';
interface ModelServer {
  url: string;
  readonly requests: { method: string; path: string }[];
  mode: ModelServerMode;
  reset(): void;
  dispose(): void;
}
interface ModelServerHost {
  createFixture(id: number): ModelServer;
  close(): Promise<void>;
}

const modelServerStorage = new AsyncLocalStorage<ModelServer>();
const currentModelServer = (): ModelServer => {
  const fixture = modelServerStorage.getStore();
  if (fixture === undefined) throw new Error('installer case has no model-server fixture');
  return fixture;
};
const modelServer = new Proxy({} as ModelServer, {
  get: (_target, property) => Reflect.get(currentModelServer(), property),
  set: (_target, property, value) => Reflect.set(currentModelServer(), property, value),
});

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

const COMMAND_BOUNDARY_SECRET = 'secret-from-downloaded-script-密钥';

const startModelServer = async (): Promise<ModelServerHost> => {
  const states = new Map<string, { mode: ModelServerMode; requests: { method: string; path: string }[] }>();
  const HTML_BODY = '<!DOCTYPE html><HTML><BODY>blocked</BODY></HTML>';
  const server: Server = createServer((req, res) => {
    const requestPath = new URL(req.url ?? '/', 'http://localhost').pathname;
    const separator = requestPath.indexOf('/', 1);
    const fixtureId = decodeURIComponent(requestPath.slice(1, separator === -1 ? undefined : separator));
    const state = states.get(fixtureId);
    if (state === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"unknown test fixture"}');
      return;
    }
    const pathname = separator === -1 ? '/' : requestPath.slice(separator);
    state.requests.push({ method: req.method ?? '', path: pathname });
    // Unauthenticated probe bodies for the command-injection-semantics tests:
    // each echoes the base URL the wrapping command injected into the executing
    // shell, so the harness can confirm `export SETUP_ENDPOINT` / `$SetupEndpoint`
    // reached the clean child process without carrying caller-owned functions.
    if (pathname === '/probe/setup.sh') {
      res.writeHead(200, { 'content-type': 'text/x-shellscript' });
      res.end([
        `SETUP_PROBE_SECRET='${COMMAND_BOUNDARY_SECRET}'`,
        'if [ "${FLOWAY_BASH_ENV_RAN:-}" = 1 ] || declare -F floway_poison >/dev/null; then printf \'poison crossed Bash boundary\\n\' >&2; exit 1; fi',
        'case "$(ps -o command= -p $$)" in *"$SETUP_PROBE_SECRET"*) printf \'downloaded secret reached Bash argv\\n\' >&2; exit 1;; esac',
        'printf \'PROBE_BASE_URL=[%s]\\n\' "${SETUP_ENDPOINT:-UNSET}"',
        'printf \'PROBE_UNICODE=[%s]\\n\' "$SETUP_PROBE_SECRET"',
        '',
      ].join('\n'));
      return;
    }
    if (pathname === '/probe/setup.ps1') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end([
        `$ProbeSecret = '${COMMAND_BOUNDARY_SECRET}'`,
        "if (Get-Command FlowayPoison -CommandType Function -ErrorAction SilentlyContinue) { throw 'caller function crossed PowerShell boundary' }",
        "if ([Environment]::CommandLine.Contains($ProbeSecret)) { throw 'downloaded secret reached PowerShell argv' }",
        'Write-Output "PROBE_BASE_URL=[$(if ($null -eq $SetupEndpoint) { \'UNSET\' } else { $SetupEndpoint })]"',
        'Write-Output "PROBE_UNICODE=[$ProbeSecret]"',
        '',
      ].join('\n'));
      return;
    }
    if (pathname === '/probe/setup-fail.ps1') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('$global:LASTEXITCODE = 23\n');
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
      if (state.mode === 'installer-banner-html') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`\ufeffregional access notice\nproxy banner\n${HTML_BODY}`);
        return;
      }
      if (state.mode === 'installer-ps1') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(PS1_FAKE_INSTALLER_BODY('claude', 'FAKE_CLAUDE_SRC'));
        return;
      }
      if (state.mode === 'installer-oversized-ps1') {
        res.writeHead(200, { 'content-length': String(8 * 1024 * 1024 + 1), 'content-type': 'text/plain' });
        res.end();
        return;
      }
      if (state.mode === 'installer-unsupported-charset') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=floway-unsupported' });
        res.end('Write-Output "must not execute"');
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
  const origin = `http://127.0.0.1:${port}`;
  return {
    createFixture(id) {
      const fixtureId = `case-${id}`;
      const state = {
        mode: 'ok' as ModelServerMode,
        requests: [] as { method: string; path: string }[],
      };
      if (states.has(fixtureId)) throw new Error(`duplicate model-server fixture ${fixtureId}`);
      states.set(fixtureId, state);
      return {
        url: `${origin}/${fixtureId}`,
        get requests() { return state.requests; },
        get mode() { return state.mode; },
        set mode(value) { state.mode = value; },
        reset() { state.requests.length = 0; state.mode = 'ok'; },
        dispose() {
          if (!states.delete(fixtureId)) throw new Error(`model-server fixture ${fixtureId} was already disposed`);
        },
      };
    },
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

const placeFakeNpm = (workspace: Workspace): void => {
  writeFileSync(join(workspace.binDir, 'npm'), `#!/bin/bash
if [ "\${SETUP_API_KEY+x}" = x ] || [ "\${SetupApiKey+x}" = x ]; then
  printf 'fake npm inherited the setup API key environment variable\\n' >&2
  exit 91
fi
printf '%s\\n' "$*" > "$FAKE_NPM_RECORD"
if [ "\${FAKE_INSTALLER_SLEEP:-0}" -gt 0 ]; then
  bash -c '
    sleep "$FAKE_INSTALLER_SLEEP" &
    child=$!
    if [ -n "$FAKE_INSTALLER_CHILD_PID_FILE" ]; then printf "%s\\n" "$child" > "$FAKE_INSTALLER_CHILD_PID_FILE"; fi
    wait "$child"
  '
fi
case "$*" in
  *'@anthropic-ai/claude-code'*)
    mkdir -p "$HOME/.local/bin"
    cp "$FAKE_CLAUDE_SRC" "$HOME/.local/bin/claude"
    chmod 755 "$HOME/.local/bin/claude"
    ;;
  *'@openai/codex'*)
    if [ "\${CODEX_NON_INTERACTIVE:-}" != true ]; then
      printf 'fake npm did not receive CODEX_NON_INTERACTIVE=true for Codex\\n' >&2
      exit 94
    fi
    if [ -n "\${FAKE_INSTALLER_OBSERVED_NON_INTERACTIVE:-}" ]; then
      printf '%s' "$CODEX_NON_INTERACTIVE" > "$FAKE_INSTALLER_OBSERVED_NON_INTERACTIVE"
    fi
    mkdir -p "$HOME/.local/bin"
    cp "$FAKE_CODEX_SRC" "$HOME/.local/bin/codex"
    chmod 755 "$HOME/.local/bin/codex"
    ;;
  *) exit 64 ;;
esac
: > "$FAKE_INSTALLER_MARKER"
`, { mode: 0o755 });
};

const placeCurlRedirect = (workspace: Workspace): void => {
  writeFileSync(join(workspace.binDir, 'curl'), `#!/bin/bash
output=
max=8388608
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    --max-filesize) max=$2; shift 2 ;;
    *) shift ;;
  esac
done
exec "$FLOWAY_HARNESS_REAL_CURL" -fsSL --connect-timeout 2 --max-time 10 --max-filesize "$max" -o "$output" "$FLOWAY_HARNESS_CURL_URI"
`, { mode: 0o755 });
};

const placeCurlFailure = (workspace: Workspace): void => {
  writeFileSync(join(workspace.binDir, 'curl'), '#!/bin/bash\nexit 22\n', { mode: 0o755 });
};

const jqDigestForHost = (): string => {
  const key = `${process.platform}-${process.arch}`;
  const digests: Record<string, string> = {
    'darwin-x64': 'e94b266e3c26690550006abe63152b782280f4e14374accdf04cbde844f00bc0',
    'darwin-arm64': '2d75340ba57a4b4b4c8708a21c2dc8e958a48aaa8bba13b27f77f6e4c0eca07e',
    'linux-x64': 'b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f',
    'linux-arm64': '8b85c817833814ddca00a144c33705546355afccf0cf39b188f3cdb48b852309',
  };
  const digest = digests[key];
  if (digest === undefined) throw new Error(`no jq fixture digest for ${key}`);
  return digest;
};

const placeLocalJqDownload = (workspace: Workspace): void => {
  if (!hostJqPath) throw new Error('a host jq is required for the local bootstrap fixture');
  writeFileSync(join(workspace.binDir, 'curl'), `#!/bin/bash
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then output=$2; shift 2; else shift; fi
done
exec "$FLOWAY_HARNESS_REAL_CP" "$FLOWAY_HARNESS_JQ_SOURCE" "$output"
`, { mode: 0o755 });
  const checksum = '#!/bin/bash\nprintf \'%s\\n\' "$FLOWAY_HARNESS_JQ_DIGEST"\n';
  writeFileSync(join(workspace.binDir, 'sha256sum'), checksum, { mode: 0o755 });
  writeFileSync(join(workspace.binDir, 'shasum'), checksum, { mode: 0o755 });
};

const placeDeadlineShims = (workspace: Workspace, excludeTimeoutTools: boolean): void => {
  if (!excludeTimeoutTools) {
    const timeout = resolveTool('timeout') ?? resolveTool('gtimeout');
    if (!timeout) throw new Error('a timeout executable is required for the bounded-process fixture');
    writeFileSync(join(workspace.binDir, 'timeout'), `#!/bin/bash
shift
exec "$FLOWAY_HARNESS_REAL_TIMEOUT" "$FLOWAY_HARNESS_DEADLINE_SECONDS" "$@"
`, { mode: 0o755 });
  }
  writeFileSync(join(workspace.binDir, 'sleep'), `#!/bin/bash
duration=$1
shift
case "$duration" in
  30|60|120|600) duration=$FLOWAY_HARNESS_DEADLINE_SECONDS ;;
  1|0.5) if [ "$FLOWAY_HARNESS_SHORT_GRACE" = 1 ]; then duration=0.05; fi ;;
esac
if [ "$duration" = 0.1 ] && [ -n "\${FLOWAY_HARNESS_LOCK_WAIT_MARKER:-}" ]; then
  : > "$FLOWAY_HARNESS_LOCK_WAIT_MARKER"
fi
exec "$FLOWAY_HARNESS_REAL_SLEEP" "$duration" "$@"
`, { mode: 0o755 });
};

const placeLockWaitShim = (workspace: Workspace): void => {
  if (existsSync(join(workspace.binDir, 'sleep'))) return;
  writeFileSync(join(workspace.binDir, 'sleep'), `#!/bin/bash
if [ "$1" = 0.1 ] && [ -n "\${FLOWAY_HARNESS_LOCK_WAIT_MARKER:-}" ]; then
  : > "$FLOWAY_HARNESS_LOCK_WAIT_MARKER"
fi
exec "$FLOWAY_HARNESS_REAL_SLEEP" "$@"
`, { mode: 0o755 });
};

const placeExpiredClock = (workspace: Workspace): void => {
  writeFileSync(join(workspace.binDir, 'date'), `#!/bin/bash
if [ "$1" = +%s ]; then
  if [ ! -e "$FLOWAY_HARNESS_CLOCK_STATE" ]; then
    printf '1' > "$FLOWAY_HARNESS_CLOCK_STATE"
    printf '0\n'
  elif [ "$FLOWAY_HARNESS_CLOCK_MODE" = app-server ] && [ "$(cat "$FLOWAY_HARNESS_CLOCK_STATE")" = 1 ]; then
    printf '2' > "$FLOWAY_HARNESS_CLOCK_STATE"
    printf '0\n'
  else
    printf '600\n'
  fi
  exit 0
fi
exec "$FLOWAY_HARNESS_REAL_DATE" "$@"
`, { mode: 0o755 });
};

type InstallerTestConfiguration = AgentSetupConfiguration & { readonly testAgent: ScriptAgent };

const claudeConfig = (overrides: Partial<AgentSetupConfiguration['claudeCode']> = {}): InstallerTestConfiguration => ({
  testAgent: 'claude',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, modelDiscovery: false, ...overrides,
  },
  codex: { model: null, reasoningEffort: null },
});

const codexConfig = (overrides: Partial<AgentSetupConfiguration['codex']> = {}): InstallerTestConfiguration => ({
  testAgent: 'codex',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, modelDiscovery: false,
  },
  codex: { model: null, reasoningEffort: null, ...overrides },
});

const bothConfig = (
  claude: Partial<AgentSetupConfiguration['claudeCode']> = {},
  codex: Partial<AgentSetupConfiguration['codex']> = {},
): InstallerTestConfiguration => ({
  testAgent: 'claude',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, modelDiscovery: false, ...claude,
  },
  codex: { model: null, reasoningEffort: null, ...codex },
});

interface RunOptions {
  workspace: Workspace;
  configuration: InstallerTestConfiguration;
  agent?: ScriptAgent;
  runId?: string;
  apiKey?: string;
  baseUrl: string;
  // The wrapping one-line command injects the gateway origin into the executing
  // shell (Bash exports SETUP_ENDPOINT; PowerShell assigns $SetupEndpoint in the
  // clean child process); the harness mirrors that. `baseUrlOverride` injects a
  // different value than the model-server URL (used for the invalid-origin
  // guard); `omitBaseUrl` injects nothing at all (the missing-origin guard).
  baseUrlOverride?: string;
  omitBaseUrl?: boolean;
  configDir?: string;
  includeJq?: boolean;
  failJqDownload?: boolean;
  bootstrapJqLocally?: boolean;
  fakeClaudeVersion?: string;
  fakeClaudeVersionSleep?: number;
  fakeCliGate?: string;
  fakeCliGateMarker?: string;
  autoInstallWithNpm?: boolean;
  installerSleep?: number;
  bashInstallerUrl?: string;
  timeoutSeconds?: number;
  expireLockDeadline?: boolean;
  expireAppServerDeadline?: boolean;
  lockWaitMarker?: string;
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
  autoInstallCodexWithNpm?: boolean;
  bashCodexInstallerUrl?: string;
  ambientCodexNonInteractive?: string;
  powerShellTimeSeparator?: string;
  // Forces the existing-file branch through File.Replace on non-Windows hosts,
  // exercising PowerShell's real-null interop without a production test hook.
  forcePowerShellWindowsReplacement?: boolean;
  // Output and filesystem-failure knobs are implemented entirely by harness
  // state and command shims; the served installer has no test-only branches.
  noColor?: boolean;
  failPowerShellRestore?: boolean;
  failBackupPrune?: boolean;
}

const targetAgent = (configuration: InstallerTestConfiguration, agent?: ScriptAgent): ScriptAgent =>
  agent ?? configuration.testAgent;
interface RunResult { code: number; stdout: string; stderr: string; combined: string }

// Environment shared by the shell run helpers: Codex fake-binary knobs and
// CODEX_HOME. Callers merge this over the Claude environment before running
// the selected agent.
const codexEnv = (options: RunOptions): Record<string, string> => {
  const env: Record<string, string> = {
    FAKE_CODEX_SRC,
    FAKE_CODEX_SENTINEL: options.apiKey ?? SENTINEL_KEY,
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
  if (options.fakeCliGate) env.FAKE_CLI_GATE = options.fakeCliGate;
  if (options.fakeCliGateMarker) env.FAKE_CLI_GATE_MARKER = options.fakeCliGateMarker;
  if (options.fakeCodexLargeStderr) env.FAKE_CODEX_LARGE_STDERR = '1';
  if (options.codexHome) env.CODEX_HOME = options.codexHome;
  return env;
};

// The origin the wrapping one-line command injects into the executing shell.
const injectedBaseUrlValue = (options: RunOptions): string => options.baseUrlOverride ?? options.baseUrl;

// Bash's downstream `bash` is a child process, so the origin crosses the
// boundary through the exported environment — mirror the `export SETUP_ENDPOINT`
// the copyable command performs. Omitted entirely for the missing-origin guard.
const injectedBaseUrlEnv = (options: RunOptions): Record<string, string> =>
  options.omitBaseUrl ? {} : { SETUP_ENDPOINT: injectedBaseUrlValue(options) };

// The copyable command sends this assignment before the served body over the
// clean child process's UTF-8 stdin.
const powerShellBaseUrlPrelude = (options: RunOptions): string =>
  options.omitBaseUrl ? '' : `$SetupEndpoint = ${powerShellLiteral(injectedBaseUrlValue(options))}\n`;

// Runs asynchronously via `spawn` (not `spawnSync`) so local installer downloads
// can be served by this process's event loop without deadlocking.
const runShellInstaller = (options: RunOptions): Promise<RunResult> => {
  const { workspace, configuration } = options;
  const agent = targetAgent(configuration, options.agent);
  const autoInstallWithNpm = agent === 'codex'
    ? options.autoInstallCodexWithNpm !== false
    : options.autoInstallWithNpm !== false;
  if (autoInstallWithNpm) placeFakeNpm(workspace);
  const redirectedInstallerUrl = options.bashInstallerUrl ?? options.bashCodexInstallerUrl;
  if (redirectedInstallerUrl) placeCurlRedirect(workspace);
  if (options.failJqDownload) placeCurlFailure(workspace);
  if (options.bootstrapJqLocally) placeLocalJqDownload(workspace);
  if (options.timeoutSeconds !== undefined) placeDeadlineShims(workspace, options.excludeTimeoutTools === true);
  if (options.expireAppServerDeadline && options.timeoutSeconds === undefined) placeDeadlineShims(workspace, true);
  if (agent === 'codex' && options.timeoutSeconds === undefined && !options.expireAppServerDeadline) {
    placeDeadlineShims(workspace, true);
  }
  if (options.lockWaitMarker) placeLockWaitShim(workspace);
  if (options.expireLockDeadline || options.expireAppServerDeadline) placeExpiredClock(workspace);
  if (options.failBackupPrune) {
    writeFileSync(
      join(workspace.binDir, 'rm'),
      '#!/bin/bash\nfor arg in "$@"; do case "$arg" in *.floway-backup.*) exit 73 ;; esac; done\nexec "$FLOWAY_HARNESS_REAL_RM" "$@"\n',
      { mode: 0o755 },
    );
  }
  const script = renderShellPrefix({ agent, apiKey: options.apiKey ?? SENTINEL_KEY, apiKeyName: 'Primary key', configuration }) + shellBody(agent);
  const scriptPath = join(workspace.root, `setup${options.runId ? `-${options.runId}` : ''}.sh`);
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
    FLOWAY_HARNESS_REAL_CP: join(SHIM_BIN, 'cp'),
    FLOWAY_HARNESS_REAL_CURL: join(SHIM_BIN, 'curl'),
    FLOWAY_HARNESS_REAL_DATE: join(SHIM_BIN, 'date'),
    FLOWAY_HARNESS_REAL_RM: join(SHIM_BIN, 'rm'),
    FLOWAY_HARNESS_REAL_SLEEP: join(SHIM_BIN, 'sleep'),
    FLOWAY_HARNESS_REAL_TIMEOUT: resolveTool('timeout') ?? resolveTool('gtimeout') ?? '',
    FLOWAY_HARNESS_CURL_URI: redirectedInstallerUrl ?? '',
    FLOWAY_HARNESS_DEADLINE_SECONDS: String(options.timeoutSeconds ?? ''),
    FLOWAY_HARNESS_SHORT_GRACE: agent === 'codex' ? '1' : '0',
    FLOWAY_HARNESS_CLOCK_STATE: join(workspace.root, 'clock-state'),
    FLOWAY_HARNESS_CLOCK_MODE: options.expireAppServerDeadline ? 'app-server' : 'lock',
    FLOWAY_HARNESS_LOCK_WAIT_MARKER: options.lockWaitMarker ?? '',
    FLOWAY_HARNESS_JQ_SOURCE: hostJqPath ?? '',
    FLOWAY_HARNESS_JQ_DIGEST: options.bootstrapJqLocally ? jqDigestForHost() : '',
    ...codexEnv(options),
  };
  if (options.configDir) env.CLAUDE_CONFIG_DIR = options.configDir;
  if (options.fakeClaudeVersion) env.FAKE_CLAUDE_VERSION = options.fakeClaudeVersion;
  if (options.noColor) env.NO_COLOR = '1';

  if (options.fakeRestoreFailure) {
    // A `mv` shim (binDir precedes SHIM_BIN on PATH) that refuses only the
    // rollback's restore rename — its source is the `.floway-backup.` file —
    // and delegates every other rename (staging included) to the real mv.
    writeFileSync(
      join(workspace.binDir, 'mv'),
      '#!/bin/bash\nfor arg in "$@"; do case "$arg" in *.floway-backup.*) exit 1 ;; esac; done\nexec "$FLOWAY_HARNESS_REAL_MV" "$@"\n',
      { mode: 0o755 },
    );
    env.FLOWAY_HARNESS_REAL_MV = join(SHIM_BIN, 'mv');
  }

  const signal = options.signalDuringInstall;
  return new Promise<RunResult>(resolve => {
    const child = spawn('/bin/bash', ['-p', scriptPath], { env, detached: signal !== undefined });
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
  placeFakeNpm(workspace);
  const script = renderShellPrefix({ agent, apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration }) + shellBody(agent);
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
  };
  return new Promise<RunResult>(resolve => {
    const child = spawn('/bin/bash', ['-p', scriptPath], { env });
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
const waitForFile = async (path: string, label: string): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label} at ${path}`);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
};
const setupLockPath = (targetRoot: string): string => join(targetRoot, '.floway-agent-setup.lock');
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
const readMaterializedCodexConfig = (workspace: Workspace, codexHome?: string): Record<string, unknown> =>
  JSON.parse(readFileSync(codexConfigPath(workspace, codexHome), 'utf8')) as Record<string, unknown>;
// Runs the PowerShell body under a real interpreter, mirroring runShellInstaller
// but rendering the PowerShell prefix. Model-directory traffic is in-process, so
// this too must be async to keep the event loop free.
const powerShellHarnessPrelude = (options: RunOptions): string => {
  const parts: string[] = [];
  if (options.lockWaitMarker) {
    parts.push(`function Start-Sleep {
  param([int]$Milliseconds, [int]$Seconds)
  if ($Milliseconds -eq 100) { [System.IO.File]::WriteAllText($env:FLOWAY_HARNESS_LOCK_WAIT_MARKER, '') }
  if ($PSBoundParameters.ContainsKey('Milliseconds')) { Microsoft.PowerShell.Utility\\Start-Sleep -Milliseconds $Milliseconds }
  else { Microsoft.PowerShell.Utility\\Start-Sleep -Seconds $Seconds }
}
`);
  }
  if (options.failPowerShellRestore) {
    parts.push(`function Move-Item {
  param([string]$LiteralPath, [string]$Destination, [switch]$Force)
  if ($LiteralPath -like '*.floway-backup.*') { throw 'harness-blocked backup restore' }
  Microsoft.PowerShell.Management\\Move-Item @PSBoundParameters
}
`);
  }
  if (options.failBackupPrune) {
    parts.push(`function Get-ChildItem {
  param([string]$LiteralPath, [switch]$File, $ErrorAction)
  if ($LiteralPath -ceq $env:FLOWAY_HARNESS_FAIL_PRUNE_DIR) { throw 'harness-blocked backup enumeration' }
  Microsoft.PowerShell.Management\\Get-ChildItem @PSBoundParameters
}
`);
  }
  return parts.join('');
};

const runPowerShellInstaller = (options: RunOptions): Promise<RunResult> => {
  const { workspace, configuration } = options;
  const agent = targetAgent(configuration, options.agent);
  const autoInstallWithNpm = agent === 'codex'
    ? options.autoInstallCodexWithNpm !== false
    : options.autoInstallWithNpm !== false;
  if (autoInstallWithNpm) placeFakeNpm(workspace);
  if (options.timeoutSeconds !== undefined) placeDeadlineShims(workspace, false);
  const culturePrelude = options.powerShellTimeSeparator === undefined
    ? ''
    : `$culture = [Globalization.CultureInfo]::GetCultureInfo('en-US').Clone()\n$culture.DateTimeFormat.TimeSeparator = '${options.powerShellTimeSeparator.replace(/'/g, "''")}'\n[Threading.Thread]::CurrentThread.CurrentCulture = $culture\n`;
  let canonicalBody = powerShellBody(agent);
  if (options.timeoutSeconds !== undefined) {
    canonicalBody = canonicalBody.replace(/-TimeoutSeconds (?:30|60|120|600)\b/g, `-TimeoutSeconds ${options.timeoutSeconds}`);
  }
  if (options.expireLockDeadline) {
    canonicalBody = canonicalBody.replace('$wait.Elapsed.TotalSeconds -ge 600', '$wait.Elapsed.TotalSeconds -ge 0');
  }
  const body = options.forcePowerShellWindowsReplacement
    ? canonicalBody
        .replace('if ($script:ClaudeSettingsExisted -and $runningOnWindows)', 'if ($script:ClaudeSettingsExisted)')
        .replace('if ($script:CodexTokenExisted -and $runningOnWindows)', 'if ($script:CodexTokenExisted)')
    : canonicalBody;
  const script = powerShellHarnessPrelude(options) + powerShellBaseUrlPrelude(options) + renderPowerShellPrefix({ agent, apiKey: options.apiKey ?? SENTINEL_KEY, apiKeyName: 'Primary key', configuration }) + culturePrelude + body;
  const suffix = options.runId ? `-${options.runId}` : '';
  const scriptPath = join(workspace.root, `setup${suffix}.ps1`);
  writeFileSync(scriptPath, script);
  const childInput = `${script}\nexit $global:LASTEXITCODE\n`;

  if (options.fakeChmodFailure) {
    writeFileSync(join(workspace.binDir, 'chmod'), '#!/bin/bash\nexit 73\n', { mode: 0o755 });
  }
  const env: Record<string, string> = {
    HOME: workspace.home,
    PATH: [workspace.binDir, SHIM_BIN].join(':'),
    TERM: 'dumb',
    FAKE_CLAUDE_VERSION_SLEEP: String(options.fakeClaudeVersionSleep ?? 0),
    FAKE_INSTALLER_SLEEP: String(options.installerSleep ?? 0),
    FAKE_CLAUDE_SRC,
    FAKE_INSTALLER_MARKER: join(workspace.root, 'installer-ran'),
    FAKE_INSTALLER_CHILD_PID_FILE: join(workspace.root, 'installer-child.pid'),
    FAKE_NPM_RECORD: join(workspace.root, 'npm-record.txt'),
    FLOWAY_HARNESS_DEADLINE_SECONDS: String(options.timeoutSeconds ?? ''),
    FLOWAY_HARNESS_FAIL_PRUNE_DIR: options.configDir ?? join(workspace.home, '.claude'),
    FLOWAY_HARNESS_LOCK_WAIT_MARKER: options.lockWaitMarker ?? '',
    FLOWAY_HARNESS_REAL_SLEEP: join(SHIM_BIN, 'sleep'),
    FLOWAY_HARNESS_REAL_TIMEOUT: resolveTool('timeout') ?? resolveTool('gtimeout') ?? '',
    ...codexEnv(options),
  };
  if (options.configDir) env.CLAUDE_CONFIG_DIR = options.configDir;
  if (options.fakeClaudeVersion) env.FAKE_CLAUDE_VERSION = options.fakeClaudeVersion;
  if (options.ambientApiKey) env.SETUP_API_KEY = SENTINEL_KEY;
  if (options.noColor) env.NO_COLOR = '1';

  return new Promise<RunResult>(resolve => {
    const child = spawn(hostPwsh!, ['-NoProfile', '-NonInteractive', '-Command', '-'], { env });
    let stdout = '';
    let stderr = '';
    child.stdin.on('error', error => { stderr += String(error); });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}`, combined: `${stdout}${stderr}${String(error)}` }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: `${stdout}${stderr}` }));
    child.stdin.end(childInput);
  });
};

const runProbeProcess = (
  exe: string,
  args: string[],
  env: Record<string, string>,
  input?: string,
): Promise<RunResult> => new Promise(resolve => {
  const child = spawn(exe, args, { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}`, combined: `${stdout}${stderr}${String(error)}` }));
  child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: `${stdout}${stderr}` }));
  if (input === undefined) child.stdin.end(); else child.stdin.end(input);
});

const powerShellProbeEnv = (workspace: Workspace, extra: Record<string, string> = {}): Record<string, string> => ({
  HOME: workspace.home,
  PATH: [workspace.binDir, SHIM_BIN].join(':'),
  TERM: 'dumb',
  FAKE_CLAUDE_SRC,
  FAKE_CODEX_SRC,
  FAKE_INSTALLER_MARKER: installerMarker(workspace),
  FAKE_INSTALLER_CHILD_PID_FILE: installerChildPid(workspace),
  ...extra,
});

const runPowerShellProbe = (
  workspace: Workspace,
  source: string,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> => {
  const scriptPath = join(workspace.root, 'powershell-probe.ps1');
  writeFileSync(scriptPath, source);
  return runProbeProcess(hostPwsh!, ['-NoProfile', '-NonInteractive', '-File', scriptPath], powerShellProbeEnv(workspace, extraEnv));
};

const runPowerShellRemoteInstaller = (
  workspace: Workspace,
  uri: string,
  switches = '',
  catchBody = 'exit 1',
  extraEnv: Record<string, string> = {},
): Promise<RunResult> => runPowerShellProbe(workspace, `$ErrorActionPreference = 'Stop'
${SETUP_POWERSHELL_COMMON}
try {
  Invoke-SetupRemoteInstaller -Uri ${powerShellLiteral(uri)} ${switches}
  exit 0
} catch {
  ${catchBody}
}
`, extraEnv);

const runBashRemoteInstaller = (
  workspace: Workspace,
  uri: string,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> => {
  const scriptPath = join(workspace.root, 'bash-remote-probe.sh');
  writeFileSync(scriptPath, `${SETUP_BASH_COMMON}
SETUP_TMPDIR=$1
_init_output
_download_and_run_installer "$2"
`);
  return runProbeProcess('/bin/bash', [scriptPath, workspace.root, uri], {
    HOME: workspace.home,
    PATH: [workspace.binDir, SHIM_BIN].join(':'),
    FAKE_CLAUDE_SRC,
    FAKE_CODEX_SRC,
    FAKE_INSTALLER_MARKER: installerMarker(workspace),
    FAKE_INSTALLER_CHILD_PID_FILE: installerChildPid(workspace),
    ...extraEnv,
  });
};

const runBashOutputProbe = (workspace: Workspace, noColor = false): Promise<RunResult> => {
  const scriptPath = join(workspace.root, 'bash-output-probe.sh');
  writeFileSync(scriptPath, `${SETUP_BASH_COMMON}
_stream_color() {
  [ -z "\${NO_COLOR:-}" ] || return 1
  return 0
}
_init_output
out_agent_notice 'Agent Setup' 'Claude Code'
out_metadata 'Endpoint' 'https://gateway.example'
out_metadata 'API Key' 'Primary key'
out_agent_notice 'Installing' 'Claude Code'
out_agent_notice 'Configuring' 'Claude Code'
out_agent_notice 'Completed Agent Setup' 'Claude Code'
out_warn 'warning detail'
out_error 'error detail'
`);
  return runProbeProcess('/bin/bash', [scriptPath], {
    PATH: SHIM_BIN,
    NO_COLOR: noColor ? '1' : '',
  });
};

// --- Claude cases -----------------------------------------------------------

test('claude', 'existing CLI is used without invoking the package manager', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `installer should succeed:\n${run.combined}`);
  t.ok(!existsSync(installerMarker(ws)), 'the package manager must not run when claude is already present');
  const settings = readSettings(settingsPathFor(ws)) as { env: Record<string, string> };
  t.equal(settings.env.ANTHROPIC_BASE_URL, modelServer.url, 'base URL is written');
  t.equal(settings.env.ANTHROPIC_AUTH_TOKEN, SENTINEL_KEY, 'auth token is written');
});

test('claude', 'missing CLI installs through npm', async t => {
  const ws = makeWorkspace();
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `installer should succeed after install:\n${run.combined}`);
  t.ok(existsSync(installerMarker(ws)), 'npm must run when claude is absent');
  t.ok(existsSync(join(ws.home, '.local/bin/claude')), 'the installer places claude in the user-local location');
  t.ok(existsSync(settingsPathFor(ws)), 'settings are written after installing');
  const installLine = run.stdout.split(/\r?\n/).find(line => line.includes('Claude Code CLI not found; installing with npm'));
  t.equal(installLine, 'Claude Code CLI not found; installing with npm', 'normal installation information carries no prefix or styling');
});

test('claude', 'npm is preferred over the direct installer when npm is available', async t => {
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, autoInstallWithNpm: false });
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

exclusiveTest('claude', 'Bash serializes one config root and a failing successor restores the committed settings', async t => {
  const holderWs = makeWorkspace();
  const successorWs = makeWorkspace();
  placeFakeClaude(holderWs.binDir);
  placeFakeClaude(successorWs.binDir);
  const configDir = join(holderWs.root, 'shared-claude-config');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'original', env: { KEEP: 'yes' } });
  writeFileSync(settingsPathFor(holderWs, configDir), original);
  const holderGate = join(holderWs.root, 'release-holder');
  const holderAtCli = join(holderWs.root, 'holder-at-cli');
  const successorWaiting = join(successorWs.root, 'successor-waiting');

  const holderRun = runShellInstaller({
    workspace: holderWs,
    runId: 'lock-holder',
    apiKey: 'key-holder',
    configuration: claudeConfig({ model: 'model-holder' }),
    baseUrl: 'https://holder.example',
    configDir,
    fakeCliGate: holderGate,
    fakeCliGateMarker: holderAtCli,
  });
  await waitForFile(holderAtCli, 'the lock holder to reach the Claude CLI');
  const successorRun = runShellInstaller({
    workspace: successorWs,
    runId: 'lock-successor',
    apiKey: 'key-successor',
    configuration: claudeConfig({ model: 'model-successor' }),
    baseUrl: 'https://successor.example',
    configDir,
    lockWaitMarker: successorWaiting,
    failBackupPrune: true,
  });
  try {
    await waitForFile(successorWaiting, 'the successor to contend on the shared lock');
  } catch (error) {
    writeFileSync(holderGate, 'release');
    await Promise.all([holderRun, successorRun]);
    throw error;
  }
  writeFileSync(holderGate, 'release');

  const [holder, successor] = await Promise.all([holderRun, successorRun]);
  t.equal(holder.code, 0, `the lock holder should succeed:\n${holder.combined}`);
  t.ok(successor.code !== 0, 'the injected successor failure must fail its run');
  const final = readSettings(settingsPathFor(holderWs, configDir)) as { env: Record<string, string> };
  t.equal(final.env.ANTHROPIC_BASE_URL, 'https://holder.example', 'the failed successor restores the committed endpoint');
  t.equal(final.env.ANTHROPIC_AUTH_TOKEN, 'key-holder', 'the failed successor restores the committed token');
  const backups = backupFiles(configDir);
  t.equal(backups.length, 1, 'serialized rollback leaves exactly the holder backup');
  t.equal(readFileSync(join(configDir, backups[0]!), 'utf8'), original, 'the retained backup is the state before the holder');
  t.equal(stagedFiles(configDir).length, 0, 'neither invocation leaves a stage');
  t.ok(!existsSync(setupLockPath(configDir)), 'the shared lock is released');
  t.excludes(holder.combined + successor.combined, 'key-holder', 'the holder key is not logged');
  t.excludes(holder.combined + successor.combined, 'key-successor', 'the successor key is not logged');
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

exclusiveTest('claude', 'an interrupt during the Claude install stops the selected script and cleans up', async t => {
  for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    const ws = makeWorkspace();
    // No fake claude on PATH, so the agent fragment runs the sleeping installer;
    // the signal lands while it is mid-install.
    const run = await runShellInstaller({
      workspace: ws, baseUrl: modelServer.url, configuration: bothConfig(), agent: 'claude',
      installerSleep: 2, signalDuringInstall: signal,
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
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, includeJq: false, failJqDownload: true });
  t.ok(run.code !== 0, 'a missing JSON parser must fail the run');
  t.includes(run.combined.toLowerCase(), 'jq', 'the failure names the jq requirement');
  t.equal(readFileSync(settingsPathFor(ws), 'utf8'), original, 'settings are left untouched when jq is unavailable');
  t.equal(backupFiles(configDir).length, 0, 'no backup is created before the jq check');
});

test('claude', 'jq is bootstrapped from the pinned release when absent from PATH', async t => {
  if (!hostJqPath) skip('no jq executable is available for the local pinned-download fixture');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws,
    configuration: claudeConfig({ modelDiscovery: true }),
    baseUrl: modelServer.url,
    includeJq: false,
    bootstrapJqLocally: true,
  });
  t.equal(run.code, 0, `bootstrapped jq should configure successfully:\n${run.combined}`);
  t.includes(run.stderr, 'Warning: jq not found on PATH; fetching the pinned jq-1.8.2 build', 'automatic jq recovery is presented as a non-blocking warning');
  const settings = readSettings(settingsPathFor(ws)) as { env: Record<string, string> };
  t.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1', 'the bootstrapped jq produced correct output');
});

// --- PowerShell parse + execution ------------------------------------------

powerShellTest('claude', 'PowerShell installer body parses without syntax errors', async t => {
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

powerShellTest('claude', 'PowerShell: existing CLI configures and preserves unrelated keys', async t => {
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

powerShellTest('claude', 'PowerShell: deep and case-distinct settings survive managed updates', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  let deep: Record<string, unknown> = { sentinel: 'preserved-at-depth' };
  for (let depth = 0; depth < 105; depth++) deep = { next: deep };
  writeFileSync(settingsPathFor(ws), JSON.stringify({
    __type: 7,
    Env: { ANTHROPIC_BASE_URL: 'upper-case-object' },
    env: { anthropic_base_url: 'lower-case-property', deep },
  }));

  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });

  t.equal(run.code, 0, `deep settings should remain writable:\n${run.combined}`);
  const settings = readSettings(settingsPathFor(ws)) as {
    __type: number;
    Env: { ANTHROPIC_BASE_URL: string };
    env: Record<string, unknown>;
  };
  t.equal(settings.__type, 7, 'a first __type property remains ordinary JSON data');
  t.equal(settings.Env.ANTHROPIC_BASE_URL, 'upper-case-object', 'case-distinct Env remains untouched');
  t.equal(settings.env.anthropic_base_url, 'lower-case-property', 'case-distinct nested property remains untouched');
  t.equal(settings.env.ANTHROPIC_BASE_URL, modelServer.url, 'the exact managed property is written separately');
  let cursor = settings.env.deep as Record<string, unknown>;
  for (let depth = 0; depth < 105; depth++) cursor = cursor.next as Record<string, unknown>;
  t.equal(cursor.sentinel, 'preserved-at-depth', 'data beyond the old depth-100 ceiling remains structured');
});

powerShellTest('claude', 'PowerShell: optional keys are removed when unset', async t => {
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

powerShellTest('claude', 'PowerShell: existing permissive settings are replaced with mode 0600 on Unix', async t => {
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

powerShellTest('claude', 'PowerShell: chmod failure leaves original untouched and no secret stage', async t => {
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

powerShellTest('claude', 'PowerShell: a pre-existing settings file is backed up', async t => {
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

powerShellTest('claude', 'PowerShell: successful re-runs retain only the latest settings backup', async t => {
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

exclusiveTest('claude', 'Bash and PowerShell serialize one Claude config root and a failing successor restores the committed settings', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const holderWs = makeWorkspace();
  const successorWs = makeWorkspace();
  placeFakeClaude(holderWs.binDir);
  placeFakeClaude(successorWs.binDir);
  const configDir = join(holderWs.root, 'shared-powershell-claude-config');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'original', env: { KEEP: 'yes' } });
  writeFileSync(settingsPathFor(holderWs, configDir), original);
  const holderGate = join(holderWs.root, 'release-holder');
  const holderAtCli = join(holderWs.root, 'holder-at-cli');
  const successorWaiting = join(successorWs.root, 'successor-waiting');

  const holderRun = runShellInstaller({
    workspace: holderWs,
    runId: 'lock-holder',
    apiKey: 'key-holder',
    configuration: claudeConfig({ model: 'model-holder' }),
    baseUrl: 'https://holder.example',
    configDir,
    fakeCliGate: holderGate,
    fakeCliGateMarker: holderAtCli,
  });
  await waitForFile(holderAtCli, 'the Bash lock holder to reach the Claude CLI');
  const successorRun = runPowerShellInstaller({
    workspace: successorWs,
    runId: 'lock-successor',
    apiKey: 'key-successor',
    configuration: claudeConfig({ model: 'model-successor' }),
    baseUrl: 'https://successor.example',
    configDir,
    lockWaitMarker: successorWaiting,
    failBackupPrune: true,
  });
  try {
    await waitForFile(successorWaiting, 'the PowerShell successor to contend on the shared lock');
  } catch (error) {
    writeFileSync(holderGate, 'release');
    await Promise.all([holderRun, successorRun]);
    throw error;
  }
  writeFileSync(holderGate, 'release');

  const [holder, successor] = await Promise.all([holderRun, successorRun]);
  t.equal(holder.code, 0, `the lock holder should succeed:\n${holder.combined}`);
  t.ok(successor.code !== 0, 'the injected successor failure must fail its run');
  const final = readSettings(settingsPathFor(holderWs, configDir)) as { env: Record<string, string> };
  t.equal(final.env.ANTHROPIC_BASE_URL, 'https://holder.example', 'the failed successor restores the committed endpoint');
  t.equal(final.env.ANTHROPIC_AUTH_TOKEN, 'key-holder', 'the failed successor restores the committed token');
  const backups = backupFiles(configDir);
  t.equal(backups.length, 1, 'serialized rollback leaves exactly the holder backup');
  t.equal(readFileSync(join(configDir, backups[0]!), 'utf8'), original, 'the retained backup is the state before the holder');
  t.equal(stagedFiles(configDir).length, 0, 'neither invocation leaves a stage');
  t.ok(!existsSync(setupLockPath(configDir)), 'the shared lock is released');
  t.excludes(holder.combined + successor.combined, 'key-holder', 'the holder key is not logged');
  t.excludes(holder.combined + successor.combined, 'key-successor', 'the successor key is not logged');
});

test('claude', 'Bash times out on an occupied lock before invoking the CLI or mutating settings', async t => {
  const bashWs = makeWorkspace();
  placeFakeClaude(bashWs.binDir);
  const bashConfig = join(bashWs.root, 'occupied-bash-config');
  const bashLock = setupLockPath(bashConfig);
  mkdirSync(bashLock, { recursive: true });
  writeFileSync(join(bashLock, 'owner'), 'stale-owner');
  const bashCliMarker = join(bashWs.root, 'cli-reached');
  const bash = await runShellInstaller({
    workspace: bashWs,
    configuration: claudeConfig(),
    baseUrl: modelServer.url,
    configDir: bashConfig,
    expireLockDeadline: true,
    fakeCliGateMarker: bashCliMarker,
  });
  t.ok(bash.code !== 0, 'Bash must fail when the lock timeout expires');
  t.includes(bash.stderr, 'another Agent Setup invocation is using', 'Bash reaches the occupied-lock timeout path');
  t.ok(!existsSync(bashCliMarker), 'Bash fails before invoking Claude');
  t.ok(!existsSync(settingsPathFor(bashWs, bashConfig)), 'Bash leaves settings untouched');
  t.equal(readFileSync(join(bashLock, 'owner'), 'utf8'), 'stale-owner', 'Bash does not break an unowned lock');
});

powerShellTest('claude', 'PowerShell times out on an occupied lock before invoking the CLI or mutating settings', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const psWs = makeWorkspace();
  placeFakeClaude(psWs.binDir);
  const psConfig = join(psWs.root, 'occupied-powershell-config');
  const psLock = setupLockPath(psConfig);
  mkdirSync(psLock, { recursive: true });
  writeFileSync(join(psLock, 'owner'), 'stale-owner');
  const psCliMarker = join(psWs.root, 'cli-reached');
  const ps = await runPowerShellInstaller({
    workspace: psWs,
    configuration: claudeConfig(),
    baseUrl: modelServer.url,
    configDir: psConfig,
    expireLockDeadline: true,
    fakeCliGateMarker: psCliMarker,
  });
  t.ok(ps.code !== 0, 'PowerShell must fail when the lock timeout expires');
  t.includes(ps.stderr, 'another Agent Setup invocation is using', 'PowerShell reaches the occupied-lock timeout path');
  t.ok(!existsSync(psCliMarker), 'PowerShell fails before invoking Claude');
  t.ok(!existsSync(settingsPathFor(psWs, psConfig)), 'PowerShell leaves settings untouched');
  t.equal(readFileSync(join(psLock, 'owner'), 'utf8'), 'stale-owner', 'PowerShell does not break an unowned lock');
});

powerShellTest('claude', 'PowerShell retries when a lock owner releases after exclusive create reports contention', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const target = join(ws.root, 'release-race-config');
  const run = await runPowerShellProbe(ws, `$ErrorActionPreference = 'Stop'
${SETUP_POWERSHELL_COMMON}
$script:ReleaseRaceInjected = $false
function New-Item {
  [CmdletBinding()]
  param([string]$ItemType, [string]$Path, [switch]$Force)
  if ((-not $script:ReleaseRaceInjected) -and $Path.EndsWith('.floway-agent-setup.lock', [System.StringComparison]::Ordinal)) {
    $script:ReleaseRaceInjected = $true
    Microsoft.PowerShell.Management\\New-Item @PSBoundParameters | Out-Null
    Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $Path -Force
    $record = [System.Management.Automation.ErrorRecord]::new(
      [System.IO.IOException]::new('simulated directory-exists race'),
      'DirectoryExist',
      [System.Management.Automation.ErrorCategory]::ResourceExists,
      $Path
    )
    $PSCmdlet.ThrowTerminatingError($record)
  }
  Microsoft.PowerShell.Management\\New-Item @PSBoundParameters
}
Enter-SetupLock ${powerShellLiteral(target)}
if (-not $script:SetupLockAcquired) { throw 'lock was not acquired after the release race' }
Exit-SetupLock
if (Test-Path -LiteralPath ${powerShellLiteral(setupLockPath(target))}) { throw 'lock was not released' }
exit 0
`);
  t.equal(run.code, 0, `the vanished contention must retry successfully:\n${run.combined}`);
});

exclusiveTest('claude', 'Bash cleanup preserves a lock whose owner changed while setup was running', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.root, 'bash-owner-change-config');
  const gate = join(ws.root, 'release-holder');
  const atCli = join(ws.root, 'holder-at-cli');
  const runPromise = runShellInstaller({
    workspace: ws,
    configuration: claudeConfig(),
    baseUrl: modelServer.url,
    configDir,
    fakeCliGate: gate,
    fakeCliGateMarker: atCli,
  });
  await waitForFile(atCli, 'Bash to acquire the lock before owner replacement');
  const ownerPath = join(setupLockPath(configDir), 'owner');
  writeFileSync(ownerPath, 'replacement-owner');
  writeFileSync(gate, 'release');
  const run = await runPromise;
  t.equal(run.code, 0, `settings should still commit:\n${run.combined}`);
  t.includes(run.stderr, 'because its owner changed', 'Bash reports why cleanup retained the lock');
  t.equal(readFileSync(ownerPath, 'utf8'), 'replacement-owner', 'Bash does not remove another owner token');
});

exclusiveTest('claude', 'PowerShell cleanup preserves a lock whose owner changed while setup was running', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.root, 'powershell-owner-change-config');
  const gate = join(ws.root, 'release-holder');
  const atCli = join(ws.root, 'holder-at-cli');
  const runPromise = runPowerShellInstaller({
    workspace: ws,
    configuration: claudeConfig(),
    baseUrl: modelServer.url,
    configDir,
    fakeCliGate: gate,
    fakeCliGateMarker: atCli,
  });
  await waitForFile(atCli, 'PowerShell to acquire the lock before owner replacement');
  const ownerPath = join(setupLockPath(configDir), 'owner');
  writeFileSync(ownerPath, 'replacement-owner');
  writeFileSync(gate, 'release');
  const run = await runPromise;
  t.equal(run.code, 0, `settings should still commit:\n${run.combined}`);
  t.includes(run.stderr, 'because its owner changed', 'PowerShell reports why cleanup retained the lock');
  t.equal(readFileSync(ownerPath, 'utf8'), 'replacement-owner', 'PowerShell does not remove another owner token');
});

powerShellTest('claude', 'PowerShell: existing settings use File.Replace with a real null backup path', async t => {
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

powerShellTest('claude', 'PowerShell: invalid existing JSON fails without mutating the file', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const broken = '{ not valid json';
  writeFileSync(settingsPathFor(ws), broken);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.ok(run.code !== 0, 'invalid existing settings must fail the run');
  t.equal(readFileSync(settingsPathFor(ws), 'utf8'), broken, 'the invalid file is left untouched');
  t.equal(backupFiles(configDir).length, 0, 'no backup is created when validation fails before mutation');
});

powerShellTest('claude', 'PowerShell: present null env fails closed without mutation', async t => {
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

powerShellTest('claude', 'PowerShell stages secret data only after protection and hardens Windows replacement targets', async t => {
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

powerShellTest('claude', 'PowerShell Windows file protection writes only an owner DACL', t => {
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

powerShellTest('claude', 'PowerShell: missing CLI triggers the installer', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed after install:\n${run.combined}`);
  t.ok(existsSync(installerMarker(ws)), 'the installer runs when claude is absent');
  t.ok(existsSync(settingsPathFor(ws)), 'settings are written after installing');
});

powerShellTest('claude', 'PowerShell ignores a non-executable file at a CLI candidate path', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const candidateDir = join(ws.home, '.local', 'bin');
  mkdirSync(candidateDir, { recursive: true });
  writeFileSync(join(candidateDir, 'claude'), 'not an executable application');

  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });

  t.equal(run.code, 0, `the invalid candidate must not block installation:\n${run.combined}`);
  t.ok(existsSync(installerMarker(ws)), 'the installer runs after rejecting the invalid candidate');
});

powerShellTest('claude', 'PowerShell prefers npm over the direct installer when npm is available', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, autoInstallWithNpm: false });
  t.equal(run.code, 0, `npm installation should succeed:\n${run.combined}`);
  t.equal(readFileSync(join(ws.root, 'npm-record.txt'), 'utf8').trim(), 'install --global @anthropic-ai/claude-code', 'npm receives the official global package');
});

test('claude', 'local Bash installer accepts shell content and rejects HTML', async t => {
  const accepted = makeWorkspace();
  modelServer.mode = 'installer-sh';
  const success = await runBashRemoteInstaller(accepted, `${modelServer.url}/install.sh`);
  t.equal(success.code, 0, `a local shell installer should be accepted:\n${success.combined}`);
  t.ok(existsSync(installerMarker(accepted)), 'accepted installer executed');

  const rejected = makeWorkspace();
  modelServer.mode = 'installer-html';
  const failure = await runBashRemoteInstaller(rejected, `${modelServer.url}/install.sh`);
  t.ok(failure.code !== 0, 'HTML installer response must be rejected');
  t.ok(!existsSync(installerMarker(rejected)), 'HTML response never executes');
});

powerShellTest('claude', 'local PowerShell installer accepts script content and rejects HTML', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const accepted = makeWorkspace();
  modelServer.mode = 'installer-ps1';
  const success = await runPowerShellRemoteInstaller(accepted, `${modelServer.url}/install.ps1`);
  t.equal(success.code, 0, `a local PowerShell installer should be accepted:\n${success.combined}`);
  t.ok(existsSync(installerMarker(accepted)), 'accepted installer executed');

  const rejected = makeWorkspace();
  modelServer.mode = 'installer-html';
  const failure = await runPowerShellRemoteInstaller(rejected, `${modelServer.url}/install.ps1`);
  t.ok(failure.code !== 0, 'HTML installer response must be rejected');
  t.ok(!existsSync(installerMarker(rejected)), 'HTML response never executes');

  const disguised = makeWorkspace();
  modelServer.mode = 'installer-banner-html';
  const disguisedFailure = await runPowerShellRemoteInstaller(disguised, `${modelServer.url}/install.ps1`);
  t.ok(disguisedFailure.code !== 0, 'a banner before an HTML response must still be rejected');
  t.ok(!existsSync(installerMarker(disguised)), 'bannered HTML never executes');
});

powerShellTest('claude', 'PowerShell rejects an oversized installer before execution', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  modelServer.mode = 'installer-oversized-ps1';
  const run = await runPowerShellRemoteInstaller(ws, `${modelServer.url}/install.ps1`);

  t.ok(run.code !== 0, 'the byte limit must fail the setup');
  t.includes(run.combined, 'installer download exceeded the 8 MiB size limit', 'the failure names the size policy');
  t.ok(!existsSync(installerMarker(ws)), 'an oversized body never reaches an interpreter');
});

powerShellTest('claude', 'PowerShell rejects an unsupported installer charset with its encoding cause', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  modelServer.mode = 'installer-unsupported-charset';
  const catchBody = `$current = $_.Exception
  while ($null -ne $current) {
    [Console]::Error.WriteLine(('CHAIN:{0}:{1}' -f $current.GetType().FullName, $current.Message))
    $current = $current.InnerException
  }
  exit 1`;
  const run = await runPowerShellRemoteInstaller(ws, `${modelServer.url}/install.ps1`, '', catchBody);

  t.ok(run.code !== 0, 'an unsupported declared charset must fail the download');
  t.includes(run.stderr, 'invalid or unsupported charset (floway-unsupported)', 'the primary diagnostic names the rejected declaration');
  t.includes(run.stderr, 'CHAIN:System.Exception:setup-handled', 'the handled setup error remains the outer chain node');
  t.ok(
    run.stderr.includes('CHAIN:System.ArgumentException:') || run.stderr.includes('CHAIN:System.NotSupportedException:'),
    `the runtime charset failure remains chained:\n${run.stderr}`,
  );
  t.ok(!existsSync(installerMarker(ws)), 'an unsupported charset never reaches an interpreter');
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

exclusiveTest('claude', 'PowerShell downloaded installer is bounded', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  modelServer.mode = 'installer-ps1';
  const started = Date.now();
  const run = await runPowerShellProbe(ws, `$ErrorActionPreference = 'Stop'
${SETUP_POWERSHELL_COMMON}
try {
  $response = Get-SetupRemoteInstaller ${powerShellLiteral(`${modelServer.url}/install.ps1`)}
  Invoke-SetupPowerShellBody -Body $response.Body -TimeoutSeconds 3
  exit 0
} catch {
  exit 1
}
`, { FAKE_INSTALLER_SLEEP: '12' });
  t.ok(run.code !== 0, 'timed out installer must fail the agent');
  t.ok(Date.now() - started < 10_000, 'installer deadline must fire well before natural completion');
  t.ok(!existsSync(installerMarker(ws)), 'timed-out installer must not reach its marker');
  t.ok(existsSync(installerChildPid(ws)), 'PowerShell fixture must record a child PID');
  const childPid = Number(readFileSync(installerChildPid(ws), 'utf8').trim());
  t.ok(!processExists(childPid), `timed-out PowerShell installer child ${childPid} must be dead`);
});

exclusiveTest('claude', 'PowerShell bounds stdin delivery to an interpreter that never reads', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const interpreter = join(ws.binDir, 'non-reading-pwsh');
  writeFileSync(interpreter, `#!/bin/bash
printf '%s' "$$" > "$FAKE_INSTALLER_CHILD_PID_FILE"
sleep 12
`, { mode: 0o755 });
  const started = Date.now();
  const run = await runPowerShellProbe(ws, `$ErrorActionPreference = 'Stop'
${SETUP_POWERSHELL_COMMON}
try {
  Invoke-SetupInterpreterBody -Body ('x' * (4 * 1024 * 1024)) -TimeoutSeconds 4 -Exe ${powerShellLiteral(interpreter)} -Arguments ''
  exit 0
} catch {
  exit 1
}
`);

  t.ok(run.code !== 0, 'blocked stdin delivery must fail the setup');
  t.ok(Date.now() - started < 8_000, 'stdin delivery shares the interpreter deadline');
  t.includes(run.combined, 'installer timed out after 4 seconds', 'the failure identifies the shared deadline');
  t.ok(existsSync(installerChildPid(ws)), 'the non-reading interpreter records its PID');
  const childPid = Number(readFileSync(installerChildPid(ws), 'utf8'));
  t.ok(!processExists(childPid), `timed-out non-reading interpreter ${childPid} must be dead`);
});

powerShellTest('claude', 'PowerShell claude --version is bounded', async t => {
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

powerShellTest('claude', 'PowerShell removes an ambient exported API key before installer and CLI subprocesses', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, ambientApiKey: true,
  });
  t.equal(run.code, 0, `ambient key must be removed before child processes:\n${run.combined}`);
  t.ok(existsSync(installerMarker(ws)), 'fake installer ran and verified its environment');
});

powerShellTest('claude', 'PowerShell keeps the API key out of output and performs no gateway request', async t => {
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
// `export SETUP_ENDPOINT` / `$SetupEndpoint` injection and both clean-process
// boundaries are verified end to end rather than assumed.
const runCommandLine = (exe: string, args: string[], command: string, extraEnv: Record<string, string> = {}): Promise<RunResult> =>
  new Promise<RunResult>(resolve => {
    const child = spawn(exe, [...args, command], { env: { PATH: `${SHIM_BIN}:${process.env.PATH ?? ''}`, ...extraEnv } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}`, combined: `${stdout}${stderr}${String(error)}` }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: `${stdout}${stderr}` }));
  });

test('claude', 'the copyable Bash command isolates the downloaded installer from its caller', async t => {
  const ws = makeWorkspace();
  const bashEnv = join(ws.root, 'poison-bash-env.sh');
  writeFileSync(bashEnv, 'export FLOWAY_BASH_ENV_RAN=1\n');
  const origin = modelServer.url;
  const command = `export SETUP_ENDPOINT='${origin.replace(/'/g, "'\\''")}'; curl -fsSL "$SETUP_ENDPOINT/probe/setup.sh" | bash -p`;
  const run = await runCommandLine('/bin/bash', ['-c'], command, {
    BASH_ENV: bashEnv,
    'BASH_FUNC_floway_poison%%': '() { printf \'poisoned function ran\\n\' >&2; return 1; }',
  });
  t.equal(run.code, 0, `the copyable Bash command should run cleanly:\n${run.combined}`);
  t.includes(run.stdout, `PROBE_BASE_URL=[${origin}]`, 'the exported origin reached the piped bash executing the fetched body');
  t.includes(run.stdout, `PROBE_UNICODE=[${COMMAND_BOUNDARY_SECRET}]`, 'the downloaded body stayed intact over stdin');
});

const powerShellSetupCommand = (origin: string, path: string) => {
  const endpoint = powerShellLiteral(origin);
  const childEndpointAssignment = powerShellLiteral(`$SetupEndpoint = ${endpoint}`);
  const childExit = powerShellLiteral('exit $global:LASTEXITCODE');
  return `& { $SetupEndpoint = ${endpoint}; $PowerShell = $null; foreach ($Name in @('pwsh.exe', 'pwsh', 'powershell.exe')) { $Candidate = [System.IO.Path]::Combine($PSHOME, $Name); if ([System.IO.File]::Exists($Candidate)) { $PowerShell = $Candidate; break } }; if (-not $PowerShell) { throw 'Unable to locate a PowerShell application under $PSHOME.' }; $PreviousOutputEncoding = $OutputEncoding; try { $OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(${childEndpointAssignment}, (Microsoft.PowerShell.Utility\\Invoke-RestMethod -Uri ($SetupEndpoint + ${powerShellLiteral(path)})), ${childExit}) | & $PowerShell -NoProfile -NonInteractive -Command - } finally { $OutputEncoding = $PreviousOutputEncoding } }`;
};

powerShellTest('claude', 'the copyable PowerShell command isolates the downloaded installer from its caller', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const origin = modelServer.url;
  const command = [
    "function global:FlowayPoison { throw 'poisoned function ran' }",
    "function global:Invoke-RestMethod { throw 'poisoned fetch ran' }",
    "function global:pwsh { throw 'poisoned launcher ran' }",
    powerShellSetupCommand(origin, '/probe/setup.ps1'),
  ].join('; ');
  const run = await runCommandLine(hostPwsh, ['-NoProfile', '-Command'], command);
  t.equal(run.code, 0, `the copyable PowerShell command should run cleanly:\n${run.combined}`);
  t.includes(run.stdout, `PROBE_BASE_URL=[${origin}]`, 'the endpoint prelude reached the clean child process');
  t.includes(run.stdout, `PROBE_UNICODE=[${COMMAND_BOUNDARY_SECRET}]`, 'UTF-8 stdin preserved the downloaded body');
});

powerShellTest('claude', 'the copyable PowerShell command propagates the downloaded installer status', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const command = `${powerShellSetupCommand(modelServer.url, '/probe/setup-fail.ps1')}; exit $global:LASTEXITCODE`;
  const run = await runCommandLine(hostPwsh, ['-NoProfile', '-Command'], command);
  t.equal(run.code, 23, `the clean child status must reach the caller:\n${run.combined}`);
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

powerShellTest('claude', 'PowerShell: a missing $SetupEndpoint fails before any mutation', async t => {
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

powerShellTest('claude', 'PowerShell: a non-http(s) $SetupEndpoint fails before any mutation', async t => {
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
    fakeCodexAppServerMode: 'ok', fakeCodexBatchDelay: 0.25,
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
    fakeCodexAppServerMode: 'ok', fakeCodexBatchDelay: 8, expireAppServerDeadline: true,
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
    fakeCodexAppServerMode: 'no-initialize-response', expireAppServerDeadline: true,
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

test('codex', 'missing CLI installs through npm', async t => {
  if (globalCodexPresent()) skip('a system Codex is installed at a known location; cannot simulate an absent CLI');
  const ws = makeWorkspace();
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `codex setup should succeed after install:\n${run.combined}`);
  t.ok(existsSync(installerMarker(ws)), 'npm must run when codex is absent');
  t.ok(existsSync(join(ws.home, '.local/bin/codex')), 'the installer places codex in the user-local location');
  assertCodexBaseEdits(t, ws, modelServer.url);
});

test('codex', 'npm is preferred over the direct installer when npm is available', async t => {
  if (globalCodexPresent()) skip('a system Codex is installed at a known location; cannot simulate an absent CLI');
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, autoInstallCodexWithNpm: false });
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
  const firstConfig = readFileSync(codexConfigPath(ws), 'utf8');
  const second = await runShellInstaller({ workspace: ws, configuration: codexConfig({ reasoningEffort: 'high' }), baseUrl: modelServer.url });
  t.equal(second.code, 0, `second run should succeed:\n${second.combined}`);

  const configBackups = codexBackupFiles(home, 'config.toml');
  t.equal(configBackups.length, 1, 'only the latest config.toml backup is retained');
  t.equal(readFileSync(join(home, configBackups[0]!), 'utf8'), firstConfig, 'the retained config backup is the materialized first write');
  t.equal(codexBackupFiles(home, 'floway-token').length, 0, 'provider-token backups are removed after each successful commit');
  t.equal(readFileSync(codexAuthPath(ws), 'utf8'), priorAuth, 'official account auth remains byte-for-byte unchanged');
  t.equal(readdirSync(home).filter(name => name.startsWith('auth.json.floway-backup.')).length, 0, 'account auth is not backed up because it is not managed');
});

exclusiveTest('codex', 'Bash and PowerShell serialize config and token as one cross-language transaction', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const holderWs = makeWorkspace();
  const successorWs = makeWorkspace();
  placeFakeCodex(holderWs.binDir);
  placeFakeCodex(successorWs.binDir);
  const codexHome = join(holderWs.root, 'shared-codex-home');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(codexConfigPath(holderWs, codexHome), 'model_provider = "original"\n');
  writeFileSync(codexTokenPath(holderWs, codexHome), 'key-original');
  const holderGate = join(holderWs.root, 'release-holder');
  const holderAtCli = join(holderWs.root, 'holder-at-cli');
  const successorWaiting = join(successorWs.root, 'successor-waiting');
  const successorGate = join(successorWs.root, 'release-successor');
  const successorAtCli = join(successorWs.root, 'successor-at-cli');

  const holderRun = runShellInstaller({
    workspace: holderWs,
    runId: 'bash-holder',
    apiKey: 'key-holder',
    configuration: codexConfig({ model: 'model-holder' }),
    baseUrl: 'https://holder.example',
    codexHome,
    fakeCliGate: holderGate,
    fakeCliGateMarker: holderAtCli,
  });
  await waitForFile(holderAtCli, 'the Bash Codex holder to reach the CLI');
  const successorRun = runPowerShellInstaller({
    workspace: successorWs,
    runId: 'powershell-successor',
    apiKey: 'key-successor',
    configuration: codexConfig({ model: 'model-successor' }),
    baseUrl: 'https://successor.example',
    codexHome,
    lockWaitMarker: successorWaiting,
    fakeCliGate: successorGate,
    fakeCliGateMarker: successorAtCli,
  });
  try {
    await waitForFile(successorWaiting, 'PowerShell to contend on the Bash lock');
  } catch (error) {
    writeFileSync(holderGate, 'release');
    writeFileSync(successorGate, 'release');
    await Promise.all([holderRun, successorRun]);
    throw error;
  }
  writeFileSync(holderGate, 'release');
  const holder = await holderRun;
  t.equal(holder.code, 0, `the Bash holder should succeed:\n${holder.combined}`);
  try {
    await waitForFile(successorAtCli, 'PowerShell to acquire the released lock');
  } catch (error) {
    writeFileSync(successorGate, 'release');
    const successor = await successorRun;
    throw new Error(`${String(error)}
PowerShell successor exited ${successor.code}:
${successor.combined}`);
  }
  const holderConfig = readFileSync(codexConfigPath(holderWs, codexHome), 'utf8');
  t.equal(readCodexToken(holderWs, codexHome), 'key-holder', 'the holder config and token commit together');
  writeFileSync(successorGate, 'release');
  const successor = await successorRun;
  t.equal(successor.code, 0, `the PowerShell successor should succeed:\n${successor.combined}`);

  const finalConfig = readMaterializedCodexConfig(holderWs, codexHome);
  t.equal(finalConfig.model, 'model-successor', 'the final config belongs to the serialized successor');
  t.equal(finalConfig['model_providers.floway.base_url'], 'https://successor.example/azure-api.codex', 'the final endpoint belongs to the same successor');
  t.equal(readCodexToken(holderWs, codexHome), 'key-successor', 'the final token belongs to the same successor');
  const configBackups = codexBackupFiles(codexHome, 'config.toml');
  t.equal(configBackups.length, 1, 'cross-language serialization retains one config backup');
  t.equal(readFileSync(join(codexHome, configBackups[0]!), 'utf8'), holderConfig, 'the retained backup is the complete holder config');
  t.equal(codexBackupFiles(codexHome, 'floway-token').length, 0, 'committed token backups are removed');
  t.equal(stagedFiles(codexHome).length, 0, 'neither runtime leaves a stage');
  t.ok(!existsSync(setupLockPath(codexHome)), 'the shared lock is released');
  t.excludes(holder.combined + successor.combined, 'key-holder', 'the holder key is not logged');
  t.excludes(holder.combined + successor.combined, 'key-successor', 'the successor key is not logged');
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

test('codex', 'Bash reports every expected rollback backup that disappears after mutation', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  const priorConfig = 'model_provider = "old"\n';
  writeFileSync(codexConfigPath(ws), priorConfig);
  writeFileSync(codexTokenPath(ws), 'old-provider-token');
  const run = await runShellInstaller({
    workspace: ws,
    configuration: codexConfig({ model: 'materialized-before-error' }),
    baseUrl: modelServer.url,
    fakeCodexAppServerMode: 'missing-backups-error',
  });
  t.ok(run.code !== 0, 'the app-server error must fail setup');
  t.includes(run.stderr, 'expected file backup is missing', 'the missing config backup is reported');
  t.includes(run.stderr, 'expected provider token backup is missing', 'the missing token backup is reported');
  t.equal(readMaterializedCodexConfig(ws).model, 'materialized-before-error', 'the fake actually mutated config before removing recovery data');
  t.equal(readCodexToken(ws), SENTINEL_KEY, 'the missing token backup leaves the staged token observable');
});

test('codex', 'configuration failure with no prior files removes the created provider token', async t => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'error' });
  t.ok(run.code !== 0, 'an app-server configuration error must fail setup');
  t.ok(!existsSync(codexConfigPath(ws)), 'the config materialized before the error is removed on rollback');
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
    autoInstallCodexWithNpm: false, bashCodexInstallerUrl: `${modelServer.url}/install-codex.sh`,
  });
  t.equal(success.code, 0, `a local codex shell installer should be accepted:\n${success.combined}`);
  t.ok(existsSync(installerMarker(accepted)), 'accepted codex installer executed');

  const rejected = makeWorkspace();
  modelServer.mode = 'installer-html';
  const failure = await runShellInstaller({
    workspace: rejected, configuration: codexConfig(), baseUrl: modelServer.url,
    autoInstallCodexWithNpm: false, bashCodexInstallerUrl: `${modelServer.url}/install-codex.sh`,
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

powerShellTest('codex', 'PowerShell: existing CLI configures via the app-server and stages the provider token', async t => {
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

powerShellTest('codex', 'PowerShell: successful setup removes the provider-token backup', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  const priorConfig = 'model_provider = "old"\n';
  writeFileSync(codexConfigPath(ws), priorConfig);
  writeFileSync(codexTokenPath(ws), 'old-provider-token');

  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `codex setup should succeed:\n${run.combined}`);
  const configBackups = codexBackupFiles(home, 'config.toml');
  t.equal(configBackups.length, 1, 'the latest config backup remains available');
  t.equal(readFileSync(join(home, configBackups[0]!), 'utf8'), priorConfig, 'the backup contains the config replaced by the fake app-server');
  t.equal(codexBackupFiles(home, 'floway-token').length, 0, 'the provider-token rollback copy is removed after commit');
});

powerShellTest('codex', 'PowerShell: provider token is UTF-8 without a BOM under a non-default culture', async t => {
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

powerShellTest('codex', 'PowerShell: the batch clears model and effort when unset', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  const edits = codexEditMap(ws);
  t.equal(edits.get('model'), null, 'unset model clears via JSON null');
  t.equal(edits.get('model_reasoning_effort'), null, 'unset effort clears via JSON null');
});

powerShellTest('codex', 'PowerShell: okOverridden counts as success and reports non-secret metadata only', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'okOverridden' });
  t.equal(run.code, 0, `okOverridden must be treated as configured:\n${run.combined}`);
  t.includes(run.combined, 'Overridden by session flags', 'the override message is surfaced');
  t.excludes(run.combined, 'shadow-model', 'the overridden effective value is not echoed');
});

powerShellTest('codex', 'PowerShell: Windows provider-token replacement and rollback preserve owner-only ACL ordering', async t => {
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

powerShellTest('codex', 'PowerShell: existing provider token uses File.Replace with a real null backup path', async t => {
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

powerShellTest('codex', 'PowerShell: a batchWrite error fails codex and rolls back the provider token', async t => {
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

powerShellTest('codex', 'PowerShell: a provider-token backup protection failure removes the unsafe backup and leaves the original intact', async t => {
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

powerShellTest('codex', 'PowerShell: a malformed response fails codex', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'malformed' });
  t.ok(run.code !== 0, 'a malformed response must fail codex');
  t.ok(!existsSync(codexTokenPath(ws)), 'the staged provider token is rolled back on a malformed response');
});

powerShellTest('codex', 'PowerShell: a premature app-server exit fails codex', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'premature-eof' });
  t.ok(run.code !== 0, 'a premature EOF must fail codex');
  t.ok(!existsSync(codexTokenPath(ws)), 'the staged provider token is rolled back on premature EOF');
});

powerShellTest('codex', 'PowerShell: a batch response past the deadline times out and rolls back', async t => {
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

powerShellTest('codex', 'PowerShell: honors an explicit CODEX_HOME', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const codexHome = join(ws.root, 'custom-codex-home');
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, codexHome });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.ok(existsSync(codexTokenPath(ws, codexHome)), 'provider token lands under CODEX_HOME');
  t.ok(!existsSync(codexTokenPath(ws)), 'the default ~/.codex is not used when overridden');
});

powerShellTest('codex', 'PowerShell: the API key never appears in output and never reaches the app-server', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig({ model: 'gpt-5-codex' }), baseUrl: modelServer.url });
  t.equal(run.code, 0, `should succeed:\n${run.combined}`);
  t.excludes(run.combined, SENTINEL_KEY, 'the API key must never be printed');
  t.excludes(run.combined, 'received the API key', 'the app-server must never observe the key in a request');
  t.equal(readCodexToken(ws), SENTINEL_KEY, 'the key was actually staged into floway-token');
});

powerShellTest('codex', 'PowerShell: the documented remote installer uses a process-scoped execution-policy override', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  modelServer.mode = 'installer-codex-ps1';
  const commandLinePath = join(ws.root, 'installer-command-line.txt');
  const run = await runPowerShellRemoteInstaller(
    ws,
    `${modelServer.url}/install-codex.ps1`,
    '-BypassExecutionPolicy',
    'exit 1',
    {
      CODEX_NON_INTERACTIVE: 'true',
      FAKE_INSTALLER_OBSERVED_COMMAND_LINE: commandLinePath,
    },
  );
  t.equal(run.code, 0, `the Codex installer should execute:\n${run.combined}`);
  t.ok(existsSync(installerMarker(ws)), 'the installer executes in the clean interpreter');
  const installerCommandLine = readFileSync(commandLinePath, 'utf8');
  t.includes(installerCommandLine, '-ExecutionPolicy Bypass', 'the subprocess matches the documented process-scoped execution-policy override');
});

powerShellTest('codex', 'PowerShell: CODEX_NON_INTERACTIVE is scoped to installer invocation and removed afterward', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  t.equal(run.code, 0, `missing CLI should install without leaking CODEX_NON_INTERACTIVE to codex:\n${run.combined}`);
  t.equal(readFileSync(join(ws.root, 'installer-non-interactive.txt'), 'utf8'), 'true', 'the installer itself receives CODEX_NON_INTERACTIVE=true');
  t.excludes(run.combined, 'unexpected CODEX_NON_INTERACTIVE', 'app-server and version subprocesses see no new ambient value');
});

powerShellTest('codex', 'PowerShell: a pre-existing CODEX_NON_INTERACTIVE value is restored after installation', async t => {
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

powerShellTest('codex', 'PowerShell: a Codex script never configures Claude when Codex fails', async t => {
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

exclusiveTest('codex', 'end-to-end against the real pinned Codex 0.144.5 app-server writes config.toml', async t => {
  if (!hostCodex) skip('real Codex 0.144.5 is not installed on this host');
  const ws = makeWorkspace();
  symlinkSync(hostCodex, join(ws.binDir, 'codex'));
  const codexHome = join(ws.root, 'real-codex-home');
  const run = await runShellInstaller({
    workspace: ws, baseUrl: modelServer.url,
    configuration: codexConfig({ model: 'gpt-5-codex', reasoningEffort: 'high' }),
    codexHome, autoInstallCodexWithNpm: false,
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

powerShellTest('claude', 'Bash and PowerShell emit an identical happy-path stdout line sequence', async t => {
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

powerShellTest('claude', 'a fully successful run keeps stderr empty and emits no escape codes when captured', async t => {
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
  const colored = await runBashOutputProbe(ws);
  t.equal(colored.code, 0, `output probe should succeed:\n${colored.combined}`);
  t.includes(colored.stdout, '[34m==>[0m [1mAgent Setup: Claude Code[0m', 'the setup title uses the notice style');
  t.includes(colored.stdout, 'Endpoint: ', 'the Endpoint metadata remains visible');
  t.includes(colored.stdout, 'API Key: Primary key', 'the API Key metadata remains visible');
  t.excludes(colored.stdout, '[1mEndpoint:', 'the Endpoint label is not styled');
  t.excludes(colored.stdout, '[1mAPI Key:', 'the API Key label is not styled');
  t.includes(colored.stdout, '[34m==>[0m [1mInstalling: Claude Code[0m', 'the installation section uses the notice style');
  t.includes(colored.stdout, '[34m==>[0m [1mConfiguring: Claude Code[0m', 'the configuration section uses the notice style');
  t.includes(colored.stdout, '[34m==>[0m [1mCompleted Agent Setup: Claude Code[0m', 'the successful result uses the notice style');
  t.includes(colored.stderr, '[93mWarning:[0m warning detail', 'warning labels use the warning palette');
  t.includes(colored.stderr, '[91mError:[0m error detail', 'error labels use the error palette');
  t.excludes(colored.stdout, '[92m', 'success does not use green ANSI styling');

  const suppressed = makeWorkspace();
  const noColor = await runBashOutputProbe(suppressed, true);
  t.equal(noColor.code, 0, `NO_COLOR probe should succeed:\n${noColor.combined}`);
  t.ok(!hasVTControlCharacters(noColor.combined), 'NO_COLOR suppresses color on both streams');
  t.includes(noColor.stdout, 'Claude Code', 'the plain heading is still present without color');
});

test('claude', 'Bash routes configuration errors to stderr', async t => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), '{ invalid json');
  const run = await runShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: claudeConfig(),
  });
  t.ok(run.code !== 0, 'invalid settings must fail the agent');
  t.includes(run.stderr, 'Error: ', 'the error is labeled on stderr');
  t.includes(run.stderr, 'is not valid Claude settings; leaving it untouched.', 'the error retains its diagnostic body');
  t.excludes(run.stdout, 'is not valid Claude settings', 'the error does not leak onto stdout');
});

powerShellTest('claude', 'PowerShell uses console color only for interactive diagnostics and honors NO_COLOR', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  t.includes(SETUP_POWERSHELL_COMMON, '[Console]::ForegroundColor = $Color', 'interactive diagnostics select the requested console color');
  t.includes(SETUP_POWERSHELL_COMMON, '$script:SetupErrColor = (-not [Console]::IsErrorRedirected)', 'color is gated by the real stderr terminal state');
  t.excludes(SETUP_POWERSHELL_COMMON, 'SetupForceColor', 'the served script exposes no forced-color branch');

  const suppressed = makeWorkspace();
  placeFakeClaude(suppressed.binDir);
  mkdirSync(join(suppressed.home, '.claude'), { recursive: true });
  writeFileSync(settingsPathFor(suppressed), '{ invalid json');
  const noColor = await runPowerShellInstaller({
    workspace: suppressed, baseUrl: modelServer.url, configuration: claudeConfig(),
    noColor: true,
  });
  t.ok(noColor.code !== 0, 'the failure still occurs');
  t.ok(!hasVTControlCharacters(noColor.combined), 'NO_COLOR wins over forced color on stderr too');
  t.includes(noColor.stderr, 'Error: ', 'the plain error is still on stderr');
});

powerShellTest('claude', 'a multiple-installation warning is a stderr line on both installers', async t => {
  const bashWs = makeWorkspace();
  placeFakeClaude(bashWs.binDir);
  placeFakeClaude(join(bashWs.home, '.local/bin'));
  const bash = await runShellInstaller({ workspace: bashWs, baseUrl: modelServer.url, configuration: claudeConfig() });
  t.equal(bash.code, 0, `should succeed:\n${bash.combined}`);
  t.includes(bash.stderr, 'Warning: multiple Claude Code installations detected;', 'Bash emits the warning on stderr');
  t.excludes(bash.stdout, 'multiple Claude Code installations detected', 'the warning is not on stdout');

  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  modelServer.reset();
  const psWs = makeWorkspace();
  placeFakeClaude(psWs.binDir);
  placeFakeClaude(join(psWs.home, '.local/bin'));
  const ps = await runPowerShellInstaller({ workspace: psWs, baseUrl: modelServer.url, configuration: claudeConfig() });
  t.equal(ps.code, 0, `should succeed:\n${ps.combined}`);
  t.includes(ps.stderr, 'Warning: multiple Claude Code installations detected;', 'PowerShell emits the warning on stderr');
  t.excludes(ps.stdout, 'multiple Claude Code installations detected', 'the warning is not on stdout');
});

powerShellTest('claude', 'PowerShell surfaces one primary error without a double wrapper', async t => {
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

powerShellTest('codex', 'PowerShell rollback restore failure preserves the Codex provider-token backup', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  writeFileSync(codexTokenPath(ws), 'old-provider-token');
  const run = await runPowerShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: codexConfig(),
    fakeCodexAppServerMode: 'error', failPowerShellRestore: true,
  });
  t.ok(run.code !== 0, 'an app-server configuration error must fail setup');
  t.includes(run.stderr, 'Warning: could not restore', 'a rollback-failure warning is printed to stderr');
  t.includes(run.stderr, 'provider token', 'the warning names the preserved provider token');
  t.includes(run.stderr, 'restore it by hand', 'the warning names the manual action');
  const backups = codexBackupFiles(home, 'floway-token');
  t.equal(backups.length, 1, 'the provider-token backup is preserved for manual recovery');
});

powerShellTest('codex', 'PowerShell reports every expected rollback backup that disappears after mutation', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  writeFileSync(codexConfigPath(ws), 'model_provider = "old"\n');
  writeFileSync(codexTokenPath(ws), 'old-provider-token');
  const run = await runPowerShellInstaller({
    workspace: ws,
    configuration: codexConfig({ model: 'materialized-before-error' }),
    baseUrl: modelServer.url,
    fakeCodexAppServerMode: 'missing-backups-error',
  });
  t.ok(run.code !== 0, 'the app-server error must fail setup');
  t.includes(run.stderr, 'expected file backup is missing', 'the missing config backup is reported');
  t.includes(run.stderr, 'expected provider token backup is missing', 'the missing token backup is reported');
  t.equal(readMaterializedCodexConfig(ws).model, 'materialized-before-error', 'the fake actually mutated config before removing recovery data');
  t.equal(readCodexToken(ws), SENTINEL_KEY, 'the missing token backup leaves the staged token observable');
});

// --- run --------------------------------------------------------------------

const parseAgentFilter = (): ScriptAgent | 'all' => {
  const index = process.argv.indexOf('--agent');
  if (index === -1) return 'all';
  const value = process.argv[index + 1];
  if (value === 'claude' || value === 'codex') return value;
  throw new Error(`--agent must be "claude" or "codex", got ${JSON.stringify(value)}`);
};

const parseNameFilter = (): string | null => {
  const index = process.argv.indexOf('--match');
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value) return value;
  throw new Error('--match requires a non-empty test-name substring');
};

const profilingEnabled = (): boolean => process.argv.includes('--profile');
const elapsedMilliseconds = (startedAt: bigint): number => Number(process.hrtime.bigint() - startedAt) / 1_000_000;
const profileSuffix = (milliseconds: number): string => ` (${milliseconds.toFixed(1)} ms)`;
const parseWorkerCount = (): number => {
  const index = process.argv.indexOf('--workers');
  if (index === -1) return 3;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    throw new Error(`--workers must be an integer from 1 through 4, got ${JSON.stringify(process.argv[index + 1])}`);
  }
  return value;
};

interface SelectedCase {
  index: number;
  testCase: Case;
}
interface CaseResult {
  index: number;
  label: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  milliseconds: number;
  detail?: string;
}

const runInstallerCase = async (host: ModelServerHost, selected: SelectedCase): Promise<CaseResult> => {
  const { index, testCase } = selected;
  const fixture = host.createFixture(index);
  const label = `[${testCase.agent}] ${testCase.name}`;
  const startedAt = process.hrtime.bigint();
  try {
    return await modelServerStorage.run(fixture, async () => {
      fixture.reset();
      const assert = makeAssert();
      try {
        await testCase.fn(assert);
        return { index, label, status: 'PASS', milliseconds: elapsedMilliseconds(startedAt) };
      } catch (error) {
        if (error instanceof SkipError) {
          return { index, label, status: 'SKIP', milliseconds: elapsedMilliseconds(startedAt), detail: error.message };
        }
        return {
          index,
          label,
          status: 'FAIL',
          milliseconds: elapsedMilliseconds(startedAt),
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    });
  } finally {
    fixture.dispose();
  }
};

const runConcurrentBatch = async (
  host: ModelServerHost,
  batch: readonly SelectedCase[],
  workerCount: number,
  results: Map<number, CaseResult>,
): Promise<void> => {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < batch.length) {
      const selected = batch[cursor++];
      if (selected === undefined) return;
      results.set(selected.index, await runInstallerCase(host, selected));
    }
  };
  await Promise.all(Array.from({ length: Math.min(workerCount, batch.length) }, worker));
};

const runParallelPhase = async (
  host: ModelServerHost,
  phase: readonly SelectedCase[],
  workerCount: number,
  results: Map<number, CaseResult>,
): Promise<void> => {
  if (workerCount === 1) {
    await runConcurrentBatch(host, phase, 1, results);
    return;
  }
  const powerShellCases = phase.filter(({ testCase }) => testCase.lane === 'powershell');
  const generalCases = phase.filter(({ testCase }) => testCase.lane === 'general');
  if (powerShellCases.length === 0) {
    await runConcurrentBatch(host, generalCases, workerCount, results);
    return;
  }
  if (generalCases.length === 0) {
    await runConcurrentBatch(host, powerShellCases, 1, results);
    return;
  }
  await Promise.all([
    runConcurrentBatch(host, generalCases, workerCount - 1, results),
    runConcurrentBatch(host, powerShellCases, 1, results),
  ]);
};

const runSelectedCases = async (
  host: ModelServerHost,
  selectedCases: readonly SelectedCase[],
  workerCount: number,
): Promise<CaseResult[]> => {
  const results = new Map<number, CaseResult>();
  let parallelPhase: SelectedCase[] = [];
  for (const selected of selectedCases) {
    if (selected.testCase.lane !== 'exclusive') {
      parallelPhase.push(selected);
      continue;
    }
    await runParallelPhase(host, parallelPhase, workerCount, results);
    parallelPhase = [];
    results.set(selected.index, await runInstallerCase(host, selected));
  }
  await runParallelPhase(host, parallelPhase, workerCount, results);
  return selectedCases.map(({ index }) => {
    const result = results.get(index);
    if (result === undefined) throw new Error(`installer case ${index} did not produce a result`);
    return result;
  });
};

const main = async (): Promise<void> => {
  const filter = parseAgentFilter();
  const nameFilter = parseNameFilter();
  const profile = profilingEnabled();
  const workerCount = parseWorkerCount();
  const host = await startModelServer();
  const selectedCases = cases
    .map((testCase, index) => ({ index, testCase }))
    .filter(({ testCase }) => (filter === 'all' || testCase.agent === filter)
      && (nameFilter === null || testCase.name.includes(nameFilter)));
  let results: CaseResult[] = [];
  try {
    results = await runSelectedCases(host, selectedCases, workerCount);
  } finally {
    await host.close();
    for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
  }

  for (const result of results) {
    const suffix = profile ? profileSuffix(result.milliseconds) : '';
    if (result.status === 'SKIP') console.log(`  SKIP ${result.label} — ${result.detail}${suffix}`);
    else console.log(`  ${result.status} ${result.label}${suffix}`);
  }
  const passed = results.filter(({ status }) => status === 'PASS').length;
  const failed = results.filter(({ status }) => status === 'FAIL').length;
  const skipped = results.filter(({ status }) => status === 'SKIP').length;
  console.log(`\nagent-setup installers: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (profile) {
    console.log(`installer scheduling: ${workerCount} workers, one PowerShell slot, ${selectedCases.filter(({ testCase }) => testCase.lane === 'exclusive').length} exclusive cases`);
    console.log('\nslowest installer cases:');
    for (const result of results.toSorted((left, right) => right.milliseconds - left.milliseconds).slice(0, 20)) {
      console.log(`  ${profileSuffix(result.milliseconds).trim()} ${result.label}`);
    }
  }
  if (failed > 0) {
    console.error('\nFailures:');
    for (const result of results) {
      if (result.status === 'FAIL') console.error(`\n${result.label}\n${result.detail}`);
    }
    process.exit(1);
  }
};

await main();
