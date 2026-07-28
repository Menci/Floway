import { ArrowDownRegular, ArrowUpRegular, DeleteRegular, WarningRegular } from '@fluentui/react-icons';
import { useId, useMemo, useState } from 'react';
import { Controller, useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import type { RuntimeInfo, UpstreamEditorValues } from './editor-data';
import { publicModelId } from './editor-data';
import { ApiPathsSection, ProviderConfigSection } from './provider-config';
import type { ProxyRecord, UpstreamModelConfig, UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { Combobox, Input, Select } from '../ui/fluent-form-controls';
import { ScrollArea } from '../ui/scroll-area';
import { UpstreamColorPicker } from '../upstreams/upstream-color-picker';
import { MODEL_PREFIX_MAX_LENGTH, MODEL_PREFIX_REGEX } from '@floway-dev/provider/model-prefix';

const { Badge, Button, Checkbox, Field, MessageBar, MessageBarBody, Option, Text, makeStyles } = fluentComponents;

const useEditorSectionStyles = makeStyles({
  required: { color: 'var(--colorPaletteRedForeground1)' },
});

export function UpstreamConfigSidebar({
  catalogAvailable,
  discovered,
  onPatch,
  onRefreshModels,
  proxies,
  record,
  runtime,
}: {
  catalogAvailable: boolean;
  discovered: UpstreamModelConfig[];
  onPatch: (patch: { config?: unknown; state?: unknown }, persisted?: boolean) => void;
  onRefreshModels: () => void;
  proxies: ProxyRecord[];
  record: UpstreamRecord;
  runtime: RuntimeInfo;
}) {
  const { t } = useTranslation();
  const { control } = useFormContext<UpstreamEditorValues>();
  return <ScrollArea axes="vertical" className="h-full min-h-0 max-[1050px]:h-auto" contentClassName="p-[18px_20px_28px]" noTabIndex>
    <aside className="grid gap-7">
      <EditorSection required title={t('dashboard.upstreamEditor.fields.name')}>
        <Controller
          control={control}
          name="name"
          rules={{ required: true }}
          render={({ field }) => (
            <Input
              aria-label={t('dashboard.upstreamEditor.fields.name')}
              required
              value={field.value}
              onBlur={field.onBlur}
              onChange={(_, data) => field.onChange(data.value)}
            />
          )}
        />
      </EditorSection>
      <EditorSection
        inline
        title={t('dashboard.upstreamEditor.sections.color')}
        description={t('dashboard.upstreamEditor.color.description')}
      >
        <UpstreamColorEditor kind={record.kind} />
      </EditorSection>
      <EditorSection title={t('dashboard.upstreamEditor.sections.connection')}>
        <ProviderConfigSection record={record} onPatch={onPatch} />
      </EditorSection>
      <EditorSection title={t('dashboard.upstreamEditor.sections.proxy')}>
        <ProxyFallbackEditor proxies={proxies} runtime={runtime} />
      </EditorSection>
      {record.kind === 'custom' && (
        <EditorSection title={t('dashboard.upstreamEditor.sections.apiPaths')}>
          <ApiPathsSection record={record} onRefreshModels={onRefreshModels} />
        </EditorSection>
      )}
      <EditorSection
        title={t('dashboard.upstreamEditor.sections.prefix')}
        description={t('dashboard.upstreamEditor.prefixDescription')}
      >
        <ModelPrefixEditor />
      </EditorSection>
      <EditorSection title={t('dashboard.upstreamEditor.sections.disabledModels')} description={t('dashboard.upstreamEditor.disabledModelsHint')}>
        <DisabledModelsCombobox catalogAvailable={catalogAvailable} discovered={discovered} />
      </EditorSection>
    </aside>
  </ScrollArea>;
}

function UpstreamColorEditor({ kind }: { kind: UpstreamRecord['kind'] }) {
  const { clearErrors, control, setError } = useFormContext<UpstreamEditorValues>();
  return <Controller control={control} name="color" render={({ field }) => <div className="grid gap-3">
    <UpstreamColorPicker
      kind={kind}
      value={field.value}
      onChange={field.onChange}
      onValidityChange={invalid => {
        if (invalid) setError('color', { type: 'validate' });
        else clearErrors('color');
      }}
    />
  </div>} />;
}

function EditorSection({ children, description, inline = false, required = false, title }: { children: React.ReactNode; description?: string; inline?: boolean; required?: boolean; title: string }) {
  const styles = useEditorSectionStyles();
  return <section className={inline ? 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4' : 'grid gap-4'}>
    <div className="grid gap-1"><Text as="h2" size={300} weight="semibold" className="!m-0">{title}{required && <span aria-hidden className={styles.required}> *</span>}</Text>{description && <Text size={200} className="text-fui-fg2">{description}</Text>}</div>
    {children}
  </section>;
}

export const buildDisabledModelOptions = (
  discovered: readonly UpstreamModelConfig[],
  manual: readonly UpstreamModelConfig[],
  disabled: readonly string[],
  catalogAvailable: boolean,
) => {
  const availableIds = new Set([...discovered, ...manual].map(publicModelId).filter(Boolean));
  const missingIds = catalogAvailable ? new Set(disabled.filter(id => !availableIds.has(id))) : new Set<string>();
  return [...new Set([...availableIds, ...disabled])]
    .toSorted((left, right) => left.localeCompare(right))
    .map(id => ({ id, missing: missingIds.has(id) }));
};

function DisabledModelsCombobox({ catalogAvailable, discovered }: { catalogAvailable: boolean; discovered: UpstreamModelConfig[] }) {
  const { t } = useTranslation();
  const { control, setValue } = useFormContext<UpstreamEditorValues>();
  const disabled = useWatch({ control, name: 'disabledPublicModelIds' });
  const manual = useWatch({ control, name: 'manualModels' });
  const [query, setQuery] = useState('');
  const options = useMemo(
    () => buildDisabledModelOptions(discovered, manual, disabled, catalogAvailable),
    [catalogAvailable, disabled, discovered, manual],
  );
  const filtered = options.filter(option => option.id.toLowerCase().includes(query.trim().toLowerCase()));
  const missing = options.filter(option => option.missing).map(option => option.id);
  return <div className="grid gap-3">
    <Combobox
      aria-label={t('dashboard.upstreamEditor.sections.disabledModels')}
      multiselect
      onChange={event => setQuery(event.target.value)}
      onOpenChange={(_, data) => { if (!data.open) setQuery(''); }}
      onOptionSelect={(_, data) => {
        setValue('disabledPublicModelIds', data.selectedOptions, { shouldDirty: true });
        setQuery('');
      }}
      placeholder={disabled.length === 0
        ? t('dashboard.upstreamEditor.disabledModelsPlaceholder')
        : t('dashboard.upstreamEditor.disabledModelsSelected', { count: disabled.length })}
      selectedOptions={disabled}
      value={query}
    >
      {filtered.map(option => <Option key={option.id} text={option.id} value={option.id}>
        <span className="flex items-center justify-between gap-3 min-w-0 w-full">
          <span className="font-mono min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{option.id}</span>
          {option.missing && <Badge appearance="tint" color="warning" size="small">{t('dashboard.upstreamEditor.disabledModelsUnavailable')}</Badge>}
        </span>
      </Option>)}
    </Combobox>
    {missing.length > 0 && <MessageBar icon={<WarningRegular />} intent="warning" layout="multiline">
      <MessageBarBody className="break-words">{t('dashboard.upstreamEditor.disabledModelsMissing', { models: missing.join(', ') })}</MessageBarBody>
    </MessageBar>}
  </div>;
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
    className="grid gap-2"
  >
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
