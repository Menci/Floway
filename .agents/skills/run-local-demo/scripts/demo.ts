import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const STATE_DIR = join(ROOT, '.tmp', 'run-local-demo');
export const STATE_PATH = join(STATE_DIR, 'state.json');
const WRANGLER_CONFIG_PATH = join(STATE_DIR, 'wrangler.jsonc');
const DEV_VARS_PATH = join(STATE_DIR, '.dev.vars');
const DEFAULT_GATEWAY_PORT = 8788;
const DEFAULT_WEB_PORT = 5174;
const STARTUP_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

export type Runtime = 'node' | 'workerd';

export interface ServiceState {
  pid: number;
  log: string;
}

export interface DemoState {
  schemaVersion: 1;
  runtime: Runtime;
  webUrl: string;
  apiUrl: string;
  adminKey: string;
  services: ServiceState[];
  startedAt: string;
}

type ParsedCommand =
  | { command: 'up'; runtime: Runtime; gatewayPort: number; webPort: number }
  | { command: 'status' | 'stop' }
  | { command: 'help' };

const usage = `Usage:
  pnpm --silent --filter @floway-dev/tools run local-demo up [options]
  pnpm --silent --filter @floway-dev/tools run local-demo status
  pnpm --silent --filter @floway-dev/tools run local-demo stop

Options:
  --runtime <node|workerd>  Gateway runtime (default: node)
  --gateway-port <port>     Gateway port (default: 8788)
  --web-port <port>         Vite port (default: 5174)
`;

const portNumber = (value: string | undefined, option: string): number => {
  if (value === undefined) throw new Error(`--${option} requires a port`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`--${option} must be an integer from 1 to 65535`);
  return port;
};

export const parseCommand = (args: readonly string[]): ParsedCommand => {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { command: 'help' };
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      runtime: { type: 'string' },
      'gateway-port': { type: 'string' },
      'web-port': { type: 'string' },
    },
  });
  const [command, ...extra] = parsed.positionals;
  if (command === undefined || extra.length > 0) throw new Error(usage);
  if (command === 'status' || command === 'stop') {
    if (Object.keys(parsed.values).length > 0) throw new Error(`${command} accepts no options`);
    return { command };
  }
  if (command !== 'up') throw new Error(usage);
  const runtime = parsed.values.runtime ?? 'node';
  if (runtime !== 'node' && runtime !== 'workerd') throw new Error('--runtime must be node or workerd');
  const gatewayPort = portNumber(parsed.values['gateway-port'] ?? String(DEFAULT_GATEWAY_PORT), 'gateway-port');
  const webPort = portNumber(parsed.values['web-port'] ?? String(DEFAULT_WEB_PORT), 'web-port');
  if (gatewayPort === webPort) throw new Error('--gateway-port and --web-port must differ');
  return { command, runtime, gatewayPort, webPort };
};

export const authMode = (adminKey: string): 'blank-password' | 'admin-key' =>
  adminKey === '' ? 'blank-password' : 'admin-key';

const sleep = (ms: number): Promise<void> => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

export const portAvailable = (port: number): Promise<boolean> => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') resolvePort(false);
    else reject(error);
  });
  server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
    server.close(error => {
      if (error) reject(error);
      else resolvePort(true);
    });
  });
});

const assertPortsAvailable = async (ports: readonly number[]): Promise<void> => {
  for (const port of ports) {
    if (!(await portAvailable(port))) {
      throw new Error(`Port ${port} is already in use; choose another --gateway-port or --web-port`);
    }
  }
};

