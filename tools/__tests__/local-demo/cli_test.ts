import { test } from 'vitest';

import { parseCommand, workerdConfig } from '../../src/local-demo/cli.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('local demo selects workerd explicitly and validates ports', () => {
  assertEquals(parseCommand(['up', '--runtime', 'workerd', '--gateway-port', '18788', '--web-port', '15174']), {
    name: 'up', runtime: 'workerd', gatewayPort: 18788, webPort: 15174,
  });
  assertThrows(() => parseCommand(['up', '--runtime', 'workers']), Error);
  assertThrows(() => parseCommand(['up', '--gateway-port', '0']), Error);
  assertThrows(() => parseCommand(['up', '--gateway-port', '5174', '--web-port', '5174']), Error);
});

test('workerd config declares both Durable Object namespaces', () => {
  const config = workerdConfig('/repo') as {
    durable_objects: { bindings: { name: string; class_name: string }[] };
    migrations: { tag: string; new_sqlite_classes: string[] }[];
  };
  assertEquals(config.durable_objects.bindings, [
    { name: 'EXECUTION_DO', class_name: 'ExecutionDO' },
    { name: 'LOG_STREAM_DO', class_name: 'LogStreamDO' },
  ]);
  assertEquals(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['ExecutionDO', 'LogStreamDO'] }]);
});
