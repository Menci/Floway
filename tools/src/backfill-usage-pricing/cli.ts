import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { openD1Database } from './d1-database.ts';
import type { DatabaseIdentity, ToolDatabase } from './database.ts';
import { inputError, ToolError } from './errors.ts';
import { applyPlan, buildPlan, inspectDatabase, normalizeIntent, parsePlan, type BackfillIntent } from './plan.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEFAULT_WRANGLER_CONFIG = resolve(ROOT, 'wrangler.jsonc');
const INVOCATION_CWD = process.env.INIT_CWD ?? process.cwd();
const invocationPath = (path: string): string => resolve(INVOCATION_CWD, path);

const help = `Usage:
  pnpm --silent tools:backfill-usage-pricing inspect <database options>
  pnpm --silent tools:backfill-usage-pricing plan <database options> <selection options> --output <file>
  pnpm --silent tools:backfill-usage-pricing apply --plan <file>

Database options:
  --database node --database-path <sqlite file>
  --database d1 --config <wrangler.jsonc> --binding <binding> --remote
  --database d1 --config <wrangler.jsonc> --binding <binding> --local --persist-to <dir>

Selection options:
  --upstream <id> --model <public id> --model-key <wire id>
  --start-hour <YYYY-MM-DDTHH> --end-hour <YYYY-MM-DDTHH> --timezone <IANA name>
  --mode <fill|overwrite> --metric <billing metric> [--metric <billing metric> ...]
`;

const requiredString = (value: string | undefined, name: string): string => {
  if (value === undefined || value.length === 0) throw inputError('missing-option', `--${name} is required`);
  return value;
};

const parseDatabaseArgs = (args: readonly string[]): {
  database: 'node' | 'd1';
  databasePath?: string;
  binding?: string;
  configPath?: string;
  location?: 'local' | 'remote';
  persistTo?: string;
  selection: {
    upstream?: string;
    model?: string;
    modelKey?: string;
    startHour?: string;
    endHour?: string;
    timezone?: string;
    mode?: string;
    metrics?: string[];
    output?: string;
  };
} => {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      database: { type: 'string' },
      'database-path': { type: 'string' },
      binding: { type: 'string' },
      config: { type: 'string' },
      local: { type: 'boolean' },
      remote: { type: 'boolean' },
      'persist-to': { type: 'string' },
      upstream: { type: 'string' },
      model: { type: 'string' },
      'model-key': { type: 'string' },
      'start-hour': { type: 'string' },
      'end-hour': { type: 'string' },
      timezone: { type: 'string' },
      mode: { type: 'string' },
      metric: { type: 'string', multiple: true },
      output: { type: 'string' },
    },
  });
  if (parsed.positionals.length > 0) throw inputError('unexpected-arguments', `Unexpected arguments: ${parsed.positionals.join(' ')}`);
  const selection = {
    ...(parsed.values.upstream !== undefined ? { upstream: parsed.values.upstream } : {}),
    ...(parsed.values.model !== undefined ? { model: parsed.values.model } : {}),
    ...(parsed.values['model-key'] !== undefined ? { modelKey: parsed.values['model-key'] } : {}),
    ...(parsed.values['start-hour'] !== undefined ? { startHour: parsed.values['start-hour'] } : {}),
    ...(parsed.values['end-hour'] !== undefined ? { endHour: parsed.values['end-hour'] } : {}),
    ...(parsed.values.timezone !== undefined ? { timezone: parsed.values.timezone } : {}),
    ...(parsed.values.mode !== undefined ? { mode: parsed.values.mode } : {}),
    ...(parsed.values.metric !== undefined ? { metrics: parsed.values.metric } : {}),
    ...(parsed.values.output !== undefined ? { output: parsed.values.output } : {}),
  };
  const database = requiredString(parsed.values.database, 'database');
  if (database !== 'node' && database !== 'd1') throw inputError('invalid-database', '--database must be node or d1');
  if (database === 'node') {
    if (parsed.values.local || parsed.values.remote || parsed.values.binding || parsed.values.config || parsed.values['persist-to']) {
      throw inputError('node-database-options', 'Node database does not accept D1 connection options');
    }
    return {
      database,
      databasePath: invocationPath(requiredString(parsed.values['database-path'], 'database-path')),
      selection,
    };
  }
  if (parsed.values['database-path']) throw inputError('d1-database-path', 'D1 does not accept --database-path');
  if (Boolean(parsed.values.local) === Boolean(parsed.values.remote)) {
    throw inputError('d1-location', 'D1 requires exactly one of --local or --remote');
  }
  if (parsed.values.remote && parsed.values['persist-to']) throw inputError('d1-remote-persist', 'Remote D1 does not accept --persist-to');
  return {
    database,
    binding: parsed.values.binding ?? 'DB',
    configPath: invocationPath(parsed.values.config ?? DEFAULT_WRANGLER_CONFIG),
    location: parsed.values.local ? 'local' : 'remote',
    ...(parsed.values['persist-to'] !== undefined ? { persistTo: invocationPath(parsed.values['persist-to']) } : {}),
    selection,
  };
};

