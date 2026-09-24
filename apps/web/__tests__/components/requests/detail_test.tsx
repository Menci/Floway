import { fireEvent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RequestDetailPanel } from '../../../src/components/requests/detail';
import { renderInApp } from '../../render';
import type { DumpRecord } from '@floway-dev/gateway/dump-types';

vi.mock('../../../src/components/ui/body-editor', () => ({ default: ({ text, toolbarStart }: { text: string; toolbarStart?: ReactNode }) => <>{toolbarStart}<pre data-testid="body-content">{text}</pre></> }));

const record: DumpRecord = {
  meta: { id: 'detail', method: 'POST', path: '/v1/chat/completions', startedAt: 0, completedAt: 1, status: 200, upstream: null, model: 'm', inputTokens: null, outputTokens: null, requestBytes: 0, responseBytes: 0, durationMs: 1, error: null },
  request: { method: 'POST', path: '/v1/chat/completions', headers: [], body: { encoding: 'utf8', data: '{"client":"large request"}' } },
  response: { status: 200, headers: [], body: { type: 'stream', events: [] } },
  capture: { exchanges: [{ upstreamId: 'u', request: { url: 'https://upstream.test', method: 'POST', headers: [], body: { encoding: 'utf8', data: '{"upstream":"translated request"}' } }, response: { status: 200, headers: [], body: { encoding: 'utf8', data: 'data: {broken\n' }, complete: false, error: null }, error: null }], response: { body: { encoding: 'utf8', data: 'data: downstream\n' }, complete: true, error: null } },
};

describe('request detail navigation', () => {
  it('opens each body directly and preserves malformed raw response text', async () => {
    renderInApp(<RequestDetailPanel record={record} recordId="detail" error={null} collected={{ result: { content: 'parsed response' }, truncated: true, error: null }} upstreamCollected={null} exchangeStreams={[{ events: null, collected: null, error: null }]} retainLastRecord={false} />);
    expect((await screen.findByTestId('body-content')).textContent).toContain('parsed response');
    expect(screen.queryByText('large request')).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: 'Request details' }));
    fireEvent.click(screen.getByRole('option', { name: 'Client request' }));
    expect((await screen.findByTestId('body-content')).textContent).toContain('large request');
    fireEvent.click(screen.getByRole('combobox', { name: 'Request details' }));
    fireEvent.click(screen.getByRole('option', { name: 'Upstream response' }));
    expect((await screen.findByTestId('body-content')).textContent).toContain('data: {broken\n');
    fireEvent.click(screen.getByRole('button', { name: 'Issues (1)' }));
    expect(screen.getByText('Capture ended before EOF. These are the bytes received so far.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Request details' }));
    fireEvent.click(screen.getByRole('option', { name: 'Upstream request' }));
    expect((await screen.findByTestId('body-content')).textContent).toContain('translated request');
    fireEvent.click(screen.getByRole('combobox', { name: 'Request details' }));
    fireEvent.click(screen.getByRole('option', { name: 'Client response' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Response body view' }));
    fireEvent.click(screen.getByRole('option', { name: 'Raw bytes' }));
    expect((await screen.findByTestId('body-content')).textContent).toBe('data: downstream\n');
  });
});

it('keeps legacy upstream streams readable without a raw exchange', async () => {
  const legacy = { ...record, capture: undefined, response: { ...record.response, upstream: { status: 200, headers: [], body: { type: 'stream' as const, events: [] } } } };
  renderInApp(<RequestDetailPanel record={legacy} recordId="detail" error={null} collected={null} upstreamCollected={{ result: { content: 'legacy output' }, error: null, truncated: false }} exchangeStreams={[]} retainLastRecord={false} />);
  fireEvent.click(screen.getByRole('combobox', { name: 'Request details' }));
  fireEvent.click(screen.getByRole('option', { name: 'Upstream response' }));
  expect((await screen.findByTestId('body-content')).textContent).toContain('legacy output');
});

it('switches upstream attempts without showing the last attempt’s payload', async () => {
  const multiple = {
    ...record, capture: {
      ...record.capture!, exchanges: [
        { ...record.capture!.exchanges[0]!, request: { ...record.capture!.exchanges[0]!.request, body: { encoding: 'utf8' as const, data: 'first attempt' } } },
        { ...record.capture!.exchanges[0]!, request: { ...record.capture!.exchanges[0]!.request, body: { encoding: 'utf8' as const, data: 'second attempt' } } },
      ],
    },
  };
  renderInApp(<RequestDetailPanel record={multiple} recordId="detail" error={null} collected={null} upstreamCollected={null} exchangeStreams={[{ events: null, collected: null, error: null }, { events: null, collected: null, error: null }]} retainLastRecord={false} />);
  fireEvent.click(screen.getByRole('combobox', { name: 'Request details' }));
  fireEvent.click(screen.getByRole('option', { name: 'Upstream request' }));
  expect((await screen.findByTestId('body-content')).textContent).toContain('second attempt');
  fireEvent.click(screen.getByRole('combobox', { name: 'Upstream calls' }));
  fireEvent.click(screen.getAllByRole('option')[0]!);
  expect((await screen.findByTestId('body-content')).textContent).toContain('first attempt');
});

it('surfaces Events and Collected views for a native upstream SSE exchange', async () => {
  const sse = 'event: response.created\ndata: {"type":"response.created","response":{"id":"r","status":"in_progress"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","usage":{"input_tokens":5,"output_tokens":7,"total_tokens":12}}}\n\ndata: [DONE]\n\n';
  const native = {
    ...record,
    capture: {
      exchanges: [{
        upstreamId: 'u',
        request: { url: 'https://upstream.test/v1/responses', method: 'POST', headers: [], body: { encoding: 'utf8' as const, data: '{}' } },
        response: { status: 200, headers: [['content-type', 'text/event-stream']] as Array<[string, string]>, body: { encoding: 'utf8' as const, data: sse }, complete: true, error: null },
        error: null,
      }],
    },
    response: { status: 200, headers: [], body: { type: 'stream' as const, events: [] } },
  };
  const events = [
    { frame: { type: 'event' as const, event: { type: 'response.created', response: { id: 'r', status: 'in_progress' } } }, ts: 0 },
    { frame: { type: 'event' as const, event: { type: 'response.completed', response: { id: 'r', status: 'completed', usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } } } }, ts: 0 },
    { frame: { type: 'done' as const }, ts: 0 },
  ];
  renderInApp(<RequestDetailPanel record={native} recordId="detail" error={null} collected={null} upstreamCollected={null} exchangeStreams={[{ events, collected: { result: { id: 'r', status: 'completed', usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } }, error: null, truncated: false }, error: null }]} retainLastRecord={false} />);
  fireEvent.click(screen.getByRole('combobox', { name: 'Request details' }));
  fireEvent.click(screen.getByRole('option', { name: 'Upstream response' }));
  // The view dropdown offers an Events option for the parsed upstream stream.
  fireEvent.click(screen.getByRole('combobox', { name: 'Response body view' }));
  fireEvent.click(screen.getByRole('option', { name: /Events/ }));
  expect(await screen.findByRole('button', { name: /#1 response.created/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /#2 response.completed/ })).toBeTruthy();
});
