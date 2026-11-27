import { zodResolver } from '@hookform/resolvers/zod';
import { fireEvent, screen } from '@testing-library/react';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { UpstreamRecord } from '../../../src/api/types';
import { refineCustomIngressHeaderRules } from '../../../src/components/upstream-editor/custom-ingress-header-rules-validation';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { UpstreamKindConfigSection } from '../../../src/components/upstream-editor/upstream-kind-config';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

type CustomRecord = Extract<UpstreamRecord, { kind: 'custom' }>;

const record = (ingressHeadersRules: { key: string; value: string | null }[]): CustomRecord => upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://api.example.com',
    apiKey: '',
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules,
    modelsFetch: { enabled: false, authStyle: 'bearer' },
  },
  manual_models: [],
  state: null,
}) as CustomRecord;

function Harness({ ingressHeadersRules = [] }: { ingressHeadersRules?: { key: string; value: string | null }[] }) {
  const upstream = record(ingressHeadersRules);
  const schema = z.custom<UpstreamEditorValues>().superRefine((values, context) => {
    const config = values.config as CustomRecord['config'];
    refineCustomIngressHeaderRules(config.ingressHeadersRules, context);
  });
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(upstream), mode: 'onBlur', resolver: zodResolver(schema) });
  const config = useWatch({ control: form.control, name: 'config' }) as typeof upstream.config;
  return <FormProvider {...form}>
    <UpstreamKindConfigSection record={upstream} onPatch={vi.fn()} />
    <button onClick={() => void form.handleSubmit(() => {})()}>Save probe</button>
    <output data-testid="rules">{JSON.stringify(config.ingressHeadersRules)}</output>
  </FormProvider>;
}

const label = (key: 'keyForRow' | 'valueForRow' | 'remove', number: number) =>
  i18n.t(`upstreams.editor.headers.${key}`, { number });
const valueOf = (element: HTMLElement) => (element as HTMLInputElement).value;
const placeholderOf = (element: HTMLElement) => (element as HTMLInputElement).placeholder;

describe('Custom ingress header rules', () => {
  it('maps both presets and custom freeform input without confusing a preset-looking literal', () => {
    renderInApp(<Harness ingressHeadersRules={[{ key: 'x-route', value: 'initial' }]} />);
    let behavior = screen.getByLabelText(label('valueForRow', 1));

    fireEvent.click(behavior);
    fireEvent.click(screen.getByRole('option', { name: i18n.t('upstreams.editor.headers.passthrough') }));
    expect(screen.getByTestId('rules').textContent).toContain('"value":null');
    expect(valueOf(behavior)).toBe('');
    expect(placeholderOf(behavior)).toBe(i18n.t('upstreams.editor.headers.passthrough'));
    fireEvent.keyDown(behavior, { key: 'Backspace' });
    expect(screen.getByTestId('rules').textContent).toContain('"value":null');

    behavior = screen.getByLabelText(label('valueForRow', 1));
    fireEvent.click(behavior);
    fireEvent.click(screen.getByRole('option', { name: i18n.t('upstreams.editor.headers.empty') }));
    expect(screen.getByTestId('rules').textContent).toContain('"value":""');
    expect(valueOf(behavior)).toBe('');
    expect(placeholderOf(behavior)).toBe(i18n.t('upstreams.editor.headers.empty'));

    behavior = screen.getByLabelText(label('valueForRow', 1));
    fireEvent.change(behavior, { target: { value: '(empty)' } });
    expect(screen.getByTestId('rules').textContent).toContain('"value":"(empty)"');
  });

  it('distinguishes repeated passthrough, protocol-owned, and transport-owned names', async () => {
    renderInApp(<Harness />);
    const first = screen.getByLabelText(label('keyForRow', 1));
    fireEvent.change(first, { target: { value: 'x-route' } });
    const second = screen.getByLabelText(label('keyForRow', 2));
    fireEvent.change(second, { target: { value: 'X-Route' } });
    fireEvent.blur(second);
    expect(await screen.findByText(i18n.t('upstreams.editor.headers.validation.duplicatePassthrough'))).toBeTruthy();

    fireEvent.change(first, { target: { value: 'Anthropic-Beta' } });
    fireEvent.blur(first);
    expect(await screen.findByText(i18n.t('upstreams.editor.headers.validation.anthropicMessagesOwned'))).toBeTruthy();
    expect(screen.queryByText(i18n.t('upstreams.editor.headers.validation.duplicatePassthrough'))).toBeNull();

    fireEvent.change(first, { target: { value: 'Authorization' } });
    fireEvent.blur(first);
    expect(await screen.findByText(i18n.t('upstreams.editor.headers.validation.transportOwned'))).toBeTruthy();
  });
});
