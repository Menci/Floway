import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useFormContext } from 'react-hook-form';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, expect, test, vi } from 'vitest';

import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { UpstreamEditorPage } from '../../../src/components/upstream-editor/page';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), listModels: vi.fn() }));

vi.mock('../../../src/api/client', () => ({
  api: { api: { upstreams: { ':id': { $get: apiMocks.get, $patch: apiMocks.patch, 'list-models': { $post: apiMocks.listModels } } } } },
  callApi: (operation: () => unknown) => operation(),
}));

vi.mock('../../../src/components/upstream-editor/config-sidebar', () => ({
  UpstreamConfigSidebar: ({ onRefreshModels }: { onRefreshModels: () => void }) => {
    const { register, setValue } = useFormContext<UpstreamEditorValues>();
    return <>
      <input aria-label="Name" {...register('name')} />
      <button type="button" onClick={() => setValue('flagOverrides', { 'vendor-kimi': true }, { shouldDirty: true })}>Edit discovery</button>
      <button type="button" onClick={onRefreshModels}>Fetch models</button>
    </>;
  },
}));

vi.mock('../../../src/components/upstream-editor/workspace', () => ({
  UpstreamWorkspace: ({ discovered, modelsError }: { discovered: { upstreamModelId: string }[]; modelsError: { message: string } | null }) => <>
    <output data-testid="discovered">{discovered.map(model => model.upstreamModelId).join(',')}</output>
    <output data-testid="models-error">{modelsError?.message ?? ''}</output>
  </>,
}));

const record = upstreamRecord('up_copilot', {
  kind: 'copilot',
  config: {
    githubHost: 'github.com',
    githubToken: 'secret',
    user: { id: 1, login: 'operator', name: null, avatar_url: 'https://example.com/avatar' },
  },
  state: null,
});
const discovered = [{ upstreamModelId: 'new-model', publicModelId: 'new-model', endpoints: { openaiChatCompletions: {} } }];

const renderPage = () => {
  const router = createMemoryRouter([{
    path: '/editor',
    element: <OutcomeToastProvider><UpstreamEditorPage data={{
      mode: 'edit', record, discovered: [], modelsError: null,
      backoffs: [], proxies: [], upstreams: [record], runtime: { kind: 'node', runtimeLocation: 'TEST' },
    }} /></OutcomeToastProvider>,
  }], { initialEntries: ['/editor'] });
  return renderInApp(<RouterProvider router={router} />);
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.get.mockResolvedValue({ data: record, error: null });
  apiMocks.patch.mockResolvedValue({ data: { ...record, modelDiscovery: { kind: 'success', data: discovered }, configVersion: 2 }, error: null });
  apiMocks.listModels.mockResolvedValue({ data: { kind: 'copilot', data: discovered, modelsCache: record.modelsCache }, error: null });
});

test('metadata-only OAuth edits fetch the saved record and keep form changes unsaved', async () => {
  renderPage();
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Unsaved name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));
  expect(apiMocks.patch).not.toHaveBeenCalled();
  expect(screen.queryByText(i18n.t('dashboard.upstreamEditor.fetchDirty.title'))).toBeNull();
  expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Unsaved name');
});

test('dirty OAuth discovery inputs ask before saving and use the save warm once', async () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Edit discovery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  expect(await screen.findByText(i18n.t('dashboard.upstreamEditor.fetchDirty.title'))).toBeTruthy();
  expect(apiMocks.patch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.cancel') }));
  expect(apiMocks.patch).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('dashboard.upstreamEditor.fetchDirty.saveAndFetch') }));
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByTestId('discovered').textContent).toBe('new-model'));
  expect(apiMocks.listModels).not.toHaveBeenCalled();
});

test('a failed save warm leaves Save successful and reports model discovery failure', async () => {
  apiMocks.patch.mockResolvedValue({
    data: {
      ...record, configVersion: 2,
      modelDiscovery: { kind: 'failure', message: 'Models unavailable', upstreamListingFailed: true },
    },
    error: null,
  });
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Edit discovery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('dashboard.upstreamEditor.fetchDirty.saveAndFetch') }));
  await waitFor(() => expect(screen.getByTestId('models-error').textContent).toBe('Models unavailable'));
  expect(apiMocks.patch).toHaveBeenCalledTimes(1);
  expect(apiMocks.listModels).not.toHaveBeenCalled();
  expect(screen.queryByText(i18n.t('dashboard.upstreamEditor.unsaved'))).toBeNull();
});

test('invalid edits do not save or fetch after confirmation', async () => {
  renderPage();
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Edit discovery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('dashboard.upstreamEditor.fetchDirty.saveAndFetch') }));
  await waitFor(() => expect(screen.queryByText(i18n.t('dashboard.upstreamEditor.fetchDirty.title'))).toBeNull());
  expect(apiMocks.patch).not.toHaveBeenCalled();
  expect(apiMocks.listModels).not.toHaveBeenCalled();
});

test('a pending saved fetch cannot overwrite the catalog returned by Save', async () => {
  let finishFetch: ((value: unknown) => void) | undefined;
  apiMocks.listModels.mockImplementation(() => new Promise(resolve => { finishFetch = resolve; }));
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Edit discovery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('dashboard.upstreamEditor.fetchDirty.saveAndFetch') }));
  await waitFor(() => expect(screen.getByTestId('discovered').textContent).toBe('new-model'));
  await act(async () => {
    finishFetch!({ data: { kind: 'copilot', data: [{ upstreamModelId: 'obsolete' }], modelsCache: record.modelsCache }, error: null });
  });
  expect(screen.getByTestId('discovered').textContent).toBe('new-model');
});

test('a failed full-record reload reports saved settings without resetting from a redacted PATCH response', async () => {
  apiMocks.get.mockResolvedValue({ data: null, error: { message: 'reload unavailable' } });
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Edit discovery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('dashboard.upstreamEditor.fetchDirty.saveAndFetch') }));
  await waitFor(() => expect(screen.getByText(i18n.t('dashboard.upstreamEditor.fetchDirty.reloadFailed', { error: 'reload unavailable' }))).toBeTruthy());
  expect(screen.getByText(i18n.t('dashboard.upstreamEditor.unsaved'))).toBeTruthy();
  expect(apiMocks.listModels).not.toHaveBeenCalled();
});
