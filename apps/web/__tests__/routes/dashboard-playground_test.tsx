import { act, fireEvent, screen } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ControlPlaneModel } from '../../src/api/types';
import DashboardPlayground from '../../src/routes/dashboard-playground';
import { renderInApp } from '../render';

const model = {
  id: 'listed-model',
  display_name: 'Listed model',
  kind: 'chat',
  limits: {},
  upstreams: [{ id: 'upstream-1', name: 'Test upstream' }],
} as ControlPlaneModel;
const secondModel = { ...model, id: 'listed-model-2', display_name: 'Second model' };

const loaderData = {
  keys: [{
    id: 'key-1',
    name: 'Test key',
    key: 'secret',
    created_at: '2026-01-01T00:00:00.000Z',
    last_used_at: null,
    upstream_ids: null,
    dump_retention_seconds: null,
    responses_retention_seconds: 0,
  }],
  models: [model, secondModel],
  error: null,
};

afterEach(() => vi.unstubAllGlobals());

const renderPage = () => {
  const router = createMemoryRouter([
    {
      path: '/',
      Component: () => <Outlet context={{ user: { id: 1, username: 'admin', role: 'admin', upstreamIds: null } }} />,
      children: [{
        index: true,
        Component: () => <DashboardPlayground loaderData={loaderData} matches={[] as never} params={{}} />,
      }],
    },
  ], { initialEntries: ['/'] });
  return renderInApp(<RouterProvider router={router} />);
};

describe('Playground model selection', () => {
  it('sends an explicitly entered model ID that is absent from /models', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetch);

    await act(async () => { renderPage(); });
    await act(async () => { screen.getByRole('button', { name: 'Playground settings' }).click(); });

    const modelPicker = screen.getByLabelText('Model');
    fireEvent.click(modelPicker);
    fireEvent.change(modelPicker, { target: { value: 'hidden/upstream-model' } });
    fireEvent.keyDown(modelPicker, { key: 'Enter' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Write a message' }), { target: { value: 'hello' } });
    await act(async () => { screen.getByRole('button', { name: 'Send' }).click(); });

    const request = fetch.mock.calls.find(([input]) => String(input) === '/v1/responses');
    expect(request).toBeDefined();
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ model: 'hidden/upstream-model' });
  });

  it('keeps catalog model selection available', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetch);

    await act(async () => { renderPage(); });
    await act(async () => { screen.getByRole('button', { name: 'Playground settings' }).click(); });

    const modelPicker = screen.getByLabelText('Model');
    fireEvent.click(modelPicker);
    fireEvent.change(modelPicker, { target: { value: 'listed-model-2' } });
    await act(async () => { screen.getByText('listed-model-2').click(); });
    fireEvent.change(screen.getByRole('textbox', { name: 'Write a message' }), { target: { value: 'hello' } });
    await act(async () => { screen.getByRole('button', { name: 'Send' }).click(); });

    const request = fetch.mock.calls.find(([input]) => String(input) === '/v1/responses');
    expect(request).toBeDefined();
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ model: 'listed-model-2' });
  });
});
