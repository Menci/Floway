import { describe, expect, it } from 'vitest';

import { RequestDetailPanel } from '../../../src/components/requests/detail';
import { renderInApp } from '../../render';
import type { DumpMetadata, DumpRecord } from '@floway-dev/gateway/dump-types';

const meta: DumpMetadata = {
  id: 'rec-1',
  startedAt: 0,
  completedAt: 10,
  method: 'POST',
  path: '/v1/embeddings',
  status: 200,
  upstream: null,
  model: 'text-embedding-3-small',
  inputTokens: 7,
  outputTokens: 0,
  requestBytes: 14,
  responseBytes: 22,
  durationMs: 10,
  error: null,
};

const runRecord: DumpRecord = {
  meta,
  events: '{"type":"stage.entered","stageId":1,"name":"serve","parentStageId":null}\n'
    + '{"type":"object","fromObjectId":1,"nodes":[{"model":"text-embedding-3-small"}]}\n'
    + '{"type":"stage.leaved","stageId":1,"facts":{"response.http.status":200}}\n',
};

const panel = (record: DumpRecord) =>
  renderInApp(<RequestDetailPanel collected={null} error={null} record={record} recordId={record.meta.id} retainLastRecord={false} />);

// A record is a whole run — every stage, both directions — and the panel draws its event
// stream, which is the whole of what it holds.
describe('request detail panel', () => {
  it('draws the event stream a record holds', () => {
    const { container } = panel(runRecord);
    const headings = [...container.querySelectorAll('h3')].map(node => node.textContent);
    // The run's own events, and the one value the frames in them add up to.
    expect(headings).toEqual(['Run', 'Collected']);
    // One block per NDJSON line, each labelled with the event's own kind.
    expect([...container.querySelectorAll('pre')]).toHaveLength(3);
    expect(container.textContent).toContain('stage.entered');
    expect(container.textContent).toContain('response.http.status');
    // The stream is the whole panel: there are no header tables and no separate body section.
    expect(container.querySelector('table')).toBe(null);
  });

  it('says so when a run recorded no events at all', () => {
    const { container } = panel({ meta, events: '' });
    expect(container.textContent).toContain('This run recorded no events.');
  });
});