export const parseState = (value: unknown): DemoState => {
  if (typeof value !== 'object' || value === null) throw new Error('Demo state is not a JSON object');
  const record = value as Record<string, unknown>;
  const runtime = record.runtime;
  if (record.schemaVersion !== 1 || (runtime !== 'node' && runtime !== 'workerd')) throw new Error('Demo state has an unsupported schema');
  if (typeof record.webUrl !== 'string' || typeof record.apiUrl !== 'string' || typeof record.adminKey !== 'string') {
    throw new Error('Demo state is missing its URLs or authentication state');
  }
  if (!Array.isArray(record.services) || record.services.length === 0) throw new Error('Demo state has no service list');
  const services = record.services.map((service, index) => {
    if (typeof service !== 'object' || service === null) throw new Error(`Demo service ${index} is invalid`);
    const entry = service as Record<string, unknown>;
    if (!Number.isSafeInteger(entry.pid) || (entry.pid as number) <= 0 || typeof entry.log !== 'string') {
      throw new Error(`Demo service ${index} is invalid`);
    }
    const log = resolve(entry.log);
    const local = relative(STATE_DIR, log);
    if (local.startsWith('..') || local === '' || local.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error(`Demo service ${index} points outside ${STATE_DIR}`);
    }
    return { pid: entry.pid as number, log };
  });
  if (typeof record.startedAt !== 'string') throw new Error('Demo state is missing startedAt');
  return {
    schemaVersion: 1,
    runtime,
    webUrl: record.webUrl,
    apiUrl: record.apiUrl,
    adminKey: record.adminKey,
    services,
    startedAt: record.startedAt,
  };
};

