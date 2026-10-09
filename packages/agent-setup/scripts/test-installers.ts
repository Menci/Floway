// Executes the served installer prefix and body in isolated configuration roots.
// Fake CLIs cover install, upgrade and rollback. Native Pi/OMP exercise discovery
// and inference; pinned Codex checks its app-server configuration.
// Run `pnpm run test:installers`, optionally selecting `--agent <name>`.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import * as zlib from 'node:zlib';

import type { AgentSetupConfiguration } from '../src/configuration.ts';
import { type RenderPrefixInput, renderPowerShellPrefix, renderShellPrefix } from '../src/render.ts';
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
} from '../src/script-assets.generated.ts';
import { type ScriptAgent, SETUP_SCRIPT_BODIES } from '../src/script-assets.ts';

const prefixInput = (agent: ScriptAgent, configuration: AgentSetupConfiguration): RenderPrefixInput => {
  const base = { apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration };
  return agent === 'pi' || agent === 'omp' ? { ...base, agent, extensionPath: agent === 'pi' ? '/api/setup/test-lease-token/pi.js' : '/omp.js' } : { ...base, agent };
};

const shellLiteral = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const powerShellLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const AGENT_NAMES: Record<ScriptAgent, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi', omp: 'oh-my-pi' };
const shellEntry = (agent: ScriptAgent): string => `main '${AGENT_NAMES[agent]}' "$@"`;
const powerShellEntry = (agent: ScriptAgent): string => `$global:LASTEXITCODE = Main '${AGENT_NAMES[agent]}'`;
const shellBody = (agent: ScriptAgent): string => SETUP_SCRIPT_BODIES[agent].sh;
const powerShellBody = (agent: ScriptAgent): string => SETUP_SCRIPT_BODIES[agent].ps1;
const ALL_BASH_FRAGMENTS = SETUP_BASH_COMMON + SETUP_BASH_CLAUDE + SETUP_BASH_CODEX + SETUP_BASH_PI + SETUP_BASH_OMP;
const ALL_POWERSHELL_FRAGMENTS = SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_CLAUDE + SETUP_POWERSHELL_CODEX + SETUP_POWERSHELL_PI + SETUP_POWERSHELL_OMP;

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
for (const tool of ['sh', 'bash', 'env', 'awk', 'tr', 'cat', 'chmod', 'cmp', 'cp', 'date', 'mkdir', 'mkfifo', 'mktemp', 'mv', 'ln', 'readlink', 'rm', 'shasum', 'sleep', 'uname', 'curl']) {
  const path = resolveTool(tool);
  if (!path) throw new Error(`required tool ${tool} is not available on the host; cannot run the installer harness`);
  symlinkSync(path, join(SHIM_BIN, tool));
}
for (const tool of ['sha256sum', 'openssl', 'timeout', 'gtimeout', 'node', 'bun', 'dirname', 'sed']) {
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

const FAKE_OMP = `#!/bin/bash
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
    [ "$2" = "--stable" ] || exit 64
    case "\${FAKE_OMP_UPDATE_MODE:-ok}" in
      fail) exit 73 ;;
      sleep) sleep 10 ;;
      noop) exit 0 ;;
    esac
    : > "$FAKE_OMP_UPDATE_MARKER"
    ;;
  --mode)
    if [ "\${FAKE_OMP_PROBE_FAILURE:-0}" = "1" ]; then
      printf 'test native path probe failure\\n' >&2
      exit 73
    fi
    [ "$2" = "rpc" ] && [ "$3" = "--no-ui" ] && [ "$4" = "--no-session" ] \
      && [ "$5" = "--no-tools" ] && [ "$6" = "--no-lsp" ] && [ "$7" = "--no-skills" ] \
      && [ "$8" = "--no-rules" ] && [ "$9" = "--no-extensions" ] && [ "\${10}" = "-e" ] \
      || { printf 'fake omp: malformed path probe args: %s\\n' "$*" >&2; exit 64; }
    [ -s "\${11}" ] || { printf 'fake omp: missing path probe file: %s\\n' "\${11}" >&2; exit 66; }
    [ -n "\${FLOWAY_SETUP_PATHS_FILE:-}" ] || { printf 'fake omp: missing FLOWAY_SETUP_PATHS_FILE\\n' >&2; exit 65; }
    printf '%s\\n' "$*" >> "$FAKE_OMP_PROBE_RECORD"
    agent_dir="\${FAKE_OMP_AGENT_DIR:-$HOME/.omp/agent}"
    plugins_dir="\${FAKE_OMP_PLUGINS_PATH:-$HOME/.omp/plugins}"
    "$FAKE_OMP_PATHS_SCRIPT" "$agent_dir" "$plugins_dir" "$FLOWAY_SETUP_PATHS_FILE" "\${11}"
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
const [agentDir, pluginsDir, outputPath, probePath] = process.argv.slice(2);
const probeSource = fs.readFileSync(probePath, 'utf8');
if (!/\\bgetAgentDir\\s*\\(/.test(probeSource) || !/\\bgetPluginsDir\\s*\\(/.test(probeSource)) {
  throw new Error('fake omp path probe does not call both public path APIs');
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const paths = { agentDir, pluginsDir };
fs.writeFileSync(outputPath, JSON.stringify(paths) + '\\n');
if (process.env.FAKE_OMP_PATHS_RECORD) fs.appendFileSync(process.env.FAKE_OMP_PATHS_RECORD, JSON.stringify(paths) + '\\n');
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
  *'@oh-my-pi/pi-coding-agent'*)
    mkdir -p "$HOME/.local/bin"
    cp "$FAKE_OMP_SRC" "$HOME/.local/bin/omp"
    chmod 755 "$HOME/.local/bin/omp"
    ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
};

const placeFakeOmp = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'omp'), FAKE_OMP, { mode: 0o755 });
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
  pi: { thinkingLevel: null, retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null },
  omp: { retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null },
});

const codexConfig = (overrides: Partial<AgentSetupConfiguration['codex']> = {}): InstallerTestConfiguration => ({
  testAgent: 'codex',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, modelDiscovery: false,
  },
  codex: { model: null, reasoningEffort: null, ...overrides },
  pi: { thinkingLevel: null, retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null },
  omp: { retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null },
});

const bothConfig = (
  claude: Partial<AgentSetupConfiguration['claudeCode']> = {},
  codex: Partial<AgentSetupConfiguration['codex']> = {},
  pi: Partial<AgentSetupConfiguration['pi']> = {},
  omp: Partial<AgentSetupConfiguration['omp']> = {},
): InstallerTestConfiguration => ({
  testAgent: 'claude',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, modelDiscovery: false, ...claude,
  },
  codex: { model: null, reasoningEffort: null, ...codex },
  pi: { thinkingLevel: null, retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null, ...pi },
  omp: { retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null, ...omp },
});

const piConfig = (overrides: Partial<AgentSetupConfiguration['pi']> = {}): InstallerTestConfiguration => ({
  testAgent: 'pi',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, modelDiscovery: false,
  },
  codex: { model: null, reasoningEffort: null },
  pi: { thinkingLevel: null, retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null, ...overrides },
  omp: { retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null },
});

const ompConfig = (overrides: Partial<AgentSetupConfiguration['omp']> = {}): InstallerTestConfiguration => ({
  testAgent: 'omp',
  apiKeyId: 'key-a',
  claudeCode: {
    model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
    defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, modelDiscovery: false,
  },
  codex: { model: null, reasoningEffort: null },
  omp: { retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null, ...overrides },
  pi: { thinkingLevel: null, retry: { enabled: null, maxRetries: null }, provider: 'floway', model: null },
});
const _ompConfig = ompConfig;

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

const runShellInstallerWithAmbientKey = (options: RunOptions): Promise<RunResult> => {
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
const piExtensionPath = (workspace: Workspace, subPath = '.pi/agent'): string => join(piDirFor(workspace, subPath), 'extensions/floway.js');
const piSettingsPath = (workspace: Workspace, subPath = '.pi/agent'): string => join(piDirFor(workspace, subPath), 'settings.json');
const piConnectionsPath = (workspace: Workspace, subPath = '.pi/agent'): string => join(piDirFor(workspace, subPath), 'floway.json');
const readPiSettings = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const piBackupFiles = (dir: string, base: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith(`${base}.floway-backup.`)) : [];
const piStagedFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter(name => name.includes('.floway-stage.')) : [];

const hostAgentBinary = (agent: 'pi' | 'omp'): string | null => {
  const command = process.env[`${agent.toUpperCase()}_BIN`] ?? agent;
  const location = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', command], { encoding: 'utf8' });
  if (location.status !== 0) return null;
  const binary = resolve(location.stdout.trim());
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim().length > 0 ? binary : null;
};
const hostPiBin = hostAgentBinary('pi');

// --- omp inspection helpers -------------------------------------------------

const ompDirFor = (workspace: Workspace, subPath = '.omp/agent'): string => join(workspace.home, subPath);
const ompPluginsDirFor = (workspace: Workspace, subPath = '.omp/plugins'): string => join(workspace.home, subPath);
const ompExtensionPath = (workspace: Workspace, subPath = '.omp/plugins'): string => join(ompPluginsDirFor(workspace, subPath), 'floway/index.js');
const ompPackagePath = (workspace: Workspace, subPath = '.omp/plugins'): string => join(ompPluginsDirFor(workspace, subPath), 'floway/package.json');
const ompPluginLinkPath = (workspace: Workspace, subPath = '.omp/plugins'): string => join(ompPluginsDirFor(workspace, subPath), 'node_modules/@floway-dev/omp');
const ompPluginLockPath = (workspace: Workspace, subPath = '.omp/plugins'): string => join(ompPluginsDirFor(workspace, subPath), 'omp-plugins.lock.json');
const ompModelsPath = (workspace: Workspace, subPath = '.omp/agent', ext = 'yml'): string => join(ompDirFor(workspace, subPath), `models.${ext}`);
const ompConfigPath = (workspace: Workspace, subPath = '.omp/agent', ext = 'yml'): string => join(ompDirFor(workspace, subPath), `config.${ext}`);
const ompBackupFiles = (dir: string, base: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith(`${base}.floway-backup.`)) : [];
const ompStagedFiles = (dir: string): string[] => existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const entryPath = join(dir, entry.name);
      return entry.isDirectory() && !entry.isSymbolicLink()
        ? ompStagedFiles(entryPath)
        : entry.name.includes('.floway-stage.') ? [entryPath] : [];
    })
  : [];
const OMP_PLUGIN_NAME = '@floway-dev/omp';
const OMP_PLUGIN_MANIFEST = { name: OMP_PLUGIN_NAME, version: '1.0.0', type: 'module', omp: { extensions: ['index.js'] } };
const writeOmpPluginPackage = (workspace: Workspace, source: string, subPath = '.omp/plugins'): void => {
  mkdirSync(dirname(ompExtensionPath(workspace, subPath)), { recursive: true });
  writeFileSync(ompExtensionPath(workspace, subPath), source, { mode: 0o600 });
  writeFileSync(ompPackagePath(workspace, subPath), `${JSON.stringify(OMP_PLUGIN_MANIFEST, null, 2)}\n`, { mode: 0o600 });
};
const seedOmpPlugin = (
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
interface OmpPluginLock {
  plugins?: Record<string, unknown>;
  settings?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}
const readOmpPluginLock = (workspace: Workspace, subPath = '.omp/plugins'): OmpPluginLock =>
  JSON.parse(readFileSync(ompPluginLockPath(workspace, subPath), 'utf8')) as OmpPluginLock;
const readOmpConnections = (workspace: Workspace, subPath = '.omp/plugins'): { provider: string; endpoint: string; apiKey: string }[] => {
  const settings = readOmpPluginLock(workspace, subPath).settings?.[OMP_PLUGIN_NAME] as { connections?: unknown } | undefined;
  if (!Array.isArray(settings?.connections)) throw new Error(`missing settings[${JSON.stringify(OMP_PLUGIN_NAME)}].connections in omp-plugins.lock.json`);
  return settings.connections as { provider: string; endpoint: string; apiKey: string }[];
};

const hostOmpBin = hostAgentBinary('omp');

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

// --- Pi extension installation -----------------------------------------------

const piFixture: { models: Record<string, unknown>[]; catalogs: Record<string, unknown>[][]; status: number } = { models: [], catalogs: [], status: 200 };

for (const [label, runInstaller] of [['Bash', runShellInstaller], ['PowerShell', runPowerShellInstaller]] as const) {
  test('pi', `${label}: installs a protected fixed extension and preserves unrelated configuration`, async t => {
    if (label === 'PowerShell' && !hostPwsh) skip('no PowerShell interpreter on this host');
    const ws = makeWorkspace();
    placeFakePi(ws.binDir);
    mkdirSync(piDirFor(ws), { recursive: true });
    const unrelated = '// Unrelated provider\r\n{"providers":{"openai":{"apiKey":"original"}}}\r\n';
    const modelsPath = join(piDirFor(ws), 'models.json');
    writeFileSync(modelsPath, unrelated);
    const run = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
    t.equal(run.code, 0, run.combined);
    const extension = piExtensionPath(ws);
    t.ok(existsSync(extension), 'extension exists');
    t.equal(statSync(extension).mode & 0o777, 0o600, 'extension is private');
    const source = readFileSync(extension, 'utf8');
    t.excludes(source, SENTINEL_KEY, 'the shared extension contains no key');
    const auth = JSON.parse(readFileSync(join(piDirFor(ws), 'auth.json'), 'utf8'));
    t.equal(auth.floway.type, 'api_key');
    t.equal(auth.floway.key, SENTINEL_KEY);
    t.equal(statSync(join(piDirFor(ws), 'auth.json')).mode & 0o777, 0o600, 'credentials are private');
    t.equal(source, SETUP_NODE_PI_EXTENSION, 'extension is the fixed resource');
    t.equal(JSON.parse(readFileSync(join(piDirFor(ws), 'floway.json'), 'utf8')).connections[0].endpoint, modelServer.url);
    t.equal(readFileSync(modelsPath, 'utf8'), unrelated, 'unrelated models.json preserved byte for byte');
    t.ok(!existsSync(piSettingsPath(ws)), 'no settings file when no default is selected');
    t.ok(modelServer.requests.some(request => request.path.endsWith('/pi.js')), 'leased extension downloaded');
    t.ok(!modelServer.requests.some(request => request.path.endsWith('/v1/models')), 'setup does not snapshot the catalog');
    t.excludes(run.combined, SENTINEL_KEY, 'key never logged');
    const second = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
    t.equal(second.code, 0, second.combined);
    t.equal(readFileSync(extension, 'utf8'), source, 'repeat setup is idempotent');
    t.equal(piBackupFiles(join(piDirFor(ws), 'extensions'), 'floway.js').length, 0, 'backups pruned');
  });

  test('pi', `${label}: rollback restores extension and settings after the injected configuration failure`, async t => {
    if (label === 'PowerShell' && !hostPwsh) skip('no PowerShell interpreter on this host');
    const ws = makeWorkspace();
    placeFakePi(ws.binDir);
    mkdirSync(join(piDirFor(ws), 'extensions'), { recursive: true });
    const extension = piExtensionPath(ws);
    const settings = piSettingsPath(ws);
    const original = SETUP_NODE_PI_EXTENSION;
    writeFileSync(extension, original);
    writeFileSync(settings, '{"theme":"dark"}');
    const connectionPath = join(piDirFor(ws), 'floway.json');
    const connections = '{"connections":[{"provider":"old","endpoint":"https://old.example"}]}';
    writeFileSync(connectionPath, connections);
    const auth = join(piDirFor(ws), 'auth.json');
    const credentials = '{"openai":{"type":"api_key","key":"original"}}';
    writeFileSync(auth, credentials);
    const run = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'm' }), fakePiFailConfig: true });
    t.notEqual(run.code, 0, 'injected failure aborts');
    t.includes(run.combined, 'Pi simulated failure; rolling back configuration.', 'fault reached after successful extension staging');
    t.equal(readFileSync(extension, 'utf8'), original);
    t.equal(readFileSync(settings, 'utf8'), '{"theme":"dark"}');
    t.equal(readFileSync(auth, 'utf8'), credentials);
    t.equal(readFileSync(connectionPath, 'utf8'), connections);
    t.equal(piStagedFiles(join(piDirFor(ws), 'extensions')).length, 0);
  });

  test('pi', `${label}: malformed native credentials fail without changing files or exposing values`, async t => {
    if (label === 'PowerShell' && !hostPwsh) skip('no PowerShell interpreter on this host');
    const ws = makeWorkspace();
    placeFakePi(ws.binDir);
    mkdirSync(piDirFor(ws), { recursive: true });
    const path = join(piDirFor(ws), 'auth.json');
    const original = '{"openai":{"type":"api_key","key":"existing-private-key"}} trailing';
    writeFileSync(path, original);
    const run = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
    t.notEqual(run.code, 0);
    t.includes(run.combined, 'Invalid JSON in auth.json');
    t.excludes(run.combined, 'existing-private-key');
    t.equal(readFileSync(path, 'utf8'), original);
    t.ok(!existsSync(piExtensionPath(ws)));
  });

  test('pi', `${label}: settings JSONC comments and line endings survive default changes`, async t => {
    if (label === 'PowerShell' && !hostPwsh) skip('no PowerShell interpreter on this host');
    const ws = makeWorkspace();
    placeFakePi(ws.binDir);
    mkdirSync(piDirFor(ws), { recursive: true });
    writeFileSync(piSettingsPath(ws), '// Settings\r\n{\r\n  "theme": "dark",\r\n}');
    const run = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'm' }) });
    t.equal(run.code, 0, run.combined);
    const settings = readFileSync(piSettingsPath(ws), 'utf8');
    t.includes(settings, '// Settings\r\n');
    t.includes(settings, '"theme": "dark",');
    t.includes(settings, '"defaultModel": "m"');
  });

  test('pi', `${label}: refuses to replace a manually authored extension`, async t => {
    if (label === 'PowerShell' && !hostPwsh) skip('no PowerShell interpreter on this host');
    const ws = makeWorkspace();
    placeFakePi(ws.binDir);
    mkdirSync(join(piDirFor(ws), 'extensions'), { recursive: true });
    const extension = piExtensionPath(ws);
    writeFileSync(extension, 'export default () => {};');
    const run = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'm' }) });
    t.notEqual(run.code, 0);
    t.includes(run.combined, 'an unmanaged floway.js extension already exists');
    t.equal(readFileSync(extension, 'utf8'), 'export default () => {};');
    t.ok(!existsSync(piSettingsPath(ws)));
  });

  test('pi', `${label}: rejects empty and HTML extension downloads before replacing files`, async t => {
    if (label === 'PowerShell' && !hostPwsh) skip('no PowerShell interpreter on this host');
    for (const path of ['/empty-extension.js', '/invalid-extension.js']) {
      const ws = makeWorkspace();
      placeFakePi(ws.binDir);
      mkdirSync(join(piDirFor(ws), 'extensions'), { recursive: true });
      const extension = piExtensionPath(ws);
      const source = '// Managed by Floway Agent Setup.\noriginal extension';
      writeFileSync(extension, source);
      const run = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'm' }), piExtensionUrl: modelServer.url + path });
      t.notEqual(run.code, 0);
      t.equal(readFileSync(extension, 'utf8'), source);
      t.ok(!existsSync(piSettingsPath(ws)));
      t.equal(piStagedFiles(join(piDirFor(ws), 'extensions')).length, 0);
      t.excludes(run.combined, SENTINEL_KEY);
    }
  });

  test('pi', `${label}: respects PI_CODING_AGENT_DIR`, async t => {
    if (label === 'PowerShell' && !hostPwsh) skip('no PowerShell interpreter on this host');
    const ws = makeWorkspace();
    placeFakePi(ws.binDir);
    const agentDir = join(ws.root, 'custom agent');
    const run = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), piAgentDir: agentDir });
    t.equal(run.code, 0, run.combined);
    t.ok(existsSync(join(agentDir, 'extensions/floway.js')));
  });
}

test('pi', 'model set, changed, and cleared updates settings.json', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const settingsFile = piSettingsPath(ws);

  const run1 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  t.equal(run1.code, 0, `setting model should succeed:\n${run1.combined}`);
  t.ok(existsSync(settingsFile), 'settings.json created');
  t.equal(statSync(settingsFile).mode & 0o777, 0o600, 'settings.json permissions are 0600');
  let settings = readPiSettings(settingsFile);
  t.equal(settings.defaultProvider, 'floway');
  t.equal(settings.defaultModel, 'floway-pi-model-1');

  const run2 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'model-2' }) });
  t.equal(run2.code, 0, `changing model should succeed:\n${run2.combined}`);
  settings = readPiSettings(settingsFile);
  t.equal(settings.defaultProvider, 'floway');
  t.equal(settings.defaultModel, 'model-2');

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

test('pi', 'missing node aborts with clear error message', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), omitNode: true });
  t.notEqual(run.code, 0, 'installer should fail when node is missing');
  t.includes(run.combined, 'Node.js (>= 22.19) is required to run Pi but was not found on PATH. Install Node.js (>= 22.19) and re-run.');
  t.ok(!existsSync(piExtensionPath(ws)), 'extension not created when node check fails');
});

test('pi', 'unsupported Node fails before configuration', async t => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), fakeNodeVersion: 'v20.10.0' });
  t.notEqual(run.code, 0, `setup should reject unsupported Node:\n${run.combined}`);
  t.includes(run.combined, 'Pi requires Node.js >= 22.19.', 'required Node version is reported');
  t.ok(!existsSync(piExtensionPath(ws)), 'extension not created when Node is unsupported');
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
  t.ok(existsSync(piExtensionPath(ws)), 'extension written after installing pi');
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
  const fullScript = renderShellPrefix({ agent: 'pi', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration: piConfig(), extensionPath: '/api/setup/test-lease-token/pi.js' }) + shellBody('pi');
  const truncatedScript = fullScript.slice(0, fullScript.lastIndexOf(shellEntry('pi')));
  const scriptPath = join(ws.root, 'truncated.sh');
  writeFileSync(scriptPath, truncatedScript);
  const probe = spawnSync('/bin/bash', [scriptPath], {
    env: { HOME: ws.home, PATH: [ws.binDir, SHIM_BIN].join(':'), TMPDIR: ws.root, SETUP_ENDPOINT: modelServer.url },
    encoding: 'utf8',
  });
  t.equal(probe.status, 0, 'truncated script defines functions and exits without executing main');
  t.ok(!existsSync(piExtensionPath(ws)), 'no extension created');
});

// --- PowerShell Pi Cases ---

test('pi', 'PowerShell: model set, changed, and cleared updates settings.json', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const settingsFile = piSettingsPath(ws);

  const run1 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  t.equal(run1.code, 0, `setting model should succeed:\n${run1.combined}`);
  t.ok(existsSync(settingsFile), 'settings.json created');
  t.equal(statSync(settingsFile).mode & 0o777, 0o600, 'settings.json permissions are 0600');
  let settings = readPiSettings(settingsFile);
  t.equal(settings.defaultProvider, 'floway');
  t.equal(settings.defaultModel, 'floway-pi-model-1');

  const run2 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'model-2' }) });
  t.equal(run2.code, 0, `changing model should succeed:\n${run2.combined}`);
  settings = readPiSettings(settingsFile);
  t.equal(settings.defaultProvider, 'floway');
  t.equal(settings.defaultModel, 'model-2');

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

test('pi', 'PowerShell: missing node aborts with clear error message', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), omitNode: true });
  t.notEqual(run.code, 0, 'installer should fail when node is missing');
  t.includes(run.combined, 'Node.js (>= 22.19) is required to run Pi but was not found on PATH. Install Node.js (>= 22.19) and re-run.');
  t.ok(!existsSync(piExtensionPath(ws)), 'extension not created when node check fails');
});

test('pi', 'PowerShell: unsupported Node fails before configuration', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), fakeNodeVersion: 'v20.10.0' });
  t.notEqual(run.code, 0, `setup should reject unsupported Node:\n${run.combined}`);
  t.includes(run.combined, 'Pi requires Node.js >= 22.19.', 'required Node version is reported');
  t.ok(!existsSync(piExtensionPath(ws)), 'extension not created when Node is unsupported');
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
  t.ok(existsSync(piExtensionPath(ws)), 'extension written after installing pi');
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
    extensionPath: '/api/setup/test-lease-token/pi.js',
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
  const script = renderPowerShellPrefix({ agent: 'pi', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration, extensionPath: '/api/setup/test-lease-token/pi.js' }) + bodyWithoutEntry;
  const scriptPath = join(ws.root, 'truncated-pi-setup.ps1');
  writeFileSync(scriptPath, script);
  const result = spawnSync(hostPwsh, ['-NoProfile', '-File', scriptPath], {
    encoding: 'utf8',
    env: { HOME: ws.home, PATH: [ws.binDir, SHIM_BIN].join(':'), SETUP_ENDPOINT: modelServer.url },
  });
  t.equal(result.status, 0, `definitions-only script should exit cleanly:\n${result.stderr}`);
  t.ok(!existsSync(piExtensionPath(ws)), 'no extension created');
});

test('pi', 'installer scripts embed expected URLs and command sequences', t => {
  t.includes(SETUP_POWERSHELL_PI, '@earendil-works/pi-coding-agent', 'PowerShell can install pi with npm');
  t.includes(SETUP_POWERSHELL_PI, 'https://pi.dev/install.sh', 'PowerShell uses official install.sh URL');
  t.includes(SETUP_BASH_PI, '@earendil-works/pi-coding-agent', 'Bash installer specifies the npm package name');
  t.includes(SETUP_BASH_PI, 'https://pi.dev/install.sh', 'Bash installer specifies the official install.sh URL');
});

test('pi', 'real Pi loads the installed extension and discovers changed models without setup', async t => {
  if (!hostPiBin) skip('real Pi is not available');
  const ws = makeWorkspace();
  writeFileSync(join(ws.binDir, 'pi'), `#!/bin/sh\nexec ${shellLiteral(hostPiBin)} "$@"\n`, { mode: 0o755 });
  const fixture = (id: string): Record<string, unknown> => ({
    id, name: id, provider: 'floway', api: 'openai-responses', baseUrl: `${modelServer.url}/v1`,
    reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null },
    input: ['text', 'image'], contextWindow: 200000, maxTokens: 32000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  });
  piFixture.models = [fixture('first-model')];
  const install = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), withPiInstallHook: false });
  t.equal(install.code, 0, install.combined);
  const listModels = () => new Promise<RunResult>((resolve, reject) => {
    const child = spawn(hostPiBin!, ['--list-models', 'floway'], {
      cwd: ws.root,
      env: { ...process.env, HOME: ws.home, PI_CODING_AGENT_DIR: piDirFor(ws), PI_OFFLINE: '1' },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: stdout + stderr }));
  });
  const first = await listModels();
  t.equal(first.code, 0, first.combined);
  t.includes(first.stdout, 'first-model');
  piFixture.models = [fixture('second-model')];
  const second = await listModels();
  t.equal(second.code, 0, second.combined);
  t.includes(second.stdout, 'second-model');
  t.excludes(second.stdout, 'first-model');
  piFixture.models = [];
  const empty = await listModels();
  t.equal(empty.code, 0, empty.combined);
  t.excludes(empty.stdout, 'first-model');
  t.excludes(empty.stdout, 'second-model');
  const requests = modelServer.requests.filter(request => request.path === '/v1/models');
  t.ok(requests.length >= 3, 'every startup discovers current models');
  for (const request of requests) {
    t.ok((request.userAgent ?? '').startsWith('pi/1.1.0 ('), 'official Pi discovery UA used');
    t.equal(request.authorization, `Bearer ${SENTINEL_KEY}`, 'discovery authenticates as the selected API key');
    t.equal(request.endpoint, modelServer.url, 'public configured endpoint accompanies authenticated discovery');
  }
  t.excludes(first.combined + second.combined + empty.combined, SENTINEL_KEY);
});

