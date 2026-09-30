import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useFormContext } from 'react-hook-form';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, expect, test, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { UpstreamEditorPage } from '../../../src/components/upstream-editor/page';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';
import type { UpstreamModelConfig } from '@floway-dev/provider/model-config';

const apiMocks = vi.hoisted(() => ({ patch: vi.fn(), listModels: vi.fn(), previewModels: vi.fn() }));

vi.mock('../../../src/api/client', () => ({
  api: { api: { upstreams: { ':id': { $patch: apiMocks.patch, 'list-models': { $post: apiMocks.listModels } }, 'preview-models': { $post: apiMocks.previewModels } } } },
  callApi: (operation: () => unknown) => operation(),
}));

vi.mock('../../../src/components/upstream-editor/config-sidebar', () => ({
  UpstreamConfigSidebar: ({ catalogAvailable, onRefreshModels }: { catalogAvailable: boolean; onRefreshModels: () => void }) => {
    const { register, setValue } = useFormContext<UpstreamEditorValues>();
    return <>
      <output data-testid="catalog-available">{String(catalogAvailable)}</output>
      <input aria-label="Name" {...register('name')} />
      <button type="button" onClick={() => setValue('flagOverrides', { 'vendor-kimi': true }, { shouldDirty: true })}>Edit discovery</button>
      <button type="button" onClick={() => setValue('manualModels', [], { shouldDirty: true })}>Remove manual model</button>
      <button type="button" onClick={onRefreshModels}>Fetch models</button>
    </>;
  },
}));

vi.mock('../../../src/components/upstream-editor/workspace', () => ({
  UpstreamWorkspace: ({ discovered, modelsError, onModelsYamlDraftChange, record: currentRecord }: {
    discovered: { upstreamModelId: string }[];
    modelsError: { message: string; upstreamResponse: { status: number } | null } | null;
    onModelsYamlDraftChange: (draft: { baseline: string; text: string; error: null }) => void;
    record: { modelsCache: { lastError: { message: string } | null } };
  }) => <>
    <output data-testid="discovered">{discovered.map(model => model.upstreamModelId).join(',')}</output>
    <output data-testid="models-error">{modelsError?.message ?? ''}</output>
    <output data-testid="upstream-response-status">{modelsError?.upstreamResponse?.status ?? ''}</output>
    <output data-testid="cache-last-error">{currentRecord.modelsCache.lastError?.message ?? ''}</output>
    <button type="button" onClick={() => onModelsYamlDraftChange({
      baseline: '[]',
      text: '- upstreamModelId: replacement\n  publicModelId: replacement\n  kind: chat\n  endpoints:\n    openaiChatCompletions: {}\n',
      error: null,
    })}>Edit YAML</button>
    <button type="button" onClick={() => onModelsYamlDraftChange({ baseline: '[]', text: '[] # formatting only\n', error: null })}>Reformat YAML</button>
    <button type="button" onClick={() => onModelsYamlDraftChange({
      baseline: 'original',
      text: '- upstreamModelId: manual\n  publicModelId: manual\n  kind: chat\n  endpoints:\n    openaiResponses: {}\n    openaiChatCompletions: {}\n',
      error: null,
    })}>Reorder YAML keys</button>
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
const customRecord = upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://custom.example.com', authStyle: 'none', ingressHeadersRules: [],
    endpoints: { openaiChatCompletions: {} }, modelsFetch: { enabled: true }, models: [],
  },
  state: null,
});
const discovered = [{ upstreamModelId: 'new-model', publicModelId: 'new-model', kind: 'chat' as const, endpoints: { openaiChatCompletions: {} } }];

const renderPage = (currentRecord = record, initialDiscovered: UpstreamModelConfig[] | null = null) => {
  const router = createMemoryRouter([{
    path: '/editor',
    element: <OutcomeToastProvider><UpstreamEditorPage data={{
      mode: 'edit', record: currentRecord, discovered: initialDiscovered,
      proxies: [], runtime: { kind: 'node', runtimeLocation: 'TEST' },
    }} /></OutcomeToastProvider>,
  }], { initialEntries: ['/editor'] });
  return renderInApp(<RouterProvider router={router} />);
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.patch.mockResolvedValue({ data: record, error: null });
  apiMocks.listModels.mockResolvedValue({ data: { kind: 'copilot', data: discovered, modelsCache: record.modelsCache }, error: null });
  apiMocks.previewModels.mockResolvedValue({ data: { kind: 'ollama', data: [] }, error: null });
});

