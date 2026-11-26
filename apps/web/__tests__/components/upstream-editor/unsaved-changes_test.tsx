import { fireEvent, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { UpstreamConfigSidebar } from '../../../src/components/upstream-editor/config-sidebar';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { ProviderConfigSection } from '../../../src/components/upstream-editor/provider-config';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

const customRecord = (
  modelsFetch: Omit<Extract<UpstreamRecord, { kind: 'custom' }>['config']['modelsFetch'], 'authStyle'>
    & Partial<Pick<Extract<UpstreamRecord, { kind: 'custom' }>['config']['modelsFetch'], 'authStyle'>>,
  proxyFallbackList: UpstreamRecord['proxy_fallback_list'] = [],
): UpstreamRecord => upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://api.example.com',
    apiKey: '',
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules: [],
    modelsFetch: { authStyle: 'bearer', ...modelsFetch },
  },
  manual_models: [],
  state: null,
  proxy_fallback_list: proxyFallbackList,
});

const dirty = () => screen.getByTestId('dirty').textContent;

const ConfigProbe = ({ record }: { record: UpstreamRecord }) => {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  return (
    <FormProvider {...form}>
      <output data-testid="dirty">{String(form.formState.isDirty)}</output>
      <ProviderConfigSection record={record} onPatch={vi.fn()} />
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
  const name = screen.getByRole('textbox', { name: i18n.t('upstreams.editor.fields.name') }) as HTMLInputElement;
  const prefix = screen.getByRole('textbox', { name: i18n.t('upstreams.editor.sections.prefix') }) as HTMLInputElement;
  expect(baseUrl.readOnly).toBe(true);
  expect(baseUrl.disabled).toBe(false);
  expect(name.readOnly).toBe(true);
  expect(name.disabled).toBe(false);
  expect(prefix.readOnly).toBe(true);
  expect(prefix.disabled).toBe(false);
  expect(baseUrl.closest('[inert]')).toBeNull();
  const catalogSwitch = screen.getByRole<HTMLInputElement>('switch', { name: i18n.t('upstreams.editor.fields.fetchModels') });
  expect(catalogSwitch.hasAttribute('disabled')).toBe(false);
  expect(catalogSwitch.getAttribute('aria-readonly')).toBe('true');
  expect(catalogSwitch.checked).toBe(true);
  fireEvent.click(catalogSwitch);
  expect(catalogSwitch.checked).toBe(true);
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
// state.
describe('upstream editor dirtiness across an edit and its undo', () => {
  it('settles clean when the catalog path is absent from the stored config', () => {
    renderInApp(<ConfigProbe record={customRecord({ enabled: true })} />);
    editAndUndo('https://api.example.com', 'https://api.example.com/x');
    expect(dirty()).toBe('false');
  });

  it('settles clean when a draft ingress header rule is typed and cleared', () => {
    renderInApp(<ConfigProbe record={customRecord({ enabled: true })} />);
    const key = screen.getByLabelText(i18n.t('upstreams.editor.headers.keyForRow', { number: 1 }));
    fireEvent.change(key, { target: { value: 'x-route' } });
    expect(dirty()).toBe('true');
    fireEvent.change(key, { target: { value: '' } });
    fireEvent.blur(key);
    expect(dirty()).toBe('false');
  });
});
