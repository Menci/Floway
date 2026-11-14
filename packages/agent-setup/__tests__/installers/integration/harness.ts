// Provides isolated configuration roots and runners for the served installers.
// Native compatibility cases run when their corresponding tools are available.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach } from 'vitest';

import type { AgentSetupConfiguration } from '../../../src/configuration.ts';
import { type RenderPrefixInput, renderPowerShellPrefix, renderShellPrefix } from '../../../src/render.ts';
import {
  SETUP_NODE_OMP_EXTENSION,
  SETUP_NODE_PI_EXTENSION,
  SETUP_BASH_CLAUDE,
  SETUP_BASH_CODEX,
  SETUP_BASH_COMMON,
  SETUP_BASH_PI,
  SETUP_POWERSHELL_CLAUDE,
  SETUP_POWERSHELL_CODEX,
  SETUP_POWERSHELL_COMMON,
  SETUP_POWERSHELL_PI,
  SETUP_BASH_OMP,
  SETUP_POWERSHELL_OMP,
} from '../../../src/script-assets.generated.ts';
import { type ScriptAgent, SETUP_SCRIPT_BODIES } from '../../../src/script-assets.ts';

const prefixInput = (agent: ScriptAgent, configuration: AgentSetupConfiguration): RenderPrefixInput => {
  const base = { apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration };
  return agent === 'pi' || agent === 'omp' ? { ...base, agent, extensionPath: agent === 'pi' ? '/api/setup/test-lease-token/pi.js' : '/omp.js' } : { ...base, agent };
};
export const shellLiteral = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export const powerShellLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const AGENT_NAMES: Record<ScriptAgent, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi', omp: 'oh-my-pi' };
export const shellEntry = (agent: ScriptAgent): string => `main '${AGENT_NAMES[agent]}' "$@"`;
export const powerShellEntry = (agent: ScriptAgent): string => `$global:LASTEXITCODE = Main '${AGENT_NAMES[agent]}'`;
export const shellBody = (agent: ScriptAgent): string => SETUP_SCRIPT_BODIES[agent].sh;
export const powerShellBody = (agent: ScriptAgent): string => SETUP_SCRIPT_BODIES[agent].ps1;
export const ALL_BASH_FRAGMENTS = SETUP_BASH_COMMON + SETUP_BASH_CLAUDE + SETUP_BASH_CODEX + SETUP_BASH_PI + SETUP_BASH_OMP;
export const ALL_POWERSHELL_FRAGMENTS = SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_CLAUDE + SETUP_POWERSHELL_CODEX + SETUP_POWERSHELL_PI + SETUP_POWERSHELL_OMP;

// A fixed, highly greppable fake credential. Dedicated secrecy tests assert
// that it never reaches installer output.
export const SENTINEL_KEY = 'sk-floway-SENTINEL-Do-Not-Log-9f3c1a7b2e4d6058';

// --- shared fixtures --------------------------------------------------------

export const HARNESS_ROOT = mkdtempSync(join(tmpdir(), 'floway-installer-harness.'));
const cleanupPaths: string[] = [HARNESS_ROOT];
export let modelServer: ModelServer;
let modelServerStarted = false;
export const piFixture: { models: Record<string, unknown>[]; catalogs: Record<string, unknown>[][]; status: number } = {
  models: [],
  catalogs: [],
  status: 200,
};
afterAll(async () => {
  if (modelServerStarted) await modelServer.close();
  for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
});

beforeAll(async () => {
  modelServer = await startModelServer();
  modelServerStarted = true;
});

beforeEach(() => modelServer.reset());

