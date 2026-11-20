import { describe, expect, it } from 'vitest';

import { renderRunEvents } from '../../../src/components/requests/run-render';

// The stored record is NDJSON, one event per line, and each line is also one SSE
// `data:` payload — so this is the same reading a live observer will do.
describe('run event reader', () => {
  it('names what each of the six event kinds is about', () => {
    const events = renderRunEvents([
      '{"type":"stage.entered","stageId":1,"name":"serve","parentStageId":null}',
      '{"type":"stage.leaved","stageId":1,"facts":{}}',
      '{"type":"stage.log","stageId":1,"level":"warn","message":"retrying"}',
      '{"type":"object","fromObjectId":97,"nodes":[]}',
      '{"type":"stream.frame","streamId":3,"frames":[]}',
      '{"type":"stream.end","streamId":3}',
      '',
    ].join('\n'));

    expect(events.map(event => [event.type, event.subject])).toEqual([
      ['stage.entered', 'serve'],
      ['stage.leaved', '#1'],
      ['stage.log', 'warn'],
      ['object', '#97'],
      ['stream.frame', '#3'],
      ['stream.end', '#3'],
    ]);
    expect(events.every(event => event.parseError === null)).toBe(true);
  });

  it('shows a line it cannot parse as it was stored, and says why', () => {
    const [event] = renderRunEvents('{"type":"stage.entered",\n');
    expect(event?.text).toBe('{"type":"stage.entered",');
    expect(event?.parseError).toBeTruthy();
  });
});