test('opening an editor shows the stored model snapshot without fetching', () => {
  renderPage(record, discovered);
  expect(screen.getByTestId('discovered').textContent).toBe('new-model');
  expect(screen.getByTestId('catalog-available').textContent).toBe('true');
  expect(apiMocks.listModels).not.toHaveBeenCalled();
});

test('a successful empty snapshot is still available', () => {
  renderPage(record, []);
  expect(screen.getByTestId('discovered').textContent).toBe('');
  expect(screen.getByTestId('catalog-available').textContent).toBe('true');
  expect(apiMocks.listModels).not.toHaveBeenCalled();
});

test('failed refresh keeps a previously loaded catalog available', async () => {
  apiMocks.listModels.mockResolvedValue({
    error: {
      message: 'HTTP 503: unavailable',
      raw: { modelsCache: { fetchedAt: 100, modelCount: 1, lastError: { message: 'HTTP 503: unavailable', at: 200 } } },
    },
  });
  renderPage(record, discovered);
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  await waitFor(() => expect(screen.getByTestId('models-error').textContent).toBe('HTTP 503: unavailable'));
  expect(screen.getByTestId('discovered').textContent).toBe('new-model');
  expect(screen.getByTestId('catalog-available').textContent).toBe('true');
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

test('metadata-only Save lets a pending explicit Fetch finish', async () => {
  let finishFetch: ((value: unknown) => void) | undefined;
  apiMocks.listModels.mockImplementation(() => new Promise(resolve => { finishFetch = resolve; }));
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));

  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'New name' } });
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }));
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(1));
  await act(async () => {
    finishFetch!({ data: { kind: 'copilot', data: discovered, modelsCache: record.modelsCache }, error: null });
  });
  expect(screen.getByTestId('discovered').textContent).toBe('new-model');
  expect(screen.getByTestId('catalog-available').textContent).toBe('true');
  expect(apiMocks.listModels).toHaveBeenCalledTimes(1);
});

test('editing Ollama manual models fetches the draft instead of the saved catalog', async () => {
  const ollama = upstreamRecord('up_ollama', {
    kind: 'ollama',
    config: {
      baseUrl: 'https://ollama.example.com',
      cloudUsage: false,
      models: [{ upstreamModelId: 'old-manual', publicModelId: 'old-manual', kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
    },
    state: null,
  });
  renderPage(ollama);
  fireEvent.click(screen.getByRole('button', { name: 'Remove manual model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  await waitFor(() => expect(apiMocks.previewModels).toHaveBeenCalledTimes(1));
  expect(apiMocks.listModels).not.toHaveBeenCalled();
  expect(apiMocks.previewModels.mock.calls[0]?.[0].json.record.config.models).toEqual([]);
});

test('saving Custom manual models keeps an already fetched remote catalog', async () => {
  const manual = { upstreamModelId: 'old-manual', publicModelId: 'old-manual', kind: 'chat' as const, endpoints: { openaiChatCompletions: {} } };
  const custom = upstreamRecord('up_custom', {
    kind: 'custom',
    config: { ...(customRecord.config as Extract<UpstreamRecord, { kind: 'custom' }>['config']), models: [manual] },
    state: null,
  });
  apiMocks.patch.mockResolvedValue({ data: customRecord, error: null });
  renderPage(custom);
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  await waitFor(() => expect(screen.getByTestId('discovered').textContent).toBe('new-model'));

  fireEvent.click(screen.getByRole('button', { name: 'Remove manual model' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }));
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId('discovered').textContent).toBe('new-model');
  expect(screen.getByTestId('catalog-available').textContent).toBe('true');
});

test('saving a pending YAML edit discards an older explicit Fetch result', async () => {
  apiMocks.patch.mockResolvedValue({ data: customRecord, error: null });
  let finishFetch: ((value: unknown) => void) | undefined;
  apiMocks.listModels.mockImplementation(() => new Promise(resolve => { finishFetch = resolve; }));
  renderPage(customRecord);
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole('button', { name: 'Edit YAML' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }));
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(1));
  await act(async () => {
    finishFetch!({ data: { kind: 'custom', data: discovered, modelsCache: customRecord.modelsCache }, error: null });
  });
  expect(screen.getByTestId('discovered').textContent).toBe('');
  expect(screen.getByTestId('catalog-available').textContent).toBe('false');
});

test('saving YAML formatting alone keeps a pending explicit Fetch', async () => {
  apiMocks.patch.mockResolvedValue({ data: customRecord, error: null });
  let finishFetch: ((value: unknown) => void) | undefined;
  apiMocks.listModels.mockImplementation(() => new Promise(resolve => { finishFetch = resolve; }));
  renderPage(customRecord);
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole('button', { name: 'Reformat YAML' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }));
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(1));
  await act(async () => {
    finishFetch!({ data: { kind: 'custom', data: discovered, modelsCache: customRecord.modelsCache }, error: null });
  });
  expect(screen.getByTestId('discovered').textContent).toBe('new-model');
  expect(screen.getByTestId('catalog-available').textContent).toBe('true');
});

