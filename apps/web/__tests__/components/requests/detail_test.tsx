import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RequestDetailPanel } from '../../../src/components/requests/detail';
import { renderInApp } from '../../render';
import type { DumpRecord } from '@floway-dev/gateway/dump-types';

vi.mock('../../../src/components/ui/body-editor', () => ({ default: ({ text }: { text: string }) => <pre data-testid="body-content">{text}</pre> }));

const record: DumpRecord = {
  meta: { id: 'detail', method: 'POST', path: '/v1/chat/completions', startedAt: 0, completedAt: 1, status: 200, upstream: null, model: 'm', inputTokens: null, outputTokens: null, requestBytes: 0, responseBytes: 0, durationMs: 1, error: null },
  events: '{"type":"stage.entered","stageId":1,"name":"serve","parentStageId":null}\n'
    + '{"type":"stage.leaved","stageId":1,"facts":{"response.http.status":200}}\n',
};

describe('request detail navigation', () => {
  it('shows run facts, searches events, and opens the collected client response', async () => {
    renderInApp(<RequestDetailPanel record={record} recordId="detail" error={null} collected={{ result: { content: 'parsed response' }, truncated: false, error: null }} retainLastRecord={false} />);
    expect(screen.getByRole('button', { name: '#1 stage.entered serve' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Search events' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search events' }), { target: { value: 'response.http.status' } });
    expect(screen.getByText('1 / 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox', { name: 'Response body view' }));
    fireEvent.click(screen.getByRole('option', { name: 'Collected' }));
    expect((await screen.findByTestId('body-content')).textContent).toContain('parsed response');
  });

  it('masks credential headers in rendered facts', () => {
    const secret = 'Bearer private-request-token-1234567890';
    const events = [
      { type: 'object', fromObjectId: 1, nodes: [[['authorization', secret]]] },
      { type: 'stage.entered', stageId: 1, name: 'serve', parentStageId: null, facts: { 'ingress.http.headers': { $: 1 } } },
    ].map(event => `${JSON.stringify(event)}\n`).join('');
    const view = renderInApp(<RequestDetailPanel record={{ ...record, events }} recordId="detail" error={null} collected={null} retainLastRecord={false} />);
    expect(view.container.textContent).not.toContain(secret);
    expect(view.container.textContent).toContain('authorization');
    expect(view.container.textContent).toContain('••••');
  });

  it('distinguishes an empty run from a search with no matches', () => {
    renderInApp(<RequestDetailPanel record={{ ...record, events: '' }} recordId="detail" error={null} collected={null} retainLastRecord={false} />);
    expect(screen.getByText('This run recorded no events.')).toBeTruthy();
  });
});
