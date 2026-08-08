import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, type ParseError } from 'jsonc-parser';

import type { DatabaseIdentityD1, DatabaseValue, SqlStatement, StatementResult, ToolDatabase } from './database.ts';
import { inputError, ToolError } from './errors.ts';

interface D1Binding {
  binding: string;
  database_id: string;
  database_name: string;
  preview_database_id?: string;
}

interface WranglerResult {
  results?: unknown;
  success?: unknown;
  meta?: { changes?: unknown };
}

type ProcessRunner = (command: string, args: readonly string[], cwd: string) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

const defaultRunner: ProcessRunner = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', code => resolve({ exitCode: code ?? 1, stdout, stderr }));
});

const sqlLiteral = (value: DatabaseValue): string => {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw inputError('invalid-sql-number', 'SQL parameters must be finite numbers');
    return String(value);
  }
  if (typeof value === 'string') {
    return `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`;
  }
  return `X'${Buffer.from(value).toString('hex')}'`;
};

export const renderD1Statement = ({ sql, params = [] }: SqlStatement): string => {
  let rendered = '';
  let parameterIndex = 0;
  let quote: "'" | '"' | '`' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (lineComment) {
      rendered += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      rendered += char;
      if (char === '*' && next === '/') {
        rendered += next;
        index++;
        blockComment = false;
      }
      continue;
    }
    if (quote !== null) {
      rendered += char;
      if (char === quote) {
        if (next === quote) {
          rendered += next;
          index++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === '-' && next === '-') {
      rendered += char + next;
      index++;
      lineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      rendered += char + next;
      index++;
      blockComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      rendered += char;
      continue;
    }
    if (char === '?') {
      if (parameterIndex >= params.length) throw inputError('missing-sql-parameter', 'SQL statement has more placeholders than parameters');
      rendered += sqlLiteral(params[parameterIndex++]!);
      continue;
    }
    rendered += char;
  }

  if (parameterIndex !== params.length) throw inputError('unused-sql-parameter', 'SQL statement has more parameters than placeholders');
  return rendered;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const findWranglerResult = (value: unknown): WranglerResult => {
  if (Array.isArray(value)) {
    const matches = value.flatMap(item => {
      try { return [findWranglerResult(item)]; } catch { return []; }
    });
    if (matches.length === 1) return matches[0]!;
    throw new Error(`Expected one Wrangler result, received ${matches.length}`);
  }
  if (isRecord(value) && ('results' in value || 'success' in value || 'meta' in value)) return value as WranglerResult;
  throw new Error('Wrangler JSON did not contain a D1 result');
};

const parseWranglerResult = <Row>(stdout: string): StatementResult<Row> => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch (cause) {
    throw new ToolError('wrangler-json', 'Wrangler returned malformed JSON', 1, { cause });
  }
  let result: WranglerResult;
  try {
    result = findWranglerResult(decoded);
  } catch (cause) {
    throw new ToolError('wrangler-result', 'Wrangler returned an unexpected D1 result', 1, { cause });
  }
  if (result.success === false) throw new ToolError('d1-query-failed', 'D1 reported an unsuccessful query', 1);
  const rows = result.results === undefined
    ? []
    : Array.isArray(result.results) && result.results.every(isRecord)
      ? result.results as Row[]
      : (() => { throw new ToolError('wrangler-rows', 'Wrangler returned malformed D1 rows', 1); })();
  const changes = result.meta?.changes;
  return { rows, changes: typeof changes === 'number' ? changes : null };
};

const parseD1Binding = async (configPath: string, binding: string): Promise<{
  configPath: string;
  binding: D1Binding;
  snapshot: Record<string, unknown>;
}> => {
  const canonicalPath = await realpath(configPath).catch(() => {
    throw inputError('wrangler-config-missing', `Wrangler config does not exist: ${configPath}`);
  });
  const source = await readFile(canonicalPath, 'utf8');
  const errors: ParseError[] = [];
  const config: unknown = parse(source, errors);
  if (errors.length > 0 || !isRecord(config) || !Array.isArray(config.d1_databases)) {
    throw inputError('wrangler-config-invalid', `Wrangler config has no valid d1_databases array: ${canonicalPath}`);
  }
  const row = config.d1_databases.find(candidate => isRecord(candidate) && candidate.binding === binding);
  if (!isRecord(row) || typeof row.binding !== 'string' || typeof row.database_id !== 'string' || typeof row.database_name !== 'string') {
    throw inputError('d1-binding-missing', `Wrangler config has no complete D1 binding named ${binding}`);
  }
  if (row.preview_database_id !== undefined && typeof row.preview_database_id !== 'string') {
    throw inputError('d1-preview-database-id', `D1 binding ${binding} has an invalid preview_database_id`);
  }
  if ([row.database_id, row.database_name, row.preview_database_id].some(value =>
    typeof value === 'string' && /^<YOUR_[A-Z0-9_]+>$/.test(value))) {
    throw inputError('d1-binding-placeholder', `D1 binding ${binding} still contains a placeholder`);
  }
  const snapshot = {
    name: typeof config.name === 'string' ? config.name : 'floway-tools',
    compatibility_date: typeof config.compatibility_date === 'string' ? config.compatibility_date : '2025-01-01',
    ...(typeof config.account_id === 'string' ? { account_id: config.account_id } : {}),
    d1_databases: [row],
  };
  return { configPath: canonicalPath, binding: row as unknown as D1Binding, snapshot };
};

export const openD1Database = async (options: {
  binding: string;
  configPath: string;
  location: 'local' | 'remote';
  persistTo?: string;
  runner?: ProcessRunner;
}): Promise<ToolDatabase> => {
  const resolved = await parseD1Binding(options.configPath, options.binding);
  const identity: DatabaseIdentityD1 = {
    kind: 'd1',
    binding: resolved.binding.binding,
    configPath: resolved.configPath,
    databaseId: options.location === 'local'
      ? resolved.binding.preview_database_id ?? resolved.binding.database_id
      : resolved.binding.database_id,
    databaseName: resolved.binding.database_name,
    location: options.location,
    ...(options.persistTo !== undefined ? { persistTo: await realpath(options.persistTo) } : {}),
  };
  if (identity.location === 'local' && identity.persistTo === undefined) {
    throw inputError('d1-local-persist-to', 'Local D1 requires an explicit existing --persist-to directory');
  }
  const runner = options.runner ?? defaultRunner;
  const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const snapshotsRoot = join(workspaceRoot, '.tmp');
  await mkdir(snapshotsRoot, { recursive: true });
  const snapshotDirectory = await mkdtemp(join(snapshotsRoot, 'wrangler-d1-'));
  const snapshotConfigPath = join(snapshotDirectory, 'wrangler.json');
  await writeFile(snapshotConfigPath, JSON.stringify(resolved.snapshot), { encoding: 'utf8', mode: 0o600 });
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  let previousExecution: Promise<void> = Promise.resolve();

  const runStatement = async <Row>(statement: SqlStatement): Promise<StatementResult<Row>> => {
    const args = [
      'exec', 'wrangler', 'd1', 'execute', identity.binding,
      `--${identity.location}`,
      '--json',
      '--config', snapshotConfigPath,
      '--command', renderD1Statement(statement),
      ...(identity.persistTo !== undefined ? ['--persist-to', identity.persistTo] : []),
    ];
    const result = await runner(pnpm, args, workspaceRoot);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
      throw new ToolError('wrangler-exit', `Wrangler D1 execution failed: ${detail}`, 1);
    }
    return parseWranglerResult<Row>(result.stdout);
  };
  const execute = <Row>(statement: SqlStatement): Promise<StatementResult<Row>> => {
    const result = previousExecution.then(() => runStatement<Row>(statement));
    previousExecution = result.then(() => {}, () => {});
    return result;
  };

  return {
    identity,
    query: execute,
    execute,
    close: async () => {
      await previousExecution;
      await rm(snapshotDirectory, { recursive: true, force: true });
    },
  };
};
