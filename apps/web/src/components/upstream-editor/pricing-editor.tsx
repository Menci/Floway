import { AddRegular, DeleteRegular, WarningRegular } from '@fluentui/react-icons';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  baseEntryOf,
  collectDraftIssues,
  coordinateKey,
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
import { EmptyState } from '../ui/empty-state';
import { Dropdown, Input } from '../ui/fluent-form-controls';
import { PANE_GAP_CLASS, TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { SectionHeader } from '../ui/section-header';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { PRICING_AXES, type BillingMetric, type ModelKind, type ModelPricing, type ModelPricingIssue } from '@floway-dev/protocols/common';

const { Button, Divider, Field, List, ListItem, MessageBar, MessageBarBody, Option, Text, Toolbar, ToolbarButton, Tooltip, makeStyles } = fluentComponents;
const usePricingStyles = makeStyles({
  // Selection is drawn by the WinUI layer, which marks a selected row with the
  // accent bar WinUI runs down its leading edge; a full-height border here
  // would sit on top of it and read as an edge rather than as a marker.
  rule: {
    borderRadius: 'var(--borderRadiusMedium)',
    minWidth: 0,
    padding: '8px 10px 8px 16px',
  },
});

// Rates are decimal strings end to end, so the input holds the raw text and
// only hands it to the model on a well-formed value. Parsing to a number here
// would round sub-cent rates before they ever reached the protocol.
const RATE_DRAFT_PATTERN = /^\d*(?:\.\d*)?$/;

const RateInput = ({ editable, label, onCommit, value }: {
  editable: boolean;
  label: string;
  onCommit: (raw: string) => void;
  value: string | undefined;
}) => {
  const [draft, setDraft] = useState(value ?? '');
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(value ?? '');
  }, [value]);

  return <Field className="min-w-0" label={label}>
    <Input
      className="!w-full"
      inputMode="decimal"
      readOnly={!editable}
      size="medium"
      value={draft}
      onBlur={() => {
        editing.current = false;
        setDraft(value ?? '');
      }}
      onChange={(_, data) => {
        if (!RATE_DRAFT_PATTERN.test(data.value)) return;
        setDraft(data.value);
        if (data.value === '' || data.value === '.') onCommit('');
        else onCommit(data.value);
      }}
      onFocus={() => { editing.current = true; }}
    />
  </Field>;
};

const issueAffectsEntry = (issue: ModelPricingIssue, index: number): boolean => {
  if ('entryIndex' in issue) return issue.entryIndex === index;
  if ('entryIndexes' in issue) return issue.entryIndexes.includes(index);
  return true;
};

export const PricingEditor = ({ editable, kind, onChange, value }: {
  editable: boolean;
  kind: ModelKind;
  onChange: (value: ModelPricing | undefined) => void;
  value: ModelPricing | undefined;
}) => {
  const { t } = useTranslation();
  const styles = usePricingStyles();
  const [ownDrafts, setOwnDrafts] = useState<PricingEntryDraft[]>(() => pricingEntryDraftsFor(value));
  const [selectedId, setSelectedId] = useState<number | null>(() => ownDrafts[0]?.id ?? null);
  // Read-only is a view of the record; editable owns its drafts, because
  // re-seeding from the prop mid-edit would fight the user's typing.
  const mirrored = useMemo(() => (editable ? null : pricingEntryDraftsFor(value)), [editable, value]);
  const drafts = mirrored ?? ownDrafts;
  const conditionsHeadingId = useId();
  const ratesHeadingId = useId();

  const selectedDraftIndex = drafts.findIndex(draft => draft.id === selectedId);
  const selectedIndex = selectedDraftIndex === -1 ? 0 : selectedDraftIndex;
  const active = drafts[selectedIndex];
  const fields = useMemo(() => visiblePricingFields(drafts, kind), [drafts, kind]);
  const issues = useMemo(() => collectDraftIssues(drafts, value), [drafts, value]);
  const baseIndex = drafts.findIndex(draft => coordinateKey(draft) === '{}');

  const metricName = (metric: BillingMetric): string => t(`dashboard.upstreamEditor.models.pricingMetrics.${metric}`);

  const commit = (next: PricingEntryDraft[]) => {
    if (!editable) return;
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
      action={editable && <Button appearance="primary" icon={<AddRegular />} onClick={addEntry}>
        {t('dashboard.upstreamEditor.models.setupPricing')}
      </Button>}
      align="start"
      description={t('dashboard.upstreamEditor.models.pricingEmptyHint')}
      title={t('dashboard.upstreamEditor.models.noPricingEntries')}
    />;
  }

  const activeIssues = issues.filter(issue => issueAffectsEntry(issue, selectedIndex));

  return <div className={`grid min-w-0 grid-cols-[240px_minmax(0,1fr)] items-stretch ${PANE_GAP_CLASS} max-[760px]:grid-cols-1`}>
    <aside className="grid h-full min-w-0 content-start gap-2 border-0 border-r border-solid border-fui-stroke1 pr-4 max-[760px]:border-b max-[760px]:border-r-0 max-[760px]:pb-4" aria-label={t('dashboard.upstreamEditor.models.pricingRules')}>
      {editable && <Toolbar aria-label={t('dashboard.upstreamEditor.models.pricingRules')} className="!justify-end !min-h-8 !p-0" size="small">
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
                <Text truncate size={300} weight="semibold" title={displayLabel}>{displayLabel}</Text>
                {issues.some(issue => issueAffectsEntry(issue, index)) && <WarningRegular aria-label={t('dashboard.upstreamEditor.models.pricingErrors')} fontSize={16} />}
              </span>
              <Text truncate size={200} className="text-fui-fg2">
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
          actions={editable && selectedIndex !== baseIndex
            ? <TooltipIconButton icon={<DeleteRegular />} label={t('dashboard.upstreamEditor.models.removePricingEntry')} onClick={removeActive} />
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
                  readOnly={!editable}
                  size="medium"
                  value={typeof current === 'string' ? current : ''}
                  onChange={(_, data) => patchActive(draft => withEqualityCoordinate(draft, axis.id, data.value))}
                />
              </Field>;
            }
            const threshold = thresholdCoordinate(active, axis.id);
            return <Field className="min-w-0" key={axis.id} label={t('dashboard.upstreamEditor.models.inputTokens')} hint={t('dashboard.upstreamEditor.models.inputTokensHint')}>
              <div className="flex min-w-0 items-center gap-2">
                <Dropdown
                  aria-label={t('dashboard.upstreamEditor.models.operator')}
                  disabled={!editable}
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
                  inputMode="numeric"
                  readOnly={!editable}
                  size="medium"
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

      <Divider />

      <section className="grid min-w-0 gap-3" aria-labelledby={ratesHeadingId}>
        <SectionHeader
          description={t('dashboard.upstreamEditor.models.pricingRatesHint')}
          level={4}
          title={t('dashboard.upstreamEditor.models.pricingRates')}
          titleId={ratesHeadingId}
        />
        <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
          {fields.map((field: PricingField) => <RateInput
            editable={editable}
            key={field.metric}
            label={pricingFieldLabel(metricName(field.metric), field)}
            value={pricingFieldRate(active, field)}
            onCommit={raw => patchActive(draft => withRate(draft, field, raw))}
          />)}
        </div>
      </section>

      {activeIssues.length > 0 && <MessageBar intent="error">
        <MessageBarBody>
          <ul className="m-0 grid gap-1 pl-4">
            {activeIssues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issueMessage(issue)}</li>)}
          </ul>
        </MessageBarBody>
      </MessageBar>}
    </div>}
  </div>;
};
