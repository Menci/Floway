import { ArrowDownRegular, ArrowUpRegular, ChevronDownRegular, DeleteRegular, WarningRegular } from '@fluentui/react-icons';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { computeModelWarning, computeRuleWarnings, findCatalogModel } from './warnings';
import type { AliasTarget, ControlPlaneModel, ModelKind } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { Combobox, Input, Select } from '../ui/fluent-form-controls';

const { Button, Field, MessageBar, MessageBarBody, Option, Tooltip } = fluentComponents;

const suggestions = {
  effort: ['none', 'low', 'medium', 'high', 'xhigh'],
  summary: ['auto', 'concise', 'detailed', 'none'],
  verbosity: ['low', 'medium', 'high'],
  tier: ['default', 'flex', 'priority', 'scale', 'fast'],
};

export function AliasTargetRow({
  disabled, index, isFirst, isLast, isSole, kind, models, onChange, onMove, onRemove, target, targetIds,
}: {
  disabled: boolean;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  isSole: boolean;
  kind: ModelKind;
  models: readonly ControlPlaneModel[] | null;
  onChange: (target: AliasTarget) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  target: AliasTarget;
  targetIds: readonly string[];
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const model = findCatalogModel(models, target.target_model_id);
  const modelWarning = computeModelWarning(target.target_model_id, model, kind);
  const ruleWarnings = computeRuleWarnings(target.rules, model);
  const options = useMemo(() => targetIds.filter(id => id.toLowerCase().includes(target.target_model_id.toLowerCase())), [target.target_model_id, targetIds]);
  const patchRules = (patch: Partial<AliasTarget['rules']>) => onChange({ ...target, rules: { ...target.rules, ...patch } });
  const patchReasoning = (patch: Partial<NonNullable<AliasTarget['rules']['reasoning']>>) => {
    const reasoning = { ...(target.rules.reasoning ?? {}), ...patch };
    for (const [key, value] of Object.entries(reasoning)) if (value === undefined || value === '') delete (reasoning as Record<string, unknown>)[key];
    patchRules({ reasoning: Object.keys(reasoning).length ? reasoning : undefined });
  };
  const warningFor = (field: string) => ruleWarnings.find(warning => warning.field === field);

  return (
    <div className="rounded-lg border border-solid border-fui-stroke1 overflow-hidden" role="group" aria-label={t('dashboard.modelAliases.target.label', { number: index + 1 })}>
      <div className="grid grid-cols-[32px_minmax(180px,1fr)_auto] gap-2 items-center p-2 max-[620px]:grid-cols-[32px_minmax(0,1fr)]">
        <Button
          appearance="subtle"
          aria-expanded={expanded}
          aria-label={t('dashboard.modelAliases.target.toggle')}
          disabled={disabled || kind !== 'chat'}
          icon={<ChevronDownRegular className={expanded ? 'rotate-180' : ''} />}
          onClick={() => setExpanded(value => !value)}
          size="small"
        />
        <Combobox
          aria-label={t('dashboard.modelAliases.target.modelId')}
          disabled={disabled}
          freeform
          onChange={event => onChange({ ...target, target_model_id: event.target.value })}
          onOptionSelect={(_, data) => data.optionText != null && onChange({ ...target, target_model_id: data.optionText })}
          placeholder={t('dashboard.modelAliases.target.placeholder')}
          value={target.target_model_id}
        >
          {options.map(id => <Option key={id} text={id}>{id}</Option>)}
        </Combobox>
        <div className="flex items-center gap-0.5 max-[620px]:col-span-2 max-[620px]:justify-end">
          {modelWarning && <Tooltip content={t(`dashboard.modelAliases.warnings.${modelWarning.key}`, modelWarning.values)} relationship="description"><span className="inline-flex"><WarningRegular aria-label={t('dashboard.modelAliases.warnings.label')} /></span></Tooltip>}
          <Button appearance="subtle" aria-label={t('dashboard.modelAliases.target.moveUp')} disabled={disabled || isFirst} icon={<ArrowUpRegular />} onClick={() => onMove(-1)} size="small" />
          <Button appearance="subtle" aria-label={t('dashboard.modelAliases.target.moveDown')} disabled={disabled || isLast} icon={<ArrowDownRegular />} onClick={() => onMove(1)} size="small" />
          <Button appearance="subtle" aria-label={t('dashboard.modelAliases.target.remove')} disabled={disabled || isSole} icon={<DeleteRegular />} onClick={onRemove} size="small" />
        </div>
      </div>
      {expanded && kind === 'chat' && (
        <div className="grid grid-cols-2 gap-3 m-2 mt-0 p-3 rounded-lg bg-fui-bg2 max-[620px]:grid-cols-1">
          <RuleCombobox label={t('dashboard.modelAliases.rules.effort')} value={target.rules.reasoning?.effort ?? ''} items={suggestions.effort} disabled={disabled} warning={warningFor('reasoning.effort')} onChange={value => patchReasoning({ effort: value || undefined })} />
          <Field label={t('dashboard.modelAliases.rules.budget')} validationMessage={warningFor('reasoning.budget_tokens') ? t(`dashboard.modelAliases.warnings.${warningFor('reasoning.budget_tokens')!.key}`, warningFor('reasoning.budget_tokens')!.values) : undefined} validationState={warningFor('reasoning.budget_tokens') ? 'warning' : undefined}>
            <Input disabled={disabled} inputMode="numeric" min={0} type="number" value={target.rules.reasoning?.budget_tokens?.toString() ?? ''} onChange={(_, data) => patchReasoning({ budget_tokens: data.value === '' ? undefined : Number(data.value) })} />
          </Field>
          <Field label={t('dashboard.modelAliases.rules.adaptive')} validationMessage={warningFor('reasoning.adaptive') ? t(`dashboard.modelAliases.warnings.${warningFor('reasoning.adaptive')!.key}`) : undefined} validationState={warningFor('reasoning.adaptive') ? 'warning' : undefined}>
            <Select disabled={disabled} value={target.rules.reasoning?.adaptive === true ? 'on' : target.rules.reasoning?.adaptive === false ? 'off' : 'auto'} onChange={(_, data) => patchReasoning({ adaptive: data.value === 'on' ? true : data.value === 'off' ? false : undefined, ...(data.value === 'on' ? { budget_tokens: undefined } : {}) })}>
              <option value="auto">{t('dashboard.modelAliases.rules.adaptiveAuto')}</option><option value="on">{t('dashboard.modelAliases.rules.adaptiveOn')}</option><option value="off">{t('dashboard.modelAliases.rules.adaptiveOff')}</option>
            </Select>
          </Field>
          <RuleCombobox label={t('dashboard.modelAliases.rules.summary')} value={target.rules.reasoning?.summary ?? ''} items={suggestions.summary} disabled={disabled} onChange={value => patchReasoning({ summary: value || undefined })} />
          <RuleCombobox label={t('dashboard.modelAliases.rules.verbosity')} value={target.rules.verbosity ?? ''} items={suggestions.verbosity} disabled={disabled} onChange={value => patchRules({ verbosity: value || undefined })} />
          <RuleCombobox label={t('dashboard.modelAliases.rules.serviceTier')} value={target.rules.serviceTier ?? ''} items={suggestions.tier} disabled={disabled} onChange={value => patchRules({ serviceTier: value || undefined })} />
          {ruleWarnings.length > 0 && <MessageBar className="col-span-2 max-[620px]:col-span-1" intent="warning"><MessageBarBody>{t('dashboard.modelAliases.warnings.ruleAdvisory')}</MessageBarBody></MessageBar>}
        </div>
      )}
    </div>
  );
}

function RuleCombobox({ disabled, items, label, onChange, value, warning }: { disabled: boolean; items: readonly string[]; label: string; onChange: (value: string) => void; value: string; warning?: { key: string; values?: Record<string, string | number> } }) {
  const { t } = useTranslation();
  return <Field label={label} validationMessage={warning ? t(`dashboard.modelAliases.warnings.${warning.key}`, warning.values) : undefined} validationState={warning ? 'warning' : undefined}><Combobox disabled={disabled} freeform value={value} onChange={event => onChange(event.target.value)} onOptionSelect={(_, data) => onChange(data.optionText ?? '')}>{items.map(item => <Option key={item}>{item}</Option>)}</Combobox></Field>;
}
