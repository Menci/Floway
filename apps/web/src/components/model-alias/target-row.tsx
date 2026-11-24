import { ChevronDownRegular, DeleteRegular, WarningRegular } from '@fluentui/react-icons';
import { useId, useMemo, useState, type CSSProperties } from 'react';

import {
  computeModelWarning,
  computeRuleWarnings,
  modelAliasWarningText,
  type RuleWarning,
  type RuleWarningField,
} from './warnings';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { applyFieldPatch, type FieldPatch } from '../../lib/field-patch';
import { filterModelOptions } from '../../lib/model-query';
import type { CatalogIndex } from '../models/catalog-index';
import { useDangerTextClass } from '../ui/danger';
import { Combobox, Dropdown, Input } from '../ui/fluent-form-controls';
import { TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { ReorderHandle, type ReorderHandleProps } from '../ui/reorder-list';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import type { AliasTarget, ModelKind } from '@floway-dev/protocols/browser';

const { Button, Field, MessageBar, MessageBarBody, Option, Text, Tooltip, mergeClasses } = fluentComponents;

const suggestions = {
  effort: ['none', 'low', 'medium', 'high', 'xhigh'],
  summary: ['auto', 'concise', 'detailed', 'none'],
  verbosity: ['low', 'medium', 'high'],
  tier: ['default', 'flex', 'priority', 'scale', 'fast'],
};

export function AliasTargetRow({
  catalog, disabled, error, handleProps, index, isSole, itemProps, kind, onChange, onRemove, target, targetIds,
}: {
  disabled: boolean;
  error?: string | undefined;
  handleProps: ReorderHandleProps;
  index: number;
  isSole: boolean;
  itemProps: { className?: string | undefined; style?: CSSProperties | undefined };
  kind: ModelKind;
  catalog: CatalogIndex;
  onChange: (target: AliasTarget) => void;
  onRemove: () => void;
  target: AliasTarget;
  targetIds: readonly string[];
}) {
  const { t } = useTranslation();
  const dangerText = useDangerTextClass();
  const errorId = useId();
  const [expanded, setExpanded] = useState(false);
  const model = catalog.get(target.target_model_id);
  const modelWarning = computeModelWarning(target.target_model_id, model, kind);
  const ruleWarnings = computeRuleWarnings(target.rules, model);
  const options = useMemo(() => filterModelOptions(targetIds.map(id => ({ value: id, label: catalog.get(id)!.display_name })), target.target_model_id), [catalog, target.target_model_id, targetIds]);
  const patchRules = (patch: FieldPatch<AliasTarget['rules']>) => onChange({ ...target, rules: applyFieldPatch(target.rules, patch) });
  const patchReasoning = (patch: FieldPatch<NonNullable<AliasTarget['rules']['reasoning']>>) => {
    const reasoning = applyFieldPatch(target.rules.reasoning ?? {}, patch);
    patchRules({ reasoning: Object.keys(reasoning).length ? reasoning : undefined });
  };
  const warningFor = (field: RuleWarningField) => ruleWarnings.find(warning => warning.field === field);
  const budgetWarning = warningFor('reasoning.budget_tokens');
  const adaptiveWarning = warningFor('reasoning.adaptive');
  const adaptive = target.rules.reasoning?.adaptive === true ? 'on' : target.rules.reasoning?.adaptive === false ? 'off' : 'auto';
  const adaptiveLabel = t(`models.aliases.rules.${adaptive === 'auto' ? 'adaptiveAuto' : adaptive === 'on' ? 'adaptiveOn' : 'adaptiveOff'}`);
  const toggleLabel = t('models.aliases.target.toggle');

  return (
    <div {...itemProps} className={mergeClasses('border-0 border-t border-solid border-fui-divider pt-2', itemProps.className)} role="group" aria-label={t('models.aliases.target.label', { number: index + 1 })}>
      <div className="grid grid-cols-[32px_minmax(180px,1fr)_100px] gap-2 items-center py-2 max-[620px]:grid-cols-[32px_minmax(0,1fr)]">
        <Tooltip content={toggleLabel} relationship="label">
          <Button
            appearance="subtle"
            aria-expanded={expanded}
            aria-label={toggleLabel}
            disabled={disabled || kind !== 'chat'}
            icon={<ChevronDownRegular className={expanded ? 'rotate-180' : ''} fontSize={20} />}
            onClick={() => setExpanded(value => !value)}
            size="small"
          />
        </Tooltip>
        <Combobox
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          aria-label={t('models.aliases.target.modelId')}
          className="font-mono"
          disabled={disabled}
          freeform
          onChange={event => onChange({ ...target, target_model_id: event.target.value })}
          onOptionSelect={(_, data) => data.optionValue != null && onChange({ ...target, target_model_id: data.optionValue })}
          placeholder={t('models.aliases.target.placeholder')}
          value={target.target_model_id}
        >
          {options.map(option => <Option key={option.value} text={option.label} value={option.value}>
            <span className="grid min-w-0">
              <span className="truncate">{option.label}</span>
              {option.label !== option.value && <span className="font-mono text-fui-fg2 truncate">{option.value}</span>}
            </span>
          </Option>)}
        </Combobox>
        <div className="grid grid-cols-3 gap-0.5 w-[100px] max-[620px]:col-span-2 max-[620px]:justify-self-end">
          {modelWarning
            ? <Tooltip content={modelAliasWarningText(modelWarning, t)} relationship="description"><span className="winui-focus-rect grid h-8 w-8 place-items-center" tabIndex={0}><WarningRegular aria-label={t('models.aliases.warnings.label')} fontSize={20} /></span></Tooltip>
            : <span aria-hidden className="h-8 w-8" />}
          <ReorderHandle {...handleProps} label={t('models.aliases.target.reorder')} />
          <TooltipIconButton danger disabled={disabled || isSole} icon={<DeleteRegular />} label={t('models.aliases.target.remove')} onClick={onRemove} />
        </div>
      </div>
      {error && <Text block className={`${dangerText} ml-10 pb-2`} id={errorId} role="alert" size={200}>{error}</Text>}
      {expanded && kind === 'chat' && (
        <div className={`${TWO_COLUMN_FORM_CLASS} gap-3 ml-10 py-3`}>
          <RuleCombobox label={t('models.aliases.rules.effort')} value={target.rules.reasoning?.effort ?? ''} items={suggestions.effort} disabled={disabled} warning={warningFor('reasoning.effort')} onChange={value => patchReasoning({ effort: value || undefined })} />
          <Field label={t('models.aliases.rules.budget')} validationMessage={budgetWarning ? modelAliasWarningText(budgetWarning, t) : undefined} validationState={budgetWarning ? 'warning' : 'none'}>
            <Input disabled={disabled} inputMode="numeric" min={0} type="number" value={target.rules.reasoning?.budget_tokens?.toString() ?? ''} onChange={(_, data) => patchReasoning({ budget_tokens: data.value === '' ? undefined : Number(data.value) })} />
          </Field>
          <Field label={t('models.aliases.rules.adaptive')} validationMessage={adaptiveWarning ? modelAliasWarningText(adaptiveWarning, t) : undefined} validationState={adaptiveWarning ? 'warning' : 'none'}>
            <Dropdown
              disabled={disabled}
              selectedOptions={[adaptive]}
              value={adaptiveLabel}
              onOptionSelect={(_, data) => data.optionValue !== undefined && patchReasoning({ adaptive: data.optionValue === 'on' ? true : data.optionValue === 'off' ? false : undefined, ...(data.optionValue === 'on' ? { budget_tokens: undefined } : {}) })}
            >
              <Option value="auto">{t('models.aliases.rules.adaptiveAuto')}</Option><Option value="on">{t('models.aliases.rules.adaptiveOn')}</Option><Option value="off">{t('models.aliases.rules.adaptiveOff')}</Option>
            </Dropdown>
          </Field>
          <RuleCombobox label={t('models.aliases.rules.summary')} value={target.rules.reasoning?.summary ?? ''} items={suggestions.summary} disabled={disabled} onChange={value => patchReasoning({ summary: value || undefined })} />
          <RuleCombobox label={t('models.aliases.rules.verbosity')} value={target.rules.verbosity ?? ''} items={suggestions.verbosity} disabled={disabled} onChange={value => patchRules({ verbosity: value || undefined })} />
          <RuleCombobox label={t('models.aliases.rules.serviceTier')} value={target.rules.serviceTier ?? ''} items={suggestions.tier} disabled={disabled} onChange={value => patchRules({ serviceTier: value || undefined })} />
          {ruleWarnings.length > 0 && <MessageBar className="col-span-2 max-[680px]:col-span-1" intent="warning"><MessageBarBody>{t('models.aliases.warnings.ruleAdvisory')}</MessageBarBody></MessageBar>}
        </div>
      )}
    </div>
  );
}

function RuleCombobox({ disabled, items, label, onChange, value, warning }: { disabled: boolean; items: readonly string[]; label: string; onChange: (value: string) => void; value: string; warning?: RuleWarning | undefined }) {
  const { t } = useTranslation();
  return <Field label={label} validationMessage={warning ? modelAliasWarningText(warning, t) : undefined} validationState={warning ? 'warning' : 'none'}><Combobox disabled={disabled} freeform value={value} onChange={event => onChange(event.target.value)} onOptionSelect={(_, data) => onChange(data.optionText ?? '')}>{items.map(item => <Option key={item}>{item}</Option>)}</Combobox></Field>;
}