const hostJqPath = spawnSync('/bin/sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim() || null;
const HOST_JQ_BIN = join(HARNESS_ROOT, 'host-jq-bin');
mkdirSync(HOST_JQ_BIN);
if (hostJqPath) symlinkSync(hostJqPath, join(HOST_JQ_BIN, 'jq'));

// A hermetic tool directory: symlinks to exactly the external commands the
// installer uses — deliberately excluding jq, whose presence each test controls
// through PATH. Building this rather than leaning on `/usr/bin` matters because
// some hosts ship a `/usr/bin/jq`, which would otherwise defeat the
// jq-absent cases.
export const SHIM_BIN = join(HARNESS_ROOT, 'shim-bin');
mkdirSync(SHIM_BIN);
export const resolveTool = (name: string): string | null => {
  const found = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
  return found || null;
};
for (const tool of ['sh', 'bash', 'env', 'awk', 'tr', 'cat', 'chmod', 'cmp', 'cp', 'date', 'mkdir', 'mkfifo', 'mktemp', 'mv', 'ln', 'readlink', 'rm', 'shasum', 'sleep', 'uname', 'curl']) {
  const path = resolveTool(tool);
  if (!path) throw new Error(`required tool ${tool} is not available on the host; cannot run the installer harness`);
  symlinkSync(path, join(SHIM_BIN, tool));
}
for (const tool of ['sha256sum', 'openssl', 'timeout', 'gtimeout', 'node', 'bun', 'dirname', 'sed']) {
  const path = resolveTool(tool);
  if (path) symlinkSync(path, join(SHIM_BIN, tool));
}

// When a PowerShell interpreter is installed, its cases parse and execute the
// same body the gateway serves.
export const hostPwsh = resolveTool('pwsh') ?? resolveTool('powershell');
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

export const FAKE_OMP = `#!/bin/bash
if [ "\${SETUP_API_KEY+x}" = x ] || [ "\${SetupApiKey+x}" = x ]; then
  printf 'fake omp inherited the setup API key environment variable\\n' >&2
  exit 91
fi
case "$1" in
  --version)
    if [ "\${FAKE_OMP_VERSION_SLEEP:-0}" -gt 0 ]; then sleep "$FAKE_OMP_VERSION_SLEEP"; fi
    if [ -f "$FAKE_OMP_UPDATE_MARKER" ]; then
      printf '%s\\n' "\${FAKE_OMP_UPDATED_VERSION:-omp/18.8.4}"
    else
      printf '%s\\n' "\${FAKE_OMP_VERSION:-omp/18.8.4}"
    fi
    ;;
  update)
    [ "$#" -eq 1 ] || { printf "fake omp: unsupported update argument: %s\\n" "$2" >&2; exit 64; }
    resolved=$(command -v omp) || { printf 'Could not resolve omp binary path in PATH\\n' >&2; exit 73; }
    [ "$resolved" = "$0" ] || { printf 'updater resolved a different omp installation\\n' >&2; exit 73; }
    printf '%s\\n' "$resolved" > "$FAKE_OMP_UPDATE_MARKER.resolved"
    case "\${FAKE_OMP_UPDATE_MODE:-ok}" in
      fail) exit 73 ;;
      sleep) sleep 10 ;;
      noop) exit 0 ;;
    esac
    : > "$FAKE_OMP_UPDATE_MARKER"
    ;;
  --mode | models)
    if [ "\${FAKE_OMP_PROBE_FAILURE:-0}" = "1" ]; then
      printf 'test native path probe failure\\n' >&2
      exit 73
    fi
    if [ "$1" = "--mode" ]; then
      probe="\${11}"
    else
      [ "$#" -eq 4 ] && [ "$2" = "--no-extensions" ] && [ "$3" = "-e" ] \
        || { printf 'fake omp: malformed path probe args: %s\\n' "$*" >&2; exit 64; }
      probe=$4
    fi
    [ -s "$probe" ] || { printf 'fake omp: missing path probe file: %s\\n' "$probe" >&2; exit 66; }
    [ -n "\${FLOWAY_SETUP_PATHS_FILE:-}" ] || { printf 'fake omp: missing FLOWAY_SETUP_PATHS_FILE\\n' >&2; exit 65; }
    printf '%s\\n' "$*" >> "$FAKE_OMP_PROBE_RECORD"
    agent_dir="\${FAKE_OMP_AGENT_DIR:-$HOME/.omp/agent}"
    plugins_dir="\${FAKE_OMP_PLUGINS_PATH:-$HOME/.omp/plugins}"
    "$FAKE_OMP_PATHS_SCRIPT" "$agent_dir" "$plugins_dir" "$FLOWAY_SETUP_PATHS_FILE" "$probe" "$1"
    ;;
  plugin)
    [ "$2" = "link" ] && [ -n "$3" ] || { printf 'fake omp: malformed plugin args: %s\\n' "$*" >&2; exit 64; }
    printf '%s\\n' "$*" >> "$FAKE_OMP_PLUGIN_RECORD"
    "$FAKE_OMP_PLUGIN_LINK_SCRIPT" "$3" || exit $?
    if [ "\${FAKE_OMP_LINK_FAILURE:-}" = "unlink" ]; then
      printf 'fake omp plugin link removed the native link and injected a failure\\n' >&2
      exit 73
    elif [ "\${FAKE_OMP_LINK_FAILURE:-}" = "after" ]; then
      printf 'fake omp plugin link completed and injected a failure\\n' >&2
      exit 73
    fi
    ;;
  *)
    printf 'fake omp: unhandled args: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`;

const FAKE_OMP_PATHS_SCRIPT = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const [agentDir, pluginsDir, , probePath, command] = process.argv.slice(2);
const probeSource = fs.readFileSync(probePath, 'utf8');
const source = probeSource.replace(/^import .*;$/gm, '').replace('export default', 'return');
const paths = { agentDir, pluginsDir };
const writePaths = (file, contents) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  if (process.env.FAKE_OMP_PATHS_RECORD) fs.appendFileSync(process.env.FAKE_OMP_PATHS_RECORD, JSON.stringify(paths) + '\\n');
};
const factory = new Function('getAgentDir', 'getPluginsDir', 'writeFileSync', source)(() => agentDir, () => pluginsDir, writePaths);
const exit = process.exit;
process.exit = () => { throw new Error('extension factories cannot exit the host'); };
try { factory({ on() {} }); } finally { process.exit = exit; }
if (command === '--mode') {
  console.error('No default model selected.');
  process.exit(1);
}
`;

const FAKE_OMP_PLUGIN_LINK_SCRIPT = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = '@floway-dev/omp';
const sourceDir = path.resolve(process.argv[2]);
const pluginsDir = process.env.FAKE_OMP_PLUGINS_PATH || path.join(process.env.HOME || '', '.omp', 'plugins');
const packageManifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
if (packageManifest.name !== name) throw new Error('fake omp plugin link received an unexpected package');
const lockPath = path.join(pluginsDir, 'omp-plugins.lock.json');
const previous = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : {};
const lock = { plugins: previous.plugins ?? {}, settings: previous.settings ?? {} };
lock.plugins[name] = { version: packageManifest.version, enabledFeatures: null, enabled: true };
fs.mkdirSync(pluginsDir, { recursive: true });
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\\n');
const linkPath = path.join(pluginsDir, 'node_modules', ...name.split('/'));
fs.mkdirSync(path.dirname(linkPath), { recursive: true });
fs.rmSync(linkPath, { recursive: true, force: true });
if (process.env.FAKE_OMP_LINK_FAILURE !== 'unlink') fs.symlinkSync(sourceDir, linkPath, 'dir');
`;

