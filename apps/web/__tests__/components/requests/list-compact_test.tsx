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

const renderList = (failures: boolean) => renderInApp(<MemoryRouter>
  <RequestListPanel
    addressOfRecord={id => `?record=${id}`}
    apiKeys={[apiKey]}
    error={null}
    failures={failures}
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

describe('RequestListPanel at a phone width', () => {
  stubMatchMedia(query => query === '(max-width: 680px)');

  it('folds the toolbar and the export checkboxes behind the filters toggle', () => {
    renderList(false);
    const failuresOnly = () => screen.queryByRole('checkbox', { name: i18n.t('requests.failuresOnly') });
    const rowExport = () => screen.queryByRole('checkbox', { name: i18n.t('requests.selectExport') });

    expect(screen.getByRole('textbox', { name: i18n.t('requests.search') })).toBeTruthy();
    expect(failuresOnly()).toBeNull();
    expect(rowExport()).toBeNull();
    // The sizes give their room to the error or token count.
    expect(screen.queryByText('100 B')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: i18n.t('requests.tools') }));

    expect(failuresOnly()).not.toBeNull();
    expect(rowExport()).not.toBeNull();
  });

  it('keeps a selection and its export control in view once the toolbar folds again', () => {
    renderList(false);
    const toggle = screen.getByRole('button', { name: i18n.t('requests.tools') });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('checkbox', { name: i18n.t('requests.selectExport') }));
    fireEvent.click(toggle);

    expect(screen.getByRole('checkbox', { name: i18n.t('requests.selectExport') })).toBeTruthy();
    expect(screen.getByRole('button', { name: i18n.t('requests.exportSelection', { count: '1' }) })).toBeTruthy();
  });

  it('says on the toggle that a folded filter is in force', () => {
    renderList(true);

    expect(screen.getByRole('button', { name: i18n.t('requests.toolsActive', { active: '1' }) })).toBeTruthy();
  });
});