test('pi', 'real Pi SDK refresh replaces and removes models while retaining full capabilities', async t => {
  const sdkPath = process.env.PI_SDK_PATH;
  if (!sdkPath) skip('PI_SDK_PATH is not configured');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const fixture = (id: string): Record<string, unknown> => ({
    id, name: id, provider: 'floway', api: 'openai-responses', baseUrl: `${modelServer.url}/v1`,
    reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null },
    input: ['text', 'image'], contextWindow: 200000, maxTokens: 32000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    headers: { 'x-model-capability': id, 'accept-encoding': 'identity' }, compat: { supportsDeveloperRole: false },
  });
  piFixture.models = [fixture('first-model'), { ...fixture('budget-model'), api: 'anthropic-messages', baseUrl: modelServer.url, thinkingBudgets: { minimal: 4096, low: 4096, medium: 8192, high: 10000 }, effortOverrides: { low: 'fast' } }, { ...fixture('mandatory-model'), thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null } }, ...['adaptive-model', 'adaptive-mandatory-model'].map(id => ({ ...fixture(id), api: 'anthropic-messages', baseUrl: modelServer.url, thinkingLevelMap: { off: id === 'adaptive-model' ? 'off' : null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null }, compat: { forceAdaptiveThinking: true }, payloadRemovals: [['output_config', 'effort']] }))];
  const refreshedModel = {
    ...fixture('second-model'),
    inputLimits: { images: { resize: { maxWidth: 1234, maxHeight: 987, maxBytes: 345678, jpegQuality: 72 } } },
    promptCache: { short: 97, long: 193 },
    samplingParams: { temperature: 0.4 },
    samplingParamsByThinkingLevel: { high: { top_p: 0.8 } },
    compat: { supportsStrictMode: true, supportsMidConvoSystemMessages: true },
    serverAddedMetadata: { version: 2, nested: ['unchanged'] },
  };
  piFixture.catalogs = [[refreshedModel], []];
  piFixture.status = 200;
  const install = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  t.equal(install.code, 0, install.combined);
  const installedExtension = readFileSync(piExtensionPath(ws), 'utf8');
  const runner = join(ws.root, 'pi-sdk.mjs');
  writeFileSync(runner, `
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const authPath = join(process.env.PI_CODING_AGENT_DIR, 'auth.json');
const credentials = JSON.parse(readFileSync(authPath, 'utf8'));
process.env.FLOWAY_PI_FIXTURE_KEY = ${JSON.stringify(SENTINEL_KEY)};
credentials.floway.key = '!printf %s "$FLOWAY_PI_FIXTURE_KEY"';
writeFileSync(authPath, JSON.stringify(credentials));
const { createAgentSession, SessionManager } = await import(pathToFileURL(process.env.PI_SDK_PATH).href);
const { session, extensionsResult } = await createAgentSession({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: SessionManager.inMemory(process.cwd()), noTools: 'all' });
assert.deepEqual(extensionsResult.errors, []);
assert.ok(session.modelRuntime.getModels('openai').length > 0, 'original OpenAI provider remains available');
const runtime = session.modelRuntime;
const models = () => runtime.getModels().filter(model => model.provider === 'floway');
const snapshots = [models()];
const context = { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] };
for (const id of ['first-model', 'budget-model', 'mandatory-model', 'adaptive-model', 'adaptive-mandatory-model']) {
  const response = await runtime.completeSimple(runtime.getModel('floway', id), context, { reasoning: id.startsWith('adaptive') ? 'high' : 'low', headers: { 'x-request-capability': id, 'aCcEpT-EnCoDiNg': 'identity' }, onPayload: payload => { if (id.startsWith('adaptive')) payload.output_config = { ...payload.output_config, format: { type: 'json_schema', schema: { type: 'object' } } }; } });
  assert.equal(response.stopReason, 'stop', response.errorMessage);
}
const budgetModel = runtime.getModel('floway', 'budget-model');
const altered = await runtime.completeSimple(budgetModel, context, { reasoning: 'low', onPayload: payload => { payload.output_config.effort = 'request-only'; } });
assert.equal(altered.stopReason, 'stop', altered.errorMessage);
assert.equal(budgetModel.effortOverrides.low, 'fast', 'request customization must not mutate the catalog');
const repeated = await runtime.completeSimple(budgetModel, context, { reasoning: 'low' });
assert.equal(repeated.stopReason, 'stop', repeated.errorMessage);
credentials.floway.key = '$!literal$$VALUE';
writeFileSync(authPath, JSON.stringify(credentials));
assert.equal((await runtime.getAuth('floway')).auth.apiKey, '!literal$VALUE');
credentials.floway.key = '$FLOWAY_PI_FIXTURE_KEY';
process.env.FLOWAY_PI_FIXTURE_KEY = 'rotated-key';
writeFileSync(authPath, JSON.stringify(credentials));
assert.equal((await runtime.getAuth('floway')).auth.apiKey, 'rotated-key');
for (let index = 0; index < 2; index++) {
  await fetch(process.env.PI_FIXTURE_URL + '/test/pi/advance');
  const result = await runtime.refresh({ providers: ['floway'], allowNetwork: true });
  assert.equal(result.errors.size, 0);
  snapshots.push(models());
  if (index === 0) {
    const expected = ${JSON.stringify(refreshedModel)};
    const response = await runtime.completeSimple(runtime.getModel('floway', 'second-model'), context, { reasoning: 'high', onPayload: (_payload, model) => { assert.deepEqual(JSON.parse(JSON.stringify(model)), expected); } });
    assert.equal(response.stopReason, 'stop', response.errorMessage);
  }
}
await fetch(process.env.PI_FIXTURE_URL + '/test/pi/fail');
const failure = await runtime.refresh({ providers: ['floway'], allowNetwork: true });
assert.match(failure.errors.get('floway').message, /^Floway model discovery failed: HTTP 502:/);
assert.deepEqual(models(), []);
session.dispose();
process.stdout.write(JSON.stringify(snapshots));
`);
  const result = await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [runner], {
      cwd: ws.root,
      env: { PATH: process.env.PATH, HOME: ws.home, PI_OFFLINE: '1', PI_CODING_AGENT_DIR: piDirFor(ws), PI_SDK_PATH: sdkPath, PI_FIXTURE_URL: modelServer.url },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: stdout + stderr }));
  });
  piFixture.status = 200;
  t.equal(result.code, 0, result.combined);
  const snapshots = JSON.parse(result.stdout) as Record<string, unknown>[][];
  t.equal(snapshots[0]?.[0]?.id, 'first-model');
  t.equal(snapshots[1]?.[0]?.id, 'second-model');
  t.equal(snapshots[1]?.length, 1, 'refresh replaces the old catalog');
  t.equal(snapshots[2]?.length, 0, 'empty catalogs remove every model');
  t.equal(JSON.stringify(snapshots[1]?.[0]), JSON.stringify(refreshedModel), 'server-added metadata survives the native registry and request bridge');
  t.equal(readFileSync(piExtensionPath(ws), 'utf8'), installedExtension, 'metadata refresh does not rewrite the installed extension');
  t.ok(modelServer.requests.some(request => request.path === '/v1/models' && request.authorization === 'Bearer rotated-key'), 'refresh uses the updated native credential');
  t.excludes(result.combined, SENTINEL_KEY);
  const responses = modelServer.requests.find(request => request.path === '/v1/responses');
  const messages = modelServer.requests.find(request => request.path === '/v1/messages');
  for (const request of modelServer.requests.filter(request => ['/v1/models', '/v1/responses', '/v1/messages'].includes(request.path))) {
    t.equal(request.headers['accept-encoding'], typeof zlib.createZstdDecompress === 'function' ? 'gzip, deflate, br, zstd' : 'gzip, deflate, br', 'discovery and both native APIs negotiate supported response compression');
  }
  for (const request of [responses!, messages!]) {
    t.equal(request.headers['x-model-capability'], request.body!.model as string, 'model headers remain intact');
    t.equal(request.headers['x-request-capability'], request.body!.model as string, 'request headers remain intact');
  }
  t.equal(JSON.stringify(responses?.body?.reasoning), JSON.stringify({ effort: 'low', summary: 'auto' }), 'Responses effort reaches the adapter');
  const thinking = messages?.body?.thinking as { type: string; budget_tokens: number };
  t.equal(thinking.type, 'enabled', 'budget enables native Anthropic thinking');
  t.equal(thinking.budget_tokens, 4096, 'server-derived budget reaches the native Anthropic adapter');
  t.equal(JSON.stringify(messages?.body?.output_config), JSON.stringify({ effort: 'fast' }), 'combined budget and declared open-string effort survive adapter projection');
  const budgetRequests = modelServer.requests.filter(request => request.body?.model === 'budget-model');
  t.equal((budgetRequests[1]?.body?.output_config as { effort: string }).effort, 'request-only', 'the native payload callback can customize one request');
  t.equal((budgetRequests[2]?.body?.output_config as { effort: string }).effort, 'fast', 'subsequent requests use the unchanged model metadata');
  const mandatory = modelServer.requests.find(request => request.body?.model === 'mandatory-model');
  t.equal(mandatory?.body?.reasoning, undefined, 'uncontrollable mandatory reasoning does not fabricate an effort or off request');
  for (const id of ['adaptive-model', 'adaptive-mandatory-model']) {
    const request = modelServer.requests.find(request => request.body?.model === id);
    const thinking = request?.body?.thinking as { type: string };
    t.equal(thinking.type, 'adaptive', 'adaptive-only models enable their advertised native mode');
    const outputConfig = request?.body?.output_config as { effort?: string; format?: unknown };
    t.equal(outputConfig.effort, undefined, 'no unadvertised effort is fabricated');
    t.ok(outputConfig.format !== undefined, 'nested effort removal preserves structured output configuration');
  }
});

