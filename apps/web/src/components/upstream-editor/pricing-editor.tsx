import { AddRegular, DeleteRegular } from "@fluentui/react-icons";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  BILLING_DIMENSIONS,
  collectModelPricingIssues,
  type BillingDimension,
  type ModelKind,
  type ModelPricing,
  type ModelPricingIssue,
  type PriceVector,
  type PricingEntry,
  type PricingSelector,
  type PricingThresholdOperator,
} from "@floway-dev/protocols/common";
import { fluentComponents } from "../../fluent";
import { Input, Select } from "../ui/fluent-form-controls";

const { Badge, Button, Field, MessageBar, MessageBarBody, MessageBarTitle, Text, Tooltip } = fluentComponents;
const TIGHT_STACK_CLASS = "grid gap-1";

const DIMENSIONS_BY_KIND: Record<ModelKind, BillingDimension[]> = {
  chat: ["input", "input_cache_read", "input_cache_write", "input_cache_write_1h", "output"],
  embedding: ["input"],
  image: ["input", "input_image", "output", "output_image"],
};

const dimensionKey = (dimension: BillingDimension) =>
  `dashboard.upstreamEditor.models.pricingDimensions.${dimension}` as const;

const mutableEntry = (entry: PricingEntry): PricingEntry => ({
  ...(entry.selector ? { selector: structuredClone(entry.selector) } : {}),
  rates: { ...entry.rates },
});

export function pricingEntries(value: ModelPricing | undefined): PricingEntry[] {
  return (value?.entries ?? []).map(mutableEntry);
}

export function writePricingEntry(
  value: ModelPricing | undefined,
  index: number,
  update: (entry: PricingEntry) => PricingEntry,
): ModelPricing | undefined {
  const entries = pricingEntries(value);
  if (!entries[index]) return value;
  entries[index] = update(entries[index]);
  return { entries };
}

export function pricingIsValid(value: ModelPricing | undefined): boolean {
  return value === undefined || collectModelPricingIssues(value).length === 0;
}

const PRICE_DRAFT_PATTERN = /^\d*(?:\.\d*)?$/;

export function priceFromDraft(draft: string): number | undefined {
  if (!draft || draft === "." || !PRICE_DRAFT_PATTERN.test(draft)) return undefined;
  const price = Number(draft);
  return Number.isFinite(price) && price >= 0 ? price : undefined;
}

function PriceInput({ editable, onChange, placeholder, value }: {
  editable: boolean;
  onChange: (value: number | undefined) => void;
  placeholder: string;
  value: number | undefined;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(value === undefined ? "" : String(value));
  }, [value]);

  return <Input
    className="!w-full"
    inputMode="decimal"
    pattern="[0-9]*(\.[0-9]*)?"
    placeholder={placeholder}
    readOnly={!editable}
    size="medium"
    value={draft}
    onBlur={() => {
      editing.current = false;
      setDraft(value === undefined ? "" : String(value));
    }}
    onChange={(_, data) => {
      if (!PRICE_DRAFT_PATTERN.test(data.value)) return;
      setDraft(data.value);
      if (data.value === "") onChange(undefined);
      else {
        const price = priceFromDraft(data.value);
        if (price !== undefined) onChange(price);
      }
    }}
    onFocus={() => { editing.current = true; }}
  />;
}

