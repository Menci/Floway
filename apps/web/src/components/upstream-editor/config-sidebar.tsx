import { DeleteRegular } from '@fluentui/react-icons';
import { useId, useMemo } from 'react';
import { Controller, useFieldArray, useFormContext, useWatch } from 'react-hook-form';

import type { RuntimeInfo, UpstreamEditorValues } from './data';
import { modelPrefixIsValid, publicModelId } from './data';
import { ApiPathsSection, ProviderConfigSection } from './provider-config';
import { EditorSection } from './section';
import type { ProxyRecord, UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Dropdown, Input } from '../ui/fluent-form-controls';
import { MultiselectCombobox, valuesAsOptions } from '../ui/multiselect-combobox';
import { PANEL_INSET_CLASS } from '../ui/panel';
import { ReorderButtons } from '../ui/reorder-buttons';
import { ScrollArea } from '../ui/scroll-area';
import { StatusBadge } from '../ui/status-badge';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { HuePicker } from '../upstreams/hue-picker';
import type { UpstreamModelConfig } from '@floway-dev/provider';
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
  const { control, formState: { errors } } = useFormContext<UpstreamEditorValues>();
  return <ScrollArea axes="vertical" className="h-full min-h-0 max-[1050px]:h-auto" noTabIndex viewportClassName="scroll-py-1">
    <div className={PANEL_INSET_CLASS}>
      <aside className="grid gap-7">
        <EditorSection title={t('dashboard.upstreamEditor.fields.name')}>
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
                  name={field.name}
                  onBlur={field.onBlur}
                  onChange={(_, data) => field.onChange(data.value)}
                  ref={field.ref}
                  required
                  value={field.value}
                />
              </Field>
            )}
          />
        </EditorSection>
        <EditorSection
          inline
          title={t('dashboard.upstreamEditor.sections.hue')}
          description={t('dashboard.upstreamEditor.hue.description')}
        >
          <UpstreamHueEditor kind={record.kind} />
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

function UpstreamHueEditor({ kind }: { kind: UpstreamRecord['kind'] }) {
  const { control } = useFormContext<UpstreamEditorValues>();
  return <Controller control={control} name="hue" render={({ field }) => (
    <HuePicker kind={kind} hue={field.value} onChange={field.onChange} />
  )} />;
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
  const options = useMemo(
    () => buildDisabledModelOptions(discovered, manual, disabled, catalogAvailable),
    [catalogAvailable, disabled, discovered, manual],
  );
  const missing = options.filter(option => option.missing).map(option => option.id);
  return <div className="grid gap-3">
    <MultiselectCombobox
      ariaLabel={t('dashboard.upstreamEditor.sections.disabledModels')}
      onChange={next => setValue('disabledPublicModelIds', next, { shouldDirty: true })}
      options={valuesAsOptions(options.map(option => option.id))}
      placeholder={disabled.length === 0
        ? t('dashboard.upstreamEditor.disabledModelsPlaceholder')
        : t('dashboard.upstreamEditor.disabledModelsSelected', { count: disabled.length })}
      renderOption={({ value }) => <span className="flex items-center justify-between gap-3 min-w-0 w-full">
        <span className="font-mono min-w-0 truncate">{value}</span>
        {missing.includes(value) && <StatusBadge tone="warning">{t('dashboard.upstreamEditor.disabledModelsUnavailable')}</StatusBadge>}
      </span>}
      value={disabled}
    />
    {missing.length > 0 && <MessageBar intent="warning" layout="multiline">
      <MessageBarBody>{t('dashboard.upstreamEditor.disabledModelsMissing', { models: missing.join(', ') })}</MessageBarBody>
    </MessageBar>}
  </div>;
}

