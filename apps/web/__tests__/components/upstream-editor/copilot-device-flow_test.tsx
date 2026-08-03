import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderConfigHarness } from './provider-config-harness';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';
import { advance } from '../../settle';

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

const record = upstreamRecord('up_copilot', {
  name: 'Copilot',
  kind: 'copilot',
  config: { user: { login: '', avatar_url: '', name: null, id: 0 } },
  state: null,
});

let pollResponse: () => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;

const pollCount = () =>
  fetchMock.mock.calls.filter(([input]) => String(input).includes(DEVICE_LOGIN_POLL)).length;

const copilot = (key: string) => i18n.t(`dashboard.upstreamEditor.copilot.${key}`);

const startFlow = async () => {
  renderInApp(<ProviderConfigHarness record={record} />);
  fireEvent.click(screen.getByRole('button', { name: copilot('connect') }));
  await advance(0);
  expect(screen.getByText(flow.user_code)).toBeTruthy();
};

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input), 'http://localhost');
    if (pathname === DEVICE_LOGIN_START) return Response.json(flow);
    if (pathname === DEVICE_LOGIN_POLL) return await pollResponse();
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
    pollResponse = async () => Response.json({ error: { message: 'expired_token' } }, { status: 400 });
    await startFlow();

    await advance(INTERVAL_SECONDS * 1000);
    expect(pollCount()).toBe(1);
    expect(screen.getByText('expired_token')).toBeTruthy();
    expect(screen.queryByText(flow.user_code)).toBeNull();

    await advance(INTERVAL_SECONDS * 1000 * 4);
    expect(pollCount()).toBe(1);
  });

  it('keeps polling when the reply says nothing about the device code', async () => {
    pollResponse = async () => Response.json({ error: { message: 'Bad Gateway' } }, { status: 502 });
    await startFlow();

    await advance(INTERVAL_SECONDS * 1000);
    expect(pollCount()).toBe(1);
    await advance(INTERVAL_SECONDS * 1000);
    expect(pollCount()).toBe(2);
    expect(screen.getByText(flow.user_code)).toBeTruthy();
    expect(screen.queryByText('Bad Gateway')).toBeNull();
  });

  it('does not schedule another tick when the panel unmounts while a poll is in flight', async () => {
    let release: (() => void) | undefined;
    pollResponse = () => new Promise<Response>(resolve => {
      release = () => resolve(Response.json({ status: 'pending' }));
    });
    const { unmount } = renderInApp(<ProviderConfigHarness record={record} />);
    fireEvent.click(screen.getByRole('button', { name: copilot('connect') }));
    await advance(0);

    await advance(INTERVAL_SECONDS * 1000);
    expect(pollCount()).toBe(1);

    unmount();
    release!();
    await advance(INTERVAL_SECONDS * 1000 * 4);
    expect(pollCount()).toBe(1);
  });
});
