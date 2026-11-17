import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STATE_DIR = join(ROOT, '.tmp', 'run-local-demo');
const STATE_PATH = join(STATE_DIR, 'state.json');
const LOG_PATH = join(STATE_DIR, 'services.log');
const WORKERD_CONFIG = join(STATE_DIR, 'wrangler.jsonc');
const WORKERD_VARS = join(STATE_DIR, '.dev.vars');

export type Runtime = 'node' | 'workerd';

interface DemoState {
  pid: number;
  runtime: Runtime;
  webUrl: string;
  apiUrl: string;
  adminKey: string;
}

type Command = { name: 'up'; runtime: Runtime; gatewayPort: number; webPort: number } | { name: 'status' | 'stop' } | { name: 'help' };

const usage = `Usage:
  pnpm --silent --filter @floway-dev/tools run local-demo up [options]
  pnpm --silent --filter @floway-dev/tools run local-demo status
  pnpm --silent --filter @floway-dev/tools run local-demo stop

Options:
  --runtime <node|workerd>  Gateway runtime (default: node)
  --gateway-port <port>     Gateway port (default: 8788)
  --web-port <port>         Vite port (default: 5174)
`;

const port = (value: string | undefined, fallback: number): number => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error('ports must be integers from 1 to 65535');
  return parsed;
};

export const parseCommand = (args: readonly string[]): Command => {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { name: 'help' };
  const parsed = parseArgs({ args: [...args], allowPositionals: true, options: { runtime: { type: 'string' }, 'gateway-port': { type: 'string' }, 'web-port': { type: 'string' } } });
  const [name, ...extra] = parsed.positionals;
  if (name === 'status' || name === 'stop') {
    if (extra.length > 0 || Object.keys(parsed.values).length > 0) throw new Error(`${name} accepts no arguments`);
    return { name };
  }
  if (name !== 'up' || extra.length > 0) throw new Error(usage);
  const runtime = parsed.values.runtime ?? 'node';
  if (runtime !== 'node' && runtime !== 'workerd') throw new Error('--runtime must be node or workerd');
  const gatewayPort = port(parsed.values['gateway-port'], 8788);
  const webPort = port(parsed.values['web-port'], 5174);
  if (gatewayPort === webPort) throw new Error('gateway and web ports must differ');
  return { name, runtime, gatewayPort, webPort };
};

export const adminKeyForRuntime = (runtime: Runtime): string => runtime === 'workerd' ? 'admin' : '';

