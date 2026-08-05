import { zodResolver } from '@hookform/resolvers/zod';
import { fireEvent, screen } from '@testing-library/react';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { UpstreamRecord } from '../../../src/api/types';
import { refineCustomIngressHeaderRules } from '../../../src/components/upstream-editor/custom-ingress-header-rules-validation';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { ProviderConfigSection } from '../../../src/components/upstream-editor/provider-config';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

type CustomRecord = Extract<UpstreamRecord, { kind: 'custom' }>;

const record = (ingressHeadersRules: { key: string; value: string | null }[]): CustomRecord => upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://api.example.com',
    authStyle: 'bearer',
    apiKey: '',
    endpoints: { chatCompletions: {} },
    ingressHeadersRules,
    modelsFetch: { enabled: false },
    models: [],
  },
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
    <ProviderConfigSection record={upstream} onPatch={vi.fn()} onRefreshModels={vi.fn()} />
    <button onClick={() => void form.handleSubmit(() => {})()}>Save probe</button>
    <output data-testid="rules">{JSON.stringify(config.ingressHeadersRules)}</output>
  </FormProvider>;
}

const label = (key: 'keyForRow' | 'valueForRow' | 'remove', number: number) =>
  i18n.t(`dashboard.upstreamEditor.headers.${key}`, { number });
const valueOf = (element: HTMLElement) => (element as HTMLInputElement).value;
const placeholderOf = (element: HTMLElement) => (element as HTMLInputElement).placeholder;
const disabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled;