function ProxyFallbackEditor({ proxies, runtime }: { proxies: ProxyRecord[]; runtime: RuntimeInfo }) {
  const { t } = useTranslation();
  const idPrefix = useId();
  const { control } = useFormContext<UpstreamEditorValues>();
  const { fields, append, move, remove } = useFieldArray({ control, name: 'proxyFallbackList' });
  const available = [
    { id: 'direct_connect', name: t('dashboard.upstreamEditor.proxy.directConnect') },
    { id: 'direct_fetch', name: t('dashboard.upstreamEditor.proxy.directFetch') },
    ...proxies,
  ];
  const hint = runtime.kind === 'cloudflare' ? t('dashboard.upstreamEditor.proxy.colo', { colo: runtime.runtimeLocation }) : null;
  return <div
    aria-describedby={hint ? `${idPrefix}-hint` : undefined}
    className="grid gap-2"
  >
    {fields.map((field, index) => <div className="grid gap-2 border-0 border-t border-solid border-fui-divider py-2 first:border-t-0 first:pt-0" key={field.id}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <Controller control={control} name={`proxyFallbackList.${index}.id`} render={({ field: item }) => <Dropdown aria-label={t('dashboard.upstreamEditor.sections.proxy')} selectedOptions={[item.value]} value={available.find(proxy => proxy.id === item.value)?.name ?? item.value} onOptionSelect={(_, data) => data.optionValue !== undefined && item.onChange(data.optionValue)}>{available.map(proxy => <Option key={proxy.id} value={proxy.id}>{proxy.name}</Option>)}</Dropdown>} />
        <div className="inline-flex">
          <ReorderButtons downLabel={t('dashboard.upstreamEditor.actions.moveDown')} isFirst={index === 0} isLast={index === fields.length - 1} onMove={direction => move(index, index + direction)} upLabel={t('dashboard.upstreamEditor.actions.moveUp')} />
          <TooltipIconButton danger icon={<DeleteRegular />} label={t('dashboard.upstreamEditor.actions.remove')} onClick={() => remove(index)} />
        </div>
      </div>
      {runtime.kind === 'cloudflare' && <Controller control={control} name={`proxyFallbackList.${index}.colos`} render={({ field: item }) => <ColoCombobox current={runtime.runtimeLocation} onChange={item.onChange} value={item.value ?? []} />} />}
    </div>)}
    <Button onClick={() => append({ id: 'direct_connect' })}>{t('dashboard.upstreamEditor.proxy.add')}</Button>
    {hint && <Text id={`${idPrefix}-hint`} size={200} className="text-fui-fg2">{hint}</Text>}
  </div>;
}

function ColoCombobox({ current, onChange, value }: { current: string; onChange: (value: string[] | undefined) => void; value: string[] }) {
  const { t } = useTranslation();
  return <MultiselectCombobox
    ariaLabel={t('dashboard.upstreamEditor.proxy.colos')}
    freeform
    normalizeValue={location => location.trim().toUpperCase()}
    // An empty whitelist is the absence of the field, not a field holding none.
    onChange={next => onChange(next.length === 0 ? undefined : next)}
    options={valuesAsOptions([...new Set([current, ...COMMON_COLO_LOCATIONS, ...value])])}
    placeholder={value.length === 0
      ? t('dashboard.upstreamEditor.proxy.allColos')
      : t('dashboard.upstreamEditor.proxy.colosSelected', { count: value.length })}
    renderOption={({ value: location }) => <span className="flex items-center justify-between gap-2 w-full"><span className="font-mono">{location}</span>{location === current && <StatusBadge tone="neutral">{t('dashboard.upstreamEditor.proxy.currentColo')}</StatusBadge>}</span>}
    value={value}
  />;
}

function ModelPrefixEditor() {
  const { t } = useTranslation();
  const idPrefix = useId();
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
        validationState={errors.modelPrefix ? 'error' : undefined}
        validationMessage={errors.modelPrefix?.message ? t(errors.modelPrefix.message, { max: MODEL_PREFIX_MAX_LENGTH }) : undefined}
      >
        <Input aria-label={t('dashboard.upstreamEditor.sections.prefix')} value={prefix} onChange={(_, data) => update(data.value)} className="font-mono" placeholder="openrouter/" />
      </Field>
      {value && !invalid && <div className="grid gap-2">
        {(['unprefixed', 'prefixed'] as const).map(form => <div aria-labelledby={`${idPrefix}-${form}`} className="flex items-center justify-between gap-3" key={form} role="group">
          <Text id={`${idPrefix}-${form}`} size={200}>{t(`dashboard.upstreamEditor.prefix.${form}`)}</Text>
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
