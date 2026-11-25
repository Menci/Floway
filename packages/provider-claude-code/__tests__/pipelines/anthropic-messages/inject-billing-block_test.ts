import { expect, test } from 'vitest';

import { CLAUDE_CLI_VERSION } from '../../../src/headers.ts';
import { addBillingBlock } from '../../../src/pipelines/anthropic-messages/inject-billing-block.ts';

test('starts the system array with the pinned CLI version and billing fingerprint', () => {
  const { system } = addBillingBlock({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hello world' }],
  });
  expect(system).toEqual([{
    type: 'text',
    text: expect.stringMatching(/^x-anthropic-billing-header: cc_version=[\d.]+\.[0-9a-f]{3}; cc_entrypoint=cli; cch=00000;$/),
  }]);
  expect((system as { text: string }[])[0]!.text).toContain(`cc_version=${CLAUDE_CLI_VERSION}.`);
});
