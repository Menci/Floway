import {
  ArrowDownloadRegular,
  ArrowUploadRegular,
  CheckmarkCircleRegular,
  DismissCircleRegular,
  DismissRegular,
  FlashRegular,
  KeyRegular,
  MultiselectLtrRegular,
  TimerRegular,
} from '@fluentui/react-icons';
import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { List } from 'react-window';
import type { ListImperativeAPI, RowComponentProps } from 'react-window';

import { BatchExport } from './batch-export';
import { endpointName } from './endpoint';
import { errorLabel, requestSeverity, totalTokens } from './format';
import { RequestKeyLabel } from './key-label';
import { RequestSearch } from './search';
import type { ApiKey } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { formatDuration } from '../../lib/format-duration';
import { formatBytes, formatCompactCount } from '../../lib/format-number';
import { dateTime, relativeTime, shortDate } from '../../lib/format-time';
import { NO_READING } from '../../lib/no-reading';
import { useLocale } from '../../lib/use-locale';
import { useMediaQuery } from '../../lib/use-media-query';
import { useNow } from '../../lib/use-now';
import { EmptyState } from '../ui/empty-state';
import { Checkbox } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { PANEL_INSET_CLASS } from '../ui/panel';
import { useRouteAddress } from '../ui/route-link';
import { useScrollAreaHost } from '../ui/scroll-area';
import { TruncationTooltip } from '../ui/truncation-tooltip';
import { UpstreamBadge } from '../upstreams/upstream-kind-badge';
import type { DumpMetadata } from '@floway-dev/gateway/browser';

const { Button, Text, ToggleButton, Tooltip, makeStyles, mergeClasses } = fluentComponents;
// A row's lines sit closer to one another than to the next row's, so each
// record reads as one group: lines 4px apart (Fluent's spacingVerticalXS),
// rows 10px inside each divider (spacingVerticalMNudge). A line is 24px, the
// height of the upstream chip it may hold (see ../ui/chip.tsx).
const LINE_HEIGHT = 24;
const LINE_GAP = 4;
const ROW_BLOCK_PADDING = 10;
// The divider under each row (`selectionRow`) is drawn inside its height.
const ROW_DIVIDER = 1;
const rowHeight = (lines: number) => lines * LINE_HEIGHT + (lines - 1) * LINE_GAP + 2 * ROW_BLOCK_PADDING + ROW_DIVIDER;
// A phone's width, where the page inset steps down in ../../global.css: each
// row keeps two lines and drops the readings the record's details still carry.
const COMPACT_QUERY = '(max-width: 680px)';

