import { ArrowDownRegular, ArrowUpRegular, DeleteRegular } from '@fluentui/react-icons';
import { useId } from 'react';
import { Controller, useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import type { RuntimeInfo, UpstreamEditorValues } from './editor-data';
import { ApiPathsSection, ProviderConfigSection } from './provider-config';
import type { ProxyRecord, UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { Input, Select } from '../ui/fluent-form-controls';
import { ProviderBadge } from '../upstreams/provider-badge';
import { UpstreamColorPicker } from '../upstreams/upstream-color-picker';
import { MODEL_PREFIX_MAX_LENGTH, MODEL_PREFIX_REGEX } from '@floway-dev/provider/model-prefix';

const { Button, Checkbox, Field, Text } = fluentComponents;

export function UpstreamConfigSidebar({
  onPatch,
  onRefreshModels,
  proxies,
  record,
  runtime,
}: {
  onPatch: (patch: { config?: unknown; state?: unknown }, persisted?: boolean) => void;
  onRefreshModels: () => void;
  proxies: ProxyRecord[];
  record: UpstreamRecord;
  runtime: RuntimeInfo;
}) {
  const { t } = useTranslation();
  const { control, setValue } = useFormContext<UpstreamEditorValues>();
  const disabled = useWatch({ control, name: 'disabledPublicModelIds' });
  return <aside className="h-full min-h-0 overflow-y-auto [scrollbar-gutter:stable] max-[1050px]:h-auto max-[1050px]:overflow-visible">
    <div className="grid gap-7 p-[18px_20px_28px]">
      <div>
        <Field label={t('dashboard.upstreamEditor.fields.name')} required>
          <Controller
            control={control}
            name="name"
            rules={{ required: true }}
            render={({ field }) => (
              <Input
                value={field.value}
                onBlur={field.onBlur}
                onChange={(_, data) => field.onChange(data.value)}
              />
            )}
          />
        </Field>
      </div>
      <div>
        <EditorSection
          title={t('dashboard.upstreamEditor.sections.color')}
          description={t('dashboard.upstreamEditor.color.description')}
        >
          <UpstreamColorEditor kind={record.kind} />
        </EditorSection>
      </div>
      <div>
        <EditorSection title={t('dashboard.upstreamEditor.sections.connection')}>
          <ProviderConfigSection record={record} onPatch={onPatch} />
          <ProxyFallbackEditor proxies={proxies} runtime={runtime} />
        </EditorSection>
      </div>
      {record.kind === 'custom' && <div>
        <EditorSection title={t('dashboard.upstreamEditor.sections.apiPaths')}>
          <ApiPathsSection record={record} onRefreshModels={onRefreshModels} />
        </EditorSection>
      </div>}
      <div className="grid gap-5">
        <EditorSection
          title={t('dashboard.upstreamEditor.sections.prefix')}
          description={t('dashboard.upstreamEditor.prefixDescription')}
        >
          <ModelPrefixEditor />
        </EditorSection>
        <EditorSection title={t('dashboard.upstreamEditor.sections.disabledModels')} description={t('dashboard.upstreamEditor.disabledModelsHint')}>
          <Field>
            <Input
              value={disabled.join(', ')}
              onChange={(_, data) => setValue('disabledPublicModelIds', data.value.split(',').map(v => v.trim()).filter(Boolean), { shouldDirty: true })}
              placeholder="model-a, model-b"
            />
          </Field>
        </EditorSection>
      </div>
    </div>
  </aside>;
}

function UpstreamColorEditor({ kind }: { kind: UpstreamRecord['kind'] }) {
  const { control } = useFormContext<UpstreamEditorValues>();
  return <Controller control={control} name="color" render={({ field }) => <div className="grid gap-3">
    <UpstreamColorPicker kind={kind} value={field.value ?? null} onChange={field.onChange} />
    <div className="flex items-center gap-2"><ProviderBadge color={field.value} kind={kind} /></div>
  </div>} />;
}

function EditorSection({ children, description, title }: { children: React.ReactNode; description?: string; title: string }) {
  return <section className="grid gap-3 pt-1">
    <div className="grid gap-1"><Text as="h2" size={300} weight="semibold" className="!m-0">{title}</Text>{description && <Text size={200} className="text-fui-fg2">{description}</Text>}</div>
    {children}
  </section>;
}

function ProxyFallbackEditor({ proxies, runtime }: { proxies: ProxyRecord[]; runtime: RuntimeInfo }) {
  const { t } = useTranslation();
  const idPrefix = useId();
  const { control } = useFormContext<UpstreamEditorValues>();
  const { fields, append, move, remove } = useFieldArray({ control, name: 'proxyFallbackList' });
  const available = [
    { id: 'direct_fetch', name: t('dashboard.upstreamEditor.proxy.directFetch') },
    { id: 'direct_connect', name: t('dashboard.upstreamEditor.proxy.directConnect') },
    ...proxies,
  ];
  const hint = runtime.kind === 'cloudflare' ? t('dashboard.upstreamEditor.proxy.colo', { colo: runtime.runtimeLocation }) : null;
  return <div
    aria-describedby={hint ? `${idPrefix}-hint` : undefined}
    aria-labelledby={`${idPrefix}-label`}
    className="grid gap-2"
    role="group"
  >
    <Text id={`${idPrefix}-label`}>{t('dashboard.upstreamEditor.sections.proxy')}</Text>
    {fields.length === 0 && <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.proxy.empty')}</Text>}
    {fields.map((field, index) => <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2" key={field.id}>
      <Controller control={control} name={`proxyFallbackList.${index}.id`} render={({ field: item }) => <Select aria-label={t('dashboard.upstreamEditor.sections.proxy')} key={item.value} defaultValue={item.value} onChange={(_, data) => item.onChange(data.value)}>{available.map(proxy => <option key={proxy.id} value={proxy.id}>{proxy.name}</option>)}</Select>} />
      <div className="inline-flex">
        <Button appearance="subtle" aria-label={t('dashboard.upstreamEditor.actions.moveUp')} disabled={index === 0} icon={<ArrowUpRegular />} onClick={() => move(index, index - 1)} />
        <Button appearance="subtle" aria-label={t('dashboard.upstreamEditor.actions.moveDown')} disabled={index === fields.length - 1} icon={<ArrowDownRegular />} onClick={() => move(index, index + 1)} />
        <Button appearance="subtle" aria-label={t('dashboard.upstreamEditor.actions.remove')} icon={<DeleteRegular />} onClick={() => remove(index)} />
      </div>
    </div>)}
    <Button appearance="secondary" className="!font-fui-regular" onClick={() => append({ id: 'direct_fetch' })}>{t('dashboard.upstreamEditor.proxy.add')}</Button>
    {hint && <Text id={`${idPrefix}-hint`} size={200} className="text-fui-fg2">{hint}</Text>}
  </div>;
}

function ModelPrefixEditor() {
  const { t } = useTranslation();
  const { control } = useFormContext<UpstreamEditorValues>();
  return <Controller control={control} name="modelPrefix" render={({ field }) => {
    const value = field.value;
    const prefix = value?.prefix ?? '';
    const invalid = prefix !== '' && (!MODEL_PREFIX_REGEX.test(prefix) || prefix.length > MODEL_PREFIX_MAX_LENGTH);
    const update = (next: string) => field.onChange(next ? { prefix: next, addressable: value?.addressable ?? ['unprefixed'], listed: value?.listed ?? ['unprefixed'] } : null);
    return <div className="grid gap-3">
      <Field validationState={invalid ? 'error' : 'none'} validationMessage={invalid ? t('dashboard.upstreamEditor.prefixInvalid', { max: MODEL_PREFIX_MAX_LENGTH }) : undefined}>
        <Input value={prefix} onChange={(_, data) => update(data.value)} className="font-mono" placeholder="openrouter/" />
      </Field>
      {value && !invalid && <div className="grid gap-2">
        {(['unprefixed', 'prefixed'] as const).map(form => <div className="flex items-center justify-between gap-3" key={form}>
          <Text size={200}>{t(`dashboard.upstreamEditor.prefix.${form}`)}</Text>
          <div className="flex gap-2">
            <Checkbox label={t('dashboard.upstreamEditor.prefix.addressable')} checked={value.addressable.includes(form)} onChange={(_, data) => {
              const set = new Set(value.addressable); if (data.checked) set.add(form); else if (set.size > 1) set.delete(form);
              field.onChange({ ...value, addressable: [...set], listed: value.listed.filter(item => set.has(item)) });
            }} />
            <Checkbox label={t('dashboard.upstreamEditor.prefix.listed')} disabled={!value.addressable.includes(form)} checked={value.listed.includes(form)} onChange={(_, data) => {
              const set = new Set(value.listed); if (data.checked) set.add(form); else set.delete(form); field.onChange({ ...value, listed: [...set] });
            }} />
          </div>
        </div>)}
      </div>}
    </div>;
  }} />;
}
