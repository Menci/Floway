import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { forwardRef } from 'react';
import type { PropsWithChildren } from 'react';
import { useFormContext } from 'react-hook-form';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { UpstreamEditorPage } from '../../../src/components/upstream-editor/page';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { stubMatchMedia } from '../../match-media-stub';
import { renderInApp } from '../../render';

const apiMocks = vi.hoisted(() => ({ patch: vi.fn() }));

vi.mock('../../../src/api/client', () => ({
  api: { api: { upstreams: { ':id': { $patch: apiMocks.patch } } } },
  callApi: (operation: () => unknown) => operation(),
}));

// The configuration pane stands in as one control that edits a field it owns,
// which is all the section switching needs to observe.
vi.mock('../../../src/components/upstream-editor/config-sidebar', () => ({
  UpstreamConfigSidebar: () => {
    const { setValue } = useFormContext();
    return <button onClick={() => setValue('name', '', { shouldDirty: true })} type="button">Clear name</button>;
  },
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
    apiKey: '',
    endpoints: { openaiResponses: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: false, authStyle: 'bearer' },
  },
  manual_models: [model('model-a')],
  state: null,
});

const renderPage = (entry: string) => {
  const router = createMemoryRouter([{
    path: '/editor',
    element: <OutcomeToastProvider><UpstreamEditorPage data={{
      discovered: null,
      mode: 'edit',
      editLevel: 'full',
      proxies: [],
      record,
      runtime: { kind: 'node', runtimeLocation: 'test' },
    }} /></OutcomeToastProvider>,
  }], { initialEntries: [entry] });
  renderInApp(<RouterProvider router={router} />);
  return router;
};

const tab = (key: string) => screen.getByRole('tab', { name: i18n.t(key) });
const saveButton = () => screen.queryByRole('button', { name: i18n.t('upstreams.editor.actions.save') });

describe('single-column upstream editor', () => {
  // Every width query matches: one column, and the model list instead of the table.
  stubMatchMedia(() => true);
  beforeEach(() => vi.clearAllMocks());

  it('opens on the configuration section and moves to the models section', () => {
    const router = renderPage('/editor');

    expect(tab('upstreams.editor.tabs.config').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'Clear name' })).toBeTruthy();
    expect(screen.queryByRole('grid', { name: i18n.t('models.editor.title') })).toBeNull();

    fireEvent.click(tab('upstreams.editor.tabs.models'));

    expect(router.state.location.search).toBe('?tab=models');
    expect(screen.queryByRole('button', { name: 'Clear name' })).toBeNull();
    // A list whose rows hold controls navigates as a composite, which Fluent exposes as a grid.
    const list = screen.getByRole('grid', { name: i18n.t('models.editor.title') });
    expect(within(list).getByText('model-a', { selector: 'code' })).toBeTruthy();
  });

  it('reads an address naming a model as the models section', () => {
    renderPage('/editor?model=model-a');

    expect(screen.queryByRole('button', { name: 'Clear name' })).toBeNull();
    expect(screen.getByRole('tab', { name: i18n.t('models.editor.details') })).toBeTruthy();
  });

  it('opens a model from its row in the list', () => {
    const router = renderPage('/editor?tab=models');

    fireEvent.click(screen.getByRole('row', { name: 'model-a' }));

    expect(new URLSearchParams(router.state.location.search).get('model')).toBe('model-a');
  });

  it('offers Save only once there is an edit, and returns to the configuration for a field it rejects', async () => {
    const router = renderPage('/editor');
    expect(saveButton()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Clear name' }));
    fireEvent.click(tab('upstreams.editor.tabs.models'));
    expect(router.state.location.search).toBe('?tab=models');

    fireEvent.click(saveButton()!);

    await waitFor(() => expect(router.state.location.search).toBe('?tab=config'));
    expect(apiMocks.patch).not.toHaveBeenCalled();
  });
});
