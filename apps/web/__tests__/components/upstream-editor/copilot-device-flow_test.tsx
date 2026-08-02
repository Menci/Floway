import { act, fireEvent, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { ProviderConfigSection } from '../../../src/components/upstream-editor/provider-config';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const DEVICE_LOGIN_START = '/api/upstreams/copilot/oauth/device-login/start';
const DEVICE_LOGIN_POLL = '/api/upstreams/copilot/oauth/device-login/poll';

const INTERVAL_SECONDS = 5;

const flow = {
  device_code: 'device-code',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: INTERVAL_SECONDS,
};

const record = {
  id: 'up_copilot',
  name: 'Copilot',
  kind: 'copilot',
  enabled: true,
  sort_order: 1,
  created_at: '',
  updated_at: '',
  flag_overrides: {},
  flag_defaults: {},
  disabled_public_model_ids: [],
  proxy_fallback_list: [],
  model_prefix: null,
  color: null,
  modelsCache: { fetchedAt: null, lastError: null },
  config: { user: { login: null, name: null } },
  state: null,
} as unknown as UpstreamRecord;

function Harness() {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  return (
    <FormProvider {...form}>
      <ProviderConfigSection record={record} onPatch={vi.fn()} onRefreshModels={vi.fn()} />
    </FormProvider>
  );
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let pollResponse: () => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;

const pollCount = () =>
  fetchMock.mock.calls.filter(([input]) => String(input).includes(DEVICE_LOGIN_POLL)).length;

// Every state change here lands from a timer callback rather than from an
// event handler, so the ticks are driven inside `act` and the assertions read
// a committed tree.
const tick = async (ms: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

const copilot = (key: string) => i18n.t(`dashboard.upstreamEditor.copilot.${key}`);

const startFlow = async () => {
  renderInApp(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: copilot('connect') }));
  await tick(0);
  expect(screen.getByText(flow.user_code)).toBeTruthy();
};

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input), 'http://localhost');
    if (pathname === DEVICE_LOGIN_START) return json(200, flow);
    if (pathname === DEVICE_LOGIN_POLL) return pollResponse();
    throw new Error(`Unexpected request to ${pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Copilot device-flow polling', () => {
  it('ends the flow and surfaces the message when GitHub rejects the device code', async () => {
    pollResponse = async () => json(400, { error: { message: 'expired_token' } });
    await startFlow();

    await tick(INTERVAL_SECONDS * 1000);
    expect(pollCount()).toBe(1);
    expect(screen.getByText('expired_token')).toBeTruthy();
    expect(screen.queryByText(flow.user_code)).toBeNull();

    await tick(INTERVAL_SECONDS * 1000 * 4);
    expect(pollCount()).toBe(1);
  });

  it('keeps polling when the reply says nothing about the device code', async () => {
    pollResponse = async () => json(502, { error: { message: 'Bad Gateway' } });
    await startFlow();

    await tick(INTERVAL_SECONDS * 1000);
    expect(pollCount()).toBe(1);
    await tick(INTERVAL_SECONDS * 1000);
    expect(pollCount()).toBe(2);
    expect(screen.getByText(flow.user_code)).toBeTruthy();
    expect(screen.queryByText('Bad Gateway')).toBeNull();
  });

  it('does not schedule another tick when the panel unmounts while a poll is in flight', async () => {
    let release: (() => void) | undefined;
    pollResponse = () => new Promise<Response>(resolve => {
      release = () => resolve(json(200, { status: 'pending' }));
    });
    const { unmount } = renderInApp(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: copilot('connect') }));
    await tick(0);

    await tick(INTERVAL_SECONDS * 1000);
    expect(pollCount()).toBe(1);

    unmount();
    release!();
    await tick(INTERVAL_SECONDS * 1000 * 4);
    expect(pollCount()).toBe(1);
  });
});