describe('Custom ingress header rules', () => {
  it('starts with one permanent blank row whose delete command is disabled', () => {
    renderInApp(<Harness />);
    expect(valueOf(screen.getByLabelText(label('keyForRow', 1)))).toBe('');
    expect(valueOf(screen.getByLabelText(label('valueForRow', 1)))).toBe('');
    expect(placeholderOf(screen.getByLabelText(label('valueForRow', 1)))).toBe('');
    expect(disabled(screen.getByLabelText(label('valueForRow', 1)))).toBe(true);
    expect(disabled(screen.getByRole('button', { name: label('remove', 1) }))).toBe(true);
    expect(screen.getAllByRole('group', { name: /Header rule/ })).toHaveLength(1);
  });

  it('renders passthrough and empty presets proportionally and custom overrides in monospace', () => {
    renderInApp(<Harness ingressHeadersRules={[
      { key: 'x-pass', value: null },
      { key: 'x-empty', value: '' },
      { key: 'x-route', value: 'fast' },
    ]} />);

    const passthrough = screen.getByLabelText(label('valueForRow', 1));
    const empty = screen.getByLabelText(label('valueForRow', 2));
    const custom = screen.getByLabelText(label('valueForRow', 3));
    expect(valueOf(passthrough)).toBe('');
    expect(valueOf(empty)).toBe('');
    expect(valueOf(custom)).toBe('fast');
    expect(placeholderOf(passthrough)).toBe(i18n.t('dashboard.upstreamEditor.headers.passthrough'));
    expect(placeholderOf(empty)).toBe(i18n.t('dashboard.upstreamEditor.headers.empty'));
    expect(placeholderOf(custom)).toBe('');
    expect(disabled(passthrough)).toBe(false);
    expect(disabled(empty)).toBe(false);
    expect(disabled(custom)).toBe(false);
    expect(passthrough.closest('.font-mono')).toBeNull();
    expect(empty.closest('.font-mono')).toBeNull();
    expect(custom.closest('.font-mono')).not.toBeNull();
    expect(valueOf(screen.getByLabelText(label('keyForRow', 4)))).toBe('');
  });

  it('turns a typed draft into a rule and immediately appends the next blank row', () => {
    renderInApp(<Harness />);
    const draft = screen.getByLabelText(label('keyForRow', 1));
    expect(disabled(screen.getByLabelText(label('valueForRow', 1)))).toBe(true);
    draft.focus();
    fireEvent.change(draft, { target: { value: 'X-Route' } });
    expect(document.activeElement).toBe(draft);
    expect(disabled(screen.getByLabelText(label('valueForRow', 1)))).toBe(false);
    expect(placeholderOf(screen.getByLabelText(label('valueForRow', 1)))).toBe(i18n.t('dashboard.upstreamEditor.headers.passthrough'));
    expect(valueOf(screen.getByLabelText(label('keyForRow', 2)))).toBe('');
    expect(disabled(screen.getByLabelText(label('valueForRow', 2)))).toBe(true);
    expect(placeholderOf(screen.getByLabelText(label('valueForRow', 2)))).toBe('');
    fireEvent.blur(draft);
    expect(valueOf(draft)).toBe('x-route');
  });

  it('maps both presets and custom freeform input without confusing a preset-looking literal', () => {
    renderInApp(<Harness ingressHeadersRules={[{ key: 'x-route', value: 'initial' }]} />);
    let behavior = screen.getByLabelText(label('valueForRow', 1));

    fireEvent.click(behavior);
    fireEvent.click(screen.getByRole('option', { name: i18n.t('dashboard.upstreamEditor.headers.passthrough') }));
    expect(screen.getByTestId('rules').textContent).toContain('"value":null');
    expect(valueOf(behavior)).toBe('');
    expect(placeholderOf(behavior)).toBe(i18n.t('dashboard.upstreamEditor.headers.passthrough'));
    fireEvent.keyDown(behavior, { key: 'Backspace' });
    expect(screen.getByTestId('rules').textContent).toContain('"value":null');

    behavior = screen.getByLabelText(label('valueForRow', 1));
    fireEvent.click(behavior);
    fireEvent.click(screen.getByRole('option', { name: i18n.t('dashboard.upstreamEditor.headers.empty') }));
    expect(screen.getByTestId('rules').textContent).toContain('"value":""');
    expect(valueOf(behavior)).toBe('');
    expect(placeholderOf(behavior)).toBe(i18n.t('dashboard.upstreamEditor.headers.empty'));

    behavior = screen.getByLabelText(label('valueForRow', 1));
    fireEvent.change(behavior, { target: { value: '(empty)' } });
    expect(screen.getByTestId('rules').textContent).toContain('"value":"(empty)"');
    expect(screen.getByLabelText(label('valueForRow', 1)).closest('.font-mono')).not.toBeNull();
  });

  it('deletes persisted rows and keeps the blank row', () => {
    renderInApp(<Harness ingressHeadersRules={[{ key: 'x-route', value: null }]} />);
    fireEvent.click(screen.getByRole('button', { name: label('remove', 1) }));
    expect(valueOf(screen.getByLabelText(label('keyForRow', 1)))).toBe('');
    expect(disabled(screen.getByRole('button', { name: label('remove', 1) }))).toBe(true);
  });

  it('shows a localized name error on the field and focuses it on Save', async () => {
    renderInApp(<Harness />);
    const key = screen.getByLabelText(label('keyForRow', 1));
    fireEvent.change(key, { target: { value: 'bad header' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save probe' }));

    expect(await screen.findByText(i18n.t('dashboard.upstreamEditor.headers.validation.invalidName'))).toBeTruthy();
    expect(key.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(key);
  });

  it('distinguishes duplicate, protocol-owned, and transport-owned names', async () => {
    renderInApp(<Harness />);
    const first = screen.getByLabelText(label('keyForRow', 1));
    fireEvent.change(first, { target: { value: 'x-route' } });
    const second = screen.getByLabelText(label('keyForRow', 2));
    fireEvent.change(second, { target: { value: 'X-Route' } });
    fireEvent.blur(second);
    expect(await screen.findByText(i18n.t('dashboard.upstreamEditor.headers.validation.duplicateName'))).toBeTruthy();

    fireEvent.change(first, { target: { value: 'Anthropic-Beta' } });
    fireEvent.blur(first);
    expect(await screen.findByText(i18n.t('dashboard.upstreamEditor.headers.validation.messagesOwned'))).toBeTruthy();
    expect(screen.queryByText(i18n.t('dashboard.upstreamEditor.headers.validation.duplicateName'))).toBeNull();

    fireEvent.change(first, { target: { value: 'Authorization' } });
    fireEvent.blur(first);
    expect(await screen.findByText(i18n.t('dashboard.upstreamEditor.headers.validation.transportOwned'))).toBeTruthy();
  });

  it('shows invalid replacement values beneath the value control', async () => {
    renderInApp(<Harness />);
    const key = screen.getByLabelText(label('keyForRow', 1));
    fireEvent.change(key, { target: { value: 'x-route' } });
    const value = screen.getByLabelText(label('valueForRow', 1));
    fireEvent.change(value, { target: { value: 'control\u0001byte' } });
    fireEvent.blur(value);

    expect(await screen.findByText(i18n.t('dashboard.upstreamEditor.headers.validation.invalidValue'))).toBeTruthy();
    expect(value.getAttribute('aria-invalid')).toBe('true');
  });
});