// --- omp test cases ---------------------------------------------------------

test('omp', 'fresh install downloads a protected JS extension without model or role configuration', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  modelServer.reset();
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  t.equal(run.code, 0, `fresh install should succeed:\n${run.combined}`);
  t.includes(run.stdout, '==> Completed Agent Setup: oh-my-pi', 'completion notice emitted');
  const extensionPath = ompExtensionPath(ws);
  t.ok(existsSync(extensionPath), 'extension exists inside the linked plugin package');
  t.equal(statSync(extensionPath).mode & 0o777, 0o600, 'extension permissions are 0600');
  t.equal(readFileSync(extensionPath, 'utf8'), SETUP_NODE_OMP_EXTENSION, 'installed source matches the leased extension');
  const manifest = JSON.parse(readFileSync(ompPackagePath(ws), 'utf8')) as typeof OMP_PLUGIN_MANIFEST;
  t.equal(manifest.name, OMP_PLUGIN_NAME, 'package uses the native Floway plugin name');
  t.equal(manifest.version, '1.0.0', 'plugin package has the declared version');
  t.equal(manifest.type, 'module', 'plugin package is an ES module');
  t.equal(manifest.omp.extensions[0], 'index.js', 'plugin manifest exposes the extension entrypoint');
  const paths = JSON.parse(readFileSync(join(ws.root, 'omp-setup-paths-record.jsonl'), 'utf8')) as { agentDir: string; pluginsDir: string };
  t.equal(paths.agentDir, join(ws.home, '.omp/agent'), 'default agent directory is discovered');
  t.equal(paths.pluginsDir, join(ws.home, '.omp/plugins'), 'default plugin directory is discovered independently');
  const probeCommand = readFileSync(join(ws.root, 'omp-probe-commands.txt'), 'utf8').trim();
  t.includes(probeCommand, '--mode rpc --no-ui --no-session --no-tools --no-lsp --no-skills --no-rules --no-extensions -e ', 'probe uses the isolated RPC mode and an explicit script file');
  const pluginLink = ompPluginLinkPath(ws);
  t.ok(lstatSync(pluginLink).isSymbolicLink(), 'native plugin link was registered');
  t.equal(realpathSync(pluginLink), realpathSync(join(ompPluginsDirFor(ws), 'floway')), 'native plugin link targets the installed package');
  t.equal(readFileSync(join(ws.root, 'omp-plugin-commands.txt'), 'utf8').trim(), `plugin link ${join(ompPluginsDirFor(ws), 'floway')}`, 'installer registers the source through omp plugin link');
  const lockPath = ompPluginLockPath(ws);
  const pluginLock = readOmpPluginLock(ws);
  const registration = pluginLock.plugins?.[OMP_PLUGIN_NAME] as { version?: string; enabledFeatures?: unknown; enabled?: boolean } | undefined;
  t.ok(registration !== undefined, 'native plugin lock registers Floway');
  t.equal(registration?.version, '1.0.0', 'native plugin registration uses the package version');
  t.equal(registration?.enabledFeatures, null, 'native plugin registration keeps default feature selection');
  t.equal(registration?.enabled, true, 'native plugin registration enables Floway');
  t.equal(statSync(lockPath).mode & 0o777, 0o600, 'plugin settings and credentials are private');
  t.equal(readOmpConnections(ws)[0]?.endpoint, modelServer.url, 'connection settings live in the native plugin lock');
  t.equal(readOmpConnections(ws)[0]?.apiKey, SENTINEL_KEY, 'connection credentials live in the native plugin lock');
  t.ok(!existsSync(ompConfigPath(ws)), 'no default role is created');
  t.ok(!existsSync(ompModelsPath(ws)), 'models configuration is untouched');
});

