import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ProviderConfigHarness } from './provider-config-harness';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';
import { primeDefaultSession } from '../../test-session';

beforeEach(() => { primeDefaultSession(); });

const apiKeyLabel = i18n.t('dashboard.upstreamEditor.fields.apiKey');
const showLabel = i18n.t('dashboard.upstreamEditor.actions.showSecret');
const hideLabel = i18n.t('dashboard.upstreamEditor.actions.hideSecret');

const customRecord = (apiKey: string, modelsFetchEnabled = false) => upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://api.example.com',
    apiKey,
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: modelsFetchEnabled, authStyle: 'bearer' },
    models: [],
  },
  state: null,
});

const azureRecord = (apiKey: string) => upstreamRecord('up_azure', {
  kind: 'azure',
  config: { endpoint: 'https://resource.openai.azure.com/openai/v1', apiKey, models: [] },
  state: null,
});

const ollamaRecord = (apiKey: string) => upstreamRecord('up_ollama', {
  kind: 'ollama',
  config: { baseUrl: 'https://ollama.com', cloudUsage: false, apiKey, models: [] },
  state: null,
});

const kimiCodeRecord = (apiKey: string) => upstreamRecord('up_kimi', {
  kind: 'kimi-code', config: { region: 'overseas', apiKey }, state: null,
});

// The optional variant appends its qualifier to the label.
const keyInput = () => screen.getByLabelText(new RegExp(`^${apiKeyLabel}`)) as HTMLInputElement;

describe('the API key field', () => {
  it.each([
    ['custom', customRecord],
    ['azure', azureRecord],
    ['ollama', ollamaRecord],
    ['kimi-code', kimiCodeRecord],
  ])('opens a %s upstream on its stored key, masked, and reveals it on demand', (_kind, record) => {
    renderInApp(<ProviderConfigHarness record={record('sk-live-key')} />);

    const input = keyInput();
    expect(input.value).toBe('sk-live-key');
    expect(input.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: showLabel }));
    expect(keyInput().type).toBe('text');
    expect(keyInput().value).toBe('sk-live-key');

    fireEvent.click(screen.getByRole('button', { name: hideLabel }));
    expect(keyInput().type).toBe('password');
  });

  it('marks the custom key optional, since an empty key makes the upstream anonymous', () => {
    renderInApp(<ProviderConfigHarness record={customRecord('')} />);
    expect(screen.getByLabelText(`${apiKeyLabel} (${i18n.t('dashboard.upstreamEditor.optional')})`)).toBeTruthy();
  });

  it('opens an upstream whose config stores no key on an empty field', () => {
    renderInApp(<ProviderConfigHarness record={customRecord('')} />);
    expect(keyInput().value).toBe('');
  });

  it('offers authentication only for model catalog fetching', () => {
    renderInApp(<ProviderConfigHarness record={customRecord('sk-live-key', true)} />);
    expect(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.fields.fetchModelsAuthStyle') })).toBeTruthy();
    expect(screen.queryByText(i18n.t('dashboard.upstreamEditor.fields.authStyle'))).toBeNull();
  });

  it('keeps catalog authentication visible when the API key is empty', () => {
    // An anonymous upstream still has to say which header it expects; an empty
    // key simply sends none.
    renderInApp(<ProviderConfigHarness record={customRecord('', true)} />);
    expect(screen.getByText(i18n.t('dashboard.upstreamEditor.fields.catalogPath'))).toBeTruthy();
    expect(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.fields.fetchModelsAuthStyle') })).toBeTruthy();
  });

  it('selects a catalog authentication mode from the inline menu', () => {
    renderInApp(<ProviderConfigHarness record={customRecord('sk-live-key', true)} />);
    const selector = screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.fields.fetchModelsAuthStyle') });
    fireEvent.click(selector);
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual([i18n.t('dashboard.upstreamEditor.auth.bearer'), 'x-api-key', 'x-goog-api-key']);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'x-goog-api-key' }));
    expect(selector.textContent).toBe('x-goog-api-key');
  });

  it('keeps the field editable so the stored key can be replaced', () => {
    renderInApp(<ProviderConfigHarness record={customRecord('sk-old-key')} />);
    fireEvent.change(keyInput(), { target: { value: 'sk-new-key' } });
    expect(keyInput().value).toBe('sk-new-key');
  });
});
