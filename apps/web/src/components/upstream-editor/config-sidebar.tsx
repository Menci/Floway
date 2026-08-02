import { DeleteRegular } from '@fluentui/react-icons';
import { useId, useMemo, useState } from 'react';
import { Controller, useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import type { RuntimeInfo, UpstreamEditorValues } from './editor-data';
import { modelPrefixIsValid, publicModelId } from './editor-data';
import { ApiPathsSection, ProviderConfigSection } from './provider-config';
import type { ProxyRecord, UpstreamModelConfig, UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useDangerTextClass } from '../ui/danger';
import { Combobox, Dropdown, Input } from '../ui/fluent-form-controls';
import { ReorderButtons } from '../ui/reorder-buttons';
import { ScrollArea } from '../ui/scroll-area';
import { SectionHeader } from '../ui/section-header';
import { StatusBadge } from '../ui/status-badge';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { UpstreamColorPicker } from '../upstreams/upstream-color-picker';
import { MODEL_PREFIX_MAX_LENGTH } from '@floway-dev/provider/model-prefix';

const { Button, Checkbox, Field, MessageBar, MessageBarBody, Option, Text } = fluentComponents;

const COMMON_COLO_LOCATIONS = [
  'HKG', 'NRT', 'KIX', 'TPE', 'ICN', 'SIN', 'BKK', 'KUL',
  'LAX', 'SJC', 'SEA', 'DFW', 'ORD', 'IAD', 'EWR', 'YYZ',
  'LHR', 'CDG', 'AMS', 'FRA', 'MAD', 'MXP', 'WAW', 'ARN',
  'SYD', 'AKL', 'GRU', 'JNB', 'DXB', 'BOM', 'DEL',
] as const;

export function UpstreamConfigSidebar({
  catalogAvailable,
  discovered,
  onColorValidityChange,
  onPatch,
  onRefreshModels,
  proxies,
  record,
  runtime,
}: {
  catalogAvailable: boolean;
  discovered: UpstreamModelConfig[];
  onColorValidityChange: (invalid: boolean) => void;
  onPatch: (patch: { config?: unknown; state?: unknown }, persisted?: boolean) => void;
  onRefreshModels: () => void;
  proxies: ProxyRecord[];
  record: UpstreamRecord;
  runtime: RuntimeInfo;
}) {
  const { t } = useTranslation();
  const { control, formState: { errors } } = useFormContext<UpstreamEditorValues>();
  return <ScrollArea axes="vertical" className="h-full min-h-0 max-[1050px]:h-auto" noTabIndex viewportClassName="scroll-py-1">
    <div className="p-[18px_20px_28px]">
      <aside className="grid gap-7">
        <EditorSection required title={t('dashboard.upstreamEditor.fields.name')}>
          <Controller
            control={control}
            name="name"
            render={({ field }) => (
              <Field
                validationMessage={errors.name?.message ? t(errors.name.message) : undefined}
                validationState={errors.name ? 'error' : undefined}
              >
                <Input
                  aria-label={t('dashboard.upstreamEditor.fields.name')}
                  required
                  value={field.value}
                  onBlur={field.onBlur}
                  onChange={(_, data) => field.onChange(data.value)}
                />
              </Field>
            )}
          />
        </EditorSection>
        <EditorSection
          error={errors.color?.message ? t(errors.color.message) : undefined}
          inline
          title={t('dashboard.upstreamEditor.sections.color')}
          description={t('dashboard.upstreamEditor.color.description')}
        >
          <UpstreamColorEditor kind={record.kind} onValidityChange={onColorValidityChange} />
        </EditorSection>
        <EditorSection
          error={errors.config?.message ? t(errors.config.message) : undefined}
          title={t('dashboard.upstreamEditor.sections.connection')}
        >
          <ProviderConfigSection record={record} onPatch={onPatch} onRefreshModels={onRefreshModels} />
        </EditorSection>
        <EditorSection title={t('dashboard.upstreamEditor.sections.proxy')} description={t('dashboard.upstreamEditor.proxy.empty')}>
          <ProxyFallbackEditor proxies={proxies} runtime={runtime} />
        </EditorSection>
        {record.kind === 'custom' && (
          <EditorSection title={t('dashboard.upstreamEditor.sections.apiPaths')}>
            <ApiPathsSection record={record} />
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
    </div>
  </ScrollArea>;
}

function UpstreamColorEditor({ kind, onValidityChange }: { kind: UpstreamRecord['kind']; onValidityChange: (invalid: boolean) => void }) {
  const { control } = useFormContext<UpstreamEditorValues>();
  return <Controller control={control} name="color" render={({ field }) => <div className="grid gap-3">
    <UpstreamColorPicker
      kind={kind}
      value={field.value}
      onChange={field.onChange}
      onValidityChange={onValidityChange}
    />
  </div>} />;
}

// The composite editors here -- colour popover, provider credential flow -- are not one control a Fluent `Field` could speak for.
function EditorSection({ children, description, error, inline = false, required = false, title }: { children: React.ReactNode; description?: string; error?: string; inline?: boolean; required?: boolean; title: string }) {
  const dangerText = useDangerTextClass();
  return <section className={inline ? 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4' : 'grid gap-4'}>
    <SectionHeader description={description} level={2} title={<>{title}{required && <span aria-hidden className={dangerText}> *</span>}</>} />
    {children}
    {error && <Text className={`${dangerText} ${inline ? 'col-span-2' : ''}`} role="alert" size={200}>{error}</Text>}
  </section>;
}

// The sorted union of every model id this upstream can disable, which
// `__tests__/components/upstream-editor/disabled-models_test.ts` drives
// directly -- the export is that seam, not a second consumer.
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
          <span className="font-mono min-w-0 truncate">{option.id}</span>
          {option.missing && <StatusBadge color="warning">{t('dashboard.upstreamEditor.disabledModelsUnavailable')}</StatusBadge>}
        </span>
      </Option>)}
    </Combobox>
    {missing.length > 0 && <MessageBar intent="warning" layout="multiline">
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
    {fields.map((field, index) => <div className="grid gap-2 border-0 border-t border-solid border-fui-stroke1 py-2 first:border-t-0 first:pt-0" key={field.id}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <Controller control={control} name={`proxyFallbackList.${index}.id`} render={({ field: item }) => <Dropdown aria-label={t('dashboard.upstreamEditor.sections.proxy')} selectedOptions={[item.value]} value={available.find(proxy => proxy.id === item.value)?.name ?? item.value} onOptionSelect={(_, data) => data.optionValue !== undefined && item.onChange(data.optionValue)}>{available.map(proxy => <Option key={proxy.id} value={proxy.id}>{proxy.name}</Option>)}</Dropdown>} />
        <div className="inline-flex">
          <ReorderButtons downLabel={t('dashboard.upstreamEditor.actions.moveDown')} isFirst={index === 0} isLast={index === fields.length - 1} onMove={direction => move(index, index + direction)} upLabel={t('dashboard.upstreamEditor.actions.moveUp')} />
          <TooltipIconButton danger icon={<DeleteRegular />} label={t('dashboard.upstreamEditor.actions.remove')} onClick={() => remove(index)} />
        </div>
      </div>
      {runtime.kind === 'cloudflare' && <Controller control={control} name={`proxyFallbackList.${index}.colos`} render={({ field: item }) => <ColoCombobox current={runtime.runtimeLocation} onChange={item.onChange} value={item.value ?? []} />} />}
    </div>)}
    <Button appearance="secondary" className="!font-fui-regular" onClick={() => append({ id: 'direct_fetch' })}>{t('dashboard.upstreamEditor.proxy.add')}</Button>
    {hint && <Text id={`${idPrefix}-hint`} size={200} className="text-fui-fg2">{hint}</Text>}
  </div>;
}

function ColoCombobox({ current, onChange, value }: { current: string; onChange: (value: string[] | undefined) => void; value: string[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const options = [...new Set([current, ...COMMON_COLO_LOCATIONS, ...value])]
    .filter(location => location.toLowerCase().includes(query.trim().toLowerCase()));
  const commit = (locations: readonly string[]) => {
    const normalized = [...new Set(locations.map(location => location.trim().toUpperCase()).filter(Boolean))];
    onChange(normalized.length === 0 ? undefined : normalized);
  };
  return <Combobox
    aria-label={t('dashboard.upstreamEditor.proxy.colos')}
    freeform
    multiselect
    onChange={event => setQuery(event.target.value)}
    onKeyDown={event => {
      if (event.key !== 'Enter' || query.trim() === '') return;
      event.preventDefault();
      commit([...value, query]);
      setQuery('');
    }}
    onOpenChange={(_, data) => { setOpen(data.open); setQuery(''); }}
    onOptionSelect={(_, data) => { commit(data.selectedOptions); setQuery(''); }}
    placeholder={t('dashboard.upstreamEditor.proxy.allColos')}
    selectedOptions={value}
    value={open ? query : value.length === 0 ? '' : value.join(', ')}
  >
    {options.map(location => <Option key={location} text={location} value={location}>
      <span className="flex items-center justify-between gap-2 w-full"><span className="font-mono">{location}</span>{location === current && <StatusBadge color="informative">{t('dashboard.upstreamEditor.proxy.currentColo')}</StatusBadge>}</span>
    </Option>)}
  </Combobox>;
}

function ModelPrefixEditor() {
  const { t } = useTranslation();
  const { control, formState: { errors }, setValue } = useFormContext<UpstreamEditorValues>();
  // setValue rather than the Controller's onChange, so the prefix re-validates per keystroke.
  const commit = (value: UpstreamEditorValues['modelPrefix']) => setValue('modelPrefix', value, { shouldDirty: true, shouldValidate: true });
  return <Controller control={control} name="modelPrefix" render={({ field }) => {
    const value = field.value;
    const prefix = value?.prefix ?? '';
    const invalid = prefix !== '' && !modelPrefixIsValid(prefix);
    const update = (next: string) => commit(next ? { prefix: next, addressable: value?.addressable ?? ['unprefixed'], listed: value?.listed ?? ['unprefixed'] } : null);
    return <div className="grid gap-3">
      <Field
        validationState={errors.modelPrefix ? 'error' : 'none'}
        validationMessage={errors.modelPrefix?.message ? t(errors.modelPrefix.message, { max: MODEL_PREFIX_MAX_LENGTH }) : undefined}
      >
        <Input value={prefix} onChange={(_, data) => update(data.value)} className="font-mono" placeholder="openrouter/" />
      </Field>
      {value && !invalid && <div className="grid gap-2">
        {(['unprefixed', 'prefixed'] as const).map(form => <div className="flex items-center justify-between gap-3" key={form}>
          <Text size={200}>{t(`dashboard.upstreamEditor.prefix.${form}`)}</Text>
          <div className="flex gap-2">
            <Checkbox label={t('dashboard.upstreamEditor.prefix.addressable')} checked={value.addressable.includes(form)} onChange={(_, data) => {
              const set = new Set(value.addressable); if (data.checked) set.add(form); else if (set.size > 1) set.delete(form);
              commit({ ...value, addressable: [...set], listed: value.listed.filter(item => set.has(item)) });
            }} />
            <Checkbox label={t('dashboard.upstreamEditor.prefix.listed')} disabled={!value.addressable.includes(form)} checked={value.listed.includes(form)} onChange={(_, data) => {
              const set = new Set(value.listed); if (data.checked) set.add(form); else set.delete(form);
              commit({ ...value, listed: [...set] });
            }} />
          </div>
        </div>)}
      </div>}
    </div>;
  }} />;
}