for (const [platform, install] of [['Bash', runShellInstaller], ...(hostPwsh ? [['PowerShell', runPowerShellInstaller] as const] : [])] as const) {
  test('omp', `${platform}: preserves native plugin settings when linking Floway`, async t => {
    const ws = makeWorkspace();
    placeFakeOmp(ws.binDir);
    mkdirSync(ompPluginsDirFor(ws), { recursive: true });
    const otherPlugin = { enabled: false, preferences: { accent: 'violet' } };
    const existingFlowayConnection = { provider: 'existing-floway', endpoint: 'https://existing.example', apiKey: 'existing-key' };
    const priorLock: OmpPluginLock = {
      plugins: { '@example/theme': { version: '2.0.0', source: 'registry' } },
      settings: {
        '@example/theme': otherPlugin,
        [OMP_PLUGIN_NAME]: { theme: 'dark', custom: { retained: true }, connections: [existingFlowayConnection] },
      },
    };
    writeFileSync(ompPluginLockPath(ws), `${JSON.stringify(priorLock, null, 2)}\n`, { mode: 0o644 });

    const run = await install({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
    t.equal(run.code, 0, run.combined);

    const lock = readOmpPluginLock(ws);
    t.equal(JSON.stringify(lock.plugins?.['@example/theme']), JSON.stringify(priorLock.plugins?.['@example/theme']), 'other plugin registration is preserved');
    t.equal(JSON.stringify(lock.settings?.['@example/theme']), JSON.stringify(otherPlugin), 'other plugin settings are preserved');
    const flowaySettings = lock.settings?.[OMP_PLUGIN_NAME] as { theme?: string; custom?: unknown } | undefined;
    t.equal(flowaySettings?.theme, 'dark', 'unrelated Floway settings are preserved');
    t.equal(JSON.stringify(flowaySettings?.custom), JSON.stringify({ retained: true }), 'nested Floway settings are preserved');
    t.ok(lock.plugins?.[OMP_PLUGIN_NAME] !== undefined, 'Floway appears in native plugin registration');
    t.ok(lstatSync(ompPluginLinkPath(ws)).isSymbolicLink(), 'the native package link is created');
    t.equal(realpathSync(ompPluginLinkPath(ws)), realpathSync(join(ompPluginsDirFor(ws), 'floway')), 'the package link resolves to the installed source');
    t.equal(readOmpConnections(ws).length, 2, 'existing connections remain alongside the new connection');
    t.equal(readOmpConnections(ws)[0]?.provider, 'existing-floway', 'existing connection order is retained');
    t.equal(statSync(ompPluginLockPath(ws)).mode & 0o777, 0o600, 'plugin settings are protected after update');
  });
}

test('omp', 'model set, changed, and cleared updates config.yml', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const configFile = ompConfigPath(ws);

  const run1 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'gpt-4o' }) });
  t.equal(run1.code, 0, `setting model should succeed:\n${run1.combined}`);
  t.ok(existsSync(configFile), 'config.yml created');
  const expectedConfig1 = [
    'modelRoles:',
    '  default: "floway/gpt-4o"',
    '',
  ].join('\n');
  t.equal(readFileSync(configFile, 'utf8'), expectedConfig1, 'exact config shape when set');

  const run2 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: "claude-3-5:special'quote" }) });
  t.equal(run2.code, 0, `changing model should succeed:\n${run2.combined}`);
  const expectedConfig2 = [
    'modelRoles:',
    '  default: "floway/claude-3-5:special\'quote"',
    '',
  ].join('\n');
  t.equal(readFileSync(configFile, 'utf8'), expectedConfig2, 'exact config shape when changed with escaping');

  const run3 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: null }) });
  t.equal(run3.code, 0, `clearing model should succeed:\n${run3.combined}`);
  t.ok(!existsSync(configFile) || readFileSync(configFile, 'utf8') === '', 'empty modelRoles cleaned up completely');
});

test('omp', 'idempotent re-run produces no diff and prunes backups', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run1 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'gpt-4o' }) });
  t.equal(run1.code, 0, `first run should succeed:\n${run1.combined}`);
  const extension1 = readFileSync(ompExtensionPath(ws), 'utf8');
  const config1 = readFileSync(ompConfigPath(ws), 'utf8');

  const run2 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'gpt-4o' }) });
  t.equal(run2.code, 0, `second run should succeed:\n${run2.combined}`);
  t.equal(readFileSync(ompExtensionPath(ws), 'utf8'), extension1, 'extension source identical');
  t.equal(readFileSync(ompConfigPath(ws), 'utf8'), config1, 'config.yml identical');
  t.equal(ompBackupFiles(dirname(ompExtensionPath(ws)), 'index.js').length, 0, 'no extension backups remain');
  t.equal(ompBackupFiles(dirname(ompPackagePath(ws)), 'package.json').length, 0, 'no manifest backups remain');
  t.equal(ompBackupFiles(ompPluginsDirFor(ws), 'omp-plugins.lock.json').length, 0, 'no plugin settings backups remain');
  t.equal(ompBackupFiles(ompDirFor(ws), 'config.yml').length, 0, 'no config backups remain');
});

test('omp', 'preserves unrelated providers, comments, roles, CRLF, and missing trailing newline', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });

  const priorModels = '# User comments\r\nproviders:\r\n  anthropic:\r\n    baseUrl: https://api.anthropic.com\r\n    apiKey: ant-secret';
  const priorConfig = '# Custom config\r\nmodelRoles:\r\n  plan: anthropic/claude-3-opus';
  writeFileSync(ompModelsPath(ws), priorModels);
  writeFileSync(ompConfigPath(ws), priorConfig);

  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'test-model' }) });
  t.equal(run.code, 0, `setup should succeed:\n${run.combined}`);

  const modelsText = readFileSync(ompModelsPath(ws), 'utf8');
  t.includes(modelsText, '# User comments', 'comments preserved in models.yml');
  t.includes(modelsText, 'anthropic:', 'unrelated provider preserved');
  t.includes(modelsText, 'apiKey: ant-secret', 'unrelated provider keys preserved');
  t.excludes(modelsText, 'floway:', 'no provider configuration is inserted');
  t.ok(modelsText.includes('\r\n'), 'CRLF preserved in models.yml');

  const configText = readFileSync(ompConfigPath(ws), 'utf8');
  t.includes(configText, '# Custom config', 'comments preserved in config.yml');
  t.includes(configText, 'plan: anthropic/claude-3-opus', 'unrelated role preserved');
  t.includes(configText, 'default: "floway/test-model"', 'managed default inserted');
  t.ok(configText.includes('\r\n'), 'CRLF preserved in config.yml');

  const runClear = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: null }) });
  t.equal(runClear.code, 0, `clearing should succeed:\n${runClear.combined}`);

  const configCleared = readFileSync(ompConfigPath(ws), 'utf8');
  t.includes(configCleared, '# Custom config', 'comments preserved after clear');
  t.includes(configCleared, 'modelRoles:', 'modelRoles header preserved');
  t.includes(configCleared, 'plan: anthropic/claude-3-opus', 'unrelated user role preserved');
  t.excludes(configCleared, 'default:', 'managed default key removed');
});

test('omp', 'refuses config.yml containing tabs without modifying file', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const badContent = 'modelRoles:\n\tdefault: foo\n';
  writeFileSync(ompConfigPath(ws), badContent);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'foo' }) });
  t.ok(run.code !== 0, 'tabs in config.yml must fail');
  t.includes(run.combined, 'tabs found in', 'error mentions tabs');
  t.equal(readFileSync(ompConfigPath(ws), 'utf8'), badContent, 'file unmodified');
});

test('omp', 'refuses flow-style modelRoles mapping in config.yml without modifying file', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const badContent = 'modelRoles: {}\n';
  writeFileSync(ompConfigPath(ws), badContent);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'foo' }) });
  t.ok(run.code !== 0, 'flow-style modelRoles must fail');
  t.includes(run.combined, 'modelRoles must be a single block-style YAML mapping', 'unsafe mapping is reported');
  t.equal(readFileSync(ompConfigPath(ws), 'utf8'), badContent, 'file unmodified');
});

test('omp', 'refuses an unmanaged extension without modifying it', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(dirname(ompExtensionPath(ws)), { recursive: true });
  const badContent = 'providers:\n  floway:\n    baseUrl: https://custom.example.com\n';
  writeFileSync(ompExtensionPath(ws), badContent);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  t.ok(run.code !== 0, 'unmanaged floway provider must fail');
  t.includes(run.combined, 'existing unmanaged Floway extension found', 'error mentions unmanaged floway provider');
  t.equal(readFileSync(ompExtensionPath(ws), 'utf8'), badContent, 'file unmodified');
});

for (const [platform, install] of [['Bash', runShellInstaller], ...(hostPwsh ? [['PowerShell', runPowerShellInstaller] as const] : [])] as const) {
  test('omp', `${platform}: preserves an unmanaged plugin with a different extension entrypoint`, async t => {
    const ws = makeWorkspace();
    placeFakeOmp(ws.binDir);
    mkdirSync(dirname(ompPackagePath(ws)), { recursive: true });
    const manifest = '{"name":"custom-plugin","omp":{"extensions":["custom.js"]}}';
    const entrypoint = join(dirname(ompPackagePath(ws)), 'custom.js');
    writeFileSync(ompPackagePath(ws), manifest);
    writeFileSync(entrypoint, 'export default () => {};');
    const run = await install({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
    t.notEqual(run.code, 0, 'unmanaged plugin setup must fail');
    t.equal(readFileSync(ompPackagePath(ws), 'utf8'), manifest, 'manifest preserved');
    t.equal(readFileSync(entrypoint, 'utf8'), 'export default () => {};', 'native extension entrypoint preserved');
    t.ok(!existsSync(ompExtensionPath(ws)), 'no managed extension created');
    t.ok(!existsSync(ompPluginLockPath(ws)), 'no native settings written');
  });

  test('omp', `${platform}: rejects a non-object plugin settings root without modifying it`, async t => {
    const ws = makeWorkspace();
    placeFakeOmp(ws.binDir);
    mkdirSync(ompPluginsDirFor(ws), { recursive: true });
    const badContent = '[{}]\n';
    writeFileSync(ompPluginLockPath(ws), badContent, { mode: 0o600 });

    const run = await install({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
    t.notEqual(run.code, 0, 'array root must fail setup');
    t.excludes(run.stdout, '==> Completed Agent Setup: oh-my-pi', 'invalid lock data cannot complete setup');
    t.equal(readFileSync(ompPluginLockPath(ws), 'utf8'), badContent, 'invalid lock file remains byte for byte unchanged');
    t.ok(!existsSync(ompExtensionPath(ws)), 'invalid lock data is rejected before installing source');
    t.ok(!existsSync(ompPluginLinkPath(ws)), 'invalid lock data is rejected before registering the plugin');
    t.equal(ompStagedFiles(ompPluginsDirFor(ws)).length, 0, 'invalid lock data leaves no stage files');
  });
}

test('omp', 'refuses YAML anchors, aliases, or merge keys touching modelRoles in config.yml', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const badContent = 'modelRoles: &r\n  plan: claude\n';
  writeFileSync(ompConfigPath(ws), badContent);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'foo' }) });
  t.ok(run.code !== 0, 'anchors in config.yml must fail');
  t.includes(run.combined, 'without aliases', 'unsafe mapping is reported');
  t.equal(readFileSync(ompConfigPath(ws), 'utf8'), badContent, 'file unmodified');
});

test('omp', 'an explicit default replaces the previous provider while preserving other roles', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const before = '# Preferences\r\nmodelRoles: # startup\r\n    default: openai/gpt-4o # default choice\r\n    plan: anthropic/claude\r\ntheme: dark';
  writeFileSync(ompConfigPath(ws), before);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'my-model' }) });
  t.equal(run.code, 0, run.combined);
  t.equal(readFileSync(ompConfigPath(ws), 'utf8'), before.replace('openai/gpt-4o', '"floway/my-model"'));
});

