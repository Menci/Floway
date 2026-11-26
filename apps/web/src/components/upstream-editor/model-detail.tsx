import { DeleteRegular } from '@fluentui/react-icons';
import { useEffect, useId, useRef } from 'react';

import type { ModelRow } from './data';
import { publicModelId } from './data';
import { DecisionTargetEditor } from './decision-target-editor';
import { CHAT_ENDPOINT_KEYS, endpointOptionsFor, IMAGE_ENDPOINT_KEYS, shapeForKind } from './endpoints';
import { FeatureFlagsEditor } from './feature-flags';
import { type ModelValidationField, modelValidationIssues } from './model-validation';
import { PricingEditor } from './pricing-editor';
import { RerankTargetEditor } from './rerank-target-editor';
import { EditorSection } from './section';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { type TFunction, useTranslation } from '../../i18n/translation';
import { applyFieldPatch, type FieldPatch } from '../../lib/field-patch';
import { ModelInputFields } from '../models/input-modalities';
import { pruneLimitsForKind } from '../models/limits';
import { ModelLimitsFields } from '../models/limits-editor';
import { ChoiceGroup } from '../ui/choice-group';
import { Checkbox, Dropdown, Input, Switch } from '../ui/fluent-form-controls';
import { CHECKBOX_LIST_CLASS, PANE_GAP_CLASS, TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { MultiselectCombobox, valuesAsOptions } from '../ui/multiselect-combobox';
import { SectionHeader } from '../ui/section-header';
import type { UpstreamChatModelConfig, UpstreamModelConfig } from '@floway-dev/provider/browser';

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
  onUpstreamModelIdCommit,
  readOnly,
  record,
  revealValidation,
  row,
  section,
  upstreamFlags,
}: {
  onChange: (value: UpstreamModelConfig) => void;
  onDelete: () => void;
  onSourceChange: (source: 'auto' | 'manual') => void;
  onUpstreamModelIdCommit: (upstreamModelId: string) => void;
  readOnly: boolean;
  record: UpstreamRecord;
  revealValidation: boolean;
  row: ModelRow;
  section: 'details' | 'flags';
  upstreamFlags: UpstreamRecord['flag_overrides'];
}) {
  const { t } = useTranslation();
  const reasoningLabelId = useId();
  const upstreamIdRef = useRef<HTMLInputElement>(null);
  const fieldsReadOnly = readOnly || row.source !== 'manual';
  const patch = (next: FieldPatch<UpstreamModelConfig>) => {
    if (fieldsReadOnly) return;
    onChange(applyFieldPatch(row.config, next));
  };
  const setKind = (kind: UpstreamModelConfig['kind']) => patch({
    kind,
    chat: kind === 'chat' ? row.config.chat : undefined,
    // Only a chat turn carries an opaque blob, so the scope goes with the kind.
    opaqueBlobCompatibilityScope: kind === 'chat' ? row.config.opaqueBlobCompatibilityScope : undefined,
    rerankTarget: undefined,
    decisionTarget: undefined,
    // A kind keeps only the limits it can state, so a value the form no longer
    // shows is not written back as a budget the new kind cannot mean.
    ...(kind !== row.config.kind ? { limits: pruneLimitsForKind(row.config.limits, kind) } : {}),
    ...shapeForKind(kind, row.config, record.kind),
  });

  const updateLimit = (key: keyof NonNullable<UpstreamModelConfig['limits']>, raw: string) => {
    const limits = applyFieldPatch(row.config.limits ?? {}, { [key]: optionalNumber(raw) });
    patch({ limits: Object.keys(limits).length ? limits : undefined });
  };

  const updateChat = (update: FieldPatch<UpstreamChatModelConfig>) => patch({ chat: cleanChat(applyFieldPatch(row.config.chat ?? {}, update)) });

  const updateReasoning = (update: FieldPatch<NonNullable<UpstreamChatModelConfig['reasoning']>>) => {
    const reasoning = applyFieldPatch(row.config.chat?.reasoning ?? {}, update);
    updateChat({ reasoning: Object.keys(reasoning).length ? reasoning : undefined });
  };

  const validationIssues = revealValidation ? modelValidationIssues(row.config) : [];
  const validationMessage = (field: ModelValidationField) => {
    const issue = validationIssues.find(candidate => candidate.field === field);
    return issue ? t(issue.message) : undefined;
  };
  const upstreamIdError = validationMessage('upstreamModelId');
  const summaryError = validationIssues.find(issue => issue.field === 'configuration' || issue.field === 'pricing' || issue.field === 'reasoning');
  const effort = row.config.chat?.reasoning?.effort;
  const budget = row.config.chat?.reasoning?.budget_tokens;
  const mandatory = row.config.chat?.reasoning?.mandatory === true;
  const controlledReasoning = effort !== undefined || budget !== undefined || row.config.chat?.reasoning?.adaptive === true;
  const opaqueBlobCompatibilityScope = row.config.opaqueBlobCompatibilityScope;
  const bindOpaqueBlobsToUpstream = opaqueBlobCompatibilityScope?.bindToUpstream ?? true;

  const updateOpaqueBlobCompatibilityScope = (
    update: FieldPatch<NonNullable<UpstreamModelConfig['opaqueBlobCompatibilityScope']>>,
  ) => patch({
    opaqueBlobCompatibilityScope: applyFieldPatch(opaqueBlobCompatibilityScope ?? { bindToUpstream: bindOpaqueBlobsToUpstream }, update),
  });

  useEffect(() => {
    if (revealValidation && upstreamIdError) upstreamIdRef.current?.focus();
  }, [revealValidation, upstreamIdError]);

  return (
    <div className="grid gap-3 min-w-0">
      <SectionHeader level={2} truncate title={row.config.display_name ?? publicModelId(row.config)} actions={
        <ChoiceGroup
          ariaLabel={t('models.editor.source')}
          items={[
            { value: 'auto', label: t('models.editor.auto'), disabled: readOnly || !row.hasAuto },
            { value: 'manual', label: t('models.editor.manual'), disabled: readOnly },
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
        {summaryError && <MessageBar intent="error"><MessageBarBody>{t(summaryError.message)}</MessageBarBody></MessageBar>}

        <EditorSection level={3} title={t('models.editor.identity')}>
          {/* This sits beside a 380px sidebar, so the available width and the
              width a media query can see are two different numbers. */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
            <Field className="min-w-0" label={t('models.editor.displayName')}>
              <Input className="!w-full" placeholder={t('models.editor.displayNamePlaceholder')} readOnly={fieldsReadOnly} value={row.config.display_name ?? ''} onChange={(_, data) => patch({ display_name: data.value || undefined })} />
            </Field>
            <Field className="min-w-0" label={t('models.editor.kind')}>
              <Dropdown readOnly={fieldsReadOnly} selectedOptions={[row.config.kind]} value={t(`models.editor.kindValue.${row.config.kind}`)} onOptionSelect={(_, data) => data.optionValue !== undefined && setKind(data.optionValue as UpstreamModelConfig['kind'])}>
                <Option value="chat">{t('models.editor.kindValue.chat')}</Option>
                <Option value="embedding">{t('models.editor.kindValue.embedding')}</Option>
                <Option value="image">{t('models.editor.kindValue.image')}</Option>
                <Option value="transcription">{t('models.editor.kindValue.transcription')}</Option>
                {record.kind === 'custom' && <Option value="speech">{t('models.editor.kindValue.speech')}</Option>}
                {/* The gateway only accepts a rerank target on a custom upstream, so the kind is offered only where it can be saved. */}
                {record.kind === 'custom' && <Option value="rerank">{t('models.editor.kindValue.rerank')}</Option>}
                {/* Decision models are first-class on custom, Azure, Ollama, Copilot, and
                    every other upstream that serves a decision dialect. */}
                <Option value="decision">{t('models.editor.kindValue.decision')}</Option>
              </Dropdown>
            </Field>
            {record.kind !== 'kimi-code' && <Field className="min-w-0" label={record.kind === 'azure' ? t('models.editor.deployment') : t('models.editor.upstreamId')} validationMessage={upstreamIdError} validationState={upstreamIdError ? 'error' : 'none'}>
              <Input className="!w-full font-mono" placeholder={record.kind === 'azure' ? t('models.editor.deploymentPlaceholder') : t('models.editor.upstreamIdPlaceholder')} readOnly={fieldsReadOnly || row.hasAuto} ref={upstreamIdRef} value={row.config.upstreamModelId} onBlur={() => onUpstreamModelIdCommit(row.config.upstreamModelId)} onChange={(_, data) => patch({ upstreamModelId: data.value })} />
            </Field>}
            <Field className="min-w-0" label={t('models.editor.publicId')}>
              <Input className="!w-full font-mono" placeholder={row.config.upstreamModelId || t('models.editor.publicIdPlaceholder')} readOnly={fieldsReadOnly} value={row.config.publicModelId ?? ''} onChange={(_, data) => patch({ publicModelId: data.value || undefined })} />
            </Field>
          </div>
        </EditorSection>

        {/* Opaque blobs ride a chat turn's history across models; no other kind
            carries one. */}
        {row.config.kind === 'chat' && <EditorSection
          info={<span className="whitespace-pre-line">{t('models.editor.opaqueBlobCompatibilityHint')}</span>}
          level={3}
          title={t('models.editor.opaqueBlobCompatibility')}
        >
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <Input
              aria-label={t('models.editor.opaqueBlobCompatibilityKey')}
              className="min-w-[220px] flex-1 font-mono"
              placeholder={row.config.upstreamModelId}
              readOnly={fieldsReadOnly}
              value={opaqueBlobCompatibilityScope?.key ?? ''}
              onChange={(_, data) => updateOpaqueBlobCompatibilityScope({ key: data.value || undefined })}
            />
            <Switch
              checked={bindOpaqueBlobsToUpstream}
              className="flex-none"
              label={t('models.editor.bindOpaqueBlobsToUpstream')}
              readOnly={fieldsReadOnly}
              onChange={(_, data) => updateOpaqueBlobCompatibilityScope({ bindToUpstream: data.checked })}
            />
          </div>
        </EditorSection>}

        {ENDPOINT_CHOICE_KINDS.has(row.config.kind) && <EditorSection error={validationMessage('endpoints')} level={3} title={t('models.editor.endpoints')}>
          <div className={`${TWO_COLUMN_FORM_CLASS} ${CHECKBOX_LIST_CLASS}`}>
            {modelEndpointOptions(row.config.kind).map(({ key, label }) => <Checkbox
              checked={key in row.config.endpoints}
              readOnly={fieldsReadOnly}
              key={key}
              label={label}
              onChange={(_, data) => {
                const endpoints = { ...row.config.endpoints };
                if (data.checked) endpoints[key] = {}; else delete endpoints[key];
                patch({ endpoints });
              }}
            />)}
          </div>
        </EditorSection>}

        {row.config.kind === 'rerank' && row.config.rerankTarget && <EditorSection error={validationMessage('rerankTarget')} level={3} title={t('models.editor.rerankTarget')}>
          <RerankTargetEditor readOnly={fieldsReadOnly} value={row.config.rerankTarget} onChange={rerankTarget => patch({ rerankTarget })} />
        </EditorSection>}

        {row.config.kind === 'decision' && record.kind === 'custom' && <EditorSection error={validationMessage('decisionTarget')} level={3} title={t('models.editor.decisionTarget')}>
          <DecisionTargetEditor readOnly={fieldsReadOnly} value={row.config.decisionTarget ?? { protocol: 'typesafe-systemone' }} onChange={decisionTarget => patch({ decisionTarget })} />
        </EditorSection>}

        {row.config.kind !== 'image' && <EditorSection level={3} title={t('models.editor.capabilities')}>
          <ModelLimitsFields
            columnGapClass="gap-4"
            kind={row.config.kind}
            limits={row.config.limits}
            onChange={updateLimit}
            readOnly={fieldsReadOnly}
            t={t}
          />
          {row.config.kind === 'chat' && <>
            <ModelInputFields chat={row.config.chat} readOnly={fieldsReadOnly} onChange={updateChat} />
            <div aria-labelledby={reasoningLabelId} className="grid gap-3" role="group">
              <Text id={reasoningLabelId} weight="semibold">{t('models.editor.reasoning')}</Text>
              <div className="flex flex-wrap gap-4">
                <Switch checked={effort !== undefined} disabled={mandatory} readOnly={fieldsReadOnly} label={t('models.editor.effortLevels')} onChange={(_, data) => updateReasoning({ effort: data.checked ? { supported: ['low', 'medium', 'high'], default: 'medium' } : undefined })} />
                <Switch checked={budget !== undefined} disabled={mandatory} readOnly={fieldsReadOnly} label={t('models.editor.budgetTokens')} onChange={(_, data) => updateReasoning({ budget_tokens: data.checked ? {} : undefined })} />
                <Switch checked={row.config.chat?.reasoning?.adaptive === true} disabled={mandatory} readOnly={fieldsReadOnly} label={t('models.editor.adaptive')} onChange={(_, data) => updateReasoning({ adaptive: data.checked ? true : undefined })} />
                <Switch checked={mandatory} disabled={controlledReasoning} readOnly={fieldsReadOnly} label={t('models.editor.mandatory')} onChange={(_, data) => updateReasoning({ mandatory: data.checked ? true : undefined })} />
              </div>
              {effort && <EffortEditor readOnly={fieldsReadOnly} effort={effort} onChange={next => updateReasoning({ effort: next })} t={t} />}
              {budget && <div className={`${TWO_COLUMN_FORM_CLASS} gap-4 max-w-[420px]`}>
                <NumberField label={t('models.editor.minimum')} placeholder="e.g. 1024" readOnly={fieldsReadOnly} value={budget.min} onChange={raw => updateReasoning({ budget_tokens: numberRange(budget, 'min', raw) })} />
                <NumberField label={t('models.editor.maximum')} placeholder="e.g. 32000" readOnly={fieldsReadOnly} value={budget.max} onChange={raw => updateReasoning({ budget_tokens: numberRange(budget, 'max', raw) })} />
              </div>}
            </div>
          </>}
        </EditorSection>}

        <EditorSection level={3} title={t('models.editor.pricing')} description={t('models.editor.pricingHint')}>
          <PricingEditor
            readOnly={fieldsReadOnly}
            kind={row.config.kind}
            onChange={pricing => patch({ pricing })}
            value={row.config.pricing}
          />
        </EditorSection>

        {!fieldsReadOnly && <Button icon={<DeleteRegular />} onClick={onDelete}>
          {t('models.editor.delete')}
        </Button>}
      </>}
    </div>
  );
}

function NumberField({ label, onChange, placeholder, readOnly, value }: { label: string; onChange: (raw: string) => void; placeholder: string; readOnly: boolean; value?: number | undefined }) {
  return <Field className="min-w-0" label={label}><Input className="!w-full" min={0} placeholder={placeholder} readOnly={readOnly} type="number" value={value === undefined ? '' : String(value)} onChange={(_, data) => onChange(data.value)} /></Field>;
}

function EffortEditor({ effort, onChange, readOnly, t }: { readOnly: boolean; effort: NonNullable<UpstreamChatModelConfig['reasoning']>['effort'] & {}; onChange: (effort: NonNullable<UpstreamChatModelConfig['reasoning']>['effort']) => void; t: TFunction }) {
  const supported = effort.supported;
  const setSupported = (values: readonly string[]) => onChange({
    supported: [...values],
    default: values.includes(effort.default) ? effort.default : values[0] ?? '',
  });
  return <div className={`grid grid-cols-[minmax(0,1fr)_minmax(180px,0.45fr)] ${PANE_GAP_CLASS} max-[760px]:grid-cols-1`}>
    <Field label={t('models.editor.supportedEfforts')}>
      <MultiselectCombobox
        closedLabel={supported.join(', ')}
        freeform
        normalizeValue={level => level.trim()}
        onChange={setSupported}
        options={valuesAsOptions([...new Set([...reasoningPresets, ...supported])])}
        placeholder={t('models.editor.effortPlaceholder')}
        readOnly={readOnly}
        value={supported}
      />
    </Field>
    <Field label={t('models.editor.defaultEffort')}>
      <Dropdown disabled={supported.length === 0} readOnly={readOnly} selectedOptions={[effort.default]} value={effort.default} onOptionSelect={(_, data) => data.optionValue !== undefined && onChange({ ...effort, default: data.optionValue })}>
        {supported.map(level => <Option key={level} value={level}>{level}</Option>)}
      </Dropdown>
    </Field>
  </div>;
}

const optionalNumber = (raw: string): number | undefined => raw === '' ? undefined : Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : undefined;
const cleanChat = (chat: UpstreamChatModelConfig): UpstreamChatModelConfig | undefined => chat.modalities || chat.image_detail_original !== undefined || chat.reasoning ? chat : undefined;
const numberRange = (range: { min?: number; max?: number }, key: 'min' | 'max', raw: string) => applyFieldPatch(range, { [key]: optionalNumber(raw) });

const ENDPOINT_CHOICE_KINDS = new Set<UpstreamModelConfig['kind']>(['chat', 'image']);

const modelEndpointOptions = (kind: UpstreamModelConfig['kind']) =>
  endpointOptionsFor(kind === 'image' ? IMAGE_ENDPOINT_KEYS : CHAT_ENDPOINT_KEYS);
