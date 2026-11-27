import { fireEvent, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { ApiKey } from '../../../src/api/types';
import { RequestListPanel } from '../../../src/components/requests/list';
import { i18n } from '../../../src/i18n';
import { stubMatchMedia } from '../../match-media-stub';
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
// A second key that shares Key A's name.
const refA2 = { id: 'key-a2', name: 'Key A', suffix: 'ccc3' };

const renderPanel = (selectedKeyId: string | null, {
  apiKeys = [keyA, keyB],
  onKeyChange = vi.fn(),
  records = [record('first', refA), record('second', refB)],
}: { apiKeys?: ApiKey[]; onKeyChange?: (keyId: string | null) => void; records?: DumpMetadata[] } = {}) => renderInApp(
  <MemoryRouter>
    <RequestListPanel
      addressOfRecord={id => `?record=${id}`}
      apiKeys={apiKeys}
      error={null}
      hasOlder={false}
      onDismissError={vi.fn()}
      onKeyChange={onKeyChange}
      onLoadOlder={vi.fn()}
      onRecordChange={vi.fn()}
      records={records}
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
    expect(log.getByText('Key A')).toBeTruthy();
    expect(log.getByText('Key B')).toBeTruthy();
    expect(log.getByText('/v1/first')).toBeTruthy();
  });

  it('adds the suffix only where two keys share a name', () => {
    renderPanel(null, {
      apiKeys: [keyA, keyB, apiKey(refA2.id, refA2.name, refA2.suffix)],
      records: [record('first', refA), record('second', refB), record('third', refA2)],
    });

    const log = within(screen.getByRole('listbox'));
    expect(log.getByText('Key A (aaa1)')).toBeTruthy();
    expect(log.getByText('Key A (ccc3)')).toBeTruthy();
    expect(log.getByText('Key B')).toBeTruthy();
  });

  it('tells apart a key that streamed rows before the key list named it', () => {
    renderPanel(null, { records: [record('first', refA), record('second', refA2)] });

    const log = within(screen.getByRole('listbox'));
    expect(log.getByText('Key A (aaa1)')).toBeTruthy();
    expect(log.getByText('Key A (ccc3)')).toBeTruthy();
  });

  it('shows no source key on a single key\'s log', () => {
    renderPanel(keyA.id);

    const log = within(screen.getByRole('listbox'));
    expect(log.queryByText('Key A')).toBeNull();
    expect(log.queryByText('Key B')).toBeNull();
  });

  it('switches from the merged log to one key and back', () => {
    const onKeyChange = vi.fn();
    renderPanel(null, { onKeyChange });

    fireEvent.click(screen.getByRole('combobox', { name: i18n.t('requests.apiKey') }));
    fireEvent.click(screen.getByRole('option', { name: 'Key B (bbb2)' }));
    expect(onKeyChange).toHaveBeenLastCalledWith(keyB.id);

    fireEvent.click(screen.getByRole('combobox', { name: i18n.t('requests.apiKey') }));
    fireEvent.click(screen.getByRole('option', { name: i18n.t('requests.allKeys') }));
    expect(onKeyChange).toHaveBeenLastCalledWith(null);
  });
});

describe('all-keys request log at a phone width', () => {
  stubMatchMedia(query => query === '(max-width: 680px)');

  it('puts the source key where the path was', () => {
    renderPanel(null);

    const log = within(screen.getByRole('listbox'));
    expect(log.getByText('Key A')).toBeTruthy();
    expect(log.queryByText('/v1/first')).toBeNull();
  });

  it('keeps the path on a single key\'s log', () => {
    renderPanel(keyA.id);

    const log = within(screen.getByRole('listbox'));
    expect(log.getByText('/v1/first')).toBeTruthy();
    expect(log.queryByText('Key A')).toBeNull();
  });
});
