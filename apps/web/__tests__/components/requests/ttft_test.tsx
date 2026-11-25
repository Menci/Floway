import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, test, vi } from 'vitest';

import type { ApiKey } from '../../../src/api/types';
import { RequestListPanel } from '../../../src/components/requests/list';
import { renderInApp } from '../../render';
import type { PipelineDumpMetadata } from '@floway-dev/gateway/browser';

const testApiKey: ApiKey = {
  id: 'key-1', name: 'Default Key', key: 'floway-test-key-1234', created_at: '2026-01-01T00:00:00.000Z',
  last_used_at: null, upstream_ids: null, randomize_upstreams: false,
  dump_retention_seconds: 3600, responses_retention_seconds: 0,
};

const record = (id: string, ttftMs: number | null): PipelineDumpMetadata => ({
  id, startedAt: 1000, completedAt: 3000, method: 'POST', path: '/v1/chat/completions',
  status: 200, model: 'test-model', durationMs: 2000, ttftMs,
  requestBytes: 100, responseBytes: 200, inputTokens: 10, outputTokens: 20, error: null, upstream: null,
});

test('displays first-frame timing only for requests with a recorded value', () => {
  renderInApp(
    <MemoryRouter>
      <RequestListPanel
        apiKeys={[testApiKey]}
        selectedKeyId={testApiKey.id}
        onKeyChange={vi.fn()}
        records={[record('streamed', 350), record('unary', null)]}
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

  expect(screen.getByText('350ms')).not.toBeNull();
  expect(screen.queryByText('0ms')).toBeNull();
});