test('omp', 'rollback restores the prior plugin registration and settings after link failure', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const priorContent = SETUP_NODE_OMP_EXTENSION;
  const priorLock: OmpPluginLock = {
    plugins: { [OMP_PLUGIN_NAME]: { version: '1.0.0', enabledFeatures: null, enabled: false }, '@example/theme': { version: '2.0.0' } },
    settings: { [OMP_PLUGIN_NAME]: { theme: 'dark', connections: [{ provider: 'floway', endpoint: 'https://before.example', apiKey: 'old-key' }] }, '@example/theme': { enabled: true, color: 'violet' } },
  };
  seedOmpPlugin(ws, priorLock, priorContent);
  const priorLockText = readFileSync(ompPluginLockPath(ws), 'utf8');
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), fakeOmpLinkFailure: 'unlink' });
  t.ok(run.code !== 0, 'simulated plugin link failure should exit nonzero');
  t.includes(run.combined, 'fake omp plugin link removed the native link and injected a failure', 'failure occurs after native registration updates and link removal');
  t.includes(run.combined, 'oh-my-pi applying changes failed; rolling back configuration.', 'plugin link failure enters rollback');
  t.ok(existsSync(join(ws.root, 'omp-plugin-commands.txt')), 'the native registration command ran');
  t.equal(readFileSync(ompExtensionPath(ws), 'utf8'), priorContent, 'extension restored to original content');
  t.equal(readFileSync(ompPluginLockPath(ws), 'utf8'), priorLockText, 'native registration and plugin settings are restored byte for byte');
  t.equal(realpathSync(ompPluginLinkPath(ws)), realpathSync(join(ompPluginsDirFor(ws), 'floway')), 'native link is restored to the Floway package');
  t.equal(ompStagedFiles(ompPluginsDirFor(ws)).length, 0, 'no plugin stage files left behind');
});

test('omp', 'rollback restore failure preserves backup file and warns operator', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const priorContent = SETUP_NODE_OMP_EXTENSION;
  seedOmpPlugin(ws, { plugins: { [OMP_PLUGIN_NAME]: { version: '1.0.0', enabledFeatures: null, enabled: false } }, settings: { [OMP_PLUGIN_NAME]: { connections: [] } } }, priorContent);
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpFailConfig: true,
    fakeRestoreFailure: true,
  });
  t.ok(run.code !== 0, 'should fail');
  t.includes(run.combined, 'oh-my-pi simulated failure; rolling back configuration.', 'fault reached after successful extension staging');
  t.includes(run.combined, 'could not restore', 'rollback warning names restore failure');
  t.includes(run.combined, 'restore it by hand', 'operator guidance emitted');
  const preservedBackups = ompBackupFiles(dirname(ompExtensionPath(ws)), 'index.js').length + ompBackupFiles(dirname(ompPackagePath(ws)), 'package.json').length;
  t.ok(preservedBackups > 0, 'a package backup is preserved for manual recovery');
});

for (const [platform, install] of [['Bash', runShellInstaller], ...(hostPwsh ? [['PowerShell', runPowerShellInstaller] as const] : [])] as const) {
  test('omp', `${platform}: removes a newly registered plugin after link failure`, async t => {
    const ws = makeWorkspace();
    placeFakeOmp(ws.binDir);
    mkdirSync(ompPluginsDirFor(ws), { recursive: true });
    const priorLock: OmpPluginLock = {
      metadata: { schema: 1 },
      plugins: { '@example/theme': { version: '2.0.0', source: 'registry' } },
      settings: { '@example/theme': { enabled: true, color: 'blue' } },
    };
    writeFileSync(ompPluginLockPath(ws), `${JSON.stringify(priorLock, null, 2)}\n`, { mode: 0o600 });
    const priorLockText = readFileSync(ompPluginLockPath(ws), 'utf8');

    const run = await install({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), fakeOmpLinkFailure: 'after' });
    t.notEqual(run.code, 0, 'simulated native link failure exits nonzero');
    t.includes(run.combined, 'fake omp plugin link completed and injected a failure', 'the fake mutates the registry and creates the link before failing');
    t.includes(run.combined, 'oh-my-pi applying changes failed; rolling back configuration.', 'plugin link failure enters rollback');
    t.equal(readFileSync(ompPluginLockPath(ws), 'utf8'), priorLockText, 'previous plugin registrations and settings are restored');
    t.equal(readOmpPluginLock(ws).plugins?.[OMP_PLUGIN_NAME], undefined, 'Floway registration is removed');
    const pluginScope = dirname(ompPluginLinkPath(ws));
    t.ok(!existsSync(pluginScope) || !readdirSync(pluginScope).includes('omp'), 'new native package link is removed');
    t.ok(!existsSync(ompExtensionPath(ws)), 'new plugin source is removed');
    t.ok(!existsSync(ompPackagePath(ws)), 'new plugin manifest is removed');
    t.equal(ompStagedFiles(ompPluginsDirFor(ws)).length, 0, 'no plugin stage files remain');
  });
}

test('omp', 'resolves agent directory from the native probe', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const customDir = join(ws.home, 'from-native-probe');
  const customPluginsDir = join(ws.home, 'independent-plugin-root');
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpAgentDir: customDir,
    fakeOmpPluginsDir: customPluginsDir,
  });
  t.equal(run.code, 0, `setup should succeed:\n${run.combined}`);
  const paths = JSON.parse(readFileSync(join(ws.root, 'omp-setup-paths-record.jsonl'), 'utf8')) as { agentDir: string; pluginsDir: string };
  t.equal(paths.agentDir, customDir, 'native probe preserves the native agent directory');
  t.equal(paths.pluginsDir, customPluginsDir, 'native probe can resolve an independent plugin root');
  t.ok(existsSync(ompExtensionPath(ws, 'independent-plugin-root')), 'extension written under the independently resolved plugin root');
});

test('omp', 'propagates native probe failure without guessing the agent directory', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const customDir = join(ws.home, 'from-pi-env-dir');
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpProbeFailure: true,
    piCodingAgentDir: customDir,
  });
  t.notEqual(run.code, 0);
  t.includes(run.combined, 'test native path probe failure');
  t.ok(!existsSync(customDir), 'failed discovery writes no guessed directory');
  t.ok(!existsSync(join(ws.root, 'omp-setup-paths-record.jsonl')), 'a failed probe publishes no native path result');
});

test('omp', 'resolves agent directory from OMP_PROFILE and ignores PI_CODING_AGENT_DIR', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const ignoredDir = join(ws.home, 'ignored-pi-env-dir');
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpAgentDir: join(ws.home, '.omp/profiles/work/agent'),
    fakeOmpPluginsDir: join(ws.home, '.omp/profiles/work/plugins'),
    ompProfile: 'work',
    piCodingAgentDir: ignoredDir,
  });
  t.equal(run.code, 0, `setup should succeed:\n${run.combined}`);
  const paths = JSON.parse(readFileSync(join(ws.root, 'omp-setup-paths-record.jsonl'), 'utf8')) as { agentDir: string; pluginsDir: string };
  t.equal(paths.agentDir, join(ws.home, '.omp/profiles/work/agent'), 'profile agent directory is discovered');
  t.equal(paths.pluginsDir, join(ws.home, '.omp/profiles/work/plugins'), 'profile plugin directory is discovered');
  t.ok(existsSync(ompExtensionPath(ws, '.omp/profiles/work/plugins')), 'extension written under the profile plugin directory');
  t.ok(!existsSync(ignoredDir), 'PI_CODING_AGENT_DIR was ignored');
});

test('omp', 'API key is never printed to stdout or stderr during setup', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  t.equal(run.code, 0, `setup should succeed:\n${run.combined}`);
  t.excludes(run.combined, SENTINEL_KEY, 'the API key must never be printed to stdout or stderr');
});

test('omp', 'ambient SETUP_API_KEY is not inherited by fake omp CLI', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run = await runShellInstallerWithAmbientKey({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  t.equal(run.code, 0, `ambient key run should succeed:\n${run.combined}`);
  t.excludes(run.combined, 'fake omp inherited the setup API key', 'subprocesses must not inherit SETUP_API_KEY');
});

test('omp', 'CLI not found runs test installer hook and installs omp', async t => {
  const ws = makeWorkspace();
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), withOmpInstallHook: true });
  t.equal(run.code, 0, `hook installation should succeed:\n${run.combined}`);
  t.ok(existsSync(join(ws.home, '.local/bin/omp')), 'installer hook installed omp');
  t.includes(run.stdout, 'oh-my-pi CLI not found; running the test installer', 'reports test installer invocation');
  t.ok(existsSync(ompExtensionPath(ws)), 'extension written after installing');
});

test('omp', 'CLI not found installs via npm when npm is available', async t => {
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), withOmpInstallHook: false });
  t.equal(run.code, 0, `npm installation should succeed:\n${run.combined}`);
  t.includes(run.stdout, 'oh-my-pi CLI not found; installing with npm', 'reports npm installation');
  t.equal(readFileSync(join(ws.root, 'npm-record.txt'), 'utf8').trim(), 'install --global @oh-my-pi/pi-coding-agent', 'npm receives the official global package');
});

test('omp', 'CLI not found fails when installer download fails', async t => {
  const ws = makeWorkspace();
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    withOmpInstallHook: false,
    ompInstallerUrl: `${modelServer.url}/nonexistent`,
  });
  t.ok(run.code !== 0, 'download failure must fail setup');
  t.includes(run.combined, 'could not download the installer', 'reports download failure');
});

test('omp', 'warns when multiple omp installations are detected', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const localBin = join(ws.home, '.local/bin');
  mkdirSync(localBin, { recursive: true });
  writeFileSync(join(localBin, 'omp'), FAKE_OMP, { mode: 0o755 });
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  t.equal(run.code, 0, `setup should succeed:\n${run.combined}`);
  t.includes(run.combined, 'multiple oh-my-pi installations detected', 'warns about multiple CLIs');
});

test('omp', 'fails when omp --version times out', async t => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpVersionSleep: 5,
    timeoutSeconds: 1,
  });
  t.ok(run.code !== 0, 'version timeout must fail setup');
  t.includes(run.combined, '`omp --version` timed out', 'reports version command timeout');
});

test('omp', 'Bash installer body parses under the macOS Bash 3.2 baseline', async t => {
  const body = shellBody('omp');
  const entry = shellEntry('omp');
  t.ok(body.trimEnd().endsWith(entry), 'the downloaded script starts execution only from its final line');
  t.ok(body.lastIndexOf(entry) > body.indexOf('configure_agent() {'), 'the entry call follows every agent function');
  const script = renderShellPrefix({ extensionPath: '/omp.js', agent: 'omp', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration: ompConfig({ model: 'm' }) }) + body;
  const scriptPath = join(HARNESS_ROOT, 'omp-syntax-check.sh');
  writeFileSync(scriptPath, script);
  const result = spawnSync('/bin/bash', ['-n', scriptPath], { encoding: 'utf8' });
  t.equal(result.status, 0, `/bin/bash -n reported a syntax error:\n${result.stderr}`);
});

test('omp', 'a download that ends before the final main call performs no setup work', t => {
  const ws = makeWorkspace();
  const configuration = ompConfig();
  const body = shellBody('omp');
  const bodyWithoutEntry = body.slice(0, body.lastIndexOf(shellEntry('omp')));
  const script = renderShellPrefix({ extensionPath: '/omp.js', agent: 'omp', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration }) + bodyWithoutEntry;
  const scriptPath = join(ws.root, 'truncated-omp-setup.sh');
  writeFileSync(scriptPath, script);
  const result = spawnSync('/bin/bash', [scriptPath], {
    encoding: 'utf8',
    env: { HOME: ws.home, PATH: [ws.binDir, SHIM_BIN].join(':'), SETUP_ENDPOINT: modelServer.url },
  });
  t.equal(result.status, 0, `definitions-only script should exit cleanly:\n${result.stderr}`);
  t.equal(result.stdout, '', 'definitions-only script prints nothing');
  t.ok(!existsSync(ompExtensionPath(ws)), 'definitions-only script writes no extension');
  t.ok(!existsSync(installerMarker(ws)), 'definitions-only script starts no installer');
});

// --- omp PowerShell parse + execution ---------------------------------------

