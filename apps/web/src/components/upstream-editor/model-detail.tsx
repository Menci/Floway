import { DeleteRegular } from '@fluentui/react-icons';
import { useId } from 'react';

import type { ModelRow } from './data';
import { publicModelId } from './data';
import { CHAT_ENDPOINT_KEYS, endpointOptionsFor, IMAGE_ENDPOINT_KEYS, shapeForKind } from './endpoints';
import { FeatureFlagsEditor } from './feature-flags';
import { useMonoLabelClass } from './mono-label';
import { PricingEditor } from './pricing-editor';
import { pricingEntryDraftsFor, pricingIsValid } from './pricing-model';
import { RerankTargetEditor } from './rerank-target-editor';
import { EditorSection } from './section';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { type TFunction, useTranslation } from '../../i18n/translation';
import { ChoiceGroup } from '../ui/choice-group';
import { Checkbox, Dropdown, Input, Switch } from '../ui/fluent-form-controls';
import { CHECKBOX_LIST_CLASS, PANE_GAP_CLASS, TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { MultiselectCombobox, valuesAsOptions } from '../ui/multiselect-combobox';
import { SectionHeader } from '../ui/section-header';
import { modelsField, type UpstreamChatModelConfig, type UpstreamModelConfig } from '@floway-dev/provider';

const {
  Button,
  Field,
  MessageBar,
  MessageBarBody,
  Option,
  Text,
} = fluentComponents;

const reasoningPresets = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function ModelDetail({
  onChange,
  onDelete,
  onSourceChange,
  readOnly,
  record,
  row,
  section,
  upstreamFlags,
}: {
  onChange: (value: UpstreamModelConfig) => void;
  onDelete: () => void;
  onSourceChange: (source: 'auto' | 'manual') => void;
  readOnly: boolean;
  record: UpstreamRecord;
  row: ModelRow;
  section: 'details' | 'flags';
  upstreamFlags: UpstreamRecord['flag_overrides'];
}) {
  const { t } = useTranslation();
  const monoLabel = useMonoLabelClass();
  const reasoningLabelId = useId();
  const fieldsReadOnly = readOnly || row.source !== 'manual';
  const patch = (next: Partial<UpstreamModelConfig>) => {
    if (fieldsReadOnly) return;
    const updated = { ...row.config, ...next };
    for (const key of Object.keys(next) as (keyof UpstreamModelConfig)[]) {
      if (next[key] === undefined) delete (updated as unknown as Record<string, unknown>)[key];
    }
    onChange(updated);
  };
  const setKind = (kind: UpstreamModelConfig['kind']) => patch({
    kind,
    chat: kind === 'chat' ? row.config.chat : undefined,
    rerankTarget: undefined,
    ...(kind === 'image' ? { limits: undefined } : {}),
    ...shapeForKind(kind, row.config),
  });

  const updateLimit = (key: keyof NonNullable<UpstreamModelConfig['limits']>, raw: string) => {
    const limits = { ...(row.config.limits ?? {}) };
    const value = optionalNumber(raw);
    if (value === undefined) delete limits[key]; else limits[key] = value;
    patch({ limits: Object.keys(limits).length ? limits : undefined });
  };

  const updateReasoning = (update: Partial<NonNullable<UpstreamChatModelConfig['reasoning']>>) => {
    const reasoning = cleanObject({ ...(row.config.chat?.reasoning ?? {}), ...update });
    const chat = cleanChat({ ...(row.config.chat ?? {}), reasoning: Object.keys(reasoning).length ? reasoning : undefined });
    patch({ chat });
  };

  const validationError = modelValidationError(row.config, t);
  const effort = row.config.chat?.reasoning?.effort;
  const budget = row.config.chat?.reasoning?.budget_tokens;
  const mandatory = row.config.chat?.reasoning?.mandatory === true;
  const controlledReasoning = effort !== undefined || budget !== undefined || row.config.chat?.reasoning?.adaptive === true;

  return (
    <div className="grid gap-3 min-w-0">
      <SectionHeader level={2} truncate title={row.config.display_name ?? publicModelId(row.config)} actions={
        <ChoiceGroup
          ariaLabel={t('dashboard.upstreamEditor.models.source')}
          items={[
            { value: 'auto', label: t('dashboard.upstreamEditor.models.auto'), disabled: readOnly || !row.hasAuto },
            { value: 'manual', label: t('dashboard.upstreamEditor.models.manual'), disabled: readOnly },
          ]}
          onChange={value => onSourceChange(value as 'auto' | 'manual')}
          value={row.source}
        />
      } />

      {section === 'flags' ? <FeatureFlagsEditor
        defaults={record.flag_defaults}
        inherited={upstreamFlags}
        readOnly={fieldsReadOnly}
        value={row.config.flagOverrides ?? {}}
        onChange={flagOverrides => patch({ flagOverrides: Object.keys(flagOverrides).length === 0 ? undefined : flagOverrides })}
      /> : <>
        {validationError && <MessageBar intent="error"><MessageBarBody>{validationError}</MessageBarBody></MessageBar>}

        <EditorSection level={3} title={t('dashboard.upstreamEditor.models.identity')}>
          {/* This sits beside a 380px sidebar, so the available width and the
              width a media query can see are two different numbers. */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
            <Field className="min-w-0" label={t('dashboard.upstreamEditor.models.displayName')}>
              <Input className="!w-full" placeholder={t('dashboard.upstreamEditor.models.displayNamePlaceholder')} readOnly={fieldsReadOnly} value={row.config.display_name ?? ''} onChange={(_, data) => patch({ display_name: data.value || undefined })} />
            </Field>
            <Field className="min-w-0" label={t('dashboard.upstreamEditor.models.kind')}>
              <Dropdown readOnly={fieldsReadOnly} selectedOptions={[row.config.kind]} value={modelKindLabel(row.config.kind)} onOptionSelect={(_, data) => data.optionValue !== undefined && setKind(data.optionValue as UpstreamModelConfig['kind'])}>
                <Option value="chat">Chat</Option><Option value="embedding">Embedding</Option><Option value="image">Image</Option><Option value="transcription">Transcription</Option>
                {/* The gateway only accepts a rerank target on a custom upstream, so the kind is offered only where it can be saved. */}
                {record.kind === 'custom' && <Option value="rerank">Rerank</Option>}
              </Dropdown>
            </Field>
            <Field className="min-w-0" label={record.kind === 'azure' ? t('dashboard.upstreamEditor.models.deployment') : t('dashboard.upstreamEditor.models.upstreamId')}>
              <Input className="!w-full font-mono" placeholder={record.kind === 'azure' ? t('dashboard.upstreamEditor.models.deploymentPlaceholder') : t('dashboard.upstreamEditor.models.upstreamIdPlaceholder')} readOnly={fieldsReadOnly || row.hasAuto} value={row.config.upstreamModelId} onChange={(_, data) => patch({ upstreamModelId: data.value })} />
            </Field>
            <Field className="min-w-0" label={t('dashboard.upstreamEditor.models.publicId')}>
              <Input className="!w-full font-mono" placeholder={row.config.upstreamModelId || t('dashboard.upstreamEditor.models.publicIdPlaceholder')} readOnly={fieldsReadOnly} value={row.config.publicModelId ?? ''} onChange={(_, data) => patch({ publicModelId: data.value || undefined })} />
            </Field>
          </div>
        </EditorSection>

        {ENDPOINT_CHOICE_KINDS.has(row.config.kind) && <EditorSection level={3} title={t('dashboard.upstreamEditor.models.endpoints')}>
          <div className={`${TWO_COLUMN_FORM_CLASS} ${CHECKBOX_LIST_CLASS}`}>
            {modelEndpointOptions(row.config.kind).map(([key, label]) => <Checkbox
              checked={key in row.config.endpoints}
              readOnly={fieldsReadOnly}
              key={key}
              label={{ children: label, className: monoLabel }}
              onChange={(_, data) => {
                const endpoints = { ...row.config.endpoints };
                if (data.checked) endpoints[key] = {}; else delete endpoints[key];
                patch({ endpoints });
              }}
            />)}
          </div>
        </EditorSection>}

        {row.config.kind === 'rerank' && row.config.rerankTarget && <EditorSection level={3} title={t('dashboard.upstreamEditor.models.rerankTarget')}>
          <RerankTargetEditor readOnly={fieldsReadOnly} value={row.config.rerankTarget} onChange={rerankTarget => patch({ rerankTarget })} />
        </EditorSection>}

        {row.config.kind !== 'image' && <EditorSection level={3} title={t('dashboard.upstreamEditor.models.capabilities')}>
          <div className="grid grid-cols-3 gap-4 max-[760px]:grid-cols-1">
            <NumberField label={t('dashboard.upstreamEditor.models.contextWindow')} placeholder="e.g. 1050000" readOnly={fieldsReadOnly} value={row.config.limits?.max_context_window_tokens} onChange={raw => updateLimit('max_context_window_tokens', raw)} />
            <NumberField label={t('dashboard.upstreamEditor.models.promptTokens')} placeholder="e.g. 922000" readOnly={fieldsReadOnly} value={row.config.limits?.max_prompt_tokens} onChange={raw => updateLimit('max_prompt_tokens', raw)} />
            <NumberField label={t('dashboard.upstreamEditor.models.outputTokens')} placeholder="e.g. 128000" readOnly={fieldsReadOnly} value={row.config.limits?.max_output_tokens} onChange={raw => updateLimit('max_output_tokens', raw)} />
          </div>
          {row.config.kind === 'chat' && <>
            <Switch
              checked={row.config.chat?.modalities?.input.includes('image') === true}
              readOnly={fieldsReadOnly}
              label={t('dashboard.upstreamEditor.models.imageInput')}
              onChange={(_, data) => patch({ chat: cleanChat({ ...(row.config.chat ?? {}), modalities: data.checked ? { input: ['text', 'image'], output: ['text'] } : undefined }) })}
            />
            <div aria-labelledby={reasoningLabelId} className="grid gap-3" role="group">
              <Text id={reasoningLabelId} weight="semibold">{t('dashboard.upstreamEditor.models.reasoning')}</Text>
              <div className="flex flex-wrap gap-4">
                <Switch checked={effort !== undefined} disabled={mandatory} readOnly={fieldsReadOnly} label={t('dashboard.upstreamEditor.models.effortLevels')} onChange={(_, data) => updateReasoning({ effort: data.checked ? { supported: ['low', 'medium', 'high'], default: 'medium' } : undefined })} />
                <Switch checked={budget !== undefined} disabled={mandatory} readOnly={fieldsReadOnly} label={t('dashboard.upstreamEditor.models.budgetTokens')} onChange={(_, data) => updateReasoning({ budget_tokens: data.checked ? {} : undefined })} />
                <Switch checked={row.config.chat?.reasoning?.adaptive === true} disabled={mandatory} readOnly={fieldsReadOnly} label={t('dashboard.upstreamEditor.models.adaptive')} onChange={(_, data) => updateReasoning({ adaptive: data.checked ? true : undefined })} />
                <Switch checked={mandatory} disabled={controlledReasoning} readOnly={fieldsReadOnly} label={t('dashboard.upstreamEditor.models.mandatory')} onChange={(_, data) => updateReasoning(data.checked ? { mandatory: true } : { mandatory: undefined })} />
              </div>
              {effort && <EffortEditor readOnly={fieldsReadOnly} effort={effort} onChange={next => updateReasoning({ effort: next })} t={t} />}
              {budget && <div className={`${TWO_COLUMN_FORM_CLASS} gap-4 max-w-[420px]`}>
                <NumberField label={t('dashboard.upstreamEditor.models.minimum')} placeholder="e.g. 1024" readOnly={fieldsReadOnly} value={budget.min} onChange={raw => updateReasoning({ budget_tokens: numberRange(budget, 'min', raw) })} />
                <NumberField label={t('dashboard.upstreamEditor.models.maximum')} placeholder="e.g. 32000" readOnly={fieldsReadOnly} value={budget.max} onChange={raw => updateReasoning({ budget_tokens: numberRange(budget, 'max', raw) })} />
              </div>}
            </div>
          </>}
        </EditorSection>}

        <EditorSection level={3} title={t('dashboard.upstreamEditor.models.pricing')} description={t('dashboard.upstreamEditor.models.pricingHint')}>
          <PricingEditor
            readOnly={fieldsReadOnly}
            kind={row.config.kind}
            onChange={pricing => patch({ pricing })}
            value={row.config.pricing}
          />
        </EditorSection>

        {!fieldsReadOnly && <Button icon={<DeleteRegular />} onClick={onDelete}>
          {t('dashboard.upstreamEditor.models.delete')}
        </Button>}
      </>}
    </div>
  );
}

function NumberField({ label, onChange, placeholder, readOnly, value }: { label: string; onChange: (raw: string) => void; placeholder: string; readOnly: boolean; value?: number }) {
  return <Field className="min-w-0" label={label}><Input className="!w-full" min={0} placeholder={placeholder} readOnly={readOnly} type="number" value={value === undefined ? '' : String(value)} onChange={(_, data) => onChange(data.value)} /></Field>;
}

function EffortEditor({ effort, onChange, readOnly, t }: { readOnly: boolean; effort: NonNullable<UpstreamChatModelConfig['reasoning']>['effort'] & {}; onChange: (effort: NonNullable<UpstreamChatModelConfig['reasoning']>['effort']) => void; t: TFunction }) {
  const supported = effort.supported;
  const setSupported = (values: readonly string[]) => onChange({
    supported: [...values],
    default: values.includes(effort.default) ? effort.default : values[0] ?? '',
  });
  return <div className={`grid grid-cols-[minmax(0,1fr)_minmax(180px,0.45fr)] ${PANE_GAP_CLASS} max-[760px]:grid-cols-1`}>
    <Field label={t('dashboard.upstreamEditor.models.supportedEfforts')}>
      <MultiselectCombobox
        closedLabel={supported.join(', ')}
        freeform
        normalizeValue={level => level.trim()}
        onChange={setSupported}
        options={valuesAsOptions([...new Set([...reasoningPresets, ...supported])])}
        placeholder={t('dashboard.upstreamEditor.models.effortPlaceholder')}
        readOnly={readOnly}
        value={supported}
      />
    </Field>
    <Field label={t('dashboard.upstreamEditor.models.defaultEffort')}>
      <Dropdown disabled={supported.length === 0} readOnly={readOnly} selectedOptions={[effort.default]} value={effort.default} onOptionSelect={(_, data) => data.optionValue !== undefined && onChange({ ...effort, default: data.optionValue })}>
        {supported.map(level => <Option key={level} value={level}>{level}</Option>)}
      </Dropdown>
    </Field>
  </div>;
}

const modelKindLabel = (kind: UpstreamModelConfig['kind']): string => {
  switch (kind) {
  case 'chat': return 'Chat';
  case 'embedding': return 'Embedding';
  case 'image': return 'Image';
  case 'transcription': return 'Transcription';
  case 'rerank': return 'Rerank';
  }
};

const editorFieldIssue = (model: UpstreamModelConfig): string | null => {
  const effort = model.chat?.reasoning?.effort;
  if (effort && (effort.supported.length === 0 || !effort.default || !effort.supported.includes(effort.default))) return 'dashboard.upstreamEditor.models.invalidEffort';
  const budget = model.chat?.reasoning?.budget_tokens;
  if (budget?.min !== undefined && budget.max !== undefined && budget.max < budget.min) return 'dashboard.upstreamEditor.models.invalidBudget';
  if (!pricingIsValid(pricingEntryDraftsFor(model.pricing), model.pricing)) return 'dashboard.upstreamEditor.models.invalidPricing';
  return null;
};

const modelValidationError = (model: UpstreamModelConfig, t: TFunction): string | null => {
  const issue = editorFieldIssue(model);
  if (issue) return t(issue);
  try {
    modelsField([model], 'model');
  } catch {
    return t('dashboard.upstreamEditor.models.invalidContract');
  }
  return null;
};

export const modelsAreValid = (models: readonly UpstreamModelConfig[]) => {
  if (models.some(model => editorFieldIssue(model) !== null)) return false;
  try {
    modelsField([...models], 'models');
    return true;
  } catch {
    return false;
  }
};

const optionalNumber = (raw: string): number | undefined => raw === '' ? undefined : Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : undefined;
const cleanObject = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
const cleanChat = (chat: UpstreamChatModelConfig): UpstreamChatModelConfig | undefined => chat.modalities || chat.reasoning ? chat : undefined;
const numberRange = (range: { min?: number; max?: number }, key: 'min' | 'max', raw: string) => { const next = { ...range }; const value = optionalNumber(raw); if (value === undefined) delete next[key]; else next[key] = value; return next; };

const ENDPOINT_CHOICE_KINDS = new Set<UpstreamModelConfig['kind']>(['chat', 'image']);

const modelEndpointOptions = (kind: UpstreamModelConfig['kind']) =>
  endpointOptionsFor(kind === 'image' ? IMAGE_ENDPOINT_KEYS : CHAT_ENDPOINT_KEYS);
