import { join } from 'node:path';

import { test } from 'vitest';

import { adminKeyForRuntime, parseCommand, workerdConfig } from '../../src/local-demo/cli.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('local demo defaults to Node, Vite, and the fixed ports', () => {
  assertEquals(parseCommand(['up']), { name: 'up', runtime: 'node', gatewayPort: 8788, webPort: 5174 });
});

test('local demo selects workerd explicitly and validates ports', () => {
  assertEquals(parseCommand(['up', '--runtime', 'workerd', '--gateway-port', '18788', '--web-port', '15174']), {
    name: 'up', runtime: 'workerd', gatewayPort: 18788, webPort: 15174,
  });
  assertThrows(() => parseCommand(['up', '--runtime', 'workers']), Error, '--runtime must be node or workerd');
  assertThrows(() => parseCommand(['up', '--gateway-port', '0']), Error, 'ports must be integers from 1 to 65535');
  assertThrows(() => parseCommand(['up', '--gateway-port', '5174', '--web-port', '5174']), Error, 'must differ');
});

test('local demo authentication is fixed by runtime', () => {
  assertEquals(adminKeyForRuntime('node'), '');
  assertEquals(adminKeyForRuntime('workerd'), 'admin');
});

test('help does not require a running instance', () => {
  assertEquals(parseCommand(['--help']), { name: 'help' });
  assertEquals(parseCommand(['-h']), { name: 'help' });
});

test('workerd config binds the Cloudflare dependencies and local migrations', () => {
  const config = workerdConfig('/checkout') as {
    d1_databases: Array<{ binding: string; migrations_dir: string }>;
    kv_namespaces: Array<{ binding: string }>;
  };
  assertEquals(config.d1_databases[0]?.binding, 'DB');
  assertEquals(config.d1_databases[0]?.migrations_dir, join('/checkout', 'packages', 'gateway', 'migrations'));
  assertEquals(config.kv_namespaces[0]?.binding, 'KV');
});