test('omp', 'PowerShell: fresh install downloads a protected JS extension without model or role configuration', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  modelServer.reset();
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  t.equal(run.code, 0, `fresh install should succeed:\n${run.combined}`);
  t.includes(run.stdout, '==> Completed Agent Setup: oh-my-pi', 'completion notice emitted');
  const extensionPath = ompExtensionPath(ws);
  t.ok(existsSync(extensionPath), 'extension exists inside the linked plugin package');
  t.equal(statSync(extensionPath).mode & 0o777, 0o600, 'extension permissions are 0600');
  t.equal(readFileSync(extensionPath, 'utf8'), SETUP_NODE_OMP_EXTENSION, 'installed source matches the leased extension');
  const manifest = JSON.parse(readFileSync(ompPackagePath(ws), 'utf8')) as typeof OMP_PLUGIN_MANIFEST;
  t.equal(manifest.name, OMP_PLUGIN_NAME, 'package uses the native Floway plugin name');
  t.equal(manifest.version, '1.0.0', 'plugin package has the declared version');
  t.equal(manifest.type, 'module', 'plugin package is an ES module');
  t.equal(manifest.omp.extensions[0], 'index.js', 'plugin manifest exposes the extension entrypoint');
  const paths = JSON.parse(readFileSync(join(ws.root, 'omp-setup-paths-record.jsonl'), 'utf8')) as { agentDir: string; pluginsDir: string };
  t.equal(paths.agentDir, join(ws.home, '.omp/agent'), 'default agent directory is discovered');
  t.equal(paths.pluginsDir, join(ws.home, '.omp/plugins'), 'default plugin directory is discovered independently');
  t.includes(readFileSync(join(ws.root, 'omp-probe-commands.txt'), 'utf8'), '--mode rpc --no-ui --no-session --no-tools --no-lsp --no-skills --no-rules --no-extensions -e ', 'probe uses the isolated RPC mode and an explicit script file');
  const pluginLink = ompPluginLinkPath(ws);
  t.ok(lstatSync(pluginLink).isSymbolicLink(), 'native plugin link was registered');
  t.equal(realpathSync(pluginLink), realpathSync(join(ompPluginsDirFor(ws), 'floway')), 'native plugin link targets the installed package');
  t.equal(readFileSync(join(ws.root, 'omp-plugin-commands.txt'), 'utf8').trim(), `plugin link ${join(ompPluginsDirFor(ws), 'floway')}`, 'installer registers the source through omp plugin link');
  const lockPath = ompPluginLockPath(ws);
  const pluginLock = readOmpPluginLock(ws);
  const registration = pluginLock.plugins?.[OMP_PLUGIN_NAME] as { version?: string; enabledFeatures?: unknown; enabled?: boolean } | undefined;
  t.ok(registration !== undefined, 'native plugin lock registers Floway');
  t.equal(registration?.version, '1.0.0', 'native plugin registration uses the package version');
  t.equal(registration?.enabledFeatures, null, 'native plugin registration keeps default feature selection');
  t.equal(registration?.enabled, true, 'native plugin registration enables Floway');
  t.equal(statSync(lockPath).mode & 0o777, 0o600, 'plugin settings and credentials are private');
  t.equal(readOmpConnections(ws)[0]?.endpoint, modelServer.url, 'connection settings live in the native plugin lock');
  t.equal(readOmpConnections(ws)[0]?.apiKey, SENTINEL_KEY, 'connection credentials live in the native plugin lock');
  t.ok(!existsSync(ompConfigPath(ws)), 'no default role is created');
  t.ok(!existsSync(ompModelsPath(ws)), 'models configuration is untouched');
});

test('omp', 'PowerShell: model set, changed, and cleared updates config.yml', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const configFile = ompConfigPath(ws);

  const run1 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'gpt-4o' }) });
  t.equal(run1.code, 0, `setting model should succeed:\n${run1.combined}`);
  t.ok(existsSync(configFile), 'config.yml created');
  const expectedConfig1 = [
    'modelRoles:',
    '  default: "floway/gpt-4o"',
    '',
  ].join('\n');
  t.equal(readFileSync(configFile, 'utf8'), expectedConfig1, 'exact config shape when set');

  const run2 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: "claude-3-5:special'quote" }) });
  t.equal(run2.code, 0, `changing model should succeed:\n${run2.combined}`);
  const expectedConfig2 = [
    'modelRoles:',
    '  default: "floway/claude-3-5:special\'quote"',
    '',
  ].join('\n');
  t.equal(readFileSync(configFile, 'utf8'), expectedConfig2, 'exact config shape when changed with escaping');

  const run3 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: null }) });
  t.equal(run3.code, 0, `clearing model should succeed:\n${run3.combined}`);
  t.ok(!existsSync(configFile) || readFileSync(configFile, 'utf8') === '', 'empty modelRoles cleaned up completely');
});

test('omp', 'PowerShell: idempotent re-run produces no diff and prunes backups', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run1 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'gpt-4o' }) });
  t.equal(run1.code, 0, `first run should succeed:\n${run1.combined}`);
  const extension1 = readFileSync(ompExtensionPath(ws), 'utf8');
  const config1 = readFileSync(ompConfigPath(ws), 'utf8');

  const run2 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'gpt-4o' }) });
  t.equal(run2.code, 0, `second run should succeed:\n${run2.combined}`);
  t.equal(readFileSync(ompExtensionPath(ws), 'utf8'), extension1, 'extension source identical');
  t.equal(readFileSync(ompConfigPath(ws), 'utf8'), config1, 'config.yml identical');
  t.equal(ompBackupFiles(dirname(ompExtensionPath(ws)), 'index.js').length, 0, 'no extension backups remain');
  t.equal(ompBackupFiles(dirname(ompPackagePath(ws)), 'package.json').length, 0, 'no manifest backups remain');
  t.equal(ompBackupFiles(ompPluginsDirFor(ws), 'omp-plugins.lock.json').length, 0, 'no plugin settings backups remain');
  t.equal(ompBackupFiles(ompDirFor(ws), 'config.yml').length, 0, 'no config backups remain');
});

test('omp', 'PowerShell: preserves unrelated providers, comments, roles, CRLF, and missing trailing newline', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });

  const priorModels = '# User comments\r\nproviders:\r\n  anthropic:\r\n    baseUrl: https://api.anthropic.com\r\n    apiKey: ant-secret';
  const priorConfig = '# Custom config\r\nmodelRoles:\r\n  plan: anthropic/claude-3-opus';
  writeFileSync(ompModelsPath(ws), priorModels);
  writeFileSync(ompConfigPath(ws), priorConfig);

  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'test-model' }) });
  t.equal(run.code, 0, `setup should succeed:\n${run.combined}`);

  const modelsText = readFileSync(ompModelsPath(ws), 'utf8');
  t.includes(modelsText, '# User comments', 'comments preserved in models.yml');
  t.includes(modelsText, 'anthropic:', 'unrelated provider preserved');
  t.includes(modelsText, 'apiKey: ant-secret', 'unrelated provider keys preserved');
  t.excludes(modelsText, 'floway:', 'no provider configuration is inserted');
  t.ok(modelsText.includes('\r\n'), 'CRLF preserved in models.yml');

  const configText = readFileSync(ompConfigPath(ws), 'utf8');
  t.includes(configText, '# Custom config', 'comments preserved in config.yml');
  t.includes(configText, 'plan: anthropic/claude-3-opus', 'unrelated role preserved');
  t.includes(configText, 'default: "floway/test-model"', 'managed default inserted');
  t.ok(configText.includes('\r\n'), 'CRLF preserved in config.yml');

  const runClear = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: null }) });
  t.equal(runClear.code, 0, `clearing should succeed:\n${runClear.combined}`);

  const configCleared = readFileSync(ompConfigPath(ws), 'utf8');
  t.includes(configCleared, '# Custom config', 'comments preserved after clear');
  t.includes(configCleared, 'modelRoles:', 'modelRoles header preserved');
  t.includes(configCleared, 'plan: anthropic/claude-3-opus', 'unrelated user role preserved');
  t.excludes(configCleared, 'default:', 'managed default key removed');
});

test('omp', 'PowerShell: refuses config.yml containing tabs without modifying file', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const badContent = 'modelRoles:\n\tdefault: foo\n';
  writeFileSync(ompConfigPath(ws), badContent);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'foo' }) });
  t.ok(run.code !== 0, 'tabs in config.yml must fail');
  t.includes(run.combined, 'tabs found in', 'error mentions tabs');
  t.equal(readFileSync(ompConfigPath(ws), 'utf8'), badContent, 'file unmodified');
});

test('omp', 'PowerShell: refuses flow-style modelRoles mapping in config.yml without modifying file', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const badContent = 'modelRoles: {}\n';
  writeFileSync(ompConfigPath(ws), badContent);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'foo' }) });
  t.ok(run.code !== 0, 'flow-style modelRoles must fail');
  t.includes(run.combined, 'modelRoles must be a single block-style YAML mapping', 'unsafe mapping is reported');
  t.equal(readFileSync(ompConfigPath(ws), 'utf8'), badContent, 'file unmodified');
});

test('omp', 'PowerShell: refuses an unmanaged extension without modifying it', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(dirname(ompExtensionPath(ws)), { recursive: true });
  const badContent = 'providers:\n  floway:\n    baseUrl: https://custom.example.com\n';
  writeFileSync(ompExtensionPath(ws), badContent);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  t.ok(run.code !== 0, 'unmanaged floway provider must fail');
  t.includes(run.combined, 'existing unmanaged Floway extension found', 'error mentions unmanaged floway provider');
  t.equal(readFileSync(ompExtensionPath(ws), 'utf8'), badContent, 'file unmodified');
});

test('omp', 'PowerShell: refuses YAML anchors, aliases, or merge keys touching modelRoles in config.yml', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const badContent = 'modelRoles: &r\n  plan: claude\n';
  writeFileSync(ompConfigPath(ws), badContent);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'foo' }) });
  t.ok(run.code !== 0, 'anchors in config.yml must fail');
  t.includes(run.combined, 'without aliases', 'unsafe mapping is reported');
  t.equal(readFileSync(ompConfigPath(ws), 'utf8'), badContent, 'file unmodified');
});

test('omp', 'PowerShell: an explicit default replaces the previous provider while preserving other roles', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const before = '# Preferences\r\nmodelRoles: # startup\r\n    default: openai/gpt-4o # default choice\r\n    plan: anthropic/claude\r\ntheme: dark';
  writeFileSync(ompConfigPath(ws), before);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'my-model' }) });
  t.equal(run.code, 0, run.combined);
  t.equal(readFileSync(ompConfigPath(ws), 'utf8'), before.replace('openai/gpt-4o', '"floway/my-model"'));
});

test('omp', 'PowerShell: rollback restores the prior plugin registration and settings after link failure', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const priorContent = SETUP_NODE_OMP_EXTENSION;
  const priorLock: OmpPluginLock = {
    plugins: { [OMP_PLUGIN_NAME]: { version: '1.0.0', enabledFeatures: null, enabled: false }, '@example/theme': { version: '2.0.0' } },
    settings: { [OMP_PLUGIN_NAME]: { theme: 'dark', connections: [{ provider: 'floway', endpoint: 'https://before.example', apiKey: 'old-key' }] }, '@example/theme': { enabled: true, color: 'violet' } },
  };
  seedOmpPlugin(ws, priorLock, priorContent);
  const priorLockText = readFileSync(ompPluginLockPath(ws), 'utf8');
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), fakeOmpLinkFailure: 'unlink' });
  t.ok(run.code !== 0, 'simulated plugin link failure should exit nonzero');
  t.includes(run.combined, 'fake omp plugin link removed the native link and injected a failure', 'failure occurs after native registration updates and link removal');
  t.includes(run.combined, 'oh-my-pi applying changes failed; rolling back configuration.', 'plugin link failure enters rollback');
  t.ok(existsSync(join(ws.root, 'omp-plugin-commands.txt')), 'the native registration command ran');
  t.equal(readFileSync(ompExtensionPath(ws), 'utf8'), priorContent, 'extension restored to original content');
  t.equal(readFileSync(ompPluginLockPath(ws), 'utf8'), priorLockText, 'native registration and plugin settings are restored byte for byte');
  t.equal(realpathSync(ompPluginLinkPath(ws)), realpathSync(join(ompPluginsDirFor(ws), 'floway')), 'native link is restored to the Floway package');
  t.equal(ompStagedFiles(ompPluginsDirFor(ws)).length, 0, 'no plugin stage files left behind');
});

test('omp', 'PowerShell: rollback restore failure preserves backup file and warns operator', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const priorContent = SETUP_NODE_OMP_EXTENSION;
  seedOmpPlugin(ws, { plugins: { [OMP_PLUGIN_NAME]: { version: '1.0.0', enabledFeatures: null, enabled: false } }, settings: { [OMP_PLUGIN_NAME]: { connections: [] } } }, priorContent);
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpFailConfig: true,
    failRestore: true,
  });
  t.ok(run.code !== 0, 'should fail');
  t.includes(run.combined, 'oh-my-pi simulated failure; rolling back configuration.', 'fault reached after successful extension staging');
  t.includes(run.combined, 'could not restore', 'rollback warning names restore failure');
  t.includes(run.combined, 'restore it by hand', 'operator guidance emitted');
  const preservedBackups = ompBackupFiles(dirname(ompExtensionPath(ws)), 'index.js').length + ompBackupFiles(dirname(ompPackagePath(ws)), 'package.json').length;
  t.ok(preservedBackups > 0, 'a package backup is preserved for manual recovery');
});

test('omp', 'PowerShell: resolves agent directory from the native probe', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const customDir = join(ws.home, 'from-native-probe');
  const customPluginsDir = join(ws.home, 'independent-plugin-root');
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpAgentDir: customDir,
    fakeOmpPluginsDir: customPluginsDir,
  });
  t.equal(run.code, 0, `setup should succeed:\n${run.combined}`);
  const paths = JSON.parse(readFileSync(join(ws.root, 'omp-setup-paths-record.jsonl'), 'utf8')) as { agentDir: string; pluginsDir: string };
  t.equal(paths.agentDir, customDir, 'native probe preserves the native agent directory');
  t.equal(paths.pluginsDir, customPluginsDir, 'native probe can resolve an independent plugin root');
  t.ok(existsSync(ompExtensionPath(ws, 'independent-plugin-root')), 'extension written under the independently resolved plugin root');
});

test('omp', 'PowerShell: propagates native probe failure without guessing the agent directory', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const customDir = join(ws.home, 'from-pi-env-dir');
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpProbeFailure: true,
    piCodingAgentDir: customDir,
  });
  t.notEqual(run.code, 0);
  t.includes(run.combined, 'test native path probe failure');
  t.ok(!existsSync(customDir), 'failed discovery writes no guessed directory');
  t.ok(!existsSync(join(ws.root, 'omp-setup-paths-record.jsonl')), 'a failed probe publishes no native path result');
});

