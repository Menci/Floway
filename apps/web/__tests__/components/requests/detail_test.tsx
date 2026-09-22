import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RequestDetailPanel } from '../../../src/components/requests/detail';
import { renderInApp } from '../../render';
import type { DumpRecord } from '@floway-dev/gateway/dump-types';

vi.mock('../../../src/components/ui/body-editor', () => ({ default: ({ text }: { text: string }) => <pre data-testid="body-content">{text}</pre> }));

const record: DumpRecord = {
  meta: { id: 'detail', method: 'POST', path: '/v1/chat/completions', startedAt: 0, completedAt: 1, status: 200, upstream: null, model: 'm', inputTokens: null, outputTokens: null, requestBytes: 0, responseBytes: 0, durationMs: 1, error: null },
  request: { method: 'POST', path: '/v1/chat/completions', headers: [], body: { encoding: 'utf8', data: '{"client":"large request"}' } },
  response: { status: 200, headers: [], body: { type: 'stream', events: [] } },
  capture: { exchanges: [{ upstreamId: 'u', request: { url: 'https://upstream.test', method: 'POST', headers: [], body: { encoding: 'utf8', data: '{"upstream":"translated request"}' } }, response: { status: 200, headers: [], body: { encoding: 'utf8', data: 'data: {broken\n' }, complete: false, error: null }, error: null }], response: { body: { encoding: 'utf8', data: 'data: downstream\n' }, complete: true, error: null } },
};

describe('request detail navigation', () => {
  it('opens each body directly and preserves malformed raw response text', async () => {
    renderInApp(<RequestDetailPanel record={record} recordId="detail" error={null} collected={{ result: { content: 'parsed response' }, truncated: true, error: null }} upstreamCollected={null} retainLastRecord={false} />);
    expect((await screen.findByTestId('body-content')).textContent).toContain('parsed response');
    expect(screen.queryByText('large request')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Client request' }));
    expect((await screen.findByTestId('body-content')).textContent).toContain('large request');
    fireEvent.click(screen.getByRole('tab', { name: 'Upstream calls' }));
    expect((await screen.findByTestId('body-content')).textContent).toContain('data: {broken\n');
    expect(screen.getByText('Capture ended before EOF. These are the bytes received so far.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Request' }));
    expect((await screen.findByTestId('body-content')).textContent).toContain('translated request');
    fireEvent.click(screen.getByRole('tab', { name: 'Client response' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Raw bytes' }));
    expect((await screen.findByTestId('body-content')).textContent).toBe('data: downstream\n');
  });
});
