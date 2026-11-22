import { test } from 'vitest';

import { CLAUDE_CLI_VERSION } from '../../../src/headers.ts';
import { injectBillingBlock } from '../../../src/stages/anthropic-messages/inject-billing-block.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('drops a single billing block as system[0] with the pinned CLI version and a 3-hex fingerprint', () => {
  const payload = injectBillingBlock({
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hello world' }],
  });

  const system = payload.system;
  if (!Array.isArray(system)) throw new Error('expected system to be an array');
  assertEquals(system.length, 1);
  const [block] = system;
  assertEquals(block!.type, 'text');
  const fp = block!.text.match(/cc_version=([\d.]+)\.([0-9a-f]{3});/);
  if (!fp) throw new Error(`expected billing text to embed version.fingerprint, got: ${block!.text}`);
  assertEquals(fp[1], CLAUDE_CLI_VERSION);
  // cch=00000 is a literal in the wire shape, not a client-computed hash.
  assertEquals(block!.text.endsWith('cch=00000;'), true);
  assertEquals(block!.text.startsWith('x-anthropic-billing-header: '), true);
});