test('omp', 'PowerShell: resolves agent directory from OMP_PROFILE and ignores PI_CODING_AGENT_DIR', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const ignoredDir = join(ws.home, 'ignored-pi-env-dir');
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpAgentDir: join(ws.home, '.omp/profiles/work/agent'),
    fakeOmpPluginsDir: join(ws.home, '.omp/profiles/work/plugins'),
    ompProfile: 'work',
    piCodingAgentDir: ignoredDir,
  });
  t.equal(run.code, 0, `setup should succeed:\n${run.combined}`);
  const paths = JSON.parse(readFileSync(join(ws.root, 'omp-setup-paths-record.jsonl'), 'utf8')) as { agentDir: string; pluginsDir: string };
  t.equal(paths.agentDir, join(ws.home, '.omp/profiles/work/agent'), 'profile agent directory is discovered');
  t.equal(paths.pluginsDir, join(ws.home, '.omp/profiles/work/plugins'), 'profile plugin directory is discovered');
  t.ok(existsSync(ompExtensionPath(ws, '.omp/profiles/work/plugins')), 'extension written under the profile plugin directory');
  t.ok(!existsSync(ignoredDir), 'PI_CODING_AGENT_DIR was ignored');
});

test('omp', 'PowerShell: API key is never printed to stdout or stderr during setup', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  t.equal(run.code, 0, `setup should succeed:\n${run.combined}`);
  t.excludes(run.combined, SENTINEL_KEY, 'the API key must never be printed to stdout or stderr');
});

test('omp', 'PowerShell: ambient SETUP_API_KEY is not inherited by fake omp CLI', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), ambientApiKey: true });
  t.equal(run.code, 0, `ambient key run should succeed:\n${run.combined}`);
  t.excludes(run.combined, 'fake omp inherited the setup API key', 'subprocesses must not inherit SETUP_API_KEY');
});

test('omp', 'PowerShell: CLI not found runs test installer hook and installs omp', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), withOmpInstallHook: true });
  t.equal(run.code, 0, `hook installation should succeed:\n${run.combined}`);
  t.ok(existsSync(join(ws.home, '.local/bin/omp')), 'installer hook installed omp');
  t.includes(run.stdout, 'oh-my-pi CLI not found; running the test installer', 'reports test installer invocation');
  t.ok(existsSync(ompExtensionPath(ws)), 'extension written after installing');
});

test('omp', 'PowerShell prefers npm over the direct installer when npm is available', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), withOmpInstallHook: false });
  t.equal(run.code, 0, `npm installation should succeed:\n${run.combined}`);
  t.includes(run.stdout, 'oh-my-pi CLI not found; installing with npm', 'reports npm installation');
  t.equal(readFileSync(join(ws.root, 'npm-record.txt'), 'utf8').trim(), 'install --global @oh-my-pi/pi-coding-agent', 'npm receives the official global package');
});

test('omp', 'PowerShell: CLI not found fails when installer download fails', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    withOmpInstallHook: false,
    ompInstallerUrl: `${modelServer.url}/nonexistent`,
  });
  t.ok(run.code !== 0, 'download failure must fail setup');
});

test('omp', 'PowerShell: warns when multiple omp installations are detected', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const localBin = join(ws.home, '.local/bin');
  mkdirSync(localBin, { recursive: true });
  writeFileSync(join(localBin, 'omp'), FAKE_OMP, { mode: 0o755 });
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  t.equal(run.code, 0, `setup should succeed:\n${run.combined}`);
  t.includes(run.combined, 'multiple oh-my-pi installations detected', 'warns about multiple CLIs');
});

test('omp', 'PowerShell: fails when omp --version times out', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpVersionSleep: 5,
    timeoutSeconds: 1,
  });
  t.ok(run.code !== 0, 'version timeout must fail setup');
  t.includes(run.combined, '`omp --version` timed out', 'reports version command timeout');
});

test('omp', 'local PowerShell installer accepts script content and rejects HTML', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const accepted = makeWorkspace();
  modelServer.mode = 'installer-omp-ps1';
  const success = await runPowerShellInstaller({
    workspace: accepted,
    configuration: ompConfig(),
    baseUrl: modelServer.url,
    withOmpInstallHook: false,
    ompInstallerUrl: `${modelServer.url}/install-omp.ps1`,
  });
  t.equal(success.code, 0, `a local PowerShell installer should be accepted:\n${success.combined}`);
  t.ok(existsSync(installerMarker(accepted)), 'accepted installer executed');

  const rejected = makeWorkspace();
  modelServer.mode = 'installer-html';
  const failure = await runPowerShellInstaller({
    workspace: rejected,
    configuration: ompConfig(),
    baseUrl: modelServer.url,
    withOmpInstallHook: false,
    ompInstallerUrl: `${modelServer.url}/install-omp.ps1`,
  });
  t.ok(failure.code !== 0, 'HTML installer response must be rejected');
  t.ok(!existsSync(installerMarker(rejected)), 'HTML response never executes');
});

test('omp', 'PowerShell: timed-out installer terminates cleanly', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  modelServer.mode = 'installer-omp-ps1';
  const started = Date.now();
  const run = await runPowerShellInstaller({
    workspace: ws,
    configuration: ompConfig(),
    baseUrl: modelServer.url,
    withOmpInstallHook: false,
    ompInstallerUrl: `${modelServer.url}/install-omp.ps1`,
    installerSleep: 12,
    timeoutSeconds: 1,
  });
  t.ok(run.code !== 0, 'timed out installer must fail the agent');
  t.ok(Date.now() - started < 8_000, 'installer deadline must fire well before natural completion');
  t.ok(!existsSync(installerMarker(ws)), 'timed-out installer must not reach its marker');
});

test('omp', 'PowerShell installer body parses without syntax errors', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const body = powerShellBody('omp');
  const entry = powerShellEntry('omp');
  t.ok(body.trimEnd().endsWith(entry), 'the downloaded script starts execution only from its final line');
  t.ok(body.lastIndexOf(entry) > body.indexOf('function Set-SetupAgent {'), 'the entry call follows every agent function');
  const script = renderPowerShellPrefix({
    agent: 'omp',
    extensionPath: '/omp.js',
    apiKey: SENTINEL_KEY,
    apiKeyName: 'Primary key',
    configuration: ompConfig({ model: 'm' }),
  }) + body;
  const scriptPath = join(HARNESS_ROOT, 'omp-parse-check.ps1');
  writeFileSync(scriptPath, script);
  const check = `$errs=$null; [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replace(/'/g, "''")}',[ref]$null,[ref]$errs); if($errs -and $errs.Count -gt 0){ $errs | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 } else { exit 0 }`;
  const result = spawnSync(hostPwsh, ['-NoProfile', '-Command', check], { encoding: 'utf8' });
  t.equal(result.status, 0, `PowerShell parse errors:\n${result.stdout}${result.stderr}`);
});