export const workerdConfig = (root: string): unknown => ({
  name: 'floway-local-demo',
  main: join(root, 'apps', 'platform-cloudflare', 'entry.ts'),
  compatibility_date: '2025-01-01',
  compatibility_flags: ['nodejs_compat', 'enable_ctx_exports'],
  d1_databases: [{ binding: 'DB', database_name: 'floway-local-demo', database_id: 'floway-local-demo', migrations_dir: join(root, 'packages', 'gateway', 'migrations') }],
  r2_buckets: [{ binding: 'FILES', bucket_name: 'floway-local-demo' }],
  images: { binding: 'IMAGES' },
  kv_namespaces: [{ binding: 'KV', id: 'floway-local-demo' }],
  durable_objects: { bindings: [{ name: 'EXECUTION_DO', class_name: 'ExecutionDO' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['ExecutionDO'] }],
});

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const readState = async (): Promise<DemoState | null> => {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8')) as DemoState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const terminate = async (pid: number): Promise<void> => {
  if (!alive(pid)) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(-pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (alive(pid) && Date.now() < deadline) await sleep(100);
  if (alive(pid) && process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
  const killDeadline = Date.now() + 10_000;
  while (alive(pid) && Date.now() < killDeadline) await sleep(100);
  if (alive(pid)) throw new Error(`Could not stop process group ${pid}`);
};

const report = (state: DemoState): string => JSON.stringify({
  running: alive(state.pid),
  runtime: state.runtime,
  webUrl: state.webUrl,
  apiUrl: state.apiUrl,
  adminKey: state.adminKey,
  auth: state.adminKey === '' ? 'blank-password' : 'admin-key',
}, null, 2);

const start = async (command: Extract<Command, { name: 'up' }>): Promise<string> => {
  const previous = await readState();
  if (previous !== null && alive(previous.pid)) throw new Error(`A local demo is already running at ${previous.webUrl}`);
  if (previous !== null) await terminate(previous.pid);
  await rm(STATE_DIR, { recursive: true, force: true });
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    ADMIN_KEY: '',
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(command.gatewayPort),
    FLOWAY_DB_PATH: join(STATE_DIR, 'floway.db'),
    FLOWAY_FILES_DIR: join(STATE_DIR, 'files'),
    FLOWAY_DEV_GATEWAY_ORIGIN: `http://127.0.0.1:${command.gatewayPort}`,
    FLOWAY_DEV_WEB_PORT: String(command.webPort),
    WRANGLER_LOG_PATH: join(STATE_DIR, 'wrangler.log'),
  };
  if (command.runtime === 'workerd') {
    await writeFile(WORKERD_CONFIG, `${JSON.stringify(workerdConfig(ROOT), null, 2)}\n`, { mode: 0o600 });
    await writeFile(WORKERD_VARS, `ADMIN_KEY=${adminKeyForRuntime('workerd')}\n`, { mode: 0o600 });
    const migrationLog = openSync(join(STATE_DIR, 'migrations.log'), 'w', 0o600);
    const migration = spawnSync('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', join(STATE_DIR, 'wrangler-state'), '--config', WORKERD_CONFIG], {
      cwd: ROOT, env: { ...env, CI: '1' }, stdio: ['ignore', migrationLog, migrationLog],
    });
    closeSync(migrationLog);
    if (migration.status !== 0) throw new Error(`D1 migration failed; see ${join(STATE_DIR, 'migrations.log')}`);
  }
  const gateway = command.runtime === 'node'
    ? 'pnpm --filter @floway-dev/platform-node exec tsx entry.ts'
    : `pnpm exec wrangler dev --local --config .tmp/run-local-demo/wrangler.jsonc --ip 127.0.0.1 --port ${command.gatewayPort} --inspector-port ${command.gatewayPort + 1} --persist-to .tmp/run-local-demo/wrangler-state --show-interactive-dev-session=false --test-scheduled`;
  const log = openSync(LOG_PATH, 'a', 0o600);
  const child = spawn('pnpm', ['exec', 'concurrently', '--kill-others', '--names', 'gateway,web', gateway, `pnpm --filter @floway-dev/web run dev --host 127.0.0.1 --port ${command.webPort} --strictPort`], {
    cwd: ROOT, env, detached: true, stdio: ['ignore', log, log],
  });
  closeSync(log);
  if (child.pid === undefined) throw new Error('Could not start local demo');
  const state: DemoState = {
    pid: child.pid,
    runtime: command.runtime,
    webUrl: `http://127.0.0.1:${command.webPort}`,
    apiUrl: `http://127.0.0.1:${command.gatewayPort}`,
    adminKey: adminKeyForRuntime(command.runtime),
  };
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const [health, web, login] = await Promise.all([
        fetch(`${state.apiUrl}/api/health`),
        fetch(state.webUrl),
        fetch(`${state.apiUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: '', password: state.adminKey }) }),
      ]);
      if (health.ok && web.ok && login.ok) return report(state);
    } catch {
      // Services have not bound their sockets yet.
    }
    if (!alive(state.pid)) break;
    await sleep(250);
  }
  await terminate(state.pid).catch(() => undefined);
  await rm(STATE_DIR, { recursive: true, force: true });
  throw new Error(`Local demo did not become ready; see ${LOG_PATH}`);
};

const main = async (): Promise<void> => {
  const command = parseCommand(process.argv.slice(2));
  if (command.name === 'help') {
    process.stdout.write(usage);
    return;
  }
  const state = await readState();
  if (command.name === 'up') {
    process.stdout.write(`${await start(command)}\n`);
    // Undici keeps keep-alive sockets alive after the readiness checks. The
    // services are detached, so terminate only this completed launcher process.
    process.exit(0);
  } else if (command.name === 'status') {
    process.stdout.write(`${state === null ? JSON.stringify({ running: false }) : report(state)}\n`);
  } else {
    if (state === null) return;
    await terminate(state.pid);
    await rm(STATE_DIR, { recursive: true, force: true });
    process.stdout.write(`Stopped ${state.webUrl}.\n`);
  }
};

if (process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
