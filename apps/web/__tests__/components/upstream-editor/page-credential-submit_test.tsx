import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useFormContext } from 'react-hook-form';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, expect, test, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { UpstreamEditorPage } from '../../../src/components/upstream-editor/page';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { stubMatchMedia } from '../../match-media-stub';
import { renderInApp } from '../../render';

// The two-column editor. happy-dom measures width queries against its 1024px
// window, which is the single-column layout page-sectioned_test.tsx covers.
stubMatchMedia(() => false);

const apiMocks = vi.hoisted(() => ({ create: vi.fn(), patch: vi.fn(), listModels: vi.fn() }));

vi.mock('../../../src/api/client', () => ({
  api: { api: { upstreams: { $post: apiMocks.create, ':id': { $patch: apiMocks.patch, 'list-models': { $post: apiMocks.listModels } } } } },
  callApi: (operation: () => unknown) => operation(),
}));

const imported = {
  config: { accounts: [{ email: 'operator@example.com', chatgptAccountId: null, chatgptUserId: null, planType: 'free' }] },
  state: {
    accounts: [{
      chatgptAccountId: null,
      refresh_token: 'refresh-token',
      state: 'active',
      state_updated_at: '2026-09-30T00:00:00.000Z',
      openaiDeviceId: 'device-id',
      accessToken: null,
      quotaSnapshot: null,
    }],
  },
};

vi.mock('../../../src/components/upstream-editor/config-sidebar', () => ({
  UpstreamConfigSidebar: ({ onPatch, record }: {
    onPatch: (patch: typeof imported, persisted: boolean) => void;
    record: UpstreamRecord;
  }) => {
    const { setValue } = useFormContext<UpstreamEditorValues>();
    return <>
      <button type="button" onClick={() => onPatch(imported, record.id !== '')}>Import credential</button>
      <button type="button" onClick={() => setValue('config', imported.config, { shouldDirty: true })}>Edit credential draft</button>
    </>;
  },
}));

vi.mock('../../../src/components/upstream-editor/workspace', () => ({ UpstreamWorkspace: () => null }));

const blueprint = upstreamRecord('', { kind: 'chatgpt', config: { accounts: [] }, state: { accounts: [] } });

const renderPage = (record: UpstreamRecord, mode: 'create' | 'edit') => {
  const router = createMemoryRouter([
    {
      path: '/editor',
      element: <OutcomeToastProvider><UpstreamEditorPage data={{
        mode, editLevel: 'full', record, discovered: null, proxies: [], runtime: { kind: 'node', runtimeLocation: 'TEST' },
      }} /></OutcomeToastProvider>,
    },
    { path: '/dashboard/providers/upstreams/:id', element: <div>Saved upstream</div> },
  ], { initialEntries: ['/editor'] });
  return renderInApp(<RouterProvider router={router} />);
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.create.mockResolvedValue({ data: { ...blueprint, id: 'up_chatgpt', ...imported }, error: null });
  apiMocks.listModels.mockResolvedValue({ data: { kind: 'chatgpt', data: [], modelsCache: blueprint.modelsCache }, error: null });
});

test('creating a ChatGPT upstream saves the imported credential', async () => {
  renderPage(blueprint, 'create');
  fireEvent.click(screen.getByRole('button', { name: 'Import credential' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('upstreams.editor.actions.save') }));

  await waitFor(() => expect(apiMocks.create).toHaveBeenCalledWith({
    json: expect.objectContaining({
      kind: 'chatgpt',
      config: imported.config,
      state: imported.state,
    }),
  }));
  expect(screen.queryByText(i18n.t('upstreams.editor.fetchDirty.unsavedCredential'))).toBeNull();
});

test('editing a saved ChatGPT upstream still rejects unsaved credential changes', async () => {
  renderPage({ ...blueprint, id: 'up_chatgpt' }, 'edit');
  fireEvent.click(screen.getByRole('button', { name: 'Edit credential draft' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('upstreams.editor.actions.save') }));

  expect(await screen.findByText(i18n.t('upstreams.editor.fetchDirty.unsavedCredential'))).toBeTruthy();
  expect(apiMocks.patch).not.toHaveBeenCalled();
});