const useStyles = makeStyles({
  toolbar: {
    flexShrink: 0,
    paddingBottom: 'var(--spacingVerticalS)',
    // The fixed band and scrolling rows meet at WinUI's divider brush.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L250
    borderBottom: '1px solid var(--winui-divider-stroke-default)',
  },
  list: { outlineStyle: 'none' },
  selectionRow: {
    backgroundColor: 'transparent',
    display: 'flex',
    // A divider rather than a card stroke, shared by the selection cell and content.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L46
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L250
    borderBottom: `${ROW_DIVIDER}px solid var(--winui-divider-stroke-default)`,
    // The full row owns the fill; the content link and selection cell share it.
    // ../../winui/controls/list.css.ts
    ':hover': { backgroundColor: 'var(--winui-subtle-fill-secondary)' },
    ':active': { backgroundColor: 'var(--winui-subtle-fill-tertiary)' },
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L83-L90
    '@media (forced-colors: active)': {
      ':hover': { backgroundColor: 'Highlight', color: 'HighlightText' },
      ':active': { backgroundColor: 'Highlight', color: 'HighlightText' },
      ':hover *': { color: 'HighlightText' },
      ':active *': { color: 'HighlightText' },
    },
  },
  row: {
    backgroundColor: 'transparent',
    // The row addresses the record it opens, and an anchor would otherwise take
    // the user-agent link colour and underline.
    color: 'inherit',
    textDecorationLine: 'none',
    cursor: 'pointer',
    display: 'grid',
    gridTemplateRows: 'repeat(3, minmax(0, 1fr))',
    outlineStyle: 'none',
    // The panel inset sits inside the link rather than around it, so the
    // focus ring drawn just inside the link keeps clear of the text.
    padding: `${ROW_BLOCK_PADDING}px var(--floway-panel-inset)`,
    rowGap: `${LINE_GAP}px`,
    position: 'relative',
    flex: 1,
    minWidth: 0,
    // Two concentric strokes held a pixel clear of the row's edge, keeping the
    // ring off the divider shared with the row above. The inner stroke's
    // pseudo-element resolves against the relatively positioned content link.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L29-L30
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L181-L182
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L248
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L250
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L252
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: 'var(--winui-focus-stroke-outer)',
      outlineOffset: '-3px',
    },
    ':focus-visible::after': {
      content: '""',
      position: 'absolute',
      inset: '3px',
      boxShadow: 'inset 0 0 0 1px var(--winui-focus-stroke-inner)',
      pointerEvents: 'none',
    },
  },
  // A leading export checkbox takes the panel inset, leaving the row only the
  // gap after it.
  exportCheckbox: { marginInlineStart: 'var(--floway-panel-inset)' },
  afterCheckbox: { paddingLeft: 'var(--spacingHorizontalL)' },
  twoLines: { gridTemplateRows: 'repeat(2, minmax(0, 1fr))' },
  // Restated per state because the row's hover rule is a pseudo-class and would
  // otherwise outrank a bare declaration here, washing out a selected row under
  // the pointer. This class must stay last at the mergeClasses call site.
  selected: {
    backgroundColor: 'var(--colorBrandBackgroundInvertedHover)',
    ':hover': { backgroundColor: 'var(--colorBrandBackgroundInvertedHover)' },
    ':active': { backgroundColor: 'var(--colorBrandBackgroundInvertedHover)' },
    '@media (prefers-color-scheme: dark)': {
      backgroundColor: 'var(--colorBrandBackground2)',
      ':hover': { backgroundColor: 'var(--colorBrandBackground2)' },
      ':active': { backgroundColor: 'var(--colorBrandBackground2)' },
    },
    // A forced palette would repaint the tint as the page background, so the
    // selection is handed over as the keywords WinUI names for a selected row.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L85-L87
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L91-L93
    '@media (forced-colors: active)': {
      backgroundColor: 'Highlight',
      color: 'HighlightText',
      '& *': { color: 'HighlightText' },
    },
  },
  // WinUI's SystemFillColorCritical, Success and Caution, each tuned per theme
  // dictionary, so none of the three is restated for dark.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L280-L282
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L76-L78
  error: { color: 'var(--winui-system-fill-critical)' },
  success: { color: 'var(--winui-system-fill-success)' },
  warning: { color: 'var(--winui-system-fill-caution)' },
});

interface RequestListProps {
  q?: string | undefined;
  failures?: boolean | undefined;
  onFilterChange?: ((q: string, failures: boolean) => void) | undefined;
  /** Where the record a row opens is read, so the row can be opened in a second tab. */
  addressOfRecord: (recordId: string) => string;
  apiKeys: ApiKey[];
  /** `null` is the merged all-keys log. */
  selectedKeyId: string | null;
  onKeyChange: (keyId: string | null) => void;
  records: DumpMetadata[];
  selectedRecordId: string | null;
  onRecordChange: (recordId: string) => void;
  hasOlder: boolean;
  error: string | null;
  onDismissError: () => void;
  onLoadOlder: () => void;
}

interface RowProps {
  /** Folded to a phone's width; see COMPACT_QUERY. */
  compact: boolean;
  /** Whether the export checkbox leads the row. */
  exportable: boolean;
  /** Whether every row names the key that captured it. */
  showSourceKey: boolean;
  /** Key names worn by more than one key, whose labels add the key's suffix. */
  sharedKeyNames: ReadonlySet<string>;
  exportIds: Set<string>;
  onToggleExport: (id: string) => void;
  addressOfRecord: (recordId: string) => string;
  now: number;
  onSelect: (recordId: string) => void;
  records: DumpMetadata[];
  selectedId: string | null;
  selectByIndex: (index: number) => void;
}

function RequestRow({ index, records, style, ...rest }: RowComponentProps<RowProps>) {
  const record = records[index];
  if (!record) return null;
  return <RequestRowContent {...rest} index={index} record={record} records={records} style={style} />;
}

