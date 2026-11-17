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

const keyInput = () => screen.getByLabelText(apiKeyLabel) as HTMLInputElement;

describe('the API key field', () => {
  it('opens on the stored key, masked, and reveals it on demand', () => {
    renderInApp(<ProviderConfigHarness record={customRecord('sk-live-key')} />);

    const input = keyInput();
    expect(input.value).toBe('sk-live-key');
    expect(input.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: showLabel }));
    expect(keyInput().type).toBe('text');
    expect(keyInput().value).toBe('sk-live-key');

    fireEvent.click(screen.getByRole('button', { name: hideLabel }));
    expect(keyInput().type).toBe('password');
  });

  it('selects a catalog authentication mode from the inline menu', () => {
    renderInApp(<ProviderConfigHarness record={customRecord('sk-live-key', true)} />);
    const selector = screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.fields.fetchModelsAuthStyle') });
    fireEvent.click(selector);
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual([i18n.t('dashboard.upstreamEditor.auth.bearer'), 'x-api-key', 'x-goog-api-key']);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'x-goog-api-key' }));
    expect(selector.textContent).toBe('x-goog-api-key');
  });
});