const readState = async (): Promise<DemoState | null> => {
  let source: string;
  try {
    source = await readFile(STATE_PATH, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return parseState(JSON.parse(source));
  } catch (error) {
    throw new Error(`Cannot parse ${STATE_PATH}`, { cause: error });
  }
};

const writeState = async (state: DemoState): Promise<void> => {
  const stage = `${STATE_PATH}.stage`;
  await writeFile(stage, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(stage, 0o600);
  await rename(stage, STATE_PATH);
};

export const processGroupAlive = (pid: number): boolean => {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const waitFor = async (description: string, check: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
};

const healthIsReady = async (apiUrl: string): Promise<boolean> => {
  try {
    const response = await fetch(`${apiUrl}/api/health`, { redirect: 'manual' });
    if (!response.ok) return false;
    const body = await response.json() as { status?: unknown; service?: unknown };
    return body.status === 'ok' && body.service === 'floway';
  } catch {
    return false;
  }
};

const webIsReady = async (webUrl: string): Promise<boolean> => {
  try {
    const response = await fetch(webUrl, { redirect: 'manual' });
    return response.ok && (await response.text()).includes('<html');
  } catch {
    return false;
  }
};

export const loginSucceeds = async (apiUrl: string, password: string): Promise<boolean> => {
  try {
    const response = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '', password }),
    });
    if (!response.ok) return false;
    const body = await response.json() as { token?: unknown };
    return typeof body.token === 'string' && body.token.length > 0;
  } catch {
    return false;
  }
};

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  if (process.platform === 'win32') {
    process.kill(pid, signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

export const stopServices = async (state: DemoState): Promise<void> => {
  if (state.services.every(service => !processGroupAlive(service.pid))) return;
  if (process.platform === 'win32') {
    for (const service of state.services) {
      spawnSync('taskkill.exe', ['/PID', String(service.pid), '/T', '/F'], { stdio: 'ignore' });
    }
  } else {
    for (const service of state.services) signalGroup(service.pid, 'SIGTERM');
  }
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (Date.now() < deadline && state.services.some(service => processGroupAlive(service.pid))) await sleep(100);
  if (process.platform !== 'win32') {
    for (const service of state.services) if (processGroupAlive(service.pid)) signalGroup(service.pid, 'SIGKILL');
  }
  const finalDeadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (Date.now() < finalDeadline && state.services.some(service => processGroupAlive(service.pid))) await sleep(100);
  const survivors = state.services.filter(service => processGroupAlive(service.pid));
  if (survivors.length > 0) throw new Error(`Could not stop demo process groups: ${survivors.map(service => service.pid).join(', ')}`);
};

const stop = async (): Promise<string> => {
  const state = await readState();
  if (state === null) {
    await rm(STATE_DIR, { recursive: true, force: true });
    return 'No local demo state exists; nothing was running.';
  }
  await stopServices(state);
  await rm(STATE_DIR, { recursive: true, force: true });
  return `Stopped local demo at ${state.webUrl}.`;
};

const envForServices = (): NodeJS.ProcessEnv => ({
  ...process.env,
  ADMIN_KEY: '',
  NODE_ENV: 'development',
  WRANGLER_LOG_PATH: join(STATE_DIR, 'wrangler.log'),
});

const launch = (
  command: string,
  args: readonly string[],
  cwd: string,
  logPath: string,
  env: NodeJS.ProcessEnv,
): ChildProcess => {
  const log = openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(command, [...args], {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', log, log],
    });
    if (child.pid === undefined) throw new Error(`Failed to start ${command} ${args.join(' ')}`);
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
};

const startServices = (
  runtime: Runtime,
  gatewayPort: number,
  webPort: number,
): { gateway: ChildProcess; web: ChildProcess } => {
  const env = {
    ...envForServices(),
    PORT: String(gatewayPort),
    HOST: '127.0.0.1',
    FLOWAY_DB_PATH: join(STATE_DIR, 'floway.db'),
    FLOWAY_FILES_DIR: join(STATE_DIR, 'files'),
    FLOWAY_DEV_GATEWAY_ORIGIN: `http://127.0.0.1:${gatewayPort}`,
    FLOWAY_DEV_WEB_PORT: String(webPort),
  };
  const gatewayArgs = runtime === 'node'
    ? ['--filter', '@floway-dev/platform-node', 'exec', 'tsx', 'entry.ts']
    : ['exec', 'wrangler', 'dev', '--local', '--config', WRANGLER_CONFIG_PATH, '--ip', '127.0.0.1', '--port', String(gatewayPort), '--inspector-port', String(gatewayPort + 1), '--persist-to', join(STATE_DIR, 'wrangler-state'), '--show-interactive-dev-session=false', '--test-scheduled'];
  const gatewayCwd = runtime === 'node' ? join(ROOT, 'apps', 'platform-node') : ROOT;
  const gateway = launch('pnpm', gatewayArgs, gatewayCwd, join(STATE_DIR, 'gateway.log'), env);
  const web = launch(
    'pnpm',
    ['--filter', '@floway-dev/web', 'run', 'dev', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
    ROOT,
    join(STATE_DIR, 'web.log'),
    env,
  );
  return { gateway, web };
};

const applyWorkerdMigrations = (): void => {
  const log = openSync(join(STATE_DIR, 'migrations.log'), 'w', 0o600);
  let result;
  try {
    result = spawnSync('pnpm', [
      'exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB',
      '--local', '--persist-to', join(STATE_DIR, 'wrangler-state'), '--config', WRANGLER_CONFIG_PATH,
    ], { cwd: ROOT, env: { ...envForServices(), CI: '1' }, stdio: ['ignore', log, log] });
  } finally {
    closeSync(log);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Local D1 migration exited with status ${result.status ?? 'unknown'}; see ${join(STATE_DIR, 'migrations.log')}`);
  }
};

export const workerdConfig = (root: string): unknown => ({
  name: 'floway-local-demo',
  main: join(root, 'apps', 'platform-cloudflare', 'entry.ts'),
  // Stay on the repository example's date so the generated config never asks
  // the bundled workerd for a compatibility level it does not implement.
  compatibility_date: '2025-01-01',
  compatibility_flags: ['nodejs_compat', 'enable_ctx_exports'],
  d1_databases: [{ binding: 'DB', database_name: 'floway-local-demo', database_id: 'floway-local-demo', migrations_dir: join(root, 'packages', 'gateway', 'migrations') }],
  r2_buckets: [{ binding: 'FILES', bucket_name: 'floway-local-demo' }],
  images: { binding: 'IMAGES' },
  kv_namespaces: [{ binding: 'KV', id: 'floway-local-demo' }],
  durable_objects: { bindings: [{ name: 'EXECUTION_DO', class_name: 'ExecutionDO' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['ExecutionDO'] }],
});

const createWorkerdConfig = async (adminKey: string): Promise<void> => {
  await writeFile(WRANGLER_CONFIG_PATH, `${JSON.stringify(workerdConfig(ROOT), null, 2)}\n`, { mode: 0o600 });
  await writeFile(DEV_VARS_PATH, adminKey === '' ? '' : `ADMIN_KEY=${adminKey}\n`, { mode: 0o600 });
};

const createState = (
  runtime: Runtime,
  gatewayPort: number,
  webPort: number,
  adminKey: string,
  services: { gateway: ChildProcess; web: ChildProcess },
): DemoState => ({
  schemaVersion: 1,
  runtime,
  webUrl: `http://127.0.0.1:${webPort}`,
  apiUrl: `http://127.0.0.1:${gatewayPort}`,
  adminKey,
  services: [
    { pid: services.gateway.pid!, log: join(STATE_DIR, 'gateway.log') },
    { pid: services.web.pid!, log: join(STATE_DIR, 'web.log') },
  ],
  startedAt: new Date().toISOString(),
});

const assertAlive = (state: DemoState): void => {
  const dead = state.services.filter(service => !processGroupAlive(service.pid));
  if (dead.length > 0) throw new Error(`Demo process groups exited before becoming ready: ${dead.map(service => `${service.pid} (${service.log})`).join(', ')}`);
};

const waitUntilReady = async (state: DemoState): Promise<void> => {
  await waitFor('the local demo to become healthy', async () => {
    assertAlive(state);
    return await healthIsReady(state.apiUrl) && await webIsReady(state.webUrl);
  });
};

const start = async (parsed: Extract<ParsedCommand, { command: 'up' }>): Promise<string> => {
  const existing = await readState();
  if (existing !== null) {
    if (existing.services.some(service => processGroupAlive(service.pid))) {
      throw new Error(`A local demo is already running at ${existing.webUrl}; stop it before starting another`);
    }
    await stopServices(existing);
    await rm(STATE_DIR, { recursive: true, force: true });
  }
  await assertPortsAvailable([parsed.gatewayPort, parsed.webPort]);
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await rm(join(STATE_DIR, 'gateway.log'), { force: true });
  await rm(join(STATE_DIR, 'web.log'), { force: true });

  if (parsed.runtime === 'workerd') {
    await createWorkerdConfig('');
    applyWorkerdMigrations();
  }
  let state = createState(parsed.runtime, parsed.gatewayPort, parsed.webPort, '', startServices(parsed.runtime, parsed.gatewayPort, parsed.webPort));
  await writeState(state);
  try {
    await waitUntilReady(state);
    if (await loginSucceeds(state.apiUrl, '')) {
      return `${JSON.stringify({ running: true, runtime: state.runtime, webUrl: state.webUrl, apiUrl: state.apiUrl, adminKey: state.adminKey, auth: authMode(state.adminKey) }, null, 2)}\n`;
    }
    if (parsed.runtime !== 'workerd') throw new Error('Blank-password login failed on the Node runtime');

    await stopServices(state);
    const adminKey = randomBytes(32).toString('hex');
    await createWorkerdConfig(adminKey);
    state = createState(parsed.runtime, parsed.gatewayPort, parsed.webPort, adminKey, startServices(parsed.runtime, parsed.gatewayPort, parsed.webPort));
    await writeState(state);
    await waitUntilReady(state);
    await waitFor('the workerd demo to accept its generated admin key', async () => await loginSucceeds(state.apiUrl, adminKey));
    return `${JSON.stringify({ running: true, runtime: state.runtime, webUrl: state.webUrl, apiUrl: state.apiUrl, adminKey: state.adminKey, auth: authMode(state.adminKey) }, null, 2)}\n`;
  } catch (error) {
    await stopServices(state).catch(stopError => console.error('Could not clean up after startup failure:', stopError));
    await rm(STATE_DIR, { recursive: true, force: true });
    throw error;
  }
};

const status = async (): Promise<string> => {
  const state = await readState();
  if (state === null) return `${JSON.stringify({ running: false, asOf: new Date().toISOString() }, null, 2)}\n`;
  const processesRunning = state.services.every(service => processGroupAlive(service.pid));
  const healthy = processesRunning && await healthIsReady(state.apiUrl) && await webIsReady(state.webUrl);
  const auth = healthy && await loginSucceeds(state.apiUrl, state.adminKey);
  return `${JSON.stringify({
    running: processesRunning && healthy && auth,
    processesRunning,
    healthy,
    runtime: state.runtime,
    webUrl: state.webUrl,
    apiUrl: state.apiUrl,
    adminKey: state.adminKey,
    auth: auth ? authMode(state.adminKey) : 'unverified',
    startedAt: state.startedAt,
  }, null, 2)}\n`;
};

const main = async (): Promise<void> => {
  const parsed = parseCommand(process.argv.slice(2));
  if (parsed.command === 'help') process.stdout.write(usage);
  else if (parsed.command === 'stop') process.stdout.write(`${await stop()}\n`);
  else if (parsed.command === 'status') process.stdout.write(await status());
  else process.stdout.write(await start(parsed as Extract<ParsedCommand, { command: 'up' }>));
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
