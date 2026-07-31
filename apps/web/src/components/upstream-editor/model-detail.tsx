import { DeleteRegular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { publicModelId } from './editor-data';
import { FeatureFlagsEditor } from './feature-flags';
import { PricingEditor } from './pricing-editor';
import { pricingEntryDraftsFor, pricingIsValid } from './pricing-model';
import { RerankTargetEditor } from './rerank-target-editor';
import type {
  UpstreamModelConfig,
  UpstreamRecord,
} from '../../api/types';
import { fluentComponents } from '../../fluent';
import { ChoiceGroup } from '../ui/choice-group';
import { Checkbox, Combobox, Dropdown, Input, Switch } from '../ui/fluent-form-controls';
import { TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { SectionHeader } from '../ui/section-header';
import { modelsField, type UpstreamChatModelConfig } from '@floway-dev/provider';

const {
  Button,
  Field,
  MessageBar,
  MessageBarBody,
  Option,
  Text,
  makeStyles,
} = fluentComponents;

const useStyles = makeStyles({
  endpointLabel: {
    fontFamily: 'var(--fontFamilyMonospace) !important',
    fontSize: 'var(--floway-font-size-mono) !important',
  },
});

export interface ModelDetailRow {
  key: string;
  source: 'auto' | 'manual';
  config: UpstreamModelConfig;
  manualIndex: number | null;
  hasAuto: boolean;
}

const reasoningPresets = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function ModelDetail({
  onDelete,
  onSourceChange,
  onUpdate,
  readOnly,
  record,
  row,
  section,
  upstreamFlags,
}: {
  onDelete: () => void;
  onSourceChange: (source: 'auto' | 'manual') => void;
  onUpdate: (value: UpstreamModelConfig) => void;
  readOnly: boolean;
  record: UpstreamRecord;
  row: ModelDetailRow;
  section: 'details' | 'flags';
  upstreamFlags: UpstreamRecord['flag_overrides'];
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  const editable = row.source === 'manual' && !readOnly;
  const patch = (next: Partial<UpstreamModelConfig>) => {
    if (!editable) return;
    const updated = { ...row.config, ...next };
    for (const key of Object.keys(next) as (keyof UpstreamModelConfig)[]) {
      if (next[key] === undefined) delete (updated as unknown as Record<string, unknown>)[key];
    }
    onUpdate(updated);
  };
  const setKind = (kind: UpstreamModelConfig['kind']) => patch({
    kind,
    endpoints: defaultEndpointsForKind(kind, row.config.endpoints),
    chat: kind === 'chat' ? row.config.chat : undefined,
    // A rerank model is invalid without a target, so switching to the kind
    // seeds the default protocol rather than leaving the config unsavable.
    rerankTarget: kind === 'rerank' ? row.config.rerankTarget ?? { protocol: 'cohere-v2' } : undefined,
    ...(kind === 'image' ? { limits: undefined } : {}),
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
        <div className="flex-none">
          <ChoiceGroup
            ariaLabel={t('dashboard.upstreamEditor.models.source')}
            items={[
              { value: 'auto', label: t('dashboard.upstreamEditor.models.auto'), disabled: readOnly || !row.hasAuto },
              { value: 'manual', label: t('dashboard.upstreamEditor.models.manual'), disabled: readOnly },
            ]}
            onChange={value => onSourceChange(value as 'auto' | 'manual')}
            value={row.source}
          />
        </div>
      } />

      {section === 'flags' ? <FeatureFlagsEditor
        defaults={record.flag_defaults}
        inherited={upstreamFlags}
        readOnly={!editable}
        value={row.config.flagOverrides ?? {}}
        onChange={flagOverrides => patch({ flagOverrides: Object.keys(flagOverrides).length === 0 ? undefined : flagOverrides })}
      /> : <>
        {validationError && <MessageBar intent="error"><MessageBarBody>{validationError}</MessageBarBody></MessageBar>}

        <ModelEditorSection title={t('dashboard.upstreamEditor.models.identity')}>
          {/* Column count follows the room there is rather than the viewport:
              this sits beside a 380px sidebar, so the width here and the width
              a media query can see are two different numbers. Four fields fit
              on one line when they can, and fall to two and then one as the
              track minimum stops being met. */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
            <Field className="min-w-0" label={t('dashboard.upstreamEditor.models.displayName')}>
              <Input className="!w-full" placeholder={t('dashboard.upstreamEditor.models.displayNamePlaceholder')} readOnly={!editable} value={row.config.display_name ?? ''} onChange={(_, data) => patch({ display_name: data.value || undefined })} />
            </Field>
            <Field className="min-w-0" label={t('dashboard.upstreamEditor.models.kind')}>
              <Dropdown readOnly={!editable} selectedOptions={[row.config.kind]} value={modelKindLabel(row.config.kind)} onOptionSelect={(_, data) => data.optionValue !== undefined && setKind(data.optionValue as UpstreamModelConfig['kind'])}>
                <Option value="chat">Chat</Option><Option value="embedding">Embedding</Option><Option value="image">Image</Option><Option value="transcription">Transcription</Option>
                {/* The gateway only accepts a rerank target on a custom upstream, so the kind is offered only where it can be saved. */}
                {record.kind === 'custom' && <Option value="rerank">Rerank</Option>}
              </Dropdown>
            </Field>
            <Field className="min-w-0" label={record.kind === 'azure' ? t('dashboard.upstreamEditor.models.deployment') : t('dashboard.upstreamEditor.models.upstreamId')}>
              <Input className="!w-full font-mono" placeholder={record.kind === 'azure' ? t('dashboard.upstreamEditor.models.deploymentPlaceholder') : t('dashboard.upstreamEditor.models.upstreamIdPlaceholder')} readOnly={!editable || row.hasAuto} value={row.config.upstreamModelId} onChange={(_, data) => patch({ upstreamModelId: data.value })} />
            </Field>
            <Field className="min-w-0" label={t('dashboard.upstreamEditor.models.publicId')}>
              <Input className="!w-full font-mono" placeholder={row.config.upstreamModelId || t('dashboard.upstreamEditor.models.publicIdPlaceholder')} readOnly={!editable} value={row.config.publicModelId ?? ''} onChange={(_, data) => patch({ publicModelId: data.value || undefined })} />
            </Field>
          </div>
        </ModelEditorSection>

        {/* Embedding, transcription, and rerank each address exactly one
          endpoint, so there is nothing for the operator to choose. */}
        {ENDPOINT_CHOICE_KINDS.has(row.config.kind) && <ModelEditorSection title={t('dashboard.upstreamEditor.models.endpoints')}>
          <div className={`${TWO_COLUMN_FORM_CLASS} gap-2`}>
            {modelEndpointOptions(row.config.kind).map(([key, label]) => <Checkbox
              checked={key in row.config.endpoints}
              readOnly={!editable}
              key={key}
              label={{ children: label, className: styles.endpointLabel }}
              onChange={(_, data) => {
                const endpoints = { ...row.config.endpoints };
                if (data.checked) endpoints[key] = {}; else delete endpoints[key];
                patch({ endpoints });
              }}
            />)}
          </div>
        </ModelEditorSection>}

        {row.config.kind === 'rerank' && row.config.rerankTarget && <ModelEditorSection title={t('dashboard.upstreamEditor.models.rerankTarget')}>
          <RerankTargetEditor readOnly={!editable} value={row.config.rerankTarget} onChange={rerankTarget => patch({ rerankTarget })} />
        </ModelEditorSection>}

        {row.config.kind !== 'image' && <ModelEditorSection title={t('dashboard.upstreamEditor.models.capabilities')}>
          <div className="grid grid-cols-3 gap-4 max-[760px]:grid-cols-1">
            <NumberField label={t('dashboard.upstreamEditor.models.contextWindow')} placeholder="e.g. 1050000" readOnly={!editable} value={row.config.limits?.max_context_window_tokens} onChange={raw => updateLimit('max_context_window_tokens', raw)} />
            <NumberField label={t('dashboard.upstreamEditor.models.promptTokens')} placeholder="e.g. 922000" readOnly={!editable} value={row.config.limits?.max_prompt_tokens} onChange={raw => updateLimit('max_prompt_tokens', raw)} />
            <NumberField label={t('dashboard.upstreamEditor.models.outputTokens')} placeholder="e.g. 128000" readOnly={!editable} value={row.config.limits?.max_output_tokens} onChange={raw => updateLimit('max_output_tokens', raw)} />
          </div>
          {row.config.kind === 'chat' && <>
            <Switch
              checked={row.config.chat?.modalities?.input.includes('image') === true}
              readOnly={!editable}
              label={t('dashboard.upstreamEditor.models.imageInput')}
              onChange={(_, data) => patch({ chat: cleanChat({ ...(row.config.chat ?? {}), modalities: data.checked ? { input: ['text', 'image'], output: ['text'] } : undefined }) })}
            />
            <div className="grid gap-3">
              <Text weight="semibold">{t('dashboard.upstreamEditor.models.reasoning')}</Text>
              <div className="flex flex-wrap gap-4">
                <Switch checked={effort !== undefined} disabled={mandatory} readOnly={!editable} label={t('dashboard.upstreamEditor.models.effortLevels')} onChange={(_, data) => updateReasoning({ effort: data.checked ? { supported: ['low', 'medium', 'high'], default: 'medium' } : undefined })} />
                <Switch checked={budget !== undefined} disabled={mandatory} readOnly={!editable} label={t('dashboard.upstreamEditor.models.budgetTokens')} onChange={(_, data) => updateReasoning({ budget_tokens: data.checked ? {} : undefined })} />
                <Switch checked={row.config.chat?.reasoning?.adaptive === true} disabled={mandatory} readOnly={!editable} label={t('dashboard.upstreamEditor.models.adaptive')} onChange={(_, data) => updateReasoning({ adaptive: data.checked ? true : undefined })} />
                <Switch checked={mandatory} disabled={controlledReasoning} readOnly={!editable} label={t('dashboard.upstreamEditor.models.mandatory')} onChange={(_, data) => updateReasoning(data.checked ? { mandatory: true } : { mandatory: undefined })} />
              </div>
              {effort && <EffortEditor editable={editable} effort={effort} onChange={next => updateReasoning({ effort: next })} t={t} />}
              {budget && <div className={`${TWO_COLUMN_FORM_CLASS} gap-4 max-w-[420px]`}>
                <NumberField label={t('dashboard.upstreamEditor.models.minimum')} placeholder="e.g. 1024" readOnly={!editable} value={budget.min} onChange={raw => updateReasoning({ budget_tokens: numberRange(budget, 'min', raw) })} />
                <NumberField label={t('dashboard.upstreamEditor.models.maximum')} placeholder="e.g. 32000" readOnly={!editable} value={budget.max} onChange={raw => updateReasoning({ budget_tokens: numberRange(budget, 'max', raw) })} />
              </div>}
            </div>
          </>}
        </ModelEditorSection>}

        <ModelEditorSection title={t('dashboard.upstreamEditor.models.pricing')} description={t('dashboard.upstreamEditor.models.pricingHint')}>
          <PricingEditor
            editable={editable}
            kind={row.config.kind}
            onChange={pricing => patch({ pricing })}
            value={row.config.pricing}
          />
        </ModelEditorSection>

        {editable && <Button appearance="secondary" icon={<DeleteRegular />} onClick={onDelete}>
          {t('dashboard.upstreamEditor.models.delete')}
        </Button>}
      </>}
    </div>
  );
}

function ModelEditorSection({ children, description, title }: { children: React.ReactNode; description?: string; title: string }) {
  return <section className="grid gap-3">
    <SectionHeader description={description} level={3} title={title} />
    {children}
  </section>;
}

function NumberField({ label, onChange, placeholder, readOnly, value }: { label: string; onChange: (raw: string) => void; placeholder: string; readOnly: boolean; value?: number }) {
  return <Field className="min-w-0" label={label}><Input className="!w-full" min={0} placeholder={placeholder} readOnly={readOnly} type="number" value={value === undefined ? '' : String(value)} onChange={(_, data) => onChange(data.value)} /></Field>;
}

function EffortEditor({ editable, effort, onChange, t }: { editable: boolean; effort: NonNullable<UpstreamChatModelConfig['reasoning']>['effort'] & {}; onChange: (effort: NonNullable<UpstreamChatModelConfig['reasoning']>['effort']) => void; t: ReturnType<typeof useTranslation>['t'] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const supported = effort.supported;
  const options = [...new Set([...reasoningPresets, ...supported])]
    .filter(level => level.toLowerCase().includes(query.trim().toLowerCase()));
  const setSupported = (next: readonly string[]) => {
    const values = [...next];
    onChange({
      supported: values,
      default: values.includes(effort.default) ? effort.default : values[0] ?? '',
    });
  };
  const add = (raw: string) => {
    const level = raw.trim();
    if (level && !supported.includes(level)) setSupported([...supported, level]);
    setQuery('');
  };
  return <div className="grid grid-cols-[minmax(0,1fr)_minmax(180px,0.45fr)] gap-4 max-[760px]:grid-cols-1">
    <Field label={t('dashboard.upstreamEditor.models.supportedEfforts')}>
      <Combobox
        readOnly={!editable}
        freeform
        multiselect
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || query.trim() === '') return;
          event.preventDefault();
          add(query);
        }}
        onOpenChange={(_, data) => {
          setOpen(data.open);
          setQuery('');
        }}
        onOptionSelect={(_, data) => {
          setSupported(data.selectedOptions);
          setQuery('');
        }}
        placeholder={t('dashboard.upstreamEditor.models.effortPlaceholder')}
        selectedOptions={[...supported]}
        value={open ? query : supported.join(', ')}
      >
        {options.map(level => <Option key={level} text={level} value={level}>{level}</Option>)}
      </Combobox>
    </Field>
    <Field label={t('dashboard.upstreamEditor.models.defaultEffort')}>
      <Dropdown disabled={supported.length === 0} readOnly={!editable} selectedOptions={[effort.default]} value={effort.default} onOptionSelect={(_, data) => data.optionValue !== undefined && onChange({ ...effort, default: data.optionValue })}>
        {supported.map(level => <Option key={level} value={level}>{level}</Option>)}
      </Dropdown>
    </Field>
  </div>;
}

function modelKindLabel(kind: UpstreamModelConfig['kind']): string {
  switch (kind) {
  case 'chat': return 'Chat';
  case 'embedding': return 'Embedding';
  case 'image': return 'Image';
  case 'transcription': return 'Transcription';
  case 'rerank': return 'Rerank';
  }
}

export function modelValidationError(model: UpstreamModelConfig, t: ReturnType<typeof useTranslation>['t']): string | null {
  const effort = model.chat?.reasoning?.effort;
  if (effort && (effort.supported.length === 0 || !effort.default || !effort.supported.includes(effort.default))) return t('dashboard.upstreamEditor.models.invalidEffort');
  const budget = model.chat?.reasoning?.budget_tokens;
  if (budget?.min !== undefined && budget.max !== undefined && budget.max < budget.min) return t('dashboard.upstreamEditor.models.invalidBudget');
  if (!pricingIsValid(pricingEntryDraftsFor(model.pricing), model.pricing)) return t('dashboard.upstreamEditor.models.invalidPricing');
  try {
    modelsField([model], 'model');
  } catch {
    return t('dashboard.upstreamEditor.models.invalidContract');
  }
  return null;
}

export const modelsAreValid = (models: readonly UpstreamModelConfig[]) => {
  const hasInvalidEditorFields = models.some(model => {
    const effort = model.chat?.reasoning?.effort;
    if (effort && (effort.supported.length === 0 || !effort.default || !effort.supported.includes(effort.default))) return true;
    const budget = model.chat?.reasoning?.budget_tokens;
    return (budget?.min !== undefined && budget.max !== undefined && budget.max < budget.min)
      || !pricingIsValid(pricingEntryDraftsFor(model.pricing), model.pricing);
  });
  if (hasInvalidEditorFields) return false;
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

const defaultEndpointsForKind = (kind: UpstreamModelConfig['kind'], current: UpstreamModelConfig['endpoints']) => {
  if (kind === 'embedding') return { embeddings: {} };
  if (kind === 'transcription') return { audioTranscriptions: {} };
  if (kind === 'rerank') return { rerank: {} };
  const keys = kind === 'image' ? ['imagesGenerations', 'imagesEdits'] as const : ['completions', 'chatCompletions', 'responses', 'messages'] as const;
  const kept: UpstreamModelConfig['endpoints'] = {};
  for (const key of keys) if (current[key]) kept[key] = current[key];
  if (Object.keys(kept).length) return kept;
  return kind === 'image' ? { imagesGenerations: {}, imagesEdits: {} } : { chatCompletions: {} };
};

const modelEndpointOptions = (kind: UpstreamModelConfig['kind']): [keyof UpstreamModelConfig['endpoints'], string][] => {
  if (kind === 'image') return [['imagesGenerations', '/images/generations'], ['imagesEdits', '/images/edits']];
  return [['completions', '/completions'], ['chatCompletions', '/chat/completions'], ['responses', '/responses'], ['messages', '/messages']];
};
