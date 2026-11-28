import { fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { ApiKey } from '../../../src/api/types';
import { RequestListPanel } from '../../../src/components/requests/list';
import { i18n } from '../../../src/i18n';
import { stubMatchMedia } from '../../match-media-stub';
import { renderInApp } from '../../render';
import type { DumpMetadata } from '@floway-dev/gateway/browser';

const apiKey: ApiKey = {
  id: 'key-1',
  name: 'Default Key',
  key: 'floway-test-key-1234',
  created_at: '2026-01-01T00:00:00.000Z',
  last_used_at: null,
  upstream_ids: null,
  randomize_upstreams: false,
  dump_retention_seconds: 3600,
  responses_retention_seconds: 0,
};

const record: DumpMetadata = {
  id: 'rec-1',
  startedAt: 1000,
  completedAt: 3000,
  method: 'POST',
  path: '/v1/chat/completions',
  status: 200,
  key: { id: 'key-1', name: 'Default Key', suffix: '1234' },
  model: 'gpt-4o',
  inputTokens: 10,
  outputTokens: 20,
  requestBytes: 100,
  responseBytes: 200,
  durationMs: 2000,
  ttftMs: null,
  error: null,
  targetApi: 'openaiChatCompletions',
  upstream: null,
};

const renderList = () => renderInApp(<MemoryRouter>
  <RequestListPanel
    addressOfRecord={id => `?record=${id}`}
    apiKeys={[apiKey]}
    error={null}
    failures={false}
    hasOlder={false}
    onDismissError={vi.fn()}
    onFilterChange={vi.fn()}
    onKeyChange={vi.fn()}
    onLoadOlder={vi.fn()}
    onRecordChange={vi.fn()}
    q=""
    records={[record]}
    selectedKeyId={apiKey.id}
    selectedRecordId={null}
  />
</MemoryRouter>);

const rowExport = () => screen.queryByRole('checkbox', { name: i18n.t('requests.selectExport') });
const selectToggle = () => screen.getByRole('button', { name: i18n.t('requests.select') });

describe('RequestListPanel export selection', () => {
  it('shows no checkboxes until the list is put into selection', () => {
    renderList();
    expect(rowExport()).toBeNull();
    expect(screen.queryByRole('checkbox', { name: i18n.t('requests.selectLoaded') })).toBeNull();

    fireEvent.click(selectToggle());

    expect(rowExport()).not.toBeNull();
    expect(screen.getByRole('checkbox', { name: i18n.t('requests.selectLoaded') })).toBeTruthy();
  });

  it('drops the selection it made once the list leaves selection', () => {
    renderList();
    fireEvent.click(selectToggle());
    fireEvent.click(rowExport()!);
    expect(screen.getByRole('button', { name: i18n.t('requests.exportSelection', { count: '1' }) })).toBeTruthy();

    fireEvent.click(selectToggle());
    expect(rowExport()).toBeNull();
    fireEvent.click(selectToggle());
    expect((rowExport() as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole('button', { name: i18n.t('requests.exportSelection', { count: '1' }) })).toBeNull();
  });

  it('gives each row its sizes beside its timings', () => {
    renderList();
    expect(screen.getByText('100 B')).toBeTruthy();
  });

  it('keeps the placeholder short and lists what the search matches in its name', () => {
    renderList();
    const field = screen.getByRole('textbox', { name: i18n.t('requests.search') });
    expect(field.getAttribute('placeholder')).toBe(i18n.t('requests.searchShort'));
  });
});

describe('RequestListPanel at a phone width', () => {
  stubMatchMedia(query => query === '(max-width: 680px)');

  it('keeps two lines and gives the sizes and timings to the record\'s details', () => {
    renderList();
    expect(screen.queryByText('100 B')).toBeNull();
    expect(screen.getByText('30 tok')).toBeTruthy();
  });
});
