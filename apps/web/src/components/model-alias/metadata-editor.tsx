import type { AnnouncedMetadataField, AnnouncedMetadataIssues } from './validation';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Dropdown, Input, Switch } from '../ui/fluent-form-controls';
import { SECTION_STACK_CLASS, TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { SectionHeader } from '../ui/section-header';
import type { AnnouncedMetadata, ModelKind } from '@floway-dev/protocols/common';

const { Field, Option } = fluentComponents;

const numberValue = (value: string) => value === '' ? undefined : Number(value);

export function MetadataEditor({ disabled, issues, kind, onChange, readOnly, value }: {
  disabled: boolean;
  issues: AnnouncedMetadataIssues;
  kind: ModelKind;
  onChange: (value: AnnouncedMetadata) => void;
  readOnly: boolean;
  value: AnnouncedMetadata;
}) {
  const { t } = useTranslation();
  const patchLimit = (key: 'max_context_window_tokens' | 'max_prompt_tokens' | 'max_output_tokens', raw: string) => {
    const limits = { ...(value.limits ?? {}), [key]: numberValue(raw) };
    if (limits[key] === undefined) delete limits[key];
    onChange({ ...value, limits: Object.keys(limits).length ? limits : undefined });
  };
  const patchReasoning = (patch: Record<string, unknown>) => {
    const reasoning = { ...(value.chat?.reasoning ?? {}), ...patch } as NonNullable<NonNullable<AnnouncedMetadata['chat']>['reasoning']>;
    for (const [key, item] of Object.entries(reasoning)) if (item === undefined) delete (reasoning as Record<string, unknown>)[key];
    const chat = { ...(value.chat ?? {}), reasoning: Object.keys(reasoning).length ? reasoning : undefined };
    onChange({ ...value, chat: chat.modalities || chat.reasoning ? chat : undefined });
  };
  const effort = value.chat?.reasoning?.effort;
  const budget = value.chat?.reasoning?.budget_tokens;
  const issueProps = (field: AnnouncedMetadataField) => issues[field] === undefined
    ? {}
    : { validationMessage: t(issues[field]), validationState: 'error' as const };

  return (
    <div className="grid gap-5" role="group" aria-label={t('dashboard.modelAliases.metadata.heading')}>
      <section className={SECTION_STACK_CLASS}>
        <SectionHeader level={4} title={t('dashboard.modelAliases.metadata.limits')} />
        <div className="grid grid-cols-3 gap-3 max-[680px]:grid-cols-1">
          <Field label={t('dashboard.modelAliases.metadata.context')} {...issueProps('max_context_window_tokens')}><Input disabled={disabled} min={0} readOnly={readOnly} type="number" value={value.limits?.max_context_window_tokens?.toString() ?? ''} onChange={(_, data) => patchLimit('max_context_window_tokens', data.value)} /></Field>
          <Field label={t('dashboard.modelAliases.metadata.prompt')} {...issueProps('max_prompt_tokens')}><Input disabled={disabled} min={0} readOnly={readOnly} type="number" value={value.limits?.max_prompt_tokens?.toString() ?? ''} onChange={(_, data) => patchLimit('max_prompt_tokens', data.value)} /></Field>
          <Field label={t('dashboard.modelAliases.metadata.output')} {...issueProps('max_output_tokens')}><Input disabled={disabled} min={0} readOnly={readOnly} type="number" value={value.limits?.max_output_tokens?.toString() ?? ''} onChange={(_, data) => patchLimit('max_output_tokens', data.value)} /></Field>
        </div>
      </section>
      {kind === 'chat' && <>
        <section className={SECTION_STACK_CLASS}>
          <SectionHeader level={4} title={t('dashboard.modelAliases.metadata.modalities')} />
          <Switch
            checked={value.chat?.modalities?.input.includes('image') ?? false}
            disabled={disabled}
            readOnly={readOnly}
            label={t('dashboard.modelAliases.metadata.imageInput')}
            onChange={(_, data) => {
              const chat = { ...(value.chat ?? {}), modalities: data.checked ? { input: ['text', 'image'] as const, output: ['text'] as const } : undefined };
              onChange({ ...value, chat: chat.modalities || chat.reasoning ? chat : undefined });
            }}
          />
        </section>
        <section className={SECTION_STACK_CLASS}>
          <SectionHeader level={4} title={t('dashboard.modelAliases.metadata.reasoning')} />
          <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>
            <Switch checked={effort !== undefined} disabled={disabled || value.chat?.reasoning?.mandatory === true} readOnly={readOnly} label={t('dashboard.modelAliases.metadata.effortEnabled')} onChange={(_, data) => patchReasoning({ effort: data.checked ? { supported: ['low', 'medium', 'high'], default: 'medium' } : undefined })} />
            <Switch checked={budget !== undefined} disabled={disabled || value.chat?.reasoning?.mandatory === true} readOnly={readOnly} label={t('dashboard.modelAliases.metadata.budgetEnabled')} onChange={(_, data) => patchReasoning({ budget_tokens: data.checked ? {} : undefined })} />
            <Switch checked={value.chat?.reasoning?.adaptive === true} disabled={disabled || value.chat?.reasoning?.mandatory === true} readOnly={readOnly} label={t('dashboard.modelAliases.metadata.adaptive')} onChange={(_, data) => patchReasoning({ adaptive: data.checked ? true : undefined })} />
            <Switch checked={value.chat?.reasoning?.mandatory === true} disabled={disabled || effort !== undefined || budget !== undefined || value.chat?.reasoning?.adaptive === true} readOnly={readOnly} label={t('dashboard.modelAliases.metadata.mandatory')} onChange={(_, data) => patchReasoning({ mandatory: data.checked ? true : undefined })} />
          </div>
          {effort && <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>
            <Field hint={t('dashboard.modelAliases.metadata.effortsHint')} label={t('dashboard.modelAliases.metadata.efforts')}><Input disabled={disabled} readOnly={readOnly} value={effort.supported.join(', ')} onChange={(_, data) => { const supported = data.value.split(',').map(item => item.trim()).filter(Boolean); patchReasoning({ effort: { supported, default: supported.includes(effort.default) ? effort.default : supported[0] ?? '' } }); }} /></Field>
            <Field label={t('dashboard.modelAliases.metadata.defaultEffort')}><Dropdown disabled={disabled || effort.supported.length === 0} readOnly={readOnly} selectedOptions={[effort.default]} value={effort.default} onOptionSelect={(_, data) => data.optionValue !== undefined && patchReasoning({ effort: { supported: effort.supported, default: data.optionValue } })}>{effort.supported.map(item => <Option key={item} value={item}>{item}</Option>)}</Dropdown></Field>
          </div>}
          {budget && <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>
            <Field label={t('dashboard.modelAliases.metadata.minBudget')} {...issueProps('budgetMin')}><Input disabled={disabled} min={0} readOnly={readOnly} type="number" value={budget.min?.toString() ?? ''} onChange={(_, data) => patchReasoning({ budget_tokens: { ...budget, min: numberValue(data.value) } })} /></Field>
            <Field label={t('dashboard.modelAliases.metadata.maxBudget')} {...issueProps('budgetMax')}><Input disabled={disabled} min={0} readOnly={readOnly} type="number" value={budget.max?.toString() ?? ''} onChange={(_, data) => patchReasoning({ budget_tokens: { ...budget, max: numberValue(data.value) } })} /></Field>
          </div>}
        </section>
      </>}
    </div>
  );
}
