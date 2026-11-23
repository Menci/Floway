import { expect, test } from 'vitest';

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

test('local workerd provisions the live log stream binding and its SQLite class', () => {
  expect(workerdConfig('/worktree')).toMatchObject({
    durable_objects: {
      bindings: expect.arrayContaining([{ name: 'LOG_STREAM_DO', class_name: 'LogStreamDO' }]),
    },
    migrations: expect.arrayContaining([{ tag: 'v2', new_sqlite_classes: ['LogStreamDO'] }]),
  });
});
