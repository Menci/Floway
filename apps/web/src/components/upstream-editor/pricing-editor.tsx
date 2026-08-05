import { AddRegular, DeleteRegular, WarningRegular } from '@fluentui/react-icons';
import { useId, useMemo, useState } from 'react';

import {
  baseEntryOf,
  collectDraftIssues,
  isBaseEntry,
  nextPricingDraftId,
  pricingEntryCoordinateLabel,
  pricingEntryDraftsFor,
  pricingFieldLabel,
  pricingFieldRate,
  pricingFromDrafts,
  thresholdCoordinate,
  visiblePricingFields,
  withEqualityCoordinate,
  withRate,
  withThresholdCoordinate,
  type PricingEntryDraft,
  type PricingField,
} from './pricing-model';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { EmptyState } from '../ui/empty-state';
import { Dropdown, Input } from '../ui/fluent-form-controls';
import { CONTROL_ROW_CLASS, PANE_GAP_CLASS, TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { SectionHeader } from '../ui/section-header';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { TruncationTooltip } from '../ui/truncation-tooltip';
import { PRICING_AXES, type BillingMetric, type ModelKind, type ModelPricing, type ModelPricingIssue } from '@floway-dev/protocols/common';

const { Button, Field, List, ListItem, Option, Text, Toolbar, ToolbarButton, Tooltip, makeStyles } = fluentComponents;
const usePricingStyles = makeStyles({
  // WinUI centres one line in a 40px minimum with no block padding; a rule row
  // carries two. Everything else stays the WinUI layer's, whose doubled
  // `.fui-ListItem.fui-ListItem` in ../../winui/controls/list.css.ts outranks
  // whatever this rule declares.
  rule: {
    paddingBlock: '8px',
  },
});

// Rates stay raw text: parsing to a number here would round sub-cent rates
// before they ever reached the protocol.
const RATE_DRAFT_PATTERN = /^\d*(?:\.\d*)?$/;

function RateInput({ label, onChange, readOnly, value }: {
  label: string;
  onChange: (raw: string) => void;
  readOnly: boolean;
  value: string | undefined;
}) {
  const [draft, setDraft] = useState(value ?? '');
  // Read while deciding what to render, so state rather than a ref.
  const [editing, setEditing] = useState(false);

  // The rate inputs are keyed by metric rather than by rule, so selecting
  // another rule hands the same input a new value instead of a new instance;
  // adopting during render rather than in an effect keeps the previous rule's
  // numbers from being painted for a frame. A focused field keeps its own
  // text: a lone `.` reaches the model as an empty rate and must not come back
  // as one.
  const [adopted, setAdopted] = useState(value);
  if (!editing && value !== adopted) {
    setAdopted(value);
    setDraft(value ?? '');
  }

  return <Field className="min-w-0" label={label}>
    <Input
      className="!w-full"
      inputMode="decimal"
      readOnly={readOnly}
      value={draft}
      onBlur={() => {
        setEditing(false);
        setDraft(value ?? '');
      }}
      onChange={(_, data) => {
        if (!RATE_DRAFT_PATTERN.test(data.value)) return;
        setDraft(data.value);
        if (data.value === '' || data.value === '.') onChange('');
        else onChange(data.value);
      }}
      onFocus={() => setEditing(true)}
    />
  </Field>;
}

const issueAffectsEntry = (issue: ModelPricingIssue, index: number): boolean => {
  if ('entryIndex' in issue) return issue.entryIndex === index;
  if ('entryIndexes' in issue) return issue.entryIndexes.includes(index);
  return true;
};

export function PricingEditor({ kind, onChange, readOnly, value }: {
  kind: ModelKind;
  onChange: (value: ModelPricing | undefined) => void;
  readOnly: boolean;
  value: ModelPricing | undefined;
}) {
  const { t } = useTranslation();
  const styles = usePricingStyles();
  const [ownDrafts, setOwnDrafts] = useState<PricingEntryDraft[]>(() => pricingEntryDraftsFor(value));
  const [selectedId, setSelectedId] = useState<number | null>(() => ownDrafts[0]?.id ?? null);
  // An editable editor owns its drafts: re-seeding from the prop mid-edit
  // would fight the operator's typing.
  const mirrored = useMemo(() => (readOnly ? pricingEntryDraftsFor(value) : null), [readOnly, value]);
  const drafts = mirrored ?? ownDrafts;
  const conditionsHeadingId = useId();
  const thresholdIdPrefix = useId();
  const ratesHeadingId = useId();

  const selectedDraftIndex = drafts.findIndex(draft => draft.id === selectedId);
  const selectedIndex = selectedDraftIndex === -1 ? 0 : selectedDraftIndex;
  const active = drafts[selectedIndex];
  const fields = useMemo(() => visiblePricingFields(drafts, kind), [drafts, kind]);
  const issues = useMemo(() => collectDraftIssues(drafts, value), [drafts, value]);
  const baseIndex = drafts.findIndex(isBaseEntry);

  const metricName = (metric: BillingMetric): string => t(`dashboard.upstreamEditor.models.pricingMetrics.${metric}`);

  const commit = (next: PricingEntryDraft[]) => {
    if (readOnly) return;
    setOwnDrafts(next);
    onChange(pricingFromDrafts(next));
  };

  const patchActive = (update: (draft: PricingEntryDraft) => PricingEntryDraft) => {
    commit(drafts.map((draft, index) => (index === selectedIndex ? update(draft) : draft)));
  };

  const addEntry = () => {
    const base = baseEntryOf(drafts);
    const draft: PricingEntryDraft = { id: nextPricingDraftId(), selector: {}, rates: { ...(base?.rates ?? {}) } };
    setSelectedId(draft.id);
    commit([...drafts, draft]);
  };

  const removeActive = () => {
    const next = drafts.filter((_, index) => index !== selectedIndex);
    setSelectedId(next[selectedIndex]?.id ?? next[selectedIndex - 1]?.id ?? null);
    commit(next);
  };

  const issueMessage = (issue: ModelPricingIssue): string => {
    const key = 'dashboard.upstreamEditor.models.pricingIssue.';
    switch (issue.code) {
    case 'empty-catalog': return t(`${key}emptyCatalog`);
    case 'empty-rates': return t(`${key}emptyRates`);
    case 'invalid-rate': return t(`${key}invalidRate`, { metric: metricName(issue.metric) });
    case 'invalid-selector': return t(`${key}invalidSelector`);
    case 'base-count': return t(`${key}baseCount`);
    case 'rate-metrics': return t(`${key}rateMetrics`);
    case 'duplicate-selector': return t(`${key}duplicateSelector`);
    case 'threshold-operator-conflict': return t(`${key}thresholdConflict`);
    }
  };

  if (drafts.length === 0) {
    return <EmptyState
      action={!readOnly && <Button appearance="primary" icon={<AddRegular />} onClick={addEntry}>
        {t('dashboard.upstreamEditor.models.setupPricing')}
      </Button>}
      align="start"
      description={t('dashboard.upstreamEditor.models.pricingEmptyHint')}
      title={t('dashboard.upstreamEditor.models.noPricingEntries')}
    />;
  }

  const activeIssues = issues.filter(issue => issueAffectsEntry(issue, selectedIndex));

  return <div className={`grid min-w-0 grid-cols-[240px_minmax(0,1fr)] items-stretch ${PANE_GAP_CLASS} max-[760px]:grid-cols-1`}>
    <aside className="grid h-full min-w-0 content-start gap-2 border-0 border-r border-solid border-fui-divider pr-4 max-[760px]:border-b max-[760px]:border-r-0 max-[760px]:pb-4" aria-label={t('dashboard.upstreamEditor.models.pricingRules')}>
      {!readOnly && <Toolbar className={`!justify-end !p-0 ${CONTROL_ROW_CLASS}`} size="small">
        <Tooltip content={t('dashboard.upstreamEditor.models.addPricingOverride')} relationship="label">
          <ToolbarButton aria-label={t('dashboard.upstreamEditor.models.addPricingOverride')} icon={<AddRegular />} onClick={addEntry} />
        </Tooltip>
      </Toolbar>}
      <List
        aria-label={t('dashboard.upstreamEditor.models.pricingRules')}
        onSelectionChange={(_, data) => {
          const next = data.selectedItems[0];
          if (typeof next === 'number') setSelectedId(next);
        }}
        selectedItems={active ? [active.id] : []}
        selectionMode="single"
      >
        {drafts.map((draft, index) => {
          const label = pricingEntryCoordinateLabel(draft);
          const displayLabel = index === baseIndex ? t('dashboard.upstreamEditor.models.pricingBase') : label;
          return <ListItem checkmark={null} className={styles.rule} key={draft.id} value={draft.id}>
            <span className="grid min-w-0 gap-0.5 text-left">
              <span className="flex min-w-0 items-center gap-2">
                <TruncationTooltip content={displayLabel} relationship="label">
                  {measureRef => <Text block className="winui-focus-rect" ref={measureRef} truncate size={300} weight="semibold" tabIndex={0} wrap={false}>{displayLabel}</Text>}
                </TruncationTooltip>
                {issues.some(issue => issueAffectsEntry(issue, index)) && <WarningRegular aria-label={t('dashboard.upstreamEditor.models.pricingErrors')} fontSize={16} />}
              </span>
              <Text block truncate size={200} className="text-fui-fg2" wrap={false}>
                {index === baseIndex
                  ? t('dashboard.upstreamEditor.models.basePricingSummary')
                  : t('dashboard.upstreamEditor.models.overridePricingSummary')}
              </Text>
            </span>
          </ListItem>;
        })}
      </List>
    </aside>

    {active && <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4">
      <section className="grid min-w-0 gap-3" aria-labelledby={conditionsHeadingId}>
        <SectionHeader
          description={t('dashboard.upstreamEditor.models.pricingConditionsHint')}
          level={4}
          title={t('dashboard.upstreamEditor.models.pricingConditions')}
          titleId={conditionsHeadingId}
          actions={!readOnly && selectedIndex !== baseIndex
            ? <TooltipIconButton danger icon={<DeleteRegular />} label={t('dashboard.upstreamEditor.models.removePricingEntry')} onClick={removeActive} />
            : undefined}
        />
        <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>
          {PRICING_AXES.map(axis => {
            if (axis.kind === 'equality') {
              const current = active.selector[axis.id];
              return <Field className="min-w-0" key={axis.id} label={t('dashboard.upstreamEditor.models.serviceTierName')} hint={t('dashboard.upstreamEditor.models.serviceTierHint')}>
                <Input
                  className="!w-full"
                  placeholder={t('dashboard.upstreamEditor.models.serviceTierPlaceholder')}
                  readOnly={readOnly}
                  value={typeof current === 'string' ? current : ''}
                  onChange={(_, data) => patchActive(draft => withEqualityCoordinate(draft, axis.id, data.value))}
                />
              </Field>;
            }
            const threshold = thresholdCoordinate(active, axis.id);
            const thresholdId = `${thresholdIdPrefix}-${axis.id}`;
            // Two field-aware controls under one Field would both take its
            // generated control id; the label names the one that carries the
            // value, and the operator select speaks for itself.
            return <Field className="min-w-0" key={axis.id} label={{ children: t('dashboard.upstreamEditor.models.inputTokens'), htmlFor: thresholdId }} hint={t('dashboard.upstreamEditor.models.inputTokensHint')}>
              <div className="flex min-w-0 items-center gap-2">
                <Dropdown
                  aria-label={t('dashboard.upstreamEditor.models.operator')}
                  readOnly={readOnly}
                  className="!w-[76px] flex-none"
                  selectedOptions={[threshold?.operator ?? 'gt']}
                  value={threshold?.operator === 'gte' ? '≥' : '>'}
                  onOptionSelect={(_, data) => data.optionValue !== undefined && patchActive(draft => withThresholdCoordinate(draft, axis.id, { operator: data.optionValue as 'gt' | 'gte' }))}
                >
                  <Option value="gt">&gt;</Option>
                  <Option value="gte">≥</Option>
                </Dropdown>
                <Input
                  className="!w-full"
                  id={thresholdId}
                  inputMode="numeric"
                  readOnly={readOnly}
                  value={threshold?.value === undefined ? '' : String(threshold.value)}
                  onChange={(_, data) => {
                    const raw = data.value.trim();
                    if (raw !== '' && !/^\d+$/.test(raw)) return;
                    patchActive(draft => withThresholdCoordinate(draft, axis.id, { value: raw === '' ? undefined : Number(raw) }));
                  }}
                />
              </div>
            </Field>;
          })}
        </div>
      </section>

      <section className="grid min-w-0 gap-3" aria-labelledby={ratesHeadingId}>
        <SectionHeader
          description={t('dashboard.upstreamEditor.models.pricingRatesHint')}
          level={4}
          title={t('dashboard.upstreamEditor.models.pricingRates')}
          titleId={ratesHeadingId}
        />
        <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
          {fields.map((field: PricingField) => <RateInput
            key={field.metric}
            label={pricingFieldLabel(metricName(field.metric), field)}
            readOnly={readOnly}
            value={pricingFieldRate(active, field)}
            onChange={raw => patchActive(draft => withRate(draft, field, raw))}
          />)}
        </div>
      </section>

      {activeIssues.length > 0 && <OutcomeMessageBar>
        {activeIssues.map((issue, index) => <Text key={`${issue.code}-${index}`}>{issueMessage(issue)}</Text>)}
      </OutcomeMessageBar>}
    </div>}
  </div>;
}
