import { ArrowRepeatAllRegular, SelectAllOffRegular, SelectAllOnRegular } from "@fluentui/react-icons";
import { useTranslation } from "react-i18next";
import { fluentComponents } from "../../fluent";
import { OutlineCard } from "../ui/outline-card";
import { colorForSlot } from "./chart-model";
import type { ChartEntry, UsageChartModel } from "./types";
import { UsageChart } from "./usage-chart";

const { Button, InteractionTag, InteractionTagPrimary, Text, Tooltip } = fluentComponents;
export function ChartSection({
  chart,
  detailsLabel,
  hidden,
  onHiddenChange,
  title,
  valueFormatter,
}: {
  chart: UsageChartModel;
  detailsLabel: string;
  hidden: Set<string>;
  onHiddenChange: (next: Set<string>) => void;
  title: string;
  valueFormatter: (value: number) => string;
}) {
  const { t } = useTranslation();
  const ids = chart.entries.map((entry) => entry.id);
  const visibleLegends = chart.entries
    .filter((entry) => !hidden.has(entry.id))
    .map((entry) => entry.label);

  return (
    <section className="grid gap-3 min-w-0">
      <div className="flex items-center gap-3 justify-between min-w-0 max-[900px]:flex-col max-[900px]:items-stretch">
        <Text size={400} weight="semibold" className="text-fui-fg1 leading-[1.25]">{title}</Text>
        <div className="flex items-center flex-none gap-1" aria-label={detailsLabel}>
          <Tooltip content={t("dashboard.usage.series.all")} relationship="label">
            <Button
              appearance="subtle"
              icon={<SelectAllOnRegular />}
              onClick={() => onHiddenChange(new Set())}
            />
          </Tooltip>
          <Tooltip
            content={t("dashboard.usage.series.invert")}
            relationship="label"
          >
            <Button
              appearance="subtle"
              icon={<ArrowRepeatAllRegular />}
              onClick={() =>
                onHiddenChange(new Set(ids.filter((id) => !hidden.has(id))))
              }
            />
          </Tooltip>
          <Tooltip content={t("dashboard.usage.series.none")} relationship="label">
            <Button
              appearance="subtle"
              icon={<SelectAllOffRegular />}
              onClick={() => onHiddenChange(new Set(ids))}
            />
          </Tooltip>
        </div>
      </div>

      <ChartLegend
        entries={chart.entries}
        hidden={hidden}
        onHiddenChange={onHiddenChange}
      />

      <ChartCard>
        <UsageChart chart={chart} valueFormatter={valueFormatter} visibleLegends={visibleLegends} />
      </ChartCard>
    </section>
  );
}

function ChartLegend({
  entries,
  hidden,
  onHiddenChange,
}: {
  entries: ChartEntry[];
  hidden: Set<string>;
  onHiddenChange: (next: Set<string>) => void;
}) {
  const { t } = useTranslation();

  if (!entries.length) {
    return <Text size={200} className="text-fui-fg2">{t("dashboard.usage.empty")}</Text>;
  }

  return (
    <div className="flex flex-wrap gap-[6px] min-w-0">
      {entries.map((entry) => (
        <LegendTag
          key={entry.id}
          entry={entry}
          isHidden={hidden.has(entry.id)}
          onToggle={(exclusive) => {
            if (exclusive) {
              onHiddenChange(
                new Set(entries.map((item) => item.id).filter((id) => id !== entry.id)),
              );
              return;
            }
            const next = new Set(hidden);
            if (next.has(entry.id)) next.delete(entry.id);
            else next.add(entry.id);
            onHiddenChange(next);
          }}
          toggleHint={t("dashboard.usage.series.toggleHint")}
        />
      ))}
    </div>
  );
}

function LegendTag({
  entry,
  isHidden,
  onToggle,
  toggleHint,
}: {
  entry: ChartEntry;
  isHidden: boolean;
  onToggle: (exclusive: boolean) => void;
  toggleHint: string;
}) {
  return (
    <InteractionTag
      appearance="outline"
      shape="circular"
      size="small"
    >
      <InteractionTagPrimary
        className={isHidden ? "line-through opacity-[0.55]" : ""}
        icon={
          <span
            aria-hidden="true"
            className="inline-block rounded-full h-[8px] w-[8px] mx-[4px] flex-shrink-0"
            style={{ backgroundColor: colorForSlot(entry.colorSlot) }}
          />
        }
        onClick={(event) => onToggle(event.shiftKey)}
        title={toggleHint}
      >
        {entry.label}
      </InteractionTagPrimary>
    </InteractionTag>
  );
}

function ChartCard({ children }: { children: React.ReactNode }) {
  return (
    <OutlineCard className="min-h-[320px] min-w-0 overflow-hidden">
      {children}
    </OutlineCard>
  );
}
