import { fireEvent, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { UpstreamConfigSidebar } from '../../../src/components/upstream-editor/config-sidebar';
import { ProviderConfigSection } from '../../../src/components/upstream-editor/provider-config';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

const DirtyProbe = ({ record }: { record: UpstreamRecord }) => {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  return (
    <FormProvider {...form}>
      <output data-testid="dirty">{String(form.formState.isDirty)}</output>
      <ProviderConfigSection record={record} onPatch={vi.fn()} onRefreshModels={vi.fn()} />
    </FormProvider>
  );
};

const customWith = (modelsFetch: { enabled: boolean; endpoint?: string }): UpstreamRecord => upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://api.example.com',
    authStyle: 'bearer',
    apiKey: '',
    endpoints: { chatCompletions: {} },
    modelsFetch,
    models: [],
  },
  state: null,
});

const dirty = () => screen.getByTestId('dirty').textContent;
const baseUrl = () => screen.getByDisplayValue('https://api.example.com');
const nameInput = () => screen.getByDisplayValue('Upstream');

const SidebarProbe = ({ colos }: { colos: string[] | undefined }) => {
  const record = upstreamRecord('up_sidebar', {
    kind: 'custom',
    config: {
      baseUrl: 'https://api.example.com',
      authStyle: 'bearer',
      apiKey: '',
      endpoints: { chatCompletions: {} },
      modelsFetch: { enabled: true, endpoint: '/v1/models' },
      models: [],
    },
    state: null,
    proxy_fallback_list: [colos ? { id: 'direct_fetch', colos } : { id: 'direct_fetch' }],
  });
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  return (
    <FormProvider {...form}>
      <output data-testid="dirty">{String(form.formState.isDirty)}</output>
      <UpstreamConfigSidebar
        catalogAvailable
        discovered={[]}
        onColorValidityChange={vi.fn()}
        onPatch={vi.fn()}
        onRefreshModels={vi.fn()}
        proxies={[]}
        record={record}
        runtime={{ kind: 'cloudflare', runtimeLocation: 'HKG' }}
      />
    </FormProvider>
  );
};

describe('probe', () => {
  it('round-trips an edit without an endpoint in the stored config', () => {
    renderInApp(<DirtyProbe record={customWith({ enabled: true })} />);
    // eslint-disable-next-line no-console
    console.log('NO-ENDPOINT mounted:', dirty());
    fireEvent.change(baseUrl(), { target: { value: 'https://api.example.com/x' } });
    // eslint-disable-next-line no-console
    console.log('NO-ENDPOINT edited:', dirty());
    fireEvent.change(screen.getByDisplayValue('https://api.example.com/x'), { target: { value: 'https://api.example.com' } });
    // eslint-disable-next-line no-console
    console.log('NO-ENDPOINT reverted:', dirty());
    expect(dirty()).toBe('false');
  });

  it('round-trips an edit with an endpoint in the stored config', () => {
    renderInApp(<DirtyProbe record={customWith({ enabled: true, endpoint: '/v1/models' })} />);
    fireEvent.change(baseUrl(), { target: { value: 'https://api.example.com/x' } });
    fireEvent.change(screen.getByDisplayValue('https://api.example.com/x'), { target: { value: 'https://api.example.com' } });
    // eslint-disable-next-line no-console
    console.log('WITH-ENDPOINT reverted:', dirty());
    expect(dirty()).toBe('false');
  });

  it('round-trips the catalog switch', () => {
    renderInApp(<DirtyProbe record={customWith({ enabled: false })} />);
    const label = i18n.t('dashboard.upstreamEditor.fields.fetchModels');
    fireEvent.click(screen.getByLabelText(label));
    // eslint-disable-next-line no-console
    console.log('SWITCH on:', dirty());
    fireEvent.click(screen.getByLabelText(label));
    // eslint-disable-next-line no-console
    console.log('SWITCH off:', dirty());
    expect(dirty()).toBe('false');
  });

  it('round-trips an edit beside a proxy entry with no colo list', () => {
    renderInApp(<SidebarProbe colos={undefined} />);
    fireEvent.change(nameInput(), { target: { value: 'Renamed' } });
    fireEvent.change(screen.getByDisplayValue('Renamed'), { target: { value: 'Upstream' } });
    // eslint-disable-next-line no-console
    console.log('NO-COLOS reverted:', dirty());
    expect(dirty()).toBe('false');
  });

  it('round-trips an edit beside a proxy entry with a colo list', () => {
    renderInApp(<SidebarProbe colos={['HKG']} />);
    fireEvent.change(nameInput(), { target: { value: 'Renamed' } });
    fireEvent.change(screen.getByDisplayValue('Renamed'), { target: { value: 'Upstream' } });
    // eslint-disable-next-line no-console
    console.log('WITH-COLOS reverted:', dirty());
    expect(dirty()).toBe('false');
  });
});
