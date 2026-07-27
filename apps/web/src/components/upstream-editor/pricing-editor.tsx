import { AddRegular, DeleteRegular } from '@fluentui/react-icons';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PRICING_AXES, type BillingMetric, type ModelKind, type ModelPricing, type ModelPricingIssue } from '@floway-dev/protocols/common';
import { fluentComponents } from '../../fluent';
import { Input } from '../ui/fluent-form-controls';
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

const { Badge, Button, Field, MessageBar, MessageBarBody, Text, Tooltip } = fluentComponents;
const TIGHT_STACK_CLASS = 'grid gap-1';

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
  const [drafts, setDrafts] = useState<PricingEntryDraft[]>(() => pricingEntryDraftsFor(value));
  const [selectedId, setSelectedId] = useState<number | null>(() => drafts[0]?.id ?? null);
  const conditionsHeadingId = useId();
  const ratesHeadingId = useId();

  // A read-only editor mirrors whatever the record says; an editable one owns
  // its drafts, so re-seeding from the prop would fight the user's typing.
  useEffect(() => {
    if (editable) return;
    const next = pricingEntryDraftsFor(value);
    setDrafts(next);
    setSelectedId(next[0]?.id ?? null);
  }, [editable, value]);

  const selectedIndex = drafts.findIndex(draft => draft.id === selectedId);
  const active = drafts[selectedIndex];
  const fields = useMemo(() => visiblePricingFields(drafts, kind), [drafts, kind]);
  const issues = useMemo(() => collectDraftIssues(drafts, value), [drafts, value]);
  const baseIndex = drafts.findIndex(draft => coordinateKey(draft) === '{}');

  const metricName = (metric: BillingMetric): string => t(`dashboard.upstreamEditor.models.pricingMetrics.${metric}`);

  const commit = (next: PricingEntryDraft[]) => {
    if (!editable) return;
    setDrafts(next);
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
    const key = `dashboard.upstreamEditor.models.pricingIssue.`;
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
    return <div className="grid justify-items-start gap-3 rounded-lg bg-fui-bg2 px-4 py-5">
      <div className={TIGHT_STACK_CLASS}>
        <Text weight="semibold">{t('dashboard.upstreamEditor.models.noPricingEntries')}</Text>
        <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.models.pricingEmptyHint')}</Text>
      </div>
      {editable && <Button appearance="primary" icon={<AddRegular />} onClick={addEntry}>
        {t('dashboard.upstreamEditor.models.setupPricing')}
      </Button>}
    </div>;
  }

  const activeIssues = issues.filter(issue => issueAffectsEntry(issue, selectedIndex));

  return <div className="grid min-w-0 grid-cols-[220px_minmax(0,1fr)] items-stretch gap-5 max-[760px]:grid-cols-1">
    <aside className="grid h-full min-w-0 content-start gap-3 rounded-lg bg-fui-bg2 p-3" aria-label={t('dashboard.upstreamEditor.models.pricingRules')}>
      <div className="flex items-center justify-between gap-2 px-1">
        <Text weight="semibold">{t('dashboard.upstreamEditor.models.pricingRules')}</Text>
        <Badge appearance="tint" color="informative" size="small">{drafts.length}</Badge>
      </div>
      <div className={TIGHT_STACK_CLASS}>
        {drafts.map((draft, index) => {
          const label = pricingEntryCoordinateLabel(draft);
          const displayLabel = index === baseIndex ? t('dashboard.upstreamEditor.models.pricingBase') : label;
          return <div className="min-w-0" key={draft.id}>
            <Button
              appearance={draft.id === selectedId ? 'secondary' : 'subtle'}
              aria-pressed={draft.id === selectedId}
              className="!h-auto !justify-start !overflow-hidden !px-2 !py-2 !w-full min-w-0"
              onClick={() => setSelectedId(draft.id)}
            >
              <span className="grid w-full min-w-0 max-w-full overflow-hidden gap-0.5 text-left">
                <span className="flex w-full min-w-0 items-center gap-2 overflow-hidden">
                  <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-fui-medium" title={displayLabel}>{displayLabel}</span>
                  {issues.some(issue => issueAffectsEntry(issue, index)) && <Badge appearance="filled" aria-label={t('dashboard.upstreamEditor.models.pricingErrors')} color="danger" size="tiny">!</Badge>}
                </span>
                <span className="truncate text-fui-fg2 text-fui-base200">
                  {index === baseIndex
                    ? t('dashboard.upstreamEditor.models.basePricingSummary')
                    : t('dashboard.upstreamEditor.models.overridePricingSummary')}
                </span>
              </span>
            </Button>
          </div>;
        })}
      </div>
      {editable && <Button appearance="subtle" className="!justify-start !px-0" icon={<AddRegular />} onClick={addEntry} size="small">
        {t('dashboard.upstreamEditor.models.addPricingOverride')}
      </Button>}
    </aside>

    {active && <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-5 pt-3">
      <div className="relative min-w-0">
        <Text size={200} className="text-fui-fg2">
          {selectedIndex === baseIndex
            ? t('dashboard.upstreamEditor.models.basePricingDescription')
            : t('dashboard.upstreamEditor.models.overridePricingDescription')}
        </Text>
        {editable && <Tooltip content={t('dashboard.upstreamEditor.models.removePricingEntry')} relationship="label">
          <Button
            appearance="subtle"
            aria-label={t('dashboard.upstreamEditor.models.removePricingEntry')}
            className="!absolute !right-0 !top-[-6px]"
            icon={<DeleteRegular />}
            onClick={removeActive}
            size="small"
          />
        </Tooltip>}
      </div>

      <section className="grid min-w-0 gap-3" aria-labelledby={conditionsHeadingId}>
        <div className={TIGHT_STACK_CLASS}>
          <Text id={conditionsHeadingId} weight="semibold">{t('dashboard.upstreamEditor.models.pricingConditions')}</Text>
          <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.models.pricingConditionsHint')}</Text>
        </div>
        <div className="grid gap-3 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-[560px]:grid-cols-1">
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
                <Button
                  appearance="secondary"
                  aria-label={t('dashboard.upstreamEditor.models.operator')}
                  disabled={!editable}
                  onClick={() => patchActive(draft => withThresholdCoordinate(draft, axis.id, {
                    operator: thresholdCoordinate(draft, axis.id)?.operator === 'gte' ? 'gt' : 'gte',
                  }))}
                  size="medium"
                >
                  {threshold?.operator === 'gte' ? '≥' : '>'}
                </Button>
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

      <section className="grid min-w-0 gap-3" aria-labelledby={ratesHeadingId}>
        <div className={TIGHT_STACK_CLASS}>
          <Text id={ratesHeadingId} weight="semibold">{t('dashboard.upstreamEditor.models.pricingRates')}</Text>
          <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.models.pricingRatesHint')}</Text>
        </div>
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
