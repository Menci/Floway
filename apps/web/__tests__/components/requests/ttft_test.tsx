import { screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { ApiKey } from '../../../src/api/types';
import { RequestDetailPanel } from '../../../src/components/requests/detail';
import { RequestListPanel } from '../../../src/components/requests/list';
import { renderInApp } from '../../render';
import type { DumpMetadata, DumpRecord } from '@floway-dev/gateway/dump-types';

vi.mock('../../../src/components/ui/body-editor', () => ({
  default: ({ text, toolbarStart }: { text: string; toolbarStart?: ReactNode }) => (
    <>{toolbarStart}<pre data-testid="body-content">{text}</pre></>
  ),
}));

const testApiKey: ApiKey = {
  id: 'key-1',
  name: 'Default Key',
  key: 'floway-test-key-1234',
  created_at: '2026-01-01T00:00:00.000Z',
  last_used_at: null,
  upstream_ids: null,
  dump_retention_seconds: 3600,
  responses_retention_seconds: 0,
};

const makeRecordMeta = (id: string, ttftMs: number | null): DumpMetadata => ({
  id,
  startedAt: 1000,
  completedAt: 3000,
  method: 'POST',
  path: '/v1/chat/completions',
  status: 200,
  model: 'gpt-4o',
  inputTokens: 10,
  outputTokens: 20,
  requestBytes: 100,
  responseBytes: 200,
  durationMs: 2000,
  ttftMs,
  error: null,
  targetApi: 'openaiChatCompletions',
  upstream: null,
});

const makeFullRecord = (id: string, ttftMs: number | null): DumpRecord => ({
  meta: makeRecordMeta(id, ttftMs),
  request: { method: 'POST', path: '/v1/chat/completions', headers: [], body: { encoding: 'utf8', data: '{}' } },
  response: { status: 200, headers: [], body: { type: 'stream', events: [] } },
  capture: {
    exchanges: [],
    response: { body: { encoding: 'utf8', data: '' }, complete: true, error: null },
  },
});

describe('requests TTFT UI presentation', () => {
  it('renders TTFT in the request list for streamed records and omits it when null', () => {
    const recordWithTtft = makeRecordMeta('rec-streamed', 350);
    const recordWithoutTtft = makeRecordMeta('rec-unary', null);

    renderInApp(
      <MemoryRouter>
        <RequestListPanel
          apiKeys={[testApiKey]}
          selectedKeyId={testApiKey.id}
          onKeyChange={vi.fn()}
          records={[recordWithTtft, recordWithoutTtft]}
          selectedRecordId={null}
          onRecordChange={vi.fn()}
          hasOlder={false}
          onLoadOlder={vi.fn()}
          addressOfRecord={id => `/requests/${id}`}
          error={null}
          onDismissError={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('350ms')).toBeTruthy();
    expect(screen.queryByText('0ms')).toBeNull();
  });

  it('renders TTFT in the request detail toolbar when present and omits it when null', () => {
    const streamedRecord = makeFullRecord('detail-streamed', 420);
    const { unmount } = renderInApp(
      <RequestDetailPanel
        record={streamedRecord}
        recordId="detail-streamed"
        error={null}
        collected={null}
        upstreamCollected={null}
        retainLastRecord={false}
      />,
    );

    expect(screen.getByText('420ms')).toBeTruthy();
    unmount();

    const nonStreamedRecord = makeFullRecord('detail-nonstreamed', null);
    renderInApp(
      <RequestDetailPanel
        record={nonStreamedRecord}
        recordId="detail-nonstreamed"
        error={null}
        collected={null}
        upstreamCollected={null}
        retainLastRecord={false}
      />,
    );

    expect(screen.queryByText('420ms')).toBeNull();
    expect(screen.queryByText('0ms')).toBeNull();
  });
});
