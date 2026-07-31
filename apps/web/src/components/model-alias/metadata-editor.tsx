import { useTranslation } from 'react-i18next';

import { announcedMetadataIssues, type AnnouncedMetadataField } from './validation';
import type { AnnouncedMetadata, ModelKind } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { Dropdown, Input } from '../ui/fluent-form-controls';
import { TWO_COLUMN_FORM_CLASS } from '../ui/layout';

const { Field, Option, Switch, Text } = fluentComponents;

const numberValue = (value: string) => value === '' ? undefined : Number(value);

export function MetadataEditor({ disabled, kind, onChange, value }: {
  disabled: boolean;
  kind: ModelKind;
  onChange: (value: AnnouncedMetadata) => void;
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
  const issues = announcedMetadataIssues(value);
  const issueProps = (field: AnnouncedMetadataField) => issues[field] === undefined
    ? {}
    : { validationMessage: t(issues[field]), validationState: 'error' as const };

  return (
    <div className="grid gap-5" role="group" aria-label={t('dashboard.modelAliases.metadata.heading')}>
      <section className="grid gap-3">
        <Text size={300} weight="semibold">{t('dashboard.modelAliases.metadata.limits')}</Text>
        <div className="grid grid-cols-3 gap-3 max-[680px]:grid-cols-1">
          <Field label={t('dashboard.modelAliases.metadata.context')} {...issueProps('max_context_window_tokens')}><Input disabled={disabled} min={0} type="number" value={value.limits?.max_context_window_tokens?.toString() ?? ''} onChange={(_, data) => patchLimit('max_context_window_tokens', data.value)} /></Field>
          <Field label={t('dashboard.modelAliases.metadata.prompt')} {...issueProps('max_prompt_tokens')}><Input disabled={disabled} min={0} type="number" value={value.limits?.max_prompt_tokens?.toString() ?? ''} onChange={(_, data) => patchLimit('max_prompt_tokens', data.value)} /></Field>
          <Field label={t('dashboard.modelAliases.metadata.output')} {...issueProps('max_output_tokens')}><Input disabled={disabled} min={0} type="number" value={value.limits?.max_output_tokens?.toString() ?? ''} onChange={(_, data) => patchLimit('max_output_tokens', data.value)} /></Field>
        </div>
      </section>
      {kind === 'chat' && <>
        <section className="grid gap-2">
          <Text size={300} weight="semibold">{t('dashboard.modelAliases.metadata.modalities')}</Text>
          <Switch
            checked={value.chat?.modalities?.input.includes('image') ?? false}
            disabled={disabled}
            label={t('dashboard.modelAliases.metadata.imageInput')}
            onChange={(_, data) => {
              const chat = { ...(value.chat ?? {}), modalities: data.checked ? { input: ['text', 'image'] as const, output: ['text'] as const } : undefined };
              onChange({ ...value, chat: chat.modalities || chat.reasoning ? chat : undefined });
            }}
          />
        </section>
        <section className="grid gap-3">
          <Text size={300} weight="semibold">{t('dashboard.modelAliases.metadata.reasoning')}</Text>
          <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>
            <Switch checked={effort !== undefined} disabled={disabled || value.chat?.reasoning?.mandatory === true} label={t('dashboard.modelAliases.metadata.effortEnabled')} onChange={(_, data) => patchReasoning({ effort: data.checked ? { supported: ['low', 'medium', 'high'], default: 'medium' } : undefined })} />
            <Switch checked={budget !== undefined} disabled={disabled || value.chat?.reasoning?.mandatory === true} label={t('dashboard.modelAliases.metadata.budgetEnabled')} onChange={(_, data) => patchReasoning({ budget_tokens: data.checked ? {} : undefined })} />
            <Switch checked={value.chat?.reasoning?.adaptive === true} disabled={disabled || value.chat?.reasoning?.mandatory === true} label={t('dashboard.modelAliases.metadata.adaptive')} onChange={(_, data) => patchReasoning({ adaptive: data.checked ? true : undefined })} />
            <Switch checked={value.chat?.reasoning?.mandatory === true} disabled={disabled || effort !== undefined || budget !== undefined || value.chat?.reasoning?.adaptive === true} label={t('dashboard.modelAliases.metadata.mandatory')} onChange={(_, data) => patchReasoning({ mandatory: data.checked ? true : undefined })} />
          </div>
          {effort && <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>
            <Field hint={t('dashboard.modelAliases.metadata.effortsHint')} label={t('dashboard.modelAliases.metadata.efforts')}><Input disabled={disabled} value={effort.supported.join(', ')} onChange={(_, data) => { const supported = data.value.split(',').map(item => item.trim()).filter(Boolean); patchReasoning({ effort: { supported, default: supported.includes(effort.default) ? effort.default : supported[0] ?? '' } }); }} /></Field>
            <Field label={t('dashboard.modelAliases.metadata.defaultEffort')}><Dropdown disabled={disabled} selectedOptions={[effort.default]} value={effort.default} onOptionSelect={(_, data) => data.optionValue !== undefined && patchReasoning({ effort: { supported: effort.supported, default: data.optionValue } })}>{effort.supported.map(item => <Option key={item} value={item}>{item}</Option>)}</Dropdown></Field>
          </div>}
          {budget && <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>
            <Field label={t('dashboard.modelAliases.metadata.minBudget')} {...issueProps('budgetMin')}><Input disabled={disabled} min={0} type="number" value={budget.min?.toString() ?? ''} onChange={(_, data) => patchReasoning({ budget_tokens: { ...budget, min: numberValue(data.value) } })} /></Field>
            <Field label={t('dashboard.modelAliases.metadata.maxBudget')} {...issueProps('budgetMax')}><Input disabled={disabled} min={0} type="number" value={budget.max?.toString() ?? ''} onChange={(_, data) => patchReasoning({ budget_tokens: { ...budget, max: numberValue(data.value) } })} /></Field>
          </div>}
        </section>
      </>}
    </div>
  );
}