const FAKE_OMP_INSTALLER = `#!/bin/bash
set -eu
if [ "\${SETUP_API_KEY+x}" = x ] || [ "\${SetupApiKey+x}" = x ]; then
  printf 'fake omp installer inherited the setup API key environment variable\\n' >&2
  exit 92
fi
target="$HOME/.local/bin"
mkdir -p "$target"
cp "$FAKE_OMP_SRC" "$target/omp"
chmod 755 "$target/omp"
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
const FAKE_OMP_SRC = join(FIXTURES, 'omp');
writeFileSync(FAKE_OMP_SRC, FAKE_OMP, { mode: 0o755 });
const FAKE_OMP_INSTALLER_SCRIPT = join(FIXTURES, 'install-omp.sh');
writeFileSync(FAKE_OMP_INSTALLER_SCRIPT, FAKE_OMP_INSTALLER, { mode: 0o755 });
const FAKE_OMP_PATHS_SCRIPT_FILE = join(FIXTURES, 'omp-paths.js');
writeFileSync(FAKE_OMP_PATHS_SCRIPT_FILE, FAKE_OMP_PATHS_SCRIPT, { mode: 0o755 });
const FAKE_OMP_PLUGIN_LINK_SCRIPT_FILE = join(FIXTURES, 'omp-plugin-link.js');
writeFileSync(FAKE_OMP_PLUGIN_LINK_SCRIPT_FILE, FAKE_OMP_PLUGIN_LINK_SCRIPT, { mode: 0o755 });

const FAKE_PI = `#!/bin/bash
if [ "\${SETUP_API_KEY+x}" = x ] || [ "\${SetupApiKey+x}" = x ]; then
  printf 'fake pi inherited the setup API key environment variable\\n' >&2
  exit 91
fi
case "$1" in
  --version)
    if [ "\${FAKE_PI_VERSION_SLEEP:-0}" -gt 0 ]; then sleep "$FAKE_PI_VERSION_SLEEP"; fi
    if [ -f "$FAKE_PI_UPDATE_MARKER" ]; then
      printf '%s\\n' "\${FAKE_PI_UPDATED_VERSION:-1.1.0}"
    else
      printf '%s\\n' "\${FAKE_PI_VERSION:-1.1.0}"
    fi
    ;;
  update)
    if [ "$2" = "--help" ]; then
      if [ "\${FAKE_PI_SUPPORTS_SELF:-1}" = 1 ]; then printf 'Usage: pi update --self\\n'; else printf 'Usage: pi update [source]\\n'; fi
      exit 0
    fi
    [ "$2" = "--self" ] || exit 64
    case "\${FAKE_PI_UPDATE_MODE:-ok}" in
      fail) exit 73 ;;
      sleep) sleep 10 ;;
      noop) exit 0 ;;
    esac
    : > "$FAKE_PI_UPDATE_MARKER"
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
if [ "\${FAKE_PI_SUPPORTS_SELF:-1}" = 0 ]; then : > "$FAKE_PI_UPDATE_MARKER"; fi
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
  | 'ok' | 'empty-extension' | 'adaptive'
  | 'installer-sh' | 'installer-ps1' | 'installer-html'
  | 'installer-codex-sh' | 'installer-codex-ps1'
  | 'installer-omp-sh' | 'installer-omp-ps1' | 'installer-pi-sh' | 'installer-pi-ps1';
