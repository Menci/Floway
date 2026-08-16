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

const edgeRecord: DumpRecord = {
  shape: 'edge',
  meta,
  request: {
    method: 'POST',
    path: '/v1/embeddings',
    headers: [['content-type', 'application/json']],
    body: { encoding: 'utf8', data: '{"input":"hi"}' },
  },
  response: {
    status: 200,
    headers: [['content-type', 'application/json']],
    body: { type: 'bytes', body: { encoding: 'utf8', data: '{"object":"list"}' } },
  },
};

const runRecord: DumpRecord = {
  shape: 'run',
  meta,
  events: '{"type":"stage.entered","stageId":1,"name":"serve","parentStageId":null}\n'
    + '{"type":"object","fromObjectId":1,"nodes":[{"model":"text-embedding-3-small"}]}\n'
    + '{"type":"stage.leaved","stageId":1,"facts":{"response.http.status":200}}\n',
};

const panel = (record: DumpRecord) =>
  renderInApp(<RequestDetailPanel collected={null} error={null} record={record} recordId={record.meta.id} retainLastRecord={false} />);

// The shape follows the endpoint, so the panel is handed both and has to tell
// them apart: an endpoint on the onion is recorded as its two edges, a pipelined
// one as the whole run.
describe('request detail panel', () => {
  it('draws the two edges of an edge-shaped record', () => {
    const { container } = panel(edgeRecord);
    const headings = [...container.querySelectorAll('h3')].map(node => node.textContent);
    expect(headings).toEqual(['Request', 'Request body', 'Response', 'Response body']);
    expect(container.textContent).toContain('"input": "hi"');
    expect(container.textContent).toContain('"object": "list"');
  });

  it('draws the event stream of a run-shaped record', () => {
    const { container } = panel(runRecord);
    const headings = [...container.querySelectorAll('h3')].map(node => node.textContent);
    expect(headings).toEqual(['Run']);
    // One block per NDJSON line, each labelled with the event's own kind.
    expect([...container.querySelectorAll('pre')]).toHaveLength(3);
    expect(container.textContent).toContain('stage.entered');
    expect(container.textContent).toContain('response.http.status');
    // Nothing from the edge shape leaks into it: a run has no header tables and
    // no separate request body.
    expect(container.querySelector('table')).toBe(null);
  });

  it('says so when a run recorded no events at all', () => {
    const { container } = panel({ shape: 'run', meta, events: '' });
    expect(container.textContent).toContain('This run recorded no events.');
  });
});