test('reordering YAML object keys does not invalidate a pending Fetch', async () => {
  const custom = upstreamRecord('up_custom', {
    kind: 'custom',
    config: {
      ...(customRecord.config as Extract<UpstreamRecord, { kind: 'custom' }>['config']),
      models: [{
        upstreamModelId: 'manual', publicModelId: 'manual', kind: 'chat',
        endpoints: { openaiChatCompletions: {}, openaiResponses: {} },
      }],
    },
    state: null,
  });
  apiMocks.patch.mockResolvedValue({ data: custom, error: null });
  let finishFetch: ((value: unknown) => void) | undefined;
  apiMocks.listModels.mockImplementation(() => new Promise(resolve => { finishFetch = resolve; }));
  renderPage(custom);
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  await waitFor(() => expect(apiMocks.listModels).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole('button', { name: 'Reorder YAML keys' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }));
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(1));
  await act(async () => {
    finishFetch!({ data: { kind: 'custom', data: discovered, modelsCache: custom.modelsCache }, error: null });
  });
  expect(screen.getByTestId('discovered').textContent).toBe('new-model');
  expect(screen.getByTestId('catalog-available').textContent).toBe('true');
});

test('saving Ollama YAML models clears the previous manual-inclusive catalog', async () => {
  const ollama = upstreamRecord('up_ollama', {
    kind: 'ollama',
    config: {
      baseUrl: 'https://ollama.example.com', cloudUsage: false,
      models: [{ upstreamModelId: 'old-manual', publicModelId: 'old-manual', kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
    },
    state: null,
  });
  apiMocks.patch.mockResolvedValue({
    data: {
      ...ollama,
      config: { ...ollama.config, models: [{ upstreamModelId: 'replacement', publicModelId: 'replacement', kind: 'chat', endpoints: { openaiChatCompletions: {} } }] },
    }, error: null,
  });
  apiMocks.listModels.mockResolvedValue({
    data: {
      kind: 'ollama', data: [{ upstreamModelId: 'old-manual', publicModelId: 'old-manual', kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
      modelsCache: ollama.modelsCache,
    }, error: null,
  });
  renderPage(ollama);
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  await waitFor(() => expect(screen.getByTestId('discovered').textContent).toBe('old-manual'));

  fireEvent.click(screen.getByRole('button', { name: 'Edit YAML' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }));
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId('discovered').textContent).toBe('');
  expect(screen.getByTestId('catalog-available').textContent).toBe('false');
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
    finishFetch!({
      data: null,
      error: {
        message: 'HTTP 503: unavailable', raw: {
          error: { code: 'upstream_model_listing_failed', upstreamResponse: { status: 503, headers: [], body: 'unavailable' } },
          modelsCache: { fetchedAt: null, modelCount: null, lastError: { message: 'HTTP 503: persisted detail', at: 100 } },
        },
      },
    });
  });
  await waitFor(() => expect(screen.getByTestId('models-error').textContent).toBe('HTTP 503: unavailable'));
  expect(screen.getByTestId('upstream-response-status').textContent).toBe('503');
  expect(screen.getByTestId('cache-last-error').textContent).toBe('HTTP 503: persisted detail');
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