interface ModelServerRequest {
  method: string;
  path: string;
  userAgent?: string;
  authorization?: string;
  endpoint?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Record<string, unknown>;
}
interface ModelServer {
  url: string;
  readonly requests: ModelServerRequest[];
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
    requests: [] as ModelServerRequest[],
  };
  const HTML_BODY = '<!DOCTYPE html><HTML><BODY>blocked</BODY></HTML>';
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/^\/(?:work|updated)(?=\/)/, '');
    const requestIndex = state.requests.length;
    state.requests.push({ method: req.method ?? '', path: pathname, headers: req.headers, userAgent: req.headers['user-agent'], authorization: req.headers.authorization, endpoint: new URL(req.url ?? '/', 'http://localhost').searchParams.get('endpoint') ?? undefined });
    if (req.method === 'POST' && (pathname === '/v1/responses' || pathname === '/v1/messages')) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        state.requests[requestIndex]!.body = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = pathname === '/v1/responses'
          ? [{ type: 'response.completed', response: { id: 'response', object: 'response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }]
          : [{ type: 'message_start', message: { id: 'message', type: 'message', role: 'assistant', model: 'budget-model', content: [], usage: { input_tokens: 1, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Floway response' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
        res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      });
      return;
    }
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
    if (pathname === '/install.sh' || pathname === '/install-codex.sh' || pathname === '/install-pi.sh' || pathname === '/install-omp.sh') {
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
      if (state.mode === 'installer-omp-sh') {
        res.writeHead(200, { 'content-type': 'text/x-shellscript' });
        res.end(FAKE_OMP_INSTALLER);
        return;
      }
    }
    if (pathname === '/install.ps1' || pathname === '/install-codex.ps1' || pathname === '/install-omp.ps1' || pathname === '/install-pi.ps1') {
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
      if (state.mode === 'installer-omp-ps1') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(PS1_FAKE_INSTALLER_BODY('omp', 'FAKE_OMP_SRC'));
        return;
      }
    }
    if (pathname === '/invalid-extension.js' || pathname === '/empty-extension.js') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(pathname === '/empty-extension.js' ? '' : HTML_BODY);
      return;
    }
    if (pathname.endsWith('/pi.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(SETUP_NODE_PI_EXTENSION);
      return;
    }
    if (pathname === '/test/pi/fail') {
      piFixture.status = 502;
      res.writeHead(204);
      res.end();
      return;
    }
    if (pathname === '/test/pi/advance') {
      piFixture.models = piFixture.catalogs.shift() ?? [];
      res.writeHead(204);
      res.end();
      return;
    }
    if (pathname === '/v1/models' && String(req.headers['user-agent']).startsWith('pi/')) {
      res.writeHead(piFixture.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: piFixture.models }));
      return;
    }
    if (pathname === '/omp.js') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      if (state.mode === 'empty-extension') { res.end(''); return; }
      res.end(SETUP_NODE_OMP_EXTENSION);
      return;
    }
    if (pathname === '/v1/models' || pathname === '/models') {
      if (String(req.headers['user-agent']).startsWith('omp/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          api: 'floway:floway', wireApis: { 'floway-model-1': 'anthropic-messages' }, payloadRemovals: { 'floway-model-1': state.mode === 'adaptive' ? [['output_config', 'effort']] : [] }, streamOptions: { 'floway-model-1': { thinkingBudgets: { minimal: 1100, low: 1100, medium: 1100, high: 1100, xhigh: 1100, max: 1100 } } }, models: [{
            id: 'floway-model-1', name: 'Floway Model', api: 'floway:floway', reasoning: true,
            thinking: state.mode === 'adaptive' ? { mode: 'anthropic-adaptive', efforts: ['high'], requiresEffort: false } : { mode: 'budget', efforts: ['low', 'medium', 'high'], defaultLevel: 'medium', requiresEffort: true },
            input: ['text', 'image'], contextWindow: 262144, maxTokens: 16384,
            cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 }, compat: { supportsReasoningEffort: true },
          }],
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'floway-model-1', object: 'model', created: 1000, owned_by: 'floway' },
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

export interface Workspace { root: string; home: string; binDir: string }
export const makeWorkspace = (): Workspace => {
  const root = mkdtempSync(join(HARNESS_ROOT, 'ws.'));
  const home = join(root, 'home');
  const binDir = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  return { root, home, binDir };
};

export const placeFakeClaude = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
};

export const placeFakeCodex = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'codex'), FAKE_CODEX, { mode: 0o755 });
};

export const placeFakePi = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pi'), FAKE_PI, { mode: 0o755 });
};

export const placeFakeNpm = (workspace: Workspace): void => {
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
  *'@oh-my-pi/pi-coding-agent'*)
    mkdir -p "$HOME/.local/bin"
    cp "$FAKE_OMP_SRC" "$HOME/.local/bin/omp"
    chmod 755 "$HOME/.local/bin/omp"
    ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
};

export const placeFakeOmp = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'omp'), FAKE_OMP, { mode: 0o755 });
};

type InstallerTestConfiguration = AgentSetupConfiguration & { readonly testAgent: ScriptAgent };

