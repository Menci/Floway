import { fireEvent, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { ApiKey } from '../../../src/api/types';
import { RequestListPanel } from '../../../src/components/requests/list';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';
import type { DumpMetadata } from '@floway-dev/gateway/browser';

const apiKey = (id: string, name: string, suffix: string): ApiKey => ({
  id,
  name,
  key: `raw-${suffix}`,
  created_at: '2026-01-01T00:00:00.000Z',
  last_used_at: null,
  upstream_ids: null,
  randomize_upstreams: false,
  dump_retention_seconds: 3600,
  responses_retention_seconds: 0,
});

const record = (id: string, key: DumpMetadata['key']): DumpMetadata => ({
  id,
  startedAt: 0,
  completedAt: 0,
  method: 'POST',
  path: `/v1/${id}`,
  status: 200,
  key,
  upstream: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  requestBytes: 0,
  responseBytes: 0,
  durationMs: 0,
  error: null,
});

const keyA = apiKey('key-a', 'Key A', 'aaa1');
const keyB = apiKey('key-b', 'Key B', 'bbb2');
const refA = { id: keyA.id, name: keyA.name, suffix: 'aaa1' };
const refB = { id: keyB.id, name: keyB.name, suffix: 'bbb2' };

const renderPanel = (selectedKeyId: string | null, onKeyChange = vi.fn()) => renderInApp(
  <MemoryRouter>
    <RequestListPanel
      addressOfRecord={id => `?record=${id}`}
      apiKeys={[keyA, keyB]}
      error={null}
      hasOlder={false}
      onDismissError={vi.fn()}
      onKeyChange={onKeyChange}
      onLoadOlder={vi.fn()}
      onRecordChange={vi.fn()}
      records={[record('first', refA), record('second', refB)]}
      selectedKeyId={selectedKeyId}
      selectedRecordId={null}
    />
  </MemoryRouter>,
);

describe('all-keys request log', () => {
  it('is the default view and labels each request with its source key', () => {
    renderPanel(null);

    expect(screen.getByRole('combobox', { name: i18n.t('requests.apiKey') }).textContent).toContain(i18n.t('requests.allKeys'));
    const log = within(screen.getByRole('listbox'));
    expect(log.getByText('Key A (aaa1)')).toBeTruthy();
    expect(log.getByText('Key B (bbb2)')).toBeTruthy();
  });

  it('shows no source key on a single key\'s log', () => {
    renderPanel(keyA.id);

    const log = within(screen.getByRole('listbox'));
    expect(log.queryByText('Key A (aaa1)')).toBeNull();
    expect(log.queryByText('Key B (bbb2)')).toBeNull();
  });

  it('switches from the merged log to one key and back', () => {
    const onKeyChange = vi.fn();
    renderPanel(null, onKeyChange);

    fireEvent.click(screen.getByRole('combobox', { name: i18n.t('requests.apiKey') }));
    fireEvent.click(screen.getByRole('option', { name: 'Key B (bbb2)' }));
    expect(onKeyChange).toHaveBeenLastCalledWith(keyB.id);

    fireEvent.click(screen.getByRole('combobox', { name: i18n.t('requests.apiKey') }));
    fireEvent.click(screen.getByRole('option', { name: i18n.t('requests.allKeys') }));
    expect(onKeyChange).toHaveBeenLastCalledWith(null);
  });
});
