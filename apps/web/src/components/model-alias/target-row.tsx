import { ChevronDownRegular, DeleteRegular, WarningRegular } from '@fluentui/react-icons';
import { useId, useMemo, useState } from 'react';

import {
  computeModelWarning,
  computeRuleWarnings,
  modelAliasWarningText,
  type RuleWarning,
  type RuleWarningField,
} from './warnings';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { filterModelOptions } from '../../lib/model-query';
import type { CatalogIndex } from '../models/catalog-index';
import { useDangerTextClass } from '../ui/danger';
import { Combobox, Dropdown, Input } from '../ui/fluent-form-controls';
import { TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { ReorderButtons } from '../ui/reorder-buttons';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import type { AliasTarget, ModelKind } from '@floway-dev/protocols/common';

const { Button, Field, MessageBar, MessageBarBody, Option, Text, Tooltip } = fluentComponents;

const suggestions = {
  effort: ['none', 'low', 'medium', 'high', 'xhigh'],
  summary: ['auto', 'concise', 'detailed', 'none'],
  verbosity: ['low', 'medium', 'high'],
  tier: ['default', 'flex', 'priority', 'scale', 'fast'],
};

export function AliasTargetRow({
  catalog, disabled, error, index, isFirst, isLast, isSole, kind, onChange, onMove, onRemove, target, targetIds,
}: {
  disabled: boolean;
  error?: string;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  isSole: boolean;
  kind: ModelKind;
  catalog: CatalogIndex;
  onChange: (target: AliasTarget) => void;
  onMove: (direction: -1 | 1) => void;
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
  const options = useMemo(() => filterModelOptions(targetIds, target.target_model_id), [target.target_model_id, targetIds]);
  const patchRules = (patch: Partial<AliasTarget['rules']>) => onChange({ ...target, rules: { ...target.rules, ...patch } });
  const patchReasoning = (patch: Partial<NonNullable<AliasTarget['rules']['reasoning']>>) => {
    const reasoning = { ...(target.rules.reasoning ?? {}), ...patch };
    for (const [key, value] of Object.entries(reasoning)) if (value === undefined || value === '') delete (reasoning as Record<string, unknown>)[key];
    patchRules({ reasoning: Object.keys(reasoning).length ? reasoning : undefined });
  };
  const warningFor = (field: RuleWarningField) => ruleWarnings.find(warning => warning.field === field);
  const budgetWarning = warningFor('reasoning.budget_tokens');
  const adaptiveWarning = warningFor('reasoning.adaptive');
  const adaptive = target.rules.reasoning?.adaptive === true ? 'on' : target.rules.reasoning?.adaptive === false ? 'off' : 'auto';
  const adaptiveLabel = t(`dashboard.modelAliases.rules.${adaptive === 'auto' ? 'adaptiveAuto' : adaptive === 'on' ? 'adaptiveOn' : 'adaptiveOff'}`);
  const toggleLabel = t('dashboard.modelAliases.target.toggle');

  return (
    <div className="border-0 border-t border-solid border-fui-divider pt-2" role="group" aria-label={t('dashboard.modelAliases.target.label', { number: index + 1 })}>
      <div className="grid grid-cols-[32px_minmax(180px,1fr)_134px] gap-2 items-center py-2 max-[620px]:grid-cols-[32px_minmax(0,1fr)]">
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
          aria-label={t('dashboard.modelAliases.target.modelId')}
          className="font-mono"
          disabled={disabled}
          freeform
          onChange={event => onChange({ ...target, target_model_id: event.target.value })}
          onOptionSelect={(_, data) => data.optionText != null && onChange({ ...target, target_model_id: data.optionText })}
          placeholder={t('dashboard.modelAliases.target.placeholder')}
          value={target.target_model_id}
        >
          {options.map(id => <Option className="font-mono" key={id} text={id}>{id}</Option>)}
        </Combobox>
        <div className="grid grid-cols-4 gap-0.5 w-[134px] max-[620px]:col-span-2 max-[620px]:justify-self-end">
          {modelWarning
            ? <Tooltip content={modelAliasWarningText(modelWarning, t)} relationship="description"><span className="winui-focus-rect grid h-8 w-8 place-items-center" tabIndex={0}><WarningRegular aria-label={t('dashboard.modelAliases.warnings.label')} fontSize={20} /></span></Tooltip>
            : <span aria-hidden className="h-8 w-8" />}
          <ReorderButtons disabled={disabled} downLabel={t('dashboard.modelAliases.target.moveDown')} isFirst={isFirst} isLast={isLast} onMove={onMove} upLabel={t('dashboard.modelAliases.target.moveUp')} />
          <TooltipIconButton danger disabled={disabled || isSole} icon={<DeleteRegular />} label={t('dashboard.modelAliases.target.remove')} onClick={onRemove} />
        </div>
      </div>
      {error && <Text block className={`${dangerText} ml-10 pb-2`} id={errorId} role="alert" size={200}>{error}</Text>}
      {expanded && kind === 'chat' && (
        <div className={`${TWO_COLUMN_FORM_CLASS} gap-3 ml-10 py-3`}>
          <RuleCombobox label={t('dashboard.modelAliases.rules.effort')} value={target.rules.reasoning?.effort ?? ''} items={suggestions.effort} disabled={disabled} warning={warningFor('reasoning.effort')} onChange={value => patchReasoning({ effort: value || undefined })} />
          <Field label={t('dashboard.modelAliases.rules.budget')} validationMessage={budgetWarning ? modelAliasWarningText(budgetWarning, t) : undefined} validationState={budgetWarning ? 'warning' : undefined}>
            <Input disabled={disabled} inputMode="numeric" min={0} type="number" value={target.rules.reasoning?.budget_tokens?.toString() ?? ''} onChange={(_, data) => patchReasoning({ budget_tokens: data.value === '' ? undefined : Number(data.value) })} />
          </Field>
          <Field label={t('dashboard.modelAliases.rules.adaptive')} validationMessage={adaptiveWarning ? modelAliasWarningText(adaptiveWarning, t) : undefined} validationState={adaptiveWarning ? 'warning' : undefined}>
            <Dropdown
              disabled={disabled}
              selectedOptions={[adaptive]}
              value={adaptiveLabel}
              onOptionSelect={(_, data) => data.optionValue !== undefined && patchReasoning({ adaptive: data.optionValue === 'on' ? true : data.optionValue === 'off' ? false : undefined, ...(data.optionValue === 'on' ? { budget_tokens: undefined } : {}) })}
            >
              <Option value="auto">{t('dashboard.modelAliases.rules.adaptiveAuto')}</Option><Option value="on">{t('dashboard.modelAliases.rules.adaptiveOn')}</Option><Option value="off">{t('dashboard.modelAliases.rules.adaptiveOff')}</Option>
            </Dropdown>
          </Field>
          <RuleCombobox label={t('dashboard.modelAliases.rules.summary')} value={target.rules.reasoning?.summary ?? ''} items={suggestions.summary} disabled={disabled} onChange={value => patchReasoning({ summary: value || undefined })} />
          <RuleCombobox label={t('dashboard.modelAliases.rules.verbosity')} value={target.rules.verbosity ?? ''} items={suggestions.verbosity} disabled={disabled} onChange={value => patchRules({ verbosity: value || undefined })} />
          <RuleCombobox label={t('dashboard.modelAliases.rules.serviceTier')} value={target.rules.serviceTier ?? ''} items={suggestions.tier} disabled={disabled} onChange={value => patchRules({ serviceTier: value || undefined })} />
          {ruleWarnings.length > 0 && <MessageBar className="col-span-2 max-[680px]:col-span-1" intent="warning"><MessageBarBody>{t('dashboard.modelAliases.warnings.ruleAdvisory')}</MessageBarBody></MessageBar>}
        </div>
      )}
    </div>
  );
}

function RuleCombobox({ disabled, items, label, onChange, value, warning }: { disabled: boolean; items: readonly string[]; label: string; onChange: (value: string) => void; value: string; warning?: RuleWarning }) {
  const { t } = useTranslation();
  return <Field label={label} validationMessage={warning ? modelAliasWarningText(warning, t) : undefined} validationState={warning ? 'warning' : undefined}><Combobox disabled={disabled} freeform value={value} onChange={event => onChange(event.target.value)} onOptionSelect={(_, data) => onChange(data.optionText ?? '')}>{items.map(item => <Option key={item}>{item}</Option>)}</Combobox></Field>;
}