export const claudeConfig = (overrides: Partial<AgentSetupConfiguration['claudeCode']> = {}): InstallerTestConfiguration => ({
  testAgent: 'claude',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, disableArtifact: false, modelDiscovery: false, ...overrides,
  },
  codex: { model: null, reasoningEffort: null },
  pi: { thinkingLevel: null, retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null },
  omp: { retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null },
});

export const codexConfig = (overrides: Partial<AgentSetupConfiguration['codex']> = {}): InstallerTestConfiguration => ({
  testAgent: 'codex',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, disableArtifact: false, modelDiscovery: false,
  },
  codex: { model: null, reasoningEffort: null, ...overrides },
  pi: { thinkingLevel: null, retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null },
  omp: { retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null },
});

export const bothConfig = (
  claude: Partial<AgentSetupConfiguration['claudeCode']> = {},
  codex: Partial<AgentSetupConfiguration['codex']> = {},
  pi: Partial<AgentSetupConfiguration['pi']> = {},
  omp: Partial<AgentSetupConfiguration['omp']> = {},
): InstallerTestConfiguration => ({
  testAgent: 'claude',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, disableArtifact: false, modelDiscovery: false, ...claude,
  },
  codex: { model: null, reasoningEffort: null, ...codex },
  pi: { thinkingLevel: null, retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null, ...pi },
  omp: { retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null, ...omp },
});

export const piConfig = (overrides: Partial<AgentSetupConfiguration['pi']> = {}): InstallerTestConfiguration => ({
  testAgent: 'pi',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, disableArtifact: false, modelDiscovery: false,
  },
  codex: { model: null, reasoningEffort: null },
  pi: { thinkingLevel: null, retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null, ...overrides },
  omp: { retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null },
});

