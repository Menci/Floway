import { expect, it } from 'vitest';

import { redactHeaderValue } from '../../../src/components/requests/header-redact';
import { redactRunHeaders } from '../../../src/components/requests/run-redact';

it('redacts shared header string definitions while preserving unrelated payloads and references', () => {
  const secret = 'Bearer shared-token'.repeat(100);
  const events = [
    { type: 'object', fromObjectId: 1, nodes: [[{ $: 2 }, { $: 4 }], ['authorization', { $: 3 }], secret, ['content-type', 'application/json']] },
    { type: 'stage.entered', stageId: 1, name: 'entry', parentStageId: null, facts: { 'ingress.http.headers': { $: 1 }, 'request.payload': { $: 5 } } },
    { type: 'object', fromObjectId: 5, nodes: [{ text: 'payload remains exact' }] },
    { type: 'stage.leaved', stageId: 1, facts: { 'response.http.headers': { $: 1 } } },
  ];
  const source = events.map(event => `${JSON.stringify(event)}\n`).join('');
  const exported = redactRunHeaders(source);
  expect(exported).not.toContain(secret);
  expect(exported).toContain(redactHeaderValue(secret));
  expect(exported).toContain('payload remains exact');
  expect(JSON.parse(exported.split('\n')[0]!).nodes[1]).toEqual(['authorization', { $: 3 }]);
  expect(source).toContain(secret);
});

it('preserves already marked secrets and rejects missing header references', () => {
  const marked = [
    { type: 'object', fromObjectId: 1, nodes: [[{ $: 2 }], ['authorization', { $: 3 }], { $secret: { length: 10, redacted: '**********', hash: '0x123' } }] },
    { type: 'stage.leaved', stageId: 1, facts: { 'request.http.headers': { $: 1 } } },
  ].map(event => `${JSON.stringify(event)}\n`).join('');
  expect(redactRunHeaders(marked)).toBe(marked);
  expect(() => redactRunHeaders('{"type":"stage.leaved","stageId":1,"facts":{"request.http.headers":{"$":99}}}\n')).toThrow('missing object 99');
});