function RequestRowContent({ compact, exportable, showSourceKey, sharedKeyNames, exportIds, onToggleExport, addressOfRecord, index, now, onSelect, record, records, selectByIndex, selectedId, style }: RowProps & {
  index: number;
  record: DumpMetadata;
  style: CSSProperties;
}) {
  const s = useStyles();
  const { t } = useTranslation();
  const locale = useLocale();
  const address = useRouteAddress(addressOfRecord(record.id), () => onSelect(record.id));
  const severity = requestSeverity(record.status, record.error);
  const tokens = totalTokens(record);
  const rowError = errorLabel(record.error, record.status);
  const StatusIcon = severity === 'success' ? CheckmarkCircleRegular : DismissCircleRegular;
  const selected = selectedId === record.id;
  const endpoint = endpointName(record.method, record.path);

  const handleKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(record.id);
    } else if (event.key === 'ArrowDown' && index < records.length - 1) {
      event.preventDefault();
      selectByIndex(index + 1);
    } else if (event.key === 'ArrowUp' && index > 0) {
      event.preventDefault();
      selectByIndex(index - 1);
    }
  };

  // The endpoint by its protocol's name, which says more than its path at a
  // glance; the path stays in the tooltip, and a path no public route serves
  // is shown as it is.
  const endpointLabel = <Tooltip content={`${record.method} ${record.path}`} relationship="description">
    <Text size={200} className={mergeClasses('min-w-0 flex-1 text-fui-fg3', endpoint === null && 'font-mono mono-size-xs')} truncate wrap={false}>
      {endpoint === null ? record.path : t(`apiDocs.endpointNames.${endpoint}`)}
    </Text>
  </Tooltip>;
  // At a phone width the label takes the line's slack, so the chip and the
  // outcome hold the right edge and line up from row to row.
  const keyLabel = <RequestKeyLabel apiKey={record.key} className={mergeClasses('min-w-0 shrink-[2]', compact ? 'flex-1' : 'max-w-36')} withSuffix={sharedKeyNames.has(record.key.name)} />;
  // The chip gives way to the labels beside it rather than overflowing.
  const upstreamBadge = record.upstream && <span className="flex min-w-0 shrink">
    <UpstreamBadge upstream={record.upstream} label={record.upstream.name} title={`${record.upstream.kind}, ${record.upstream.id}`} />
  </span>;
  // A failure's reason outranks the labels beside it: they give way first,
  // and it keeps up to half the line before it clips.
  const outcome = rowError
    ? <span className="ml-auto flex min-w-0 shrink-0 max-w-1/2">
        <TruncationTooltip content={rowError} relationship="label">
          {measureRef => <Text size={200} className={mergeClasses('min-w-0', s.error)} ref={measureRef} truncate wrap={false}>{rowError}</Text>}
        </TruncationTooltip>
      </span>
    : <Text size={200} className="ml-auto shrink-0 text-fui-fg3 tabular-nums" wrap={false}>
        {tokens === null ? NO_READING : `${formatCompactCount(tokens, locale)} tok`}
      </Text>;

  return (
    <div style={style} className={mergeClasses(s.selectionRow, selected && s.selected)}>
      {exportable && <Checkbox aria-label={t('requests.selectExport')} className={s.exportCheckbox} checked={exportIds.has(record.id)} onChange={() => onToggleExport(record.id)} />}
      <a
        {...address}
        aria-selected={selected}
        className={mergeClasses(s.row, compact && s.twoLines, exportable && s.afterCheckbox)}
        data-record-index={index}
        onKeyDown={handleKeyDown}
        role="option"
        tabIndex={selected || (selectedId === null && index === 0) ? 0 : -1}
      >
        <div className="flex items-center gap-2 min-w-0">
          <StatusIcon aria-hidden="true" className={`${s[severity]} block flex-none`} fontSize={22} />
          <span className="sr-only">{t(`requests.status.${severity}`)}</span>
          <Text size={300} className="min-w-0 font-mono" truncate wrap={false}>
            {record.model ?? t('requests.unknownModel')}
          </Text>
          {/* These triggers stay unfocusable: the row is an `option` under a
            roving tabindex, and a focusable descendant breaks that stop. */}
          <Tooltip content={dateTime(record.startedAt, locale)} relationship="description">
            <Text size={200} className="ml-auto shrink-0 text-fui-fg3">
              {/* The narrow style, alone in the app: a trailing column in a dense
                virtualized row has to fit "4m ago" beside the model name. */}
              {relativeTime(record.startedAt, locale, { now, style: 'narrow' }) ?? shortDate(record.startedAt, locale)}
            </Text>
          </Tooltip>
        </div>
        {compact
          // Under the model, where the status glyph and its gap leave off. The
          // merged log names the key in the endpoint's place; the record's
          // details carry the endpoint and every reading dropped here.
          ? <div className="flex items-center gap-3 min-w-0 pl-[30px]">
              {showSourceKey ? keyLabel : endpointLabel}
              {upstreamBadge}
              {outcome}
            </div>
          : <>
              {/* A single key's log already names the key above it. */}
              <div className="flex items-center gap-3 min-w-0">
                {endpointLabel}
                {showSourceKey && keyLabel}
                {upstreamBadge}
              </div>
              <div className="flex items-center gap-3 min-w-0 text-fui-fg3">
                <Tooltip content={t('requests.duration', { value: formatDuration(record.durationMs, locale) })} relationship="description">
                  <span className="inline-flex items-center gap-1 shrink-0">
                    <TimerRegular aria-hidden="true" className="block flex-none" fontSize={16} /> <Text size={200} className="tabular-nums">{formatDuration(record.durationMs, locale)}</Text>
                  </span>
                </Tooltip>
                {record.ttftMs != null && (
                  <Tooltip content={t('requests.ttft', { value: formatDuration(record.ttftMs, locale) })} relationship="description">
                    <span className="inline-flex items-center gap-1 shrink-0">
                      <FlashRegular aria-hidden="true" className="block flex-none" fontSize={16} /> <Text size={200} className="tabular-nums">{formatDuration(record.ttftMs, locale)}</Text>
                    </span>
                  </Tooltip>
                )}
                <Tooltip content={t('requests.requestBytes', { value: record.requestBytes })} relationship="description">
                  <span className="inline-flex items-center gap-1 shrink-0">
                    <ArrowUploadRegular aria-hidden="true" className="block flex-none" fontSize={16} /> <Text size={200} className="tabular-nums">{formatBytes(record.requestBytes, locale)}</Text>
                  </span>
                </Tooltip>
                <Tooltip content={t('requests.responseBytes', { value: record.responseBytes })} relationship="description">
                  <span className="inline-flex items-center gap-1 shrink-0">
                    <ArrowDownloadRegular aria-hidden="true" className="block flex-none" fontSize={16} /> <Text size={200} className="tabular-nums">{formatBytes(record.responseBytes, locale)}</Text>
                  </span>
                </Tooltip>
                {outcome}
              </div>
            </>}
      </a>
    </div>
  );
}

