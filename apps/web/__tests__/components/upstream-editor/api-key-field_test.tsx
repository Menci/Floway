import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProviderConfigHarness } from './provider-config-harness';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

const apiKeyLabel = i18n.t('dashboard.upstreamEditor.fields.apiKey');
const showLabel = i18n.t('dashboard.upstreamEditor.actions.showSecret');
const hideLabel = i18n.t('dashboard.upstreamEditor.actions.hideSecret');

const customRecord = (apiKey: string) => upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://api.example.com',
    authStyle: 'bearer',
    apiKey,
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: false },
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

// The optional variant appends its qualifier to the label.
const keyInput = () => screen.getByLabelText(new RegExp(`^${apiKeyLabel}`)) as HTMLInputElement;

describe('the API key field', () => {
  it.each([
    ['custom', customRecord],
    ['azure', azureRecord],
    ['ollama', ollamaRecord],
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

  it('opens an upstream whose config stores no key on an empty field', () => {
    renderInApp(<ProviderConfigHarness record={customRecord('')} />);
    expect(keyInput().value).toBe('');
  });

  it('keeps the field editable so the stored key can be replaced', () => {
    renderInApp(<ProviderConfigHarness record={customRecord('sk-old-key')} />);
    fireEvent.change(keyInput(), { target: { value: 'sk-new-key' } });
    expect(keyInput().value).toBe('sk-new-key');
  });
});