export const ompConfig = (overrides: Partial<AgentSetupConfiguration['omp']> = {}): InstallerTestConfiguration => ({
  testAgent: 'omp',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, disableArtifact: false, modelDiscovery: false,
  },
  codex: { model: null, reasoningEffort: null },
  omp: { retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null, ...overrides },
  pi: { thinkingLevel: null, retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null },
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
  fakeRestoreFailure?: boolean;
  fakeBackupCleanupFailure?: boolean;
  // Group-signals the running installer once it is mid Claude install (the fake
  // installer's child-pid file has appeared), to exercise the INT/TERM traps.
  signalDuringInstall?: 'SIGINT' | 'SIGTERM';
  codexHome?: string;
  fakeCodexVersion?: string;
  fakeCodexVersionSleep?: number;
  fakeCodexAppServerMode?: string;
  fakeCodexBatchDelay?: number;
  fakeCodexLargeStderr?: boolean;
  withCodexInstallHook?: boolean;
  fakeAgentUpdateMode?: 'ok' | 'fail' | 'noop' | 'sleep';
  fakePiSupportsSelf?: boolean;
  fakePiUpdatedVersion?: string;
  fakeOmpUpdatedVersion?: string;
  fakePiVersion?: string;
  fakePiVersionSleep?: number;
  withPiInstallHook?: boolean;
  piInstallerUrl?: string;
  piAgentDir?: string;
  piExtensionUrl?: string;
  fakePiFailConfig?: boolean;
  omitNode?: boolean;
  fakeNodeVersion?: string;
  codexInstallerUrl?: string;
  ambientCodexNonInteractive?: string;
  fakeOmpVersion?: string;
  fakeOmpVersionSleep?: number;
  fakeOmpAgentDir?: string;
  fakeOmpPluginsDir?: string;
  fakeOmpLinkFailure?: 'after' | 'unlink';
  fakeOmpProbeFailure?: boolean;
  withOmpInstallHook?: boolean;
  ompInstallerUrl?: string;
  piCodingAgentDir?: string;
  piConfigDir?: string;
  ompProfile?: string;
  fakeOmpFailConfig?: boolean;
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
export interface RunResult { code: number; stdout: string; stderr: string; combined: string }

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

const piEnv = (options: RunOptions): Record<string, string> => {
  const env: Record<string, string> = {
    FAKE_PI_SRC,
    FAKE_PI_UPDATE_MODE: options.fakeAgentUpdateMode ?? 'ok',
    FAKE_PI_UPDATE_MARKER: join(options.workspace.root, 'updated-pi'),
    FAKE_PI_UPDATED_VERSION: options.fakePiUpdatedVersion ?? '1.1.0',
    FAKE_PI_SUPPORTS_SELF: options.fakePiSupportsSelf === false ? '0' : '1',
  };
  if (options.fakePiVersion) env.FAKE_PI_VERSION = options.fakePiVersion;
  if (options.fakePiVersionSleep !== undefined) env.FAKE_PI_VERSION_SLEEP = String(options.fakePiVersionSleep);
  if (options.withPiInstallHook !== false) env.AGENT_SETUP_TEST_INSTALL_PI_SCRIPT = FAKE_PI_INSTALLER_SCRIPT;
  if (options.piInstallerUrl) env.AGENT_SETUP_TEST_PI_URL = options.piInstallerUrl;
  if (options.piAgentDir) env.PI_CODING_AGENT_DIR = options.piAgentDir;
  if (options.piExtensionUrl) env.AGENT_SETUP_TEST_PI_EXTENSION_URL = options.piExtensionUrl;
  if (options.fakePiFailConfig) env.AGENT_SETUP_TEST_FAIL_CONFIG = '1';
  return env;
};

const ompEnv = (options: RunOptions): Record<string, string> => {
  const env: Record<string, string> = {
    FAKE_OMP_SRC,
    OLLAMA_BASE_URL: 'http://127.0.0.1:1',
    LLAMA_CPP_BASE_URL: 'http://127.0.0.1:1',
    FAKE_OMP_PATHS_SCRIPT: FAKE_OMP_PATHS_SCRIPT_FILE,
    FAKE_OMP_PLUGIN_LINK_SCRIPT: FAKE_OMP_PLUGIN_LINK_SCRIPT_FILE,
    FAKE_OMP_PLUGIN_RECORD: join(options.workspace.root, 'omp-plugin-commands.txt'),
    FAKE_OMP_PROBE_RECORD: join(options.workspace.root, 'omp-probe-commands.txt'),
    FAKE_OMP_PATHS_RECORD: join(options.workspace.root, 'omp-setup-paths-record.jsonl'),
    FLOWAY_SETUP_PATHS_FILE: join(options.workspace.root, 'omp-setup-paths.json'),
    FAKE_OMP_UPDATE_MODE: options.fakeAgentUpdateMode ?? 'ok',
    FAKE_OMP_UPDATE_MARKER: join(options.workspace.root, 'updated-omp'),
    FAKE_OMP_UPDATED_VERSION: options.fakeOmpUpdatedVersion ?? 'omp/18.8.4',
  };
  if (options.fakeOmpVersion) env.FAKE_OMP_VERSION = options.fakeOmpVersion;
  if (options.fakeOmpVersionSleep !== undefined) env.FAKE_OMP_VERSION_SLEEP = String(options.fakeOmpVersionSleep);
  if (options.fakeOmpAgentDir) env.FAKE_OMP_AGENT_DIR = options.fakeOmpAgentDir;
  if (options.fakeOmpPluginsDir) env.FAKE_OMP_PLUGINS_PATH = options.fakeOmpPluginsDir;
  if (options.fakeOmpLinkFailure) env.FAKE_OMP_LINK_FAILURE = options.fakeOmpLinkFailure;
  if (options.fakeOmpProbeFailure) env.FAKE_OMP_PROBE_FAILURE = '1';
  if (options.withOmpInstallHook !== false) env.AGENT_SETUP_TEST_INSTALL_OMP_SCRIPT = FAKE_OMP_INSTALLER_SCRIPT;
  if (options.ompInstallerUrl) env.AGENT_SETUP_TEST_OMP_URL = options.ompInstallerUrl;
  if (options.piCodingAgentDir) env.PI_CODING_AGENT_DIR = options.piCodingAgentDir;
  if (options.piConfigDir) env.PI_CONFIG_DIR = options.piConfigDir;
  if (options.ompProfile) env.OMP_PROFILE = options.ompProfile;
  if (options.fakeOmpFailConfig) env.AGENT_SETUP_TEST_FAIL_CONFIG = '1';
  return env;
};

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
export const runShellInstaller = (options: RunOptions): Promise<RunResult> => {
  const { workspace, configuration } = options;
  const agent = targetAgent(configuration, options.agent);
  const canonicalBody = shellBody(agent);
  const cleanupFailure = options.fakeBackupCleanupFailure ? `
_prune_managed_backups() {
  case "$1" in
    */settings.json|*/omp-plugins.lock.json|*/config.yml)
      [ -z "$${agent === 'pi' ? 'PI' : 'OMP'}_EXTENSION_BACKUP" ] || { out_error 'extension backup was not removed'; return 74; }
      printf 'committed' > ${shellLiteral(join(workspace.root, 'cleanup-after-commit'))}
      out_error 'test backup cleanup failure'
      return 73
      ;;
  esac
}
` : '';
  const body = options.fakeBackupCleanupFailure
    ? `${canonicalBody.slice(0, canonicalBody.lastIndexOf(shellEntry(agent)))}${cleanupFailure}${shellEntry(agent)}\n`
    : canonicalBody;
  const script = renderShellPrefix(prefixInput(agent, configuration)) + body;
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
    ...ompEnv(options),
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

export const runShellInstallerWithAmbientKey = (options: RunOptions): Promise<RunResult> => {
  const { workspace, configuration } = options;
  const agent = targetAgent(configuration, options.agent);
  const script = renderShellPrefix(prefixInput(agent, configuration)) + shellBody(agent);
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
    ...piEnv(options),
    ...codexEnv(options),
    ...ompEnv(options),
  };
  if (agent === 'claude') {
    env.AGENT_SETUP_TEST_INSTALL_CLAUDE_SCRIPT = FAKE_INSTALLER_SCRIPT;
  } else if (agent === 'codex') {
    env.AGENT_SETUP_TEST_INSTALL_CODEX_SCRIPT = FAKE_CODEX_INSTALLER_SCRIPT;
  } else if (agent === 'pi') {
    env.AGENT_SETUP_TEST_INSTALL_PI_SCRIPT = FAKE_PI_INSTALLER_SCRIPT;
  } else if (agent === 'omp') {
    env.AGENT_SETUP_TEST_INSTALL_OMP_SCRIPT = FAKE_OMP_INSTALLER_SCRIPT;
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
export const installerMarker = (workspace: Workspace): string => join(workspace.root, 'installer-ran');
export const installerChildPid = (workspace: Workspace): string => join(workspace.root, 'installer-child.pid');
export const processExists = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
export const settingsPathFor = (workspace: Workspace, configDir?: string): string =>
  join(configDir ?? join(workspace.home, '.claude'), 'settings.json');
export const readSettings = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
export const backupFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith('settings.json.floway-backup.')) : [];
export const stagedFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter(name => name.includes('.floway-stage.')) : [];

// --- Codex inspection helpers -----------------------------------------------

const codexRecordPath = (workspace: Workspace): string => join(workspace.root, 'codex-record.jsonl');
export const codexHomeFor = (workspace: Workspace, codexHome?: string): string => codexHome ?? join(workspace.home, '.codex');
export const codexConfigPath = (workspace: Workspace, codexHome?: string): string => join(codexHomeFor(workspace, codexHome), 'config.toml');
export const codexAuthPath = (workspace: Workspace, codexHome?: string): string => join(codexHomeFor(workspace, codexHome), 'auth.json');
export const codexTokenPath = (workspace: Workspace, codexHome?: string): string => join(codexHomeFor(workspace, codexHome), 'floway-token');
interface CodexRecord { received?: { method?: string; id?: number; params?: unknown }; marker?: string; edits?: unknown; line?: string; method?: string }
export const readCodexRecord = (workspace: Workspace): CodexRecord[] => {
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
export const codexEditMap = (workspace: Workspace): Map<string, unknown> =>
  new Map(codexBatchEdits(workspace).map(e => [e.keyPath, e.value]));
export const codexBackupFiles = (dir: string, base: 'config.toml' | 'floway-token'): string[] =>
  existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith(`${base}.floway-backup.`)) : [];
export const readCodexToken = (workspace: Workspace, codexHome?: string): string =>
  readFileSync(codexTokenPath(workspace, codexHome), 'utf8');
export const powerShellCallerSurvivalPath = (workspace: Workspace): string => join(workspace.root, 'powershell-caller-survived');

// --- Pi inspection helpers --------------------------------------------------

export const piDirFor = (workspace: Workspace, subPath = '.pi/agent'): string => join(workspace.home, subPath);
export const piExtensionPath = (workspace: Workspace, subPath = '.pi/agent'): string => join(piDirFor(workspace, subPath), 'extensions/floway.js');
export const piSettingsPath = (workspace: Workspace, subPath = '.pi/agent'): string => join(piDirFor(workspace, subPath), 'settings.json');
export const piConnectionsPath = (workspace: Workspace, subPath = '.pi/agent'): string => join(piDirFor(workspace, subPath), 'floway.json');
export const readPiSettings = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
export const piBackupFiles = (dir: string, base: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith(`${base}.floway-backup.`)) : [];
export const piStagedFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter(name => name.includes('.floway-stage.')) : [];

const hostAgentBinary = (agent: 'pi' | 'omp'): string | null => {
  const command = process.env[`${agent.toUpperCase()}_BIN`] ?? agent;
  const location = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', command], { encoding: 'utf8' });
  if (location.status !== 0) return null;
  const binary = resolve(location.stdout.trim());
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim().length > 0 ? binary : null;
};
export const hostPiBin = hostAgentBinary('pi');

// --- omp inspection helpers -------------------------------------------------

export const ompDirFor = (workspace: Workspace, subPath = '.omp/agent'): string => join(workspace.home, subPath);
export const ompPluginsDirFor = (workspace: Workspace, subPath = '.omp/plugins'): string => join(workspace.home, subPath);
export const ompExtensionPath = (workspace: Workspace, subPath = '.omp/plugins'): string => join(ompPluginsDirFor(workspace, subPath), 'floway/index.js');
export const ompPackagePath = (workspace: Workspace, subPath = '.omp/plugins'): string => join(ompPluginsDirFor(workspace, subPath), 'floway/package.json');
export const ompPluginLinkPath = (workspace: Workspace, subPath = '.omp/plugins'): string => join(ompPluginsDirFor(workspace, subPath), 'node_modules/@floway-dev/omp');
export const ompPluginLockPath = (workspace: Workspace, subPath = '.omp/plugins'): string => join(ompPluginsDirFor(workspace, subPath), 'omp-plugins.lock.json');
export const ompModelsPath = (workspace: Workspace, subPath = '.omp/agent', ext = 'yml'): string => join(ompDirFor(workspace, subPath), `models.${ext}`);
export const ompConfigPath = (workspace: Workspace, subPath = '.omp/agent', ext = 'yml'): string => join(ompDirFor(workspace, subPath), `config.${ext}`);
export const ompBackupFiles = (dir: string, base: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith(`${base}.floway-backup.`)) : [];
export const ompStagedFiles = (dir: string): string[] => existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const entryPath = join(dir, entry.name);
      return entry.isDirectory() && !entry.isSymbolicLink()
        ? ompStagedFiles(entryPath)
        : entry.name.includes('.floway-stage.') ? [entryPath] : [];
    })
  : [];
