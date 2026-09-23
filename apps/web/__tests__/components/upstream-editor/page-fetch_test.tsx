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

const apiMocks = vi.hoisted(() => ({ patch: vi.fn(), listModels: vi.fn() }));

vi.mock('../../../src/api/client', () => ({
  api: { api: { upstreams: { ':id': { $patch: apiMocks.patch, 'list-models': { $post: apiMocks.listModels } } } } },
  callApi: (operation: () => unknown) => operation(),
}));

vi.mock('../../../src/components/upstream-editor/config-sidebar', () => ({
  UpstreamConfigSidebar: ({ catalogAvailable, onRefreshModels }: { catalogAvailable: boolean; onRefreshModels: () => void }) => {
    const { register, setValue } = useFormContext<UpstreamEditorValues>();
    return <>
      <output data-testid="catalog-available">{String(catalogAvailable)}</output>
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
  disabled_public_model_ids: ['saved-model'],
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
  apiMocks.patch.mockResolvedValue({ data: record, error: null });
  apiMocks.listModels.mockResolvedValue({ data: { kind: 'copilot', data: discovered, modelsCache: record.modelsCache }, error: null });
});

test('metadata-only OAuth edits fetch the saved record and keep form changes unsaved', async () => {
  renderPage();
  expect(screen.getByTestId('catalog-available').textContent).toBe('false');
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Unsaved name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByTestId('catalog-available').textContent).toBe('true'));
  expect(apiMocks.patch).not.toHaveBeenCalled();
  expect(screen.queryByText(i18n.t('dashboard.upstreamEditor.fetchDirty.title'))).toBeNull();
  expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Unsaved name');
});

test('dirty OAuth discovery inputs save first, then make one independent Fetch request', async () => {
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
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByTestId('discovered').textContent).toBe('new-model'));
  expect(apiMocks.patch.mock.invocationCallOrder[0]).toBeLessThan(apiMocks.listModels.mock.invocationCallOrder[0]!);
});

test('a failed explicit Fetch reports model discovery failure after Save succeeded', async () => {
  let finishFetch: ((value: unknown) => void) | undefined;
  apiMocks.listModels.mockImplementation(() => new Promise(resolve => { finishFetch = resolve; }));
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Edit discovery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('dashboard.upstreamEditor.fetchDirty.saveAndFetch') }));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));
  expect(screen.getAllByText(i18n.t('dashboard.upstreamEditor.toast.saved')).length).toBeGreaterThan(0);
  await act(async () => {
    finishFetch!({ data: null, error: { message: 'Models unavailable', raw: { error: { code: 'upstream_model_listing_failed' } } } });
  });
  await waitFor(() => expect(screen.getByTestId('models-error').textContent).toBe('Models unavailable'));
  expect(apiMocks.patch).toHaveBeenCalledTimes(1);
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

test('a pending old Fetch cannot overwrite the new Fetch after Save', async () => {
  const finishFetches: Array<(value: unknown) => void> = [];
  apiMocks.listModels.mockImplementation(() => new Promise(resolve => { finishFetches.push(resolve); }));
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Edit discovery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('dashboard.upstreamEditor.fetchDirty.saveAndFetch') }));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(2));
  await act(async () => {
    finishFetches[1]!({ data: { kind: 'copilot', data: discovered, modelsCache: record.modelsCache }, error: null });
  });
  await waitFor(() => expect(screen.getByTestId('discovered').textContent).toBe('new-model'));
  await act(async () => {
    finishFetches[0]!({ data: { kind: 'copilot', data: [{ upstreamModelId: 'obsolete' }], modelsCache: record.modelsCache }, error: null });
  });
  expect(screen.getByTestId('discovered').textContent).toBe('new-model');
});

test('ordinary Save acknowledges persistence without issuing a model Fetch', async () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Edit discovery' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }));
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(1));
  expect(screen.getAllByText(i18n.t('dashboard.upstreamEditor.toast.saved')).length).toBeGreaterThan(0);
  expect(apiMocks.listModels).not.toHaveBeenCalled();
});
