import { ArrowClockwiseRegular, CheckmarkRegular, CopyRegular, DeleteRegular, DismissRegular, EditRegular } from "@fluentui/react-icons";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ApiKey } from "../../api/types";
import { fluentComponents } from "../../fluent";
import type { UpstreamOption } from "./types";
const { Button, Table, TableBody, TableCell, TableCellLayout, TableHeader, TableHeaderCell, TableRow, Text, Tooltip, createTableColumn, makeStyles, useTableColumnSizing_unstable, useTableFeatures, useTableSort } = fluentComponents;
const useStyles = makeStyles({ selectedRow: { backgroundColor: "var(--colorBrandBackground2)" }, selectedDot: { backgroundColor: "var(--colorBrandForeground1)" }, accentText: { color: "var(--colorBrandForeground1)" }, dangerText: { color: "var(--colorPaletteRedForeground1)" } });
export function KeysTable({
  copiedTag, copyFailedTag, keys, onCopy, onDelete, onEdit, onRotate, onSelect, selectedKeyId, upstreams,
}: {
  copiedTag: string | null; copyFailedTag: string | null; keys: ApiKey[];
  onCopy: (text: string, tag: string) => void; onDelete: (key: ApiKey) => void;
  onEdit: (key: ApiKey) => void; onRotate: (key: ApiKey) => void;
  onSelect: (id: string) => void; selectedKeyId: string; upstreams: UpstreamOption[];
}) {
  const { t } = useTranslation();
  const s = useStyles();
  const upstreamById = useMemo(
    () => new Map(upstreams.map((upstream) => [upstream.id, upstream])),
    [upstreams],
  );

  const columns = useMemo(
    () => [
      createTableColumn<ApiKey>({
        columnId: "name", compare: (a, b) => a.name.localeCompare(b.name),
        renderHeaderCell: () => t("dashboard.apiKeys.table.name"),
        renderCell: (key) => (
          <TableCellLayout>
            <div className="inline-flex items-center gap-2 min-w-0">
              <span className={`rounded-full flex-none h-[7px] w-[7px] ${key.id === selectedKeyId ? s.selectedDot : "bg-transparent"}`} />
              <span className="truncate min-w-0">{key.name}</span>
            </div>
          </TableCellLayout>
        ),
      }),
      createTableColumn<ApiKey>({
        columnId: "key", renderHeaderCell: () => t("dashboard.apiKeys.table.key"),
        renderCell: (key) => (
          <code className="bg-fui-bg2 border border-fui-stroke1 rounded-md text-fui-fg2 inline-block font-mono text-xs max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap p-[2px_6px]">
            {truncateKey(key.key)}
          </code>
        ),
      }),
      createTableColumn<ApiKey>({
        columnId: "upstreams", renderHeaderCell: () => t("dashboard.apiKeys.table.upstreams"),
        renderCell: (key) => (
          <span
            className={
              !key.upstream_ids ? undefined
              : key.upstream_ids.length === 0 ? s.dangerText : s.accentText
            }
            title={upstreamsTitle(key, upstreamById, t)}
          >
            {upstreamsText(key, upstreamById, t)}
          </span>
        ),
      }),
      createTableColumn<ApiKey>({
        columnId: "created", compare: (a, b) => a.created_at.localeCompare(b.created_at),
        renderHeaderCell: () => t("dashboard.apiKeys.table.created"),
        renderCell: (key) => <span title={fullDateTime(key.created_at)}>{shortDate(key.created_at)}</span>,
      }),
      createTableColumn<ApiKey>({
        columnId: "lastUsed", compare: (a, b) => (a.last_used_at ?? "").localeCompare(b.last_used_at ?? ""),
        renderHeaderCell: () => t("dashboard.apiKeys.table.lastUsed"),
        renderCell: (key) => key.last_used_at
          ? <span title={fullDateTime(key.last_used_at)}>{relativeTime(key.last_used_at, t)}</span>
          : <span>{t("dashboard.apiKeys.table.never")}</span>,
      }),
      createTableColumn<ApiKey>({
        columnId: "actions", renderHeaderCell: () => t("dashboard.apiKeys.table.actions"),
        renderCell: (key) => {
          const copyTag = `key-${key.id}`;
          return (
            <div className="inline-flex items-center gap-[2px]" onClick={(event) => event.stopPropagation()}>
              <IconButton icon={copyFailedTag === copyTag ? <DismissRegular /> : copiedTag === copyTag ? <CheckmarkRegular /> : <CopyRegular />}
                label={copyFailedTag === copyTag ? t("dashboard.apiKeys.copy.failed") : copiedTag === copyTag ? t("dashboard.apiKeys.copy.copied") : t("dashboard.apiKeys.actions.copy")}
                onClick={() => onCopy(key.key, copyTag)} />
              <IconButton icon={<EditRegular />} label={t("dashboard.apiKeys.actions.edit")} onClick={() => onEdit(key)} />
              <IconButton icon={<ArrowClockwiseRegular />} label={t("dashboard.apiKeys.actions.rotate")} onClick={() => onRotate(key)} />
              <IconButton icon={<DeleteRegular />} label={t("dashboard.apiKeys.actions.delete")} onClick={() => onDelete(key)} />
            </div>
          );
        },
      }),
    ],
    [copiedTag, copyFailedTag, onCopy, onDelete, onEdit, onRotate, s, selectedKeyId, t, upstreamById],
  );

  const columnSizingOptions = useMemo(
    () => ({
      name: { defaultWidth: 180 }, key: { defaultWidth: 160 },
      upstreams: { defaultWidth: 240 }, actions: { defaultWidth: 200 },
    }), []);

  const { getRows, columnSizing_unstable, tableRef } = useTableFeatures(
    { columns, items: keys },
    [useTableSort({}), useTableColumnSizing_unstable({ columnSizingOptions })],
  );
  const rows = getRows();

  if (keys.length === 0) {
    return <Text size={300} className="text-fui-fg3 !m-0 text-center p-[18px_0]">{t("dashboard.apiKeys.empty")}</Text>;
  }

  return (
    <div className="min-w-0 overflow-x-auto">
      <Table ref={tableRef} {...columnSizing_unstable.getTableProps()} aria-label={t("dashboard.apiKeys.table.title")} sortable>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHeaderCell key={column.columnId} {...columnSizing_unstable.getTableHeaderCellProps(column.columnId)}>
                {column.renderHeaderCell()}
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ item }) => (
            <TableRow className={item.id === selectedKeyId ? s.selectedRow : undefined} key={item.id} onClick={() => onSelect(item.id)}>
              {columns.map((column) => (
                <TableCell key={column.columnId} {...columnSizing_unstable.getTableCellProps(column.columnId)}>
                  {column.renderCell(item)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
function IconButton({
  disabled,
  icon,
  label,
  onClick,
}: {
  disabled?: boolean;
  icon: React.ReactElement;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip content={label} relationship="label">
      <Button
        appearance="subtle"
        aria-label={label}
        disabled={disabled}
        icon={icon}
        onClick={onClick}
        size="small"
      />
    </Tooltip>
  );
}
const truncateKey = (key: string) =>
  key.length <= 14 ? key : `${key.slice(0, 7)}...${key.slice(-4)}`;

const shortDate = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value))
    : "";

const fullDateTime = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(new Date(value))
    : "";

const relativeTime = (
  value: string,
  t: ReturnType<typeof useTranslation>["t"],
) => {
  const diffSeconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const abs = Math.abs(diffSeconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60) return formatter.format(diffSeconds, "second");
  if (abs < 3600) return formatter.format(Math.round(diffSeconds / 60), "minute");
  if (abs < 86400) return formatter.format(Math.round(diffSeconds / 3600), "hour");
  if (abs < 2592000) return formatter.format(Math.round(diffSeconds / 86400), "day");
  return t("dashboard.apiKeys.table.usedOn", { date: shortDate(value) });
};

const upstreamsText = (
  key: ApiKey,
  upstreamById: Map<string, UpstreamOption>,
  t: ReturnType<typeof useTranslation>["t"],
) => {
  if (!key.upstream_ids) return t("dashboard.apiKeys.upstreams.all");
  if (key.upstream_ids.length === 0) return t("dashboard.apiKeys.upstreams.none");
  const names = key.upstream_ids.map((id) => upstreamById.get(id)?.name ?? id);
  return names.length <= 2
    ? names.join(", ")
    : t("dashboard.apiKeys.upstreams.summary", {
        first: names.slice(0, 2).join(", "),
        count: names.length - 2,
      });
};

const upstreamsTitle = (
  key: ApiKey,
  upstreamById: Map<string, UpstreamOption>,
  t: ReturnType<typeof useTranslation>["t"],
) => {
  if (!key.upstream_ids) return t("dashboard.apiKeys.upstreams.inheritsTitle");
  if (key.upstream_ids.length === 0) return t("dashboard.apiKeys.upstreams.none");
  return key.upstream_ids.map((id) => upstreamById.get(id)?.name ?? id).join("\n");
};