test('omp', 'PowerShell: a download that ends before the final Main call performs no setup work', async t => {
  if (!hostPwsh) skip('no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const configuration = ompConfig();
  const body = powerShellBody('omp');
  const bodyWithoutEntry = body.slice(0, body.lastIndexOf(powerShellEntry('omp')));
  const script = renderPowerShellPrefix({ extensionPath: '/omp.js', agent: 'omp', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration }) + bodyWithoutEntry;
  const scriptPath = join(ws.root, 'truncated-omp-setup.ps1');
  writeFileSync(scriptPath, script);
  const result = spawnSync(hostPwsh, ['-NoProfile', '-File', scriptPath], {
    encoding: 'utf8',
    env: { HOME: ws.home, PATH: [ws.binDir, SHIM_BIN].join(':'), SETUP_ENDPOINT: modelServer.url },
  });
  t.equal(result.status, 0, `definitions-only script should exit cleanly:\n${result.stderr}`);
  t.equal(result.stdout, '', 'definitions-only script prints nothing');
  t.ok(!existsSync(ompExtensionPath(ws)), 'definitions-only script writes no extension');
  t.ok(!existsSync(installerMarker(ws)), 'definitions-only script starts no installer');
});

test('omp', 'PowerShell stages secret data only after protection and hardens Windows replacement targets', t => {
  const body = powerShellBody('omp');
  const stageFunctionIndex = body.indexOf('function Stage-SetupOmpPluginSettings');
  const createIndex = body.indexOf('[System.IO.File]::Create($script:OmpPluginSettingsStage).Dispose()', stageFunctionIndex);
  const protectStageIndex = body.indexOf('Protect-SetupFile $script:OmpPluginSettingsStage', createIndex);
  const writeIndex = body.indexOf('[System.IO.File]::WriteAllText($script:OmpPluginSettingsStage, (ConvertTo-Json', protectStageIndex);
  const applyIndex = body.indexOf('function Apply-SetupOmpFile');
  const protectTargetIndex = body.indexOf('Protect-SetupFile $Path', applyIndex);
  const replaceIndex = body.indexOf('[System.IO.File]::Replace($StagePath, $Path, [System.Management.Automation.Language.NullString]::Value)', protectTargetIndex);
  const applySettingsIndex = body.indexOf('Apply-SetupOmpFile -StagePath $script:OmpPluginSettingsStage -Path $script:OmpPluginSettingsPath', body.indexOf('function Apply-SetupOmpStaged'));
  t.ok(createIndex >= 0 && createIndex < protectStageIndex, 'stage must be created before protection');
  t.ok(protectStageIndex < writeIndex, 'stage must be protected before connection credentials is written');
  t.ok(protectTargetIndex < replaceIndex, 'existing Windows target must be hardened before File.Replace');
  t.ok(applySettingsIndex > writeIndex, 'the protected plugin settings stage is applied after credentials are written');
  t.includes(body, '$runningOnWindows = Test-SetupIsWindows', 'the replacement path uses the shared Windows predicate');
  t.includes(body, "[long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds", 'backup timestamp must support the .NET Framework used by PowerShell 5.1');
  t.excludes(body, 'ToUnixTimeMilliseconds()', 'PowerShell 5.1-incompatible timestamp API must not be used');
  t.includes(body, 'Move-Item -LiteralPath $StagePath -Destination $Path -Force', 'new target must use a same-directory move');
});

test('omp', 'installer scripts embed expected URLs and command sequences', t => {
  t.includes(SETUP_POWERSHELL_OMP, "Install-SetupNpmPackage -Package '@oh-my-pi/pi-coding-agent'", 'PowerShell can install omp with npm');
  t.includes(SETUP_POWERSHELL_OMP, 'https://omp.sh/install.ps1', 'omp Windows uses the official install.ps1');
  t.includes(SETUP_BASH_OMP, '@oh-my-pi/pi-coding-agent', 'Bash installer specifies the npm package name');
});

test('omp', 'both installers reject empty downloads and unmanaged empty extensions', async t => {
  for (const runInstaller of [runShellInstaller, ...(hostPwsh ? [runPowerShellInstaller] : [])]) {
    const ws = makeWorkspace();
    placeFakeOmp(ws.binDir);
    modelServer.mode = 'empty-extension';
    const emptyDownload = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
    t.ok(emptyDownload.code !== 0, 'empty downloaded source must fail');
    t.ok(!existsSync(ompExtensionPath(ws)), 'empty download leaves no extension');
    modelServer.reset();
    mkdirSync(dirname(ompExtensionPath(ws)), { recursive: true });
    writeFileSync(ompExtensionPath(ws), '');
    const emptyExisting = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
    t.ok(emptyExisting.code !== 0, 'unmanaged empty file must fail');
    t.equal(readFileSync(ompExtensionPath(ws), 'utf8'), '', 'unmanaged empty file remains untouched');
  }
});

test('omp', 'real omp smoke: discovery succeeds and server receives headers', async t => {
  if (!hostOmpBin) skip('real omp is not available or --version failed');
  const ws = makeWorkspace();
  const ompHome = ws.home;
  const cmd = hostOmpBin;
  writeFileSync(join(ws.binDir, 'omp'), `#!/bin/sh\nexec ${shellLiteral(cmd)} "$@"\n`, { mode: 0o755 });
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    withOmpInstallHook: false,
  });
  t.equal(run.code, 0, `omp installer should succeed: ${run.combined}`);
  // Asynchronous on purpose: the fixture server lives in this process, so a
  // blocking spawnSync would starve it and omp's discovery request would hang.
  const refresh = await new Promise<RunResult>(resolve => {
    const child = spawn(cmd, ['models', 'refresh'], { env: { ...process.env, HOME: ompHome } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}`, combined: `${stdout}${stderr}${String(error)}` }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: `${stdout}${stderr}` }));
  });
  t.equal(refresh.code, 0, `models refresh failed: ${refresh.stderr}\n${refresh.stdout}`);
  const req = modelServer.requests.find(r => r.path === '/v1/models' || r.path === '/models');
  t.ok(req !== undefined, 'modelServer received discovery request');
  t.equal(req?.headers['authorization'], `Bearer ${SENTINEL_KEY}`, 'discovery sent Authorization header with setup API key');
  t.equal(req?.headers['user-agent'], 'omp/18.8.4', 'discovery sent User-Agent: omp/18.8.4');

  const inference = await new Promise<RunResult>(resolve => {
    const child = spawn(cmd, ['--model', 'floway/floway-model-1', '--thinking', 'high', '--no-tools', '--no-lsp', '--no-session', '-p', 'hello'], { env: { ...process.env, HOME: ompHome } });
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', () => clearTimeout(timer));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: stdout + stderr }));
  });
  t.equal(inference.code, 0, `inference failed: ${inference.combined}`);
  t.includes(inference.stdout, 'Floway response', 'native streaming reaches the caller');
  const inferenceRequest = modelServer.requests.find(request => request.path === '/v1/messages');
  t.ok(inferenceRequest !== undefined, 'native Anthropic endpoint was called');
  t.equal((inferenceRequest!.body!.thinking as { budget_tokens: number }).budget_tokens, 1100, 'server budget bounds reach the native wire');

  modelServer.reset();
  modelServer.mode = 'adaptive';
  const adaptive = await new Promise<RunResult>(resolve => {
    const child = spawn(cmd, ['--model', 'floway/floway-model-1', '--thinking', 'high', '--no-tools', '--no-lsp', '--no-session', '-p', 'hello'], { env: { ...process.env, HOME: ompHome } });
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', () => clearTimeout(timer));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: stdout + stderr }));
  });
  t.equal(adaptive.code, 0, `adaptive inference failed: ${adaptive.combined}`);
  const adaptiveRequest = modelServer.requests.find(request => request.path === '/v1/messages')!;
  t.equal((adaptiveRequest.body!.thinking as { type: string }).type, 'adaptive', 'model-controlled reasoning stays adaptive');
  t.equal((adaptiveRequest.body!.output_config as { effort?: unknown } | undefined)?.effort, undefined, 'adaptive-only metadata emits no invented effort');

  if (hostPwsh) {
    const psWs = makeWorkspace();
    const psOmpHome = psWs.home;
    writeFileSync(join(psWs.binDir, 'omp'), `#!/bin/sh\nexec ${shellLiteral(cmd)} "$@"\n`, { mode: 0o755 });
    modelServer.reset();
    const psRun = await runPowerShellInstaller({
      workspace: psWs,
      baseUrl: modelServer.url,
      configuration: ompConfig(),
      withOmpInstallHook: false,
    });
    t.equal(psRun.code, 0, `omp PowerShell installer should succeed: ${psRun.combined}`);
    const psRefresh = await new Promise<RunResult>(resolve => {
      const child = spawn(cmd, ['models', 'refresh'], { env: { ...process.env, HOME: psOmpHome } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}`, combined: `${stdout}${stderr}${String(error)}` }));
      child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: `${stdout}${stderr}` }));
    });
    t.equal(psRefresh.code, 0, `models refresh failed: ${psRefresh.stderr}\n${psRefresh.stdout}`);
    const psReq = modelServer.requests.find(r => r.path === '/v1/models' || r.path === '/models');
    t.ok(psReq !== undefined, 'modelServer received discovery request from PowerShell setup');
    t.equal(psReq?.headers['authorization'], `Bearer ${SENTINEL_KEY}`, 'discovery sent Authorization header with setup API key');
    t.equal(psReq?.headers['user-agent'], 'omp/18.8.4', 'discovery sent User-Agent: omp/18.8.4');
  }
});

for (const agent of ['pi', 'omp'] as const) {
  const config = agent === 'pi' ? piConfig : ompConfig;
  const place = agent === 'pi' ? placeFakePi : placeFakeOmp;
  const extension = agent === 'pi' ? piExtensionPath : ompExtensionPath;
  const oldVersion = agent === 'pi' ? '1.0.4' : '18.8.3';
  for (const [platform, install] of [['Bash', runShellInstaller], ...(hostPwsh ? [['PowerShell', runPowerShellInstaller] as const] : [])] as const) {
    test(agent, `${platform}: upgrades an older CLI before writing configuration`, async t => {
      const ws = makeWorkspace();
      place(ws.binDir);
      const options = { workspace: ws, baseUrl: modelServer.url, configuration: config(), [agent === 'pi' ? 'fakePiVersion' : 'fakeOmpVersion']: oldVersion };
      const result = await install(options);
      t.equal(result.code, 0, result.combined);
      t.ok(existsSync(join(ws.root, `updated-${agent}`)), 'the selected CLI updater ran');
      t.ok(existsSync(extension(ws)), 'configuration installed after the effective version was rechecked');
    });

    if (agent === 'omp') {
      for (const [version, upgrade] of [['18.8.4-canary.1', true], ['18.8.10-canary.1', false], ['18.8.4+build.1', false]] as const) {
        test(agent, `${platform}: ${version} respects the numeric minimum and prerelease precedence`, async t => {
          const ws = makeWorkspace();
          place(ws.binDir);
          const result = await install({ workspace: ws, baseUrl: modelServer.url, configuration: config(), fakeOmpVersion: `omp/${version}` });
          t.equal(result.code, 0, result.combined);
          t.equal(existsSync(join(ws.root, 'updated-omp')), upgrade, 'only versions below the required stable release are updated');
          t.ok(existsSync(extension(ws)), 'configuration is written after the version gate');
        });
      }
    }

    for (const mode of ['fail', 'noop', 'sleep'] as const) {
      test(agent, `${platform}: update ${mode} leaves configuration unchanged`, async t => {
        const ws = makeWorkspace();
        place(ws.binDir);
        const result = await install({ workspace: ws, baseUrl: modelServer.url, configuration: config(), fakeAgentUpdateMode: mode, timeoutSeconds: 1, [agent === 'pi' ? 'fakePiVersion' : 'fakeOmpVersion']: oldVersion });
        t.notEqual(result.code, 0, 'a failed update or still-old effective CLI fails setup');
        t.ok(!existsSync(extension(ws)), 'no extension installed');
      });
    }

    test(agent, `${platform}: malformed versions fail without running an updater`, async t => {
      const ws = makeWorkspace();
      place(ws.binDir);
      const result = await install({ workspace: ws, baseUrl: modelServer.url, configuration: config(), [agent === 'pi' ? 'fakePiVersion' : 'fakeOmpVersion']: '19garbage' });
      t.notEqual(result.code, 0);
      t.ok(!existsSync(join(ws.root, `updated-${agent}`)), 'invalid version cannot authorize an update');
      t.ok(!existsSync(extension(ws)));
    });

    test(agent, `${platform}: one extension retains and updates independent providers`, async t => {
      const ws = makeWorkspace();
      place(ws.binDir);
      const first = await install({ workspace: ws, baseUrl: modelServer.url, configuration: config({ provider: 'floway-home', model: 'home-model' }) });
      t.equal(first.code, 0, first.combined);
      const second = await install({ workspace: ws, baseUrl: `${modelServer.url  }/work`, configuration: config({ provider: 'floway-work' }) });
      t.equal(second.code, 0, second.combined);
      const connectionsPath = agent === 'pi' ? piConnectionsPath(ws) : ompPluginLockPath(ws);
      const readConnections = () => agent === 'pi'
        ? JSON.parse(readFileSync(connectionsPath, 'utf8')).connections as { provider: string; endpoint: string; apiKey: string }[]
        : readOmpConnections(ws);
      t.excludes(readFileSync(extension(ws), 'utf8'), SENTINEL_KEY, 'both fixed resources contain no key');
      t.equal(statSync(connectionsPath).mode & 0o777, 0o600, 'connection configuration is private');
      if (agent === 'pi') {
        const auth = JSON.parse(readFileSync(join(piDirFor(ws), 'auth.json'), 'utf8'));
        t.equal(auth['floway-home'].key, SENTINEL_KEY);
        t.equal(auth['floway-work'].key, SENTINEL_KEY);
        t.excludes(readFileSync(extension(ws), 'utf8'), SENTINEL_KEY);
      }
      t.equal(readFileSync(extension(ws), 'utf8'), agent === 'pi' ? SETUP_NODE_PI_EXTENSION : SETUP_NODE_OMP_EXTENSION, 'two providers share the fixed resource');
      const entries = readConnections();
      t.equal(entries.length, 2);
      t.equal(entries[0]!.provider, 'floway-home');
      t.equal(entries[1]!.provider, 'floway-work');
      t.equal(entries[0]!.endpoint, modelServer.url);
      t.equal(entries[1]!.endpoint, `${modelServer.url  }/work`);
      const settings = agent === 'pi' ? readPiSettings(piSettingsPath(ws)) : readFileSync(ompConfigPath(ws), 'utf8');
      if (typeof settings === 'string') t.includes(settings, 'floway-home/home-model', 'adding a provider preserves another provider default');
      else t.equal(settings.defaultProvider, 'floway-home', 'adding a provider preserves another provider default');
      const update = await install({ workspace: ws, baseUrl: `${modelServer.url  }/updated`, configuration: config({ provider: 'floway-home', model: 'new-home-model' }) });
      t.equal(update.code, 0, update.combined);
      t.equal(readFileSync(extension(ws), 'utf8'), agent === 'pi' ? SETUP_NODE_PI_EXTENSION : SETUP_NODE_OMP_EXTENSION, 'endpoint updates retain fixed extension bytes');
      const updated = readConnections();
      t.equal(updated.length, 2, 'updating a provider replaces its connection');
      t.equal(updated.find(entry => entry.provider === 'floway-work')!.endpoint, `${modelServer.url  }/work`);
      t.equal(updated.find(entry => entry.provider === 'floway-home')!.endpoint, `${modelServer.url  }/updated`);
    });
  }
}

for (const [platform, install] of [['Bash', runShellInstaller], ...(hostPwsh ? [['PowerShell', runPowerShellInstaller] as const] : [])] as const) {
  test('pi', `${platform}: upgrades a legacy CLI without self-update through the installer`, async t => {
    const ws = makeWorkspace();
    placeFakePi(ws.binDir);
    const result = await install({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), fakePiVersion: '0.58.0', fakePiSupportsSelf: false });
    t.equal(result.code, 0, result.combined);
    t.ok(existsSync(installerMarker(ws)), 'the standard installation route ran');
    t.ok(existsSync(piExtensionPath(ws)), 'the effective upgraded CLI was verified before configuration');
  });
}

for (const agent of ['pi', 'omp'] as const) {
  const config = agent === 'pi' ? piConfig : ompConfig;
  const place = agent === 'pi' ? placeFakePi : placeFakeOmp;
  for (const [platform, install] of [['Bash', runShellInstaller], ...(hostPwsh ? [['PowerShell', runPowerShellInstaller] as const] : [])] as const) {
    test(agent, `${platform}: writes explicit global preferences and preserves them when unset`, async t => {
      const ws = makeWorkspace();
      place(ws.binDir);
      const selected = agent === 'pi'
        ? piConfig({ thinkingLevel: 'high', retry: { enabled: false, maxRetries: 0 } })
        : ompConfig({ retry: { enabled: false, maxRetries: 0 } });
      const result = await install({ workspace: ws, baseUrl: modelServer.url, configuration: selected });
      t.equal(result.code, 0, result.combined);
      const settingsPath = agent === 'pi' ? piSettingsPath(ws) : ompConfigPath(ws);
      const before = readFileSync(settingsPath, 'utf8');
      if (agent === 'pi') {
        const settings = readPiSettings(settingsPath);
        t.equal(settings.defaultThinkingLevel, 'high');
        t.equal((settings.retry as Record<string, unknown>).enabled, false);
        t.equal((settings.retry as Record<string, unknown>).maxRetries, 0);
      } else {
        t.includes(before, 'enabled: false');
        t.includes(before, 'maxRetries: 0');
      }
      const preserved = await install({ workspace: ws, baseUrl: modelServer.url, configuration: config({ provider: 'another-floway' }) });
      t.equal(preserved.code, 0, preserved.combined);
      t.equal(readFileSync(settingsPath, 'utf8'), before, 'unspecified global preferences retain their original bytes');
    });
  }
}

for (const agent of ['pi', 'omp'] as const) {
  const config = agent === 'pi' ? piConfig : ompConfig;
  const place = agent === 'pi' ? placeFakePi : placeFakeOmp;
  const extension = agent === 'pi' ? piExtensionPath : ompExtensionPath;
  const settings = agent === 'pi' ? piSettingsPath : ompConfigPath;
  for (const [platform, install] of [['Bash', runShellInstaller], ...(hostPwsh ? [['PowerShell', runPowerShellInstaller] as const] : [])] as const) {
    test(agent, `${platform}: cleanup failure preserves both committed files`, async t => {
      const ws = makeWorkspace();
      place(ws.binDir);
      const initial = await install({ workspace: ws, baseUrl: modelServer.url, configuration: config({ model: 'old-model' }) });
      t.equal(initial.code, 0, initial.combined);
      const updated = await install({ workspace: ws, baseUrl: `${modelServer.url}/updated`, configuration: config({ model: 'new-model' }), fakeBackupCleanupFailure: true });
      t.notEqual(updated.code, 0);
      t.includes(updated.combined, 'test backup cleanup failure');
      t.ok(existsSync(join(ws.root, 'cleanup-after-commit')), 'failure occurs after removing the extension backup');
      t.equal(readFileSync(extension(ws), 'utf8'), agent === 'pi' ? SETUP_NODE_PI_EXTENSION : SETUP_NODE_OMP_EXTENSION, 'fixed extension remains committed');
      const connections = agent === 'pi'
        ? JSON.parse(readFileSync(piConnectionsPath(ws), 'utf8')).connections as { endpoint: string }[]
        : readOmpConnections(ws);
      t.equal(connections[0]?.endpoint, `${modelServer.url}/updated`, 'new connection remains committed');
      t.includes(readFileSync(settings(ws), 'utf8'), 'new-model', 'new preferences remain committed');
      t.excludes(updated.combined, 'rolling back', 'committed data does not enter rollback');
    });
  }
}

// --- run --------------------------------------------------------------------

const parseAgentFilter = (): ScriptAgent | 'all' => {
  const index = process.argv.indexOf('--agent');
  if (index === -1) return 'all';
  const value = process.argv[index + 1];
  if (value === 'claude' || value === 'codex' || value === 'pi' || value === 'omp') return value;
  throw new Error(`--agent must be "claude", "codex" "pi" or "omp", got ${JSON.stringify(value)}`);
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
