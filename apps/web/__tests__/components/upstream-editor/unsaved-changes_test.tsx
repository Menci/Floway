import { fireEvent, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { UpstreamConfigSidebar, configReadOnly } from '../../../src/components/upstream-editor/config-sidebar';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { ProviderConfigSection } from '../../../src/components/upstream-editor/provider-config';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

const customRecord = (
  modelsFetch: { enabled: boolean; endpoint?: string },
  proxyFallbackList: UpstreamRecord['proxy_fallback_list'] = [],
): UpstreamRecord => upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://api.example.com',
    authStyle: 'bearer',
    apiKey: '',
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules: [],
    modelsFetch,
    models: [],
  },
  state: null,
  proxy_fallback_list: proxyFallbackList,
});

const dirty = () => screen.getByTestId('dirty').textContent;

const ConfigProbe = ({ record }: { record: UpstreamRecord }) => {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  return (
    <FormProvider {...form}>
      <output data-testid="dirty">{String(form.formState.isDirty)}</output>
      <ProviderConfigSection record={record} onPatch={vi.fn()} onRefreshModels={vi.fn()} />
    </FormProvider>
  );
};

// The colo whitelist only renders on the Cloudflare runtime, so the proxy case
// needs the sidebar the editor mounts it from.
const SidebarProbe = ({ editLevel = 'full', record }: { editLevel?: 'off' | 'models' | 'full'; record: UpstreamRecord }) => {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  return (
    <FormProvider {...form}>
      <output data-testid="dirty">{String(form.formState.isDirty)}</output>
      <UpstreamConfigSidebar
        catalogAvailable
        discovered={[]}
        onPatch={vi.fn()}
        onRefreshModels={vi.fn()}
        editLevel={editLevel}
        proxies={[]}
        record={record}
        runtime={{ kind: 'cloudflare', runtimeLocation: 'HKG' }}
      />
    </FormProvider>
  );
};

it('keeps Full-only values focusable and selectable in a models-only editor', () => {
  renderInApp(<SidebarProbe editLevel="models" record={customRecord({ enabled: true })} />);
  const baseUrl = screen.getByDisplayValue('https://api.example.com') as HTMLInputElement;
  const name = screen.getByRole('textbox', { name: i18n.t('dashboard.upstreamEditor.fields.name') }) as HTMLInputElement;
  const prefix = screen.getByRole('textbox', { name: i18n.t('dashboard.upstreamEditor.sections.prefix') }) as HTMLInputElement;
  expect(baseUrl.readOnly).toBe(true);
  expect(baseUrl.disabled).toBe(false);
  expect(name.readOnly).toBe(true);
  expect(name.disabled).toBe(false);
  expect(prefix.readOnly).toBe(true);
  expect(prefix.disabled).toBe(false);
  expect(baseUrl.closest('[inert]')).toBeNull();
  const catalogSwitch = screen.getByRole<HTMLInputElement>('switch', { name: i18n.t('dashboard.upstreamEditor.fields.fetchModels') });
  expect(catalogSwitch.hasAttribute('disabled')).toBe(false);
  expect(catalogSwitch.checked).toBe(true);
  expect(configReadOnly('models')).toEqual({ connection: true, modelsFetch: false });
  fireEvent.click(catalogSwitch);
  expect(catalogSwitch.checked).toBe(false);
});

// The page reads formState.isDirty to decide whether leaving prompts, so each
// case ends where it started and asks that flag.
const editAndUndo = (value: string, edited: string) => {
  fireEvent.change(screen.getByDisplayValue(value), { target: { value: edited } });
  fireEvent.change(screen.getByDisplayValue(edited), { target: { value } });
};

// A field the editor registers writes its key into the edited values on mount,
// and react-hook-form decides dirtiness by comparing those values against the
// ones the form opened with. So an optional field whose stored record omits its
// key used to leave the form permanently dirty after any edit anywhere, and the
// editor prompted about unsaved changes on a record that was back at its saved
// state. Each case is paired with the same record carrying the optional value,
// which is the arrangement that always worked.
it('keeps path overrides and endpoint checkboxes read-only without Full', () => {
  renderInApp(<SidebarProbe editLevel="off" record={customRecord({ enabled: true })} />);
  const endpoint = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
  expect(endpoint.readOnly).toBe(true);
  const override = screen.getByPlaceholderText('/v1/chat/completions') as HTMLInputElement;
  expect(override.readOnly).toBe(true);
  const disabledModels = screen.getByRole('combobox', { name: i18n.t('dashboard.upstreamEditor.sections.disabledModels') }) as HTMLInputElement;
  expect(disabledModels.getAttribute('aria-readonly')).toBe('true');
  const catalogSwitch = screen.getByRole<HTMLInputElement>('switch', { name: i18n.t('dashboard.upstreamEditor.fields.fetchModels') });
  expect(catalogSwitch.checked).toBe(true);
  expect(configReadOnly('off')).toEqual({ connection: true, modelsFetch: true });
});

describe('upstream editor dirtiness across an edit and its undo', () => {
  it('settles clean when the catalog path is absent from the stored config', () => {
    renderInApp(<ConfigProbe record={customRecord({ enabled: true })} />);
    editAndUndo('https://api.example.com', 'https://api.example.com/x');
    expect(dirty()).toBe('false');
  });

  it('settles clean when the catalog path is stored', () => {
    renderInApp(<ConfigProbe record={customRecord({ enabled: true, endpoint: '/v1/models' })} />);
    editAndUndo('https://api.example.com', 'https://api.example.com/x');
    expect(dirty()).toBe('false');
  });

  it('settles clean when the catalog switch is turned on and off again', () => {
    renderInApp(<ConfigProbe record={customRecord({ enabled: false })} />);
    const label = i18n.t('dashboard.upstreamEditor.fields.fetchModels');
    fireEvent.click(screen.getByLabelText(label));
    expect(dirty()).toBe('true');
    fireEvent.click(screen.getByLabelText(label));
    expect(dirty()).toBe('false');
  });

  it('settles clean when a draft ingress header rule is typed and cleared', () => {
    renderInApp(<ConfigProbe record={customRecord({ enabled: true })} />);
    const key = screen.getByLabelText(i18n.t('dashboard.upstreamEditor.headers.keyForRow', { number: 1 }));
    fireEvent.change(key, { target: { value: 'x-route' } });
    expect(dirty()).toBe('true');
    fireEvent.change(key, { target: { value: '' } });
    fireEvent.blur(key);
    expect(dirty()).toBe('false');
  });

  it('settles clean beside a proxy entry with no colo whitelist', () => {
    renderInApp(<SidebarProbe record={customRecord({ enabled: true, endpoint: '/v1/models' }, [{ id: 'direct_fetch' }])} />);
    editAndUndo('Upstream', 'Renamed');
    expect(dirty()).toBe('false');
  });

  it('settles clean beside a proxy entry with a colo whitelist', () => {
    renderInApp(<SidebarProbe record={customRecord({ enabled: true, endpoint: '/v1/models' }, [{ id: 'direct_fetch', colos: ['HKG'] }])} />);
    editAndUndo('Upstream', 'Renamed');
    expect(dirty()).toBe('false');
  });
});