export const OMP_PLUGIN_NAME = '@floway-dev/omp';
export const OMP_PLUGIN_MANIFEST = { name: OMP_PLUGIN_NAME, version: '1.0.0', type: 'module', omp: { extensions: ['index.js'] } };
const writeOmpPluginPackage = (workspace: Workspace, source: string, subPath = '.omp/plugins'): void => {
  mkdirSync(dirname(ompExtensionPath(workspace, subPath)), { recursive: true });
  writeFileSync(ompExtensionPath(workspace, subPath), source, { mode: 0o600 });
  writeFileSync(ompPackagePath(workspace, subPath), `${JSON.stringify(OMP_PLUGIN_MANIFEST, null, 2)}\n`, { mode: 0o600 });
};
export const seedOmpPlugin = (
  workspace: Workspace,
  lock: OmpPluginLock,
  source = SETUP_NODE_OMP_EXTENSION,
  subPath = '.omp/plugins',
): void => {
  writeOmpPluginPackage(workspace, source, subPath);
  mkdirSync(dirname(ompPluginLinkPath(workspace, subPath)), { recursive: true });
  symlinkSync(join(ompPluginsDirFor(workspace, subPath), 'floway'), ompPluginLinkPath(workspace, subPath), 'dir');
  writeFileSync(ompPluginLockPath(workspace, subPath), `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
};
export interface OmpPluginLock {
  plugins?: Record<string, unknown>;
  settings?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}
export const readOmpPluginLock = (workspace: Workspace, subPath = '.omp/plugins'): OmpPluginLock =>
  JSON.parse(readFileSync(ompPluginLockPath(workspace, subPath), 'utf8')) as OmpPluginLock;
export const readOmpConnections = (workspace: Workspace, subPath = '.omp/plugins'): { provider: string; endpoint: string; apiKey: string }[] => {
  const settings = readOmpPluginLock(workspace, subPath).settings?.[OMP_PLUGIN_NAME] as { connections?: unknown } | undefined;
  if (!Array.isArray(settings?.connections)) throw new Error(`missing settings[${JSON.stringify(OMP_PLUGIN_NAME)}].connections in omp-plugins.lock.json`);
  return settings.connections as { provider: string; endpoint: string; apiKey: string }[];
};

export const hostOmpBin = hostAgentBinary('omp');

export const networkReachable = (): boolean => {
  const probe = spawnSync('/usr/bin/curl', ['-fsSL', '-o', '/dev/null', '--max-time', '8', 'https://github.com/jqlang/jq/releases/download/jq-1.8.2/sha256sum.txt'], { encoding: 'utf8' });
  return probe.status === 0;
};

// Runs the PowerShell body under a real interpreter, mirroring runShellInstaller
// but rendering the PowerShell prefix. Model-directory traffic is in-process, so
// this too must be async to keep the event loop free.
export const runPowerShellInstaller = (options: RunOptions): Promise<RunResult> => {
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
        .replace('if ($script:PiExtensionExisted -and $runningOnWindows)', 'if ($script:PiExtensionExisted)')
        .replace('if ($script:PiSettingsExisted -and $runningOnWindows)', 'if ($script:PiSettingsExisted)')
    : canonicalBody;
  const cleanupFailure = options.fakeBackupCleanupFailure ? `
function Remove-SetupOlderBackups {
  param([string]$Path, [string]$Keep)
  if ($Path -match '(settings\\.json|omp-plugins\\.lock\\.json|config\\.yml)$') {
    if ($script:${agent === 'pi' ? 'Pi' : 'Omp'}ExtensionBackup) { throw 'extension backup was not removed' }
    [System.IO.File]::WriteAllText(${powerShellLiteral(join(workspace.root, 'cleanup-after-commit'))}, 'committed')
    throw 'test backup cleanup failure'
  }
}
` : '';
  const executionBody = options.fakeBackupCleanupFailure
    ? `${body.slice(0, body.lastIndexOf(powerShellEntry(agent)))}${cleanupFailure}${powerShellEntry(agent)}\n`
    : body;
  const script = powerShellBaseUrlPrelude(options) + renderPowerShellPrefix(prefixInput(agent, configuration)) + culturePrelude + executionBody;
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
    ...ompEnv(options),
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