export function PricingEditor({ editable, kind, onChange, value }: {
  editable: boolean;
  kind: ModelKind;
  onChange: (value: ModelPricing | undefined) => void;
  value: ModelPricing | undefined;
}) {
  const { t } = useTranslation();
  const entries = pricingEntries(value);
  const [selected, setSelected] = useState(0);
  const [operatorDrafts, setOperatorDrafts] = useState<Record<number, PricingThresholdOperator>>({});
  const conditionsHeadingId = useId();
  const ratesHeadingId = useId();
  const ratesHintId = useId();

  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, entries.length - 1)));
    setOperatorDrafts({});
  }, [value]);

  const visibleDimensions = useMemo(() => BILLING_DIMENSIONS.filter((dimension) =>
    DIMENSIONS_BY_KIND[kind].includes(dimension)
      || entries.some((entry) => entry.rates[dimension] !== undefined)), [entries, kind]);
  const issues = value === undefined ? [] : collectModelPricingIssues(value);
  const active = entries[selected];
  const baseIndex = entries.findIndex((entry) => !entry.selector || Object.keys(entry.selector).length === 0);
  const displayedEntries = entries
    .map((entry, index) => ({ entry, index }))
    .toSorted((left, right) => comparePricingEntries(left, right, baseIndex));

  const replaceEntries = (next: PricingEntry[]) => onChange(next.length ? { entries: next } : undefined);
  const updateActive = (update: (entry: PricingEntry) => PricingEntry) => {
    const next = writePricingEntry(value, selected, update);
    onChange(next);
  };
  const selectorFor = (entry: PricingEntry): Record<string, unknown> => ({ ...(entry.selector ?? {}) });
  const serviceTier = typeof active?.selector?.serviceTier === "string" ? active.selector.serviceTier : "";
  const inputTokens = active?.selector?.inputTokens;
  const threshold = inputTokens && typeof inputTokens === "object" ? inputTokens : undefined;
  const operator = threshold?.operator ?? operatorDrafts[selected] ?? "gt";

  const coordinateLabel = (entry: PricingEntry) => {
    const labels: string[] = [];
    if (typeof entry.selector?.serviceTier === "string" && entry.selector.serviceTier.trim()) labels.push(entry.selector.serviceTier);
    const tokens = entry.selector?.inputTokens;
    if (tokens && typeof tokens === "object") labels.push(`${tokens.operator === "gte" ? ">=" : ">"} ${tokens.value}`);
    return labels.length ? labels.join(", ") : t("dashboard.upstreamEditor.models.pricingBase");
  };

  const ruleLabel = (entry: PricingEntry, index: number) => {
    const hasCoordinates = entry.selector && Object.keys(entry.selector).length > 0;
    if (!hasCoordinates && index !== baseIndex) return t("dashboard.upstreamEditor.models.untitledPricingOverride");
    return coordinateLabel(entry);
  };

  const issueAffectsEntry = (issue: ModelPricingIssue, index: number) => {
    if ("entryIndex" in issue) return issue.entryIndex === index;
    if ("entryIndexes" in issue) return issue.entryIndexes.includes(index);
    return true;
  };
  const activeIssues = issues.filter((issue) => issueAffectsEntry(issue, selected));
  const hasIssue = (index: number) => issues.some((issue) => issueAffectsEntry(issue, index));

  const removeActive = () => {
    replaceEntries(entries.filter((_, entryIndex) => entryIndex !== selected));
    setSelected(Math.max(0, selected - 1));
  };
  const addEntry = () => {
    const base = entries.find((entry) => !entry.selector || Object.keys(entry.selector).length === 0);
    replaceEntries([...entries, { rates: { ...(base?.rates ?? {}) } }]);
    setSelected(entries.length);
  };

  if (entries.length === 0) return <div className="grid justify-items-start gap-3 rounded-lg bg-fui-bg2 px-4 py-5">
    <div className={TIGHT_STACK_CLASS}>
      <Text weight="semibold">{t("dashboard.upstreamEditor.models.noPricingEntries")}</Text>
      <Text size={200} className="text-fui-fg2">{t("dashboard.upstreamEditor.models.pricingEmptyHint")}</Text>
    </div>
    {editable && <Button appearance="primary" icon={<AddRegular />} onClick={addEntry}>
      {t("dashboard.upstreamEditor.models.setupPricing")}
    </Button>}
  </div>;

  return <div className="grid min-w-0 grid-cols-[220px_minmax(0,1fr)] items-stretch gap-5 max-[760px]:grid-cols-1">
    <aside className="grid h-full min-w-0 content-start gap-3 rounded-lg bg-fui-bg2 p-3" aria-label={t("dashboard.upstreamEditor.models.pricingRules")}>
      <div className="flex items-center justify-between gap-2 px-1">
        <Text weight="semibold">{t("dashboard.upstreamEditor.models.pricingRules")}</Text>
        <Badge appearance="tint" color="informative" size="small">{entries.length}</Badge>
      </div>
      <div className={TIGHT_STACK_CLASS}>
        {displayedEntries.map(({ entry, index }) => <div className="min-w-0" key={index}>
          <Button
            appearance={selected === index ? "secondary" : "subtle"}
            aria-pressed={selected === index}
            className="!h-auto !justify-start !overflow-hidden !px-2 !py-2 !w-full min-w-0"
            onClick={() => setSelected(index)}
          >
            <span className="grid w-full min-w-0 max-w-full overflow-hidden gap-0.5 text-left">
              <span className="flex w-full min-w-0 items-center gap-2 overflow-hidden">
                <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-fui-medium" title={ruleLabel(entry, index)}>{ruleLabel(entry, index)}</span>
                {hasIssue(index) && <Badge appearance="filled" aria-label={t("dashboard.upstreamEditor.models.pricingErrors")} color="danger" size="tiny">!</Badge>}
              </span>
              <span className="truncate text-fui-fg2 text-fui-base200">
                {index === baseIndex
                  ? t("dashboard.upstreamEditor.models.basePricingSummary")
                  : t("dashboard.upstreamEditor.models.overridePricingSummary")}
              </span>
            </span>
          </Button>
        </div>)}
      </div>
      {editable && <Button appearance="subtle" className="!justify-start !px-0" icon={<AddRegular />} onClick={addEntry} size="small">
        {t("dashboard.upstreamEditor.models.addPricingOverride")}
      </Button>}
    </aside>

    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-5 pt-3">
      {active && <>
        <div className="relative min-w-0">
          <Field className="min-w-0" label={{ children: t("dashboard.upstreamEditor.models.serviceTierName"), className: "font-fui-semibold" }} hint={t("dashboard.upstreamEditor.models.serviceTierHint")}>
            <Input
              className="!w-full"
              placeholder={t("dashboard.upstreamEditor.models.serviceTierPlaceholder")}
              readOnly={!editable}
              size="medium"
              value={serviceTier}
              onChange={(_, data) => updateActive((entry) => {
                const selector = selectorFor(entry);
                const next = data.value.trim();
                if (next) selector.serviceTier = next; else delete selector.serviceTier;
                return { ...(Object.keys(selector).length ? { selector: selector as PricingSelector } : {}), rates: entry.rates };
              })}
            />
          </Field>
          {editable && <Tooltip content={t("dashboard.upstreamEditor.models.removePricingEntry")} relationship="label"><Button appearance="subtle" aria-label={t("dashboard.upstreamEditor.models.removePricingEntry")} className="!absolute !right-0 !top-[-6px]" icon={<DeleteRegular />} onClick={removeActive} size="small" /></Tooltip>}
        </div>

        <section className="grid min-w-0 gap-3" aria-labelledby={conditionsHeadingId}>
          <div className={TIGHT_STACK_CLASS}>
            <Text as="h4" id={conditionsHeadingId} weight="semibold" className="!m-0">{t("dashboard.upstreamEditor.models.pricingConditions")}</Text>
            <Text size={200} className="text-fui-fg2">
              {selected === baseIndex
                ? t("dashboard.upstreamEditor.models.basePricingDescription")
                : t("dashboard.upstreamEditor.models.overridePricingDescription")}
            </Text>
          </div>
          <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2 items-start max-w-[440px] max-[520px]:grid-cols-[80px_minmax(0,1fr)]">
            <Field className="min-w-0" label={t("dashboard.upstreamEditor.models.operator")}>
              <Select
                disabled={!editable}
                size="medium"
                value={operator}
                onChange={(_, data) => {
                  const nextOperator = data.value as PricingThresholdOperator;
                  setOperatorDrafts((current) => ({ ...current, [selected]: nextOperator }));
                  if (threshold) updateActive((entry) => ({ ...entry, selector: { ...(entry.selector ?? {}), inputTokens: { ...threshold, operator: nextOperator } } }));
                }}
              ><option value="gt">&gt;</option><option value="gte">&gt;=</option></Select>
            </Field>
            <Field className="min-w-0" label={t("dashboard.upstreamEditor.models.inputTokens")} hint={t("dashboard.upstreamEditor.models.inputTokensHint")}>
              <Input
                className="!w-full"
                inputMode="numeric"
                min={1}
                readOnly={!editable}
                size="medium"
                type="number"
                value={threshold?.value === undefined ? "" : String(threshold.value)}
                onChange={(_, data) => updateActive((entry) => {
                  const selector = selectorFor(entry);
                  if (data.value === "") delete selector.inputTokens;
                  else selector.inputTokens = { operator, value: Number(data.value) };
                  return { ...(Object.keys(selector).length ? { selector: selector as PricingSelector } : {}), rates: entry.rates };
                })}
              />
            </Field>
          </div>
        </section>

        <section className="grid min-w-0 gap-3" aria-describedby={ratesHintId} aria-labelledby={ratesHeadingId}>
          <div className={TIGHT_STACK_CLASS}>
            <Text as="h4" id={ratesHeadingId} weight="semibold" className="!m-0">{t("dashboard.upstreamEditor.models.pricingRates")}</Text>
            <Text id={ratesHintId} size={200} className="text-fui-fg2">{t("dashboard.upstreamEditor.models.pricingRatesHint")}</Text>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-3 min-w-0">
            {visibleDimensions.map((dimension) => <Field className="min-w-0" key={dimension} label={t(dimensionKey(dimension))}>
              <PriceInput
                editable={editable}
                placeholder={t("dashboard.upstreamEditor.models.priceNotSet")}
                value={active.rates[dimension]}
                onChange={(value) => updateActive((entry) => {
                  const rates: PriceVector = { ...entry.rates };
                  if (value === undefined) delete rates[dimension]; else rates[dimension] = value;
                  return { ...entry, rates };
                })}
              />
            </Field>)}
          </div>
        </section>

        {activeIssues.length > 0 && <MessageBar className="min-w-0 max-w-full" intent="error" shape="rounded">
          <MessageBarBody>
            <MessageBarTitle>{t("dashboard.upstreamEditor.models.pricingErrors")}</MessageBarTitle>
            <ul className="!m-0 grid gap-1 pl-5">
              {activeIssues.map((issue, index) => <li key={`${issue.code}-${index}`}>{pricingIssueMessage(issue, t)}</li>)}
            </ul>
          </MessageBarBody>
        </MessageBar>}
      </>}
    </div>
  </div>;
}

