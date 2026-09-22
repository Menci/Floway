import { fireEvent, screen, waitFor } from '@testing-library/react';
import { forwardRef } from 'react';
import type { PropsWithChildren } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { UpstreamEditorPage } from '../../../src/components/upstream-editor/page';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('../../../src/api/client', () => ({
  api: {
    api: {
      upstreams: {
        ':id': {
          $get: apiMocks.get,
          $patch: apiMocks.patch,
        },
      },
    },
  },
  callApi: (operation: () => unknown) => operation(),
}));

vi.mock('../../../src/components/upstream-editor/config-sidebar', () => ({
  UpstreamConfigSidebar: () => null,
}));

vi.mock('../../../src/components/upstream-editor/models-yaml-editor', () => ({
  default: ({ onChange, value }: { onChange: (value: string) => void; value: string }) => (
    <textarea aria-label="YAML models" onChange={event => onChange(event.target.value)} value={value} />
  ),
}));

vi.mock('../../../src/components/ui/scroll-area', () => ({
  ScrollArea: forwardRef<HTMLDivElement, PropsWithChildren>(({ children }, ref) => <div ref={ref}>{children}</div>),
}));

const model = (id: string) => ({
  upstreamModelId: id,
  publicModelId: id,
  display_name: id,
  kind: 'chat' as const,
  endpoints: { openaiResponses: {} },
});

const record = upstreamRecord('up_test', {
  name: 'Test',
  kind: 'custom',
  config: {
    baseUrl: 'https://example.com',
    authStyle: 'bearer',
    apiKey: '',
    endpoints: { openaiResponses: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: false },
    models: [model('model-a')],
  },
  state: null,
});

const replacementYaml = '- upstreamModelId: replacement\n  publicModelId: replacement\n  kind: chat\n  endpoints:\n    openaiResponses: {}\n';

const renderPage = () => {
  const router = createMemoryRouter([{
    path: '/editor',
    element: <OutcomeToastProvider><UpstreamEditorPage data={{
      backoffs: [],
      discovered: [],
      mode: 'edit',
      modelsError: null,
      proxies: [],
      record,
      runtime: { kind: 'node', runtimeLocation: 'test' },
      upstreams: [record],
    }} /></OutcomeToastProvider>,
  }], { initialEntries: ['/editor?view=yaml'] });
  return renderInApp(<RouterProvider router={router} />);
};

describe('upstream editor YAML submission', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enables the page save action and submits the YAML draft', async () => {
    const saved = {
      ...record,
      config: { ...record.config, models: [model('replacement')] },
    };
    apiMocks.patch.mockResolvedValue({ data: saved, error: null });
    apiMocks.get.mockResolvedValue({ data: saved, error: null });
    renderPage();

    const save = screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(await screen.findByLabelText('YAML models'), { target: { value: replacementYaml } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledWith({
      json: expect.objectContaining({
        config: expect.objectContaining({
          models: [expect.objectContaining({ upstreamModelId: 'replacement' })],
        }),
      }),
      param: { id: record.id },
    }));
  });

  it('keeps invalid YAML in the editor and does not submit it', async () => {
    renderPage();
    const save = screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }) as HTMLButtonElement;

    fireEvent.change(await screen.findByLabelText('YAML models'), { target: { value: '- upstreamModelId: [' } });
    fireEvent.click(save);

    expect(apiMocks.patch).not.toHaveBeenCalled();
    expect(await screen.findByText(/line 1, column 21/i)).toBeTruthy();
    expect((screen.getByLabelText('YAML models') as HTMLTextAreaElement).value).toBe('- upstreamModelId: [');
  });
});
