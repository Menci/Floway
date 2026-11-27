import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderConfigHarness } from './upstream-kind-config-harness';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';
import { settle } from '../../settle';

const PREVIEW_PATH = '/api/upstreams/chatgpt/import/preview';
const EXCHANGE_PATH = '/api/upstreams/chatgpt/import/exchange';

const record = upstreamRecord('up_chatgpt', {
  name: 'ChatGPT',
  kind: 'chatgpt',
  config: { accounts: [] },
  state: { accounts: [] },
});

const twoAccounts = JSON.stringify({
  accounts: [
    { platform: 'openai', type: 'oauth', credentials: { access_token: 'first' } },
    { platform: 'openai', type: 'oauth', credentials: { access_token: 'second' } },
  ],
});

const candidate = (sourceIndex: number, overrides: Record<string, unknown> = {}) => ({
  sourceIndex,
  name: null,
  email: null,
  chatgptAccountId: null,
  chatgptUserId: null,
  planType: null,
  renewable: false,
  expiresAt: null,
  issues: [],
  ...overrides,
});

let fetchMock: ReturnType<typeof vi.fn>;
let previewCandidates: unknown[];

const bodyOf = (path: string): Record<string, unknown> | null => {
  const call = fetchMock.mock.calls.find(([input]) => String(input).includes(path));
  return call ? JSON.parse(String((call[1] as RequestInit | undefined)?.body)) as Record<string, unknown> : null;
};

beforeEach(() => {
  previewCandidates = [candidate(0), candidate(1)];
  sessionStorage.clear();
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input), 'http://localhost');
    if (pathname === PREVIEW_PATH) return Response.json({ candidates: previewCandidates });
    if (pathname === EXCHANGE_PATH) return Response.json({ patch: { config: { accounts: [] }, state: { accounts: [] } } });
    throw new Error(`Unexpected request to ${pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); });

const openImport = async () => {
  renderInApp(<ProviderConfigHarness record={record} />);
  await settle();
};

describe('ChatGPT credential import', () => {
  it('will not import a document the operator has not previewed', async () => {
    await openImport();
    fireEvent.change(screen.getByRole('textbox', { name: 'Credential JSON' }), { target: { value: twoAccounts } });
    fireEvent.click(screen.getByRole('button', { name: 'Import credential' }));
    await settle();

    expect(await screen.findByText(i18n.t('upstreams.editor.chatgpt.import.previewFirst'))).toBeTruthy();
    expect(bodyOf(EXCHANGE_PATH)).toBeNull();
  });

  it('imports the account the operator picked out of the preview', async () => {
    await openImport();
    fireEvent.change(screen.getByRole('textbox', { name: 'Credential JSON' }), { target: { value: twoAccounts } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview accounts' }));
    await settle();

    // Two usable candidates, so neither is chosen for the operator.
    fireEvent.click(screen.getByRole('button', { name: 'Import credential' }));
    await settle();
    expect(await screen.findByText(i18n.t('upstreams.editor.chatgpt.import.selectAccount'))).toBeTruthy();

    fireEvent.click(screen.getAllByRole('radio')[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Import credential' }));
    await settle();

    expect(bodyOf(EXCHANGE_PATH)?.json).toEqual({ raw_json: twoAccounts, source_index: 1 });
  });

  it('preselects the one candidate a document can import, and refuses the rest', async () => {
    previewCandidates = [candidate(0, { issues: ['tokens.access_token must be a non-empty string'] }), candidate(1)];
    await openImport();
    fireEvent.change(screen.getByRole('textbox', { name: 'Credential JSON' }), { target: { value: twoAccounts } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview accounts' }));
    await settle();

    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios[0]!.disabled).toBe(true);
    expect(radios[1]!.checked).toBe(true);
    expect(screen.getByText('tokens.access_token must be a non-empty string')).toBeTruthy();
  });
});