function pricingIssueMessage(issue: ModelPricingIssue, t: ReturnType<typeof useTranslation>["t"]): string {
  switch (issue.code) {
    case "empty-catalog": return t("dashboard.upstreamEditor.models.pricingIssue.emptyCatalog");
    case "empty-rates": return t("dashboard.upstreamEditor.models.pricingIssue.emptyRates");
    case "invalid-rate": return t("dashboard.upstreamEditor.models.pricingIssue.invalidRate", { dimension: t(dimensionKey(issue.dimension)) });
    case "invalid-selector": return t("dashboard.upstreamEditor.models.pricingIssue.invalidSelector");
    case "base-count": return t("dashboard.upstreamEditor.models.pricingIssue.baseCount");
    case "rate-dimensions": return t("dashboard.upstreamEditor.models.pricingIssue.rateDimensions");
    case "duplicate-selector": return t("dashboard.upstreamEditor.models.pricingIssue.duplicateSelector");
    case "threshold-operator-conflict": return t("dashboard.upstreamEditor.models.pricingIssue.thresholdConflict");
  }
}

function comparePricingEntries(
  left: { entry: PricingEntry; index: number },
  right: { entry: PricingEntry; index: number },
  baseIndex: number,
): number {
  if (left.index === right.index) return 0;
  if (left.index === baseIndex) return 1;
  if (right.index === baseIndex) return -1;

  const leftCoordinates = Object.keys(left.entry.selector ?? {}).length;
  const rightCoordinates = Object.keys(right.entry.selector ?? {}).length;
  if (leftCoordinates !== rightCoordinates) return rightCoordinates - leftCoordinates;

  const leftThreshold = left.entry.selector?.inputTokens;
  const rightThreshold = right.entry.selector?.inputTokens;
  const leftValue = leftThreshold && typeof leftThreshold === "object" ? leftThreshold.value : -1;
  const rightValue = rightThreshold && typeof rightThreshold === "object" ? rightThreshold.value : -1;
  if (leftValue !== rightValue) return rightValue - leftValue;

  return left.index - right.index;
}