export function RequestListPanel(props: RequestListProps) {
  const { t } = useTranslation();
  const s = useStyles();
  const [exportIds, setExportIds] = useState<Set<string>>(new Set());
  const onToggleExport = useCallback((id: string) => setExportIds(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }), []);
  const [listRef, setListRef] = useState<ListImperativeAPI | null>(null);
  const { hostProps } = useScrollAreaHost({ axes: 'vertical', noTabIndex: true, viewport: listRef?.element ?? null });
  const now = useNow(30_000);
  const compact = useMediaQuery(COMPACT_QUERY);
  // Checkboxes appear only while selecting, the way a WinUI list enters its
  // multiple-selection mode from a command rather than standing in one.
  // Leaving the mode drops the selection it made.
  const [selecting, setSelecting] = useState(false);
  const toggleSelecting = () => {
    if (selecting) setExportIds(new Set());
    setSelecting(!selecting);
  };
  const allKeys = props.selectedKeyId === null;
  // Read from the rows as well as the key list, since a key created after the
  // list loaded can stream rows before the next key refresh names it.
  const sharedKeyNames = useMemo(() => {
    const idsByName = new Map<string, Set<string>>();
    for (const { id, name } of [...props.apiKeys, ...props.records.map(record => record.key)]) {
      idsByName.set(name, (idsByName.get(name) ?? new Set()).add(id));
    }
    return new Set([...idsByName].filter(([, ids]) => ids.size > 1).map(([name]) => name));
  }, [props.apiKeys, props.records]);

  const { onRecordChange, records } = props;
  const selectByIndex = useCallback((index: number) => {
    const record = records[index];
    if (!record) return;
    onRecordChange(record.id);
    listRef?.scrollToRow({ align: 'smart', index });
    window.requestAnimationFrame(() => listRef?.element?.querySelector<HTMLElement>(`[data-record-index="${index}"]`)?.focus());
  }, [listRef, onRecordChange, records]);

  const rowProps = useMemo<RowProps>(() => ({
    compact, exportable: selecting,
    showSourceKey: allKeys,
    sharedKeyNames,
    exportIds, onToggleExport,
    addressOfRecord: props.addressOfRecord,
    now,
    onSelect: onRecordChange,
    records,
    selectedId: props.selectedRecordId,
    selectByIndex,
  }), [allKeys, compact, selecting, exportIds, onToggleExport, now, onRecordChange, props.addressOfRecord, records, props.selectedRecordId, selectByIndex, sharedKeyNames]);

  const q = props.q ?? '';
  const failures = props.failures ?? false;
  const { onFilterChange } = props;
  const selectedKey = props.selectedKeyId === null ? null : props.apiKeys.find(key => key.id === props.selectedKeyId) ?? null;
  // Icons named by their tooltips, so the search keeps the row's width.
  const failuresToggle = onFilterChange && <Tooltip content={t('requests.failuresOnly')} relationship="label">
    <ToggleButton aria-pressed={failures} checked={failures} icon={<DismissCircleRegular />} onClick={() => onFilterChange(q, !failures)} />
  </Tooltip>;
  const selectToggle = <Tooltip content={t('requests.select')} relationship="label">
    <ToggleButton aria-pressed={selecting} checked={selecting} icon={<MultiselectLtrRegular />} onClick={toggleSelecting} />
  </Tooltip>;

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className={mergeClasses(PANEL_INSET_CLASS, 'flex flex-col gap-3', s.toolbar)}>
        {onFilterChange
          ? <RequestSearch beside={<>{failuresToggle}{selectToggle}</>} key={q} q={q} onSearch={query => onFilterChange(query, failures)} />
          : <div className="flex justify-end">{selectToggle}</div>}
        {/* The log is every key's unless a link opened one key's, which then
            stays named here until it is dismissed. */}
        {selectedKey && <div className="flex min-w-0">
          <Tooltip content={t('requests.showEveryKey')} relationship="label">
            <Button appearance="secondary" className="min-w-0" icon={<DismissRegular />} iconPosition="after" onClick={() => props.onKeyChange(null)} size="small">
              <span className="inline-flex items-center gap-1 min-w-0">
                <KeyRegular aria-hidden="true" className="block flex-none" fontSize={16} />
                <Text size={200} className="min-w-0" truncate wrap={false}>{`${selectedKey.name} (${selectedKey.key.slice(-4)})`}</Text>
              </span>
            </Button>
          </Tooltip>
        </div>}
        {selecting && <BatchExport selected={exportIds} loadedIds={records.map(record => record.id)} onChange={setExportIds} />}
      </div>
      {props.error && <OutcomeMessageBar className="!m-2" onDismiss={props.onDismissError}>{props.error}</OutcomeMessageBar>}
      {props.records.length === 0 ? (
        <EmptyState className="flex-1 p-6" title={t(q || failures ? 'requests.noMatches' : 'requests.empty')} />
      ) : (
        <div {...hostProps} className={mergeClasses(hostProps.className, 'flex-1 min-h-0')}>
          <List
            aria-label={t('requests.listLabel')}
            className={s.list}
            defaultHeight={620}
            listRef={setListRef}
            onRowsRendered={({ stopIndex }) => {
              if (props.hasOlder && stopIndex >= props.records.length - 8) props.onLoadOlder();
            }}
            overscanCount={5}
            role="listbox"
            rowComponent={RequestRow}
            rowCount={props.records.length}
            rowHeight={rowHeight(compact ? 2 : 3)}
            rowProps={rowProps}
            style={{ height: '100%', overflowX: 'hidden' }}
          />
        </div>
      )}
    </div>
  );
}
