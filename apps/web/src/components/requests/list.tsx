import {
  ArrowDownloadRegular,
  ArrowUploadRegular,
  CheckmarkCircleRegular,
  DismissCircleRegular,
  TimerRegular,
} from '@fluentui/react-icons';
import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { List } from 'react-window';
import type { ListImperativeAPI, RowComponentProps } from 'react-window';

import { errorLabel, requestSeverity, totalTokens } from './format';
import type { ApiKey } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { formatDuration } from '../../lib/format-duration';
import { formatBytes, formatCompactCount } from '../../lib/format-number';
import { dateTime, relativeTime, shortDate } from '../../lib/format-time';
import { NO_READING } from '../../lib/no-reading';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { EmptyState } from '../ui/empty-state';
import { Dropdown } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useRouteAddress } from '../ui/route-link';
import { useScrollAreaHost } from '../ui/scroll-area';
import { TruncationTooltip } from '../ui/truncation-tooltip';
import { ProviderBadge } from '../upstreams/provider-badge';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';

const { Option, Text, Tooltip, makeStyles, mergeClasses } = fluentComponents;
const ROW_HEIGHT = 84;

const useStyles = makeStyles({
  keySelector: {
    // Heads a card, so it takes the subtle ramp instead of a ComboBox's control
    // fills -- pressed being the state a ComboBox holds while expanded.
    // ../../winui/controls/select.css.ts
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L230-L231
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L26-L27
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L34
    '--floway-select-fill': 'transparent',
    '--floway-select-fill-hover': 'var(--colorSubtleBackgroundHover)',
    '--floway-select-fill-pressed': 'var(--colorSubtleBackgroundPressed)',
    // The three other edges are gone, so the one that remains is not a
    // ComboBox's outline any more -- it is the seam between a fixed band and the
    // list scrolling below it, which is the divider the rows below read.
    '--floway-select-border-width': '0 0 1px',
    '--floway-select-stroke': 'var(--winui-divider-stroke-default)',
    '--floway-select-radius': 'var(--winui-overlay-corner-radius) var(--winui-overlay-corner-radius) 0 0',
    // The field sits flush against the card's clip, so the focus composite is
    // turned inward rather than opening a gutter that would put a band of card
    // fill above the field.
    '--floway-select-focus-shadow': 'inset 0 0 0 4px var(--winui-control-fill-default)',
    '--floway-select-focus-offset': '-2px',
    width: '100%',
    '&:has(.fui-Dropdown__button[aria-expanded="true"])': {
      '--floway-select-fill': 'var(--colorSubtleBackgroundPressed)',
      '--floway-select-fill-hover': 'var(--colorSubtleBackgroundPressed)',
    },
    '& .fui-Dropdown__button': { paddingInlineStart: '16px' },
  },
  list: { outlineStyle: 'none' },
  row: {
    backgroundColor: 'transparent',
    // The row addresses the record it opens, and an anchor would otherwise take
    // the user-agent link colour and underline.
    color: 'inherit',
    textDecorationLine: 'none',
    // A divider rather than a card stroke: the card stroke is black in both
    // themes and disappears against a dark page.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L46
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L250
    borderBottom: '1px solid var(--winui-divider-stroke-default)',
    cursor: 'pointer',
    display: 'grid',
    gridTemplateRows: 'repeat(3, minmax(0, 1fr))',
    outlineStyle: 'none',
    padding: '6px 10px',
    // ../../winui/controls/list.css.ts
    ':hover': { backgroundColor: 'var(--winui-subtle-fill-secondary)' },
    ':active': { backgroundColor: 'var(--winui-subtle-fill-tertiary)' },
    // Two concentric strokes held a pixel clear of the row's edge, keeping the
    // ring off the divider shared with the row above. The inner stroke's
    // pseudo-element resolves against the row, which is a containing block only
    // because the virtualizer positions every row absolutely.
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
    // A forced palette repaints every colour it can reach, so the foreground is
    // restated on the descendants, which carry colours of their own.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L83-L84
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L89-L90
    '@media (forced-colors: active)': {
      ':hover': { backgroundColor: 'Highlight', color: 'HighlightText' },
      ':active': { backgroundColor: 'Highlight', color: 'HighlightText' },
      ':hover *': { color: 'HighlightText' },
      ':active *': { color: 'HighlightText' },
    },
  },
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
  /** Where the record a row opens is read, so the row can be opened in a second tab. */
  addressOfRecord: (recordId: string) => string;
  apiKeys: ApiKey[];
  selectedKeyId: string;
  onKeyChange: (keyId: string) => void;
  records: DumpMetadata[];
  selectedRecordId: string | null;
  onRecordChange: (recordId: string) => void;
  hasOlder: boolean;
  error: string | null;
  onDismissError: () => void;
  onLoadOlder: () => void;
}

interface RowProps {
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

function RequestRowContent({ addressOfRecord, index, now, onSelect, record, records, selectByIndex, selectedId, style }: RowProps & {
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

  return (
    <a
      {...address}
      aria-selected={selected}
      className={mergeClasses(s.row, selected && s.selected)}
      data-record-index={index}
      onKeyDown={handleKeyDown}
      role="option"
      style={style}
      tabIndex={selected || (selectedId === null && index === 0) ? 0 : -1}
    >
      <div className="flex items-center gap-2 min-w-0">
        <StatusIcon aria-hidden="true" className={`${s[severity]} block flex-none`} fontSize={22} />
        <span className="sr-only">{t(`dashboard.requests.status.${severity}`)}</span>
        <Text size={300} className="min-w-0 font-mono" truncate wrap={false}>
          {record.model ?? t('dashboard.requests.unknownModel')}
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
      <div className="flex items-center gap-2 min-w-0">
        <Tooltip content={`${record.method} ${record.path}`} relationship="description">
          <Text size={200} className="min-w-0 flex-1 text-fui-fg3 font-mono" truncate wrap={false}>
            {record.path}
          </Text>
        </Tooltip>
        {record.upstream && <ProviderBadge
          upstream={record.upstream}
          label={record.upstream.name}
          title={`${record.upstream.kind}, ${record.upstream.id}`}
        />}
      </div>
      <div className="flex items-center gap-3 min-w-0 text-fui-fg3">
        <Tooltip content={t('dashboard.requests.duration', { value: record.durationMs })} relationship="description">
          <span className="inline-flex items-center gap-1 shrink-0">
            <TimerRegular aria-hidden="true" className="block flex-none" fontSize={16} /> <Text size={200}>{formatDuration(record.durationMs)}</Text>
          </span>
        </Tooltip>
        <Tooltip content={t('dashboard.requests.requestBytes', { value: record.requestBytes })} relationship="description">
          <span className="inline-flex items-center gap-1 shrink-0">
            <ArrowUploadRegular aria-hidden="true" className="block flex-none" fontSize={16} /> <Text size={200}>{formatBytes(record.requestBytes, locale)}</Text>
          </span>
        </Tooltip>
        <Tooltip content={t('dashboard.requests.responseBytes', { value: record.responseBytes })} relationship="description">
          <span className="inline-flex items-center gap-1 shrink-0">
            <ArrowDownloadRegular aria-hidden="true" className="block flex-none" fontSize={16} /> <Text size={200}>{formatBytes(record.responseBytes, locale)}</Text>
          </span>
        </Tooltip>
        {rowError
          ? <TruncationTooltip content={rowError} relationship="label">
              {measureRef => <Text size={200} className={mergeClasses('ml-auto', s.error)} ref={measureRef} truncate wrap={false}>{rowError}</Text>}
            </TruncationTooltip>
          : <Text size={200} className="ml-auto text-fui-fg3" truncate wrap={false}>
              {tokens === null ? NO_READING : `${formatCompactCount(tokens, locale)} tok`}
            </Text>}
      </div>
    </a>
  );
}

export function RequestListPanel(props: RequestListProps) {
  const { t } = useTranslation();
  const s = useStyles();
  const [listRef, setListRef] = useState<ListImperativeAPI | null>(null);
  const { hostProps } = useScrollAreaHost({ axes: 'vertical', noTabIndex: true, viewport: listRef?.element ?? null });
  const now = useNow(30_000);
  const selectedKey = props.apiKeys.find(key => key.id === props.selectedKeyId)!;

  const { onRecordChange, records } = props;
  const selectByIndex = useCallback((index: number) => {
    const record = records[index];
    if (!record) return;
    onRecordChange(record.id);
    listRef?.scrollToRow({ align: 'smart', index });
    window.requestAnimationFrame(() => listRef?.element?.querySelector<HTMLElement>(`[data-record-index="${index}"]`)?.focus());
  }, [listRef, onRecordChange, records]);

  const rowProps = useMemo<RowProps>(() => ({
    addressOfRecord: props.addressOfRecord,
    now,
    onSelect: onRecordChange,
    records,
    selectedId: props.selectedRecordId,
    selectByIndex,
  }), [now, onRecordChange, props.addressOfRecord, records, props.selectedRecordId, selectByIndex]);

  return (
    <div className="h-full min-h-0 flex flex-col">
      <Dropdown
        aria-label={t('dashboard.requests.apiKey')}
        className={s.keySelector}
        selectedOptions={[props.selectedKeyId]}
        value={`${selectedKey.name} (${selectedKey.key.slice(-4)})`}
        onOptionSelect={(_, data) => data.optionValue !== undefined && props.onKeyChange(data.optionValue)}
      >
        {props.apiKeys.map(key => <Option key={key.id} text={`${key.name} (${key.key.slice(-4)})`} value={key.id}>{key.name} ({key.key.slice(-4)})</Option>)}
      </Dropdown>
      {props.error && <OutcomeMessageBar className="!m-2" onDismiss={props.onDismissError}>{props.error}</OutcomeMessageBar>}
      {props.records.length === 0 ? (
        <EmptyState className="flex-1 p-6" title={t('dashboard.requests.empty')} />
      ) : (
        <div {...hostProps} className={mergeClasses(hostProps.className, 'flex-1 min-h-0')}>
          <List
            aria-label={t('dashboard.requests.listLabel')}
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
            rowHeight={ROW_HEIGHT}
            rowProps={rowProps}
            style={{ height: '100%', overflowX: 'hidden' }}
          />
        </div>
      )}
    </div>
  );
}
