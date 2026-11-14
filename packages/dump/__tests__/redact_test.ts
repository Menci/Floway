import { expect, test } from 'vitest';

import { REDACTED_HEADER_VALUE, redactRunCredentials } from '../src/index.ts';
import { createRunReader, encodeRun, move, secret, toNdjson, type DumpEvent, type Event } from '@floway-dev/pipeline';

const exchange = {
  type: 'response',
  status: 200,
  statusText: 'OK',
  headers: [['Set-Cookie', 'session=operator'], ['x-request-id', 'trace']],
  body: null,
};

const run = (): Event[] => [
  {
    type: 'stage.entered',
    stageId: 1,
    name: 'call',
    parentStageId: null,
    facts: move({
      'ingress.http.headers': [['authorization', 'Bearer client-key']],
      'request.http.headers': [['authorization', secret('Bearer operator-token')], ['x-api-key', 'operator-fixed-key'], ['accept', 'application/json']],
    }),
  },
  { type: 'stage.leaved', stageId: 1, facts: move({ 'response.http.exchange': exchange, 'response.http.headers': exchange.headers }) },
];

const read = (ndjson: string) => {
  const reader = createRunReader();
  return ndjson.split('\n').filter(Boolean).map(line => reader(JSON.parse(line) as DumpEvent)).flatMap(event => event === null || !('facts' in event) ? [] : [event.facts]);
};

test('upstream credential headers are redacted in every node that holds them', () => {
  const redacted = redactRunCredentials(toNdjson(encodeRun(run())));
  const [entered, leaved] = read(redacted);
  expect(entered!['ingress.http.headers']).toEqual([['authorization', 'Bearer client-key']]);
  const upstream = entered!['request.http.headers'] as unknown[][];
  expect(upstream[1]).toEqual(['x-api-key', REDACTED_HEADER_VALUE]);
  expect(upstream[2]).toEqual(['accept', 'application/json']);
  expect((leaved!['response.http.exchange'] as typeof exchange).headers).toEqual([['Set-Cookie', REDACTED_HEADER_VALUE], ['x-request-id', 'trace']]);
  expect(leaved!['response.http.headers']).toEqual([['Set-Cookie', REDACTED_HEADER_VALUE], ['x-request-id', 'trace']]);
  expect(redacted).not.toContain('operator');
});
