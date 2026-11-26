import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { useFormContext } from 'react-hook-form';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, expect, test, vi } from 'vitest';

import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { UpstreamEditorPage } from '../../../src/components/upstream-editor/page';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { stubMatchMedia } from '../../match-media-stub';
import { renderInApp } from '../../render';
import type { UpstreamModelConfig } from '@floway-dev/upstream/browser';

// The two-column editor. happy-dom measures width queries against its 1024px
// window, which is the single-column layout page-sectioned_test.tsx covers.
stubMatchMedia(() => false);

const apiMocks = vi.hoisted(() => ({ patch: vi.fn(), listModels: vi.fn() }));

vi.mock('../../../src/api/client', () => ({
  api: { api: { upstreams: { ':id': { $patch: apiMocks.patch, 'list-models': { $post: apiMocks.listModels } } } } },
  callApi: (operation: () => unknown) => operation(),
}));

vi.mock('../../../src/components/upstream-editor/config-sidebar', () => ({
  UpstreamConfigSidebar: ({ catalogAvailable }: { catalogAvailable: boolean }) => {
    const { register, setValue } = useFormContext<UpstreamEditorValues>();
    return <>
      <output data-testid="catalog-available">{String(catalogAvailable)}</output>
      <input aria-label="Name" {...register('name')} />
      <button type="button" onClick={() => setValue('flagOverrides', { 'vendor-kimi': true }, { shouldDirty: true })}>Edit discovery</button>
      <button type="button" onClick={() => setValue('manualModels', [], { shouldDirty: true })}>Remove manual model</button>
    </>;
  },
}));

vi.mock('../../../src/components/upstream-editor/workspace', () => ({
  UpstreamWorkspace: ({ discovered, modelsError, onModelsYamlDraftChange, onRefreshModels, record: currentRecord }: {
    discovered: { upstreamModelId: string }[];
    modelsError: { message: string; upstreamResponse: { status: number } | null } | null;
    onModelsYamlDraftChange: (draft: { baseline: string; text: string; error: null }) => void;
    onRefreshModels: () => void;
    record: { modelsCache: { lastError: { message: string } | null } };
  }) => <>
    <output data-testid="discovered">{discovered.map(model => model.upstreamModelId).join(',')}</output>
    <output data-testid="models-error">{modelsError?.message ?? ''}</output>
    <output data-testid="upstream-response-status">{modelsError?.upstreamResponse?.status ?? ''}</output>
    <output data-testid="cache-last-error">{currentRecord.modelsCache.lastError?.message ?? ''}</output>
    <button type="button" onClick={onRefreshModels}>Fetch models</button>
    <button type="button" onClick={() => onModelsYamlDraftChange({
      baseline: '[]',
      text: '- upstreamModelId: replacement\n  publicModelId: replacement\n  kind: chat\n  endpoints:\n    openaiChatCompletions: {}\n',
      error: null,
    })}>Edit YAML</button>
  </>,
}));

const populatedCache = { fetchedAt: 1000, lastError: null, modelCount: 1 };
const record = upstreamRecord('up_copilot', {
  kind: 'copilot',
  disabled_public_model_ids: ['saved-model'],
  config: {
    githubHost: 'github.com',
    githubToken: 'secret',
    user: { id: 1, login: 'operator', name: null, avatar_url: 'https://example.com/avatar' },
  },
  modelsCache: populatedCache,
  state: null,
});
const customRecord = upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://custom.example.com', apiKey: '', ingressHeadersRules: [],
    endpoints: { openaiChatCompletions: {} }, modelsFetch: { enabled: true, authStyle: 'bearer' },
  },
  manual_models: [],
  modelsCache: populatedCache,
  state: null,
});
const discovered = [{ upstreamModelId: 'new-model', publicModelId: 'new-model', kind: 'chat' as const, endpoints: { openaiChatCompletions: {} } }];

const renderPage = (currentRecord = record, initialDiscovered: UpstreamModelConfig[] | null = []) => {
  const router = createMemoryRouter([{
    path: '/editor',
    element: <OutcomeToastProvider><UpstreamEditorPage data={{
      mode: 'edit', audit: true, editLevel: 'full', record: currentRecord, discovered: initialDiscovered,
      proxies: [], runtime: { kind: 'node', runtimeLocation: 'TEST' },
    }} /></OutcomeToastProvider>,
  }], { initialEntries: ['/editor'] });
  return renderInApp(<RouterProvider router={router} />);
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.patch.mockResolvedValue({ data: record, error: null });
  apiMocks.listModels.mockResolvedValue({ data: { kind: 'copilot', data: discovered, modelsCache: populatedCache }, error: null });
});

