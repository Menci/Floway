import { useTranslation } from "react-i18next";
import { fluentComponents } from "../../fluent";
import { formatSummaryMetric, metricConfig, summaryMetrics } from "./chart-model";
import type { TokenSummary, UsageMetric } from "./types";
const { Text, makeStyles, mergeClasses } = fluentComponents;
const useMetricButtonStyles = makeStyles({
  root: {
    backgroundColor: "var(--colorNeutralBackground2)",
    border: "1px solid var(--colorNeutralStroke1)",
    borderRadius: "8px",
    cursor: "pointer",
    display: "grid",
    gap: "4px",
    minHeight: "66px",
    minWidth: "0",
    padding: "8px 10px",
    textAlign: "left",
    ":hover": {
      border: "1px solid var(--colorBrandStroke1)",
    },
  },
  activeRoot: {
    backgroundColor: "var(--colorBrandBackgroundInvertedHover)",
    border: "1px solid var(--colorBrandStroke1)",
    "@media (prefers-color-scheme: dark)": {
      backgroundColor: "var(--colorBrandBackground2)",
    },
  },
  value: {
    color: "var(--colorNeutralForeground1)",
    overflowWrap: "anywhere",
  },
  activeText: {
    color: "var(--colorBrandForeground1)",
  },
});

function SummaryMetricButton({
  active,
  label,
  onClick,
  value,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  value: string;
}) {
  const s = useMetricButtonStyles();
  return (
    <button
      aria-pressed={active}
      className={mergeClasses(s.root, active && s.activeRoot)}
      onClick={onClick}
      type="button"
    >
      <Text
        size={200}
        weight="semibold"
        className={mergeClasses("text-fui-fg2 leading-[1.2]", active && s.activeText)}
      >
        {label}
      </Text>
      <Text
        size={500}
        weight="semibold"
        className={mergeClasses(s.value, active && s.activeText)}
      >
        {value}
      </Text>
    </button>
  );
}
export function SummaryMetrics({ locale, metric, onMetricChange, summary }: { locale: string; metric: UsageMetric; onMetricChange: (metric: UsageMetric) => void; summary: TokenSummary }) {
  const { t } = useTranslation();
  return <div className="grid gap-2.5 grid-cols-5 max-[900px]:grid-cols-2 max-[520px]:grid-cols-1">
    {summaryMetrics.map((group) => <div className="grid gap-2 min-w-0" key={group.join("-")}>
      {group.map((item) => <SummaryMetricButton active={metric === item} key={item} label={t(metricConfig[item].labelKey)} onClick={() => onMetricChange(item)} value={formatSummaryMetric(summary, item, locale)} />)}
    </div>)}
  </div>;
}
