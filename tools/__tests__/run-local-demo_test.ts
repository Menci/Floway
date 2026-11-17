import { createServer } from 'node:net';
import { join } from 'node:path';

import { test } from 'vitest';

import {
  authMode,
  parseCommand,
  parseState,
  portAvailable,
  processGroupAlive,
  STATE_DIR,
  stopServices,
  workerdConfig,
} from '../../.agents/skills/run-local-demo/scripts/demo.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const validState = () => ({
  schemaVersion: 1,
  runtime: 'node',
  webUrl: 'http://127.0.0.1:5174',
  apiUrl: 'http://127.0.0.1:8788',
  adminKey: '',
  services: [
    { pid: 1234, log: join(STATE_DIR, 'gateway.log') },
    { pid: 1235, log: join(STATE_DIR, 'web.log') },
  ],
  startedAt: '2026-11-17T13:00:00.000Z',
});

test('default up selects Node, Vite, and the documented ports', () => {
  assertEquals(parseCommand(['up']), { command: 'up', runtime: 'node', gatewayPort: 8788, webPort: 5174 });
});

test('up accepts workerd and an explicit port pair', () => {
  assertEquals(parseCommand(['up', '--runtime', 'workerd', '--gateway-port', '18788', '--web-port', '15174']), {
    command: 'up', runtime: 'workerd', gatewayPort: 18788, webPort: 15174,
  });
});

test('up rejects an unknown runtime and an equal port pair', () => {
  assertThrows(() => parseCommand(['up', '--runtime', 'deno']), Error, '--runtime must be node or workerd');
  assertThrows(() => parseCommand(['up', '--gateway-port', '5174', '--web-port', '5174']), Error, 'must differ');
});

test('up rejects a non-port value at the CLI boundary', () => {
  assertThrows(() => parseCommand(['up', '--gateway-port', '0']), Error, 'integer from 1 to 65535');
  assertThrows(() => parseCommand(['up', '--web-port', '5174.5']), Error, 'integer from 1 to 65535');
});

test('status and stop accept no options', () => {
  assertEquals(parseCommand(['status']), { command: 'status' });
  assertEquals(parseCommand(['stop']), { command: 'stop' });
  assertThrows(() => parseCommand(['status', '--runtime', 'node']), Error, 'status accepts no options');
});

test('help is available without reaching argument parsing', () => {
  assertEquals(parseCommand(['--help']), { command: 'help' });
  assertEquals(parseCommand(['-h']), { command: 'help' });
});

test('empty admin key means blank-password mode and a generated key is reported as a key', () => {
  assertEquals(authMode(''), 'blank-password');
  assertEquals(authMode('0123456789abcdef'), 'admin-key');
});

test('workerd config declares the platform KV binding and local D1 migrations', () => {
  const config = workerdConfig('/checkout') as {
    d1_databases: Array<{ binding: string; migrations_dir: string }>;
    kv_namespaces: Array<{ binding: string }>;
  };
  assertEquals(config.d1_databases[0]?.binding, 'DB');
  assertEquals(config.d1_databases[0]?.migrations_dir, join('/checkout', 'packages', 'gateway', 'migrations'));
  assertEquals(config.kv_namespaces[0]?.binding, 'KV');
});

test('state parsing preserves the full admin key', () => {
  const key = 'a'.repeat(64);
  const state = parseState({ ...validState(), adminKey: key });
  assertEquals(state.adminKey, key);
});

test('state parsing refuses a log path outside the demo directory', () => {
  assertThrows(() => parseState({
    ...validState(),
    services: [{ pid: 1234, log: join(STATE_DIR, '..', 'other.log') }],
  }), Error, 'points outside');
});

test('state parsing refuses malformed process ids and runtime names', () => {
  assertThrows(() => parseState({ ...validState(), runtime: 'workers' }), Error, 'unsupported schema');
  assertThrows(() => parseState({
    ...validState(),
    services: [{ pid: 0, log: join(STATE_DIR, 'gateway.log') }],
  }), Error, 'invalid');
});

test('port availability reflects whether a loopback listener exists', async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected an IP socket address');
  try {
    assertEquals(await portAvailable(address.port), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  assertEquals(await portAvailable(address.port), true);
});

test('stopping an already-dead recorded process group is idempotent', async () => {
  await stopServices({
    ...parseState(validState()),
    services: [{ pid: 999_999_999, log: join(STATE_DIR, 'gateway.log') }],
  });
  assertEquals(processGroupAlive(999_999_999), false);
});