test('auto-fetches on edit mount under React StrictMode when the upstream has never fetched models', async () => {
  const coldRecord = { ...record, modelsCache: { fetchedAt: null, lastError: null, modelCount: null } };
  const router = createMemoryRouter([{
    path: '/editor',
    element: <StrictMode><OutcomeToastProvider><UpstreamEditorPage data={{
      mode: 'edit', audit: true, editLevel: 'full', record: coldRecord, discovered: null,
      proxies: [], runtime: { kind: 'node', runtimeLocation: 'TEST' },
    }} /></OutcomeToastProvider></StrictMode>,
  }], { initialEntries: ['/editor'] });
  renderInApp(<RouterProvider router={router} />);
  await waitFor(() => expect(screen.getByTestId('discovered').textContent).toBe('new-model'));
  expect(screen.getByTestId('catalog-available').textContent).toBe('true');
});

test('saving dirty discovery inputs in edit mode automatically fetches the refreshed catalog', async () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Edit discovery' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('upstreams.editor.actions.save') }));
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByTestId('discovered').textContent).toBe('new-model'));
  expect(apiMocks.patch.mock.invocationCallOrder[0]).toBeLessThan(apiMocks.listModels.mock.invocationCallOrder[0]!);
});

test('metadata-only OAuth edits fetch the saved record and keep form changes unsaved', async () => {
  renderPage(record, null);
  expect(screen.getByTestId('catalog-available').textContent).toBe('false');
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Unsaved name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByTestId('catalog-available').textContent).toBe('true'));
  expect(apiMocks.patch).not.toHaveBeenCalled();
  expect(screen.queryByText(i18n.t('upstreams.editor.fetchDirty.title'))).toBeNull();
  expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Unsaved name');
});

test('editing Ollama manual models prompts to save before fetching the catalog', async () => {
  const ollama = upstreamRecord('up_ollama', {
    kind: 'ollama',
    config: {
      baseUrl: 'https://ollama.example.com',
      cloudUsage: false,
    },
    manual_models: [{ upstreamModelId: 'old-manual', publicModelId: 'old-manual', kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
    modelsCache: populatedCache,
    state: null,
  });
  apiMocks.patch.mockResolvedValue({ data: { ...ollama, manual_models: [] }, error: null });
  renderPage(ollama);
  fireEvent.click(screen.getByRole('button', { name: 'Remove manual model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  expect(await screen.findByText(i18n.t('upstreams.editor.fetchDirty.title'))).toBeTruthy();
  expect(apiMocks.listModels).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('upstreams.editor.fetchDirty.saveAndFetch') }));
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));
});

test('editing custom manual models with modelsFetch enabled prompts to save before fetching the catalog', async () => {
  const customWithManual = {
    ...customRecord,
    manual_models: [{ upstreamModelId: 'old-manual', publicModelId: 'old-manual', kind: 'chat' as const, endpoints: { openaiChatCompletions: {} } }],
  };
  apiMocks.patch.mockResolvedValue({ data: { ...customWithManual, manual_models: [] }, error: null });
  renderPage(customWithManual);
  fireEvent.click(screen.getByRole('button', { name: 'Remove manual model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  expect(await screen.findByText(i18n.t('upstreams.editor.fetchDirty.title'))).toBeTruthy();
  expect(apiMocks.listModels).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('upstreams.editor.fetchDirty.saveAndFetch') }));
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));
});

test('saving a pending YAML edit discards an older explicit Fetch result', async () => {
  apiMocks.patch.mockResolvedValue({ data: customRecord, error: null });
  const finishFetches: Array<(value: unknown) => void> = [];
  apiMocks.listModels.mockImplementation(() => new Promise(resolve => { finishFetches.push(resolve); }));
  renderPage(customRecord, null);
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole('button', { name: 'Edit YAML' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('upstreams.editor.actions.save') }));
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(1));
  await act(async () => {
    finishFetches[0]!({ data: { kind: 'custom', data: discovered, modelsCache: customRecord.modelsCache }, error: null });
  });
  expect(screen.getByTestId('discovered').textContent).toBe('');
  expect(screen.getByTestId('catalog-available').textContent).toBe('false');
});

test('dirty discovery inputs save first, then make one independent Fetch request', async () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Edit discovery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  expect(await screen.findByText(i18n.t('upstreams.editor.fetchDirty.title'))).toBeTruthy();
  expect(apiMocks.patch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.cancel') }));
  expect(apiMocks.patch).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('upstreams.editor.fetchDirty.saveAndFetch') }));
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByTestId('discovered').textContent).toBe('new-model'));
  expect(apiMocks.patch.mock.invocationCallOrder[0]).toBeLessThan(apiMocks.listModels.mock.invocationCallOrder[0]!);
});

test('a pending old Fetch cannot overwrite the new Fetch after Save', async () => {
  const finishFetches: Array<(value: unknown) => void> = [];
  apiMocks.listModels.mockImplementation(() => new Promise(resolve => { finishFetches.push(resolve); }));
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Edit discovery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('upstreams.editor.fetchDirty.saveAndFetch') }));
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