const openDatabase = async (
  options: ReturnType<typeof parseDatabaseArgs>,
  mode: 'read' | 'write',
): Promise<ToolDatabase> => {
  if (options.database === 'node') {
    const { openNodeDatabase } = await import('./node-database.ts');
    return await openNodeDatabase(options.databasePath!, mode);
  }
  return await openD1Database({
    binding: options.binding!,
    configPath: options.configPath!,
    location: options.location!,
    ...(options.persistTo !== undefined ? { persistTo: options.persistTo } : {}),
  });
};

const openPlanDatabase = async (identity: DatabaseIdentity): Promise<ToolDatabase> => {
  if (identity.kind === 'node') {
    const { openNodeDatabase } = await import('./node-database.ts');
    return await openNodeDatabase(identity.path, 'write');
  }
  return await openD1Database({
    binding: identity.binding,
    configPath: identity.configPath,
    location: identity.location,
    ...(identity.persistTo !== undefined ? { persistTo: identity.persistTo } : {}),
  });
};

const withDatabase = async <Result>(database: ToolDatabase, fn: () => Promise<Result>): Promise<Result> => {
  try {
    return await fn();
  } finally {
    await database.close();
  }
};

const inspect = async (args: readonly string[]): Promise<unknown> => {
  const options = parseDatabaseArgs(args);
  if (Object.keys(options.selection).length > 0) throw inputError('inspect-selection', 'inspect does not accept selection options');
  const database = await openDatabase(options, 'read');
  return await withDatabase(database, () => inspectDatabase(database));
};

const parseIntent = (selection: ReturnType<typeof parseDatabaseArgs>['selection']): { intent: BackfillIntent; output: string } => {
  const mode = requiredString(selection.mode, 'mode');
  if (mode !== 'fill' && mode !== 'overwrite') throw inputError('invalid-mode', '--mode must be fill or overwrite');
  const intent = normalizeIntent({
    upstream: requiredString(selection.upstream, 'upstream'),
    model: requiredString(selection.model, 'model'),
    modelKey: requiredString(selection.modelKey, 'model-key'),
    startHour: requiredString(selection.startHour, 'start-hour'),
    endHour: requiredString(selection.endHour, 'end-hour'),
    timezone: requiredString(selection.timezone, 'timezone'),
    mode,
    metrics: (selection.metrics ?? []) as BackfillIntent['metrics'],
  });
  return { intent, output: invocationPath(requiredString(selection.output, 'output')) };
};

const writePlan = async (path: string, plan: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'wx', 0o600).catch(cause => {
    throw new ToolError('plan-output', `Cannot create plan file ${path}`, 1, { cause });
  });
  try {
    await handle.writeFile(`${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
};

const plan = async (args: readonly string[]): Promise<unknown> => {
  const databaseOptions = parseDatabaseArgs(args);
  const { intent, output } = parseIntent(databaseOptions.selection);
  const database = await openDatabase(databaseOptions, 'read');
  const built = await withDatabase(database, () => buildPlan(database, intent));
  await writePlan(output, built.plan);
  return { schemaVersion: 1, kind: 'usage-pricing-plan-created', output, plan: built.plan };
};

const apply = async (args: readonly string[]): Promise<unknown> => {
  const parsed = parseArgs({ args: [...args], strict: true, options: { plan: { type: 'string' } } });
  const path = invocationPath(requiredString(parsed.values.plan, 'plan'));
  const saved = parsePlan(await readFile(path, 'utf8').catch(cause => {
    throw new ToolError('plan-read', `Cannot read plan file ${path}`, 1, { cause });
  }));
  const database = await openPlanDatabase(saved.database);
  return await withDatabase(database, () => applyPlan(database, saved));
};

const main = async (): Promise<unknown> => {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h') return { help };
  if (command === 'inspect') return await inspect(args);
  if (command === 'plan') return await plan(args);
  if (command === 'apply') return await apply(args);
  throw inputError('command', 'Command must be inspect, plan, or apply');
};

try {
  const result = await main();
  if (typeof result === 'object' && result !== null && 'help' in result) process.stdout.write((result as { help: string }).help);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (cause) {
  const error = cause instanceof ToolError
    ? cause
    : cause instanceof TypeError && 'code' in cause && cause.code?.toString().startsWith('ERR_PARSE_ARGS')
      ? inputError('arguments', cause.message)
      : cause instanceof Error
        ? new ToolError('unexpected', cause.message, 1, { cause })
        : new ToolError('unexpected', String(cause), 1);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, kind: 'error', code: error.code, message: error.message }, null, 2)}\n`);
  if (error.code === 'unexpected' && error.cause instanceof Error) process.stderr.write(`${error.cause.stack ?? error.cause.message}\n`);
  process.exitCode = error.exitCode;
}
