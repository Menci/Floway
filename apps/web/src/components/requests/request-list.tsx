import {
  ArrowDownloadRegular,
  ArrowUploadRegular,
  CheckmarkCircleRegular,
  DismissCircleRegular,
  TimerRegular,
} from '@fluentui/react-icons';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { List } from 'react-window';
import type { ListImperativeAPI, RowComponentProps } from 'react-window';

import { errorLabel, requestSeverity, totalTokens } from './format';
import type { ApiKey } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { formatDuration } from '../../lib/format-duration';
import { formatBytes, formatCompactCount } from '../../lib/format-number';
import { dateTime, relativeTime, shortDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { EmptyState } from '../ui/empty-state';
import { Dropdown } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { initializeScrollArea, scrollAreaHostClassName, useOverlayScrollbarsEnabled } from '../ui/scroll-area';
import { ProviderBadge } from '../upstreams/provider-badge';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';

const { Option, Text, Tooltip, makeStyles, mergeClasses } = fluentComponents;
const ROW_HEIGHT = 84;

const useStyles = makeStyles({
  keySelector: {
    backgroundColor: 'transparent !important',
    borderTop: '0 !important',
    borderRight: '0 !important',
    borderBottom: '1px solid var(--colorNeutralStroke1) !important',
    borderLeft: '0 !important',
    // The selector heads a card, so its top corners follow the card's own
    // OverlayCornerRadius rather than a value of their own; the bottom pair is
    // squared off because the list continues underneath it.
    borderRadius: 'var(--winui-overlay-corner-radius) var(--winui-overlay-corner-radius) 0 0 !important',
    width: '100%',
    '&:hover': { backgroundColor: 'var(--colorSubtleBackgroundHover) !important' },
    '&:active, &:has(.fui-Dropdown__button[aria-expanded="true"])': { backgroundColor: 'var(--colorSubtleBackgroundPressed) !important' },
    '& .fui-Dropdown__button': { paddingInlineStart: '16px' },
  },
  list: { outlineStyle: 'none' },
  row: {
    backgroundColor: 'transparent',
    // The rule between rows is a divider, which is the family every other row
    // separator in the dashboard reads. The neutral stroke this used to name
    // maps onto the CARD stroke, black at 10% -- invisible against a dark page.
    borderBottom: '1px solid var(--winui-divider-stroke-default)',
    cursor: 'pointer',
    display: 'grid',
    gridTemplateRows: 'repeat(3, minmax(0, 1fr))',
    outlineStyle: 'none',
    padding: '6px 10px',
    // The row is a listbox option that selects a record when clicked, so it
    // takes the subtle ramp every other list surface here takes; without it the
    // row claimed the pointer cursor and then answered nothing.
    // ../../winui/controls/list.css.ts
    ':hover': { backgroundColor: 'var(--winui-subtle-fill-secondary)' },
    ':active': { backgroundColor: 'var(--winui-subtle-fill-tertiary)' },
    ':focus-visible': { boxShadow: 'inset 0 0 0 2px var(--colorCompoundBrandStroke)' },
  },
  // Stated per state rather than once, because the row carries both classes and
  // the hover rule above is a pseudo-class: it outranks a bare declaration on
  // the same element, so a selected row under the pointer would take the subtle
  // wash in place of its brand fill and read as deselected. Matching the
  // pseudo-classes settles it twice over: where the two atoms collide on a key
  // mergeClasses drops the row's outright, and where they do not this class is
  // merged last and wins the cascade. The argument order at the call site is
  // load-bearing either way.
  selected: {
    backgroundColor: 'var(--colorBrandBackgroundInvertedHover)',
    ':hover': { backgroundColor: 'var(--colorBrandBackgroundInvertedHover)' },
    ':active': { backgroundColor: 'var(--colorBrandBackgroundInvertedHover)' },
    '@media (prefers-color-scheme: dark)': {
      backgroundColor: 'var(--colorBrandBackground2)',
      ':hover': { backgroundColor: 'var(--colorBrandBackground2)' },
      ':active': { backgroundColor: 'var(--colorBrandBackground2)' },
    },
  },
  // One of three severities the row indexes by name, so it stays with its
  // siblings rather than joining the shared danger text.
  error: { color: 'var(--colorPaletteRedForeground1)' },
  success: { color: 'var(--colorPaletteGreenForeground1)' },
  warning: { color: 'var(--colorPaletteDarkOrangeForeground1)' },
});

interface RequestListProps {
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
  now: number;
  onSelect: (recordId: string) => void;
  records: DumpMetadata[];
  selectedId: string | null;
  selectByIndex: (index: number) => void;
}

function RequestRow({ index, style, records, selectedId, now, onSelect, selectByIndex }: RowComponentProps<RowProps>) {
  const s = useStyles();
  const { t } = useTranslation();
  const locale = useLocale();
  const record = records[index];
  if (!record) return null;
  const severity = requestSeverity(record.status, record.error);
  const tokens = totalTokens(record);
  const rowError = errorLabel(record.error, record.status);
  const StatusIcon = severity === 'success' ? CheckmarkCircleRegular : DismissCircleRegular;
  const selected = selectedId === record.id;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
    <div
      aria-selected={selected}
      className={mergeClasses(s.row, selected && s.selected)}
      data-record-index={index}
      onClick={() => onSelect(record.id)}
      onKeyDown={handleKeyDown}
      role="option"
      style={style}
      tabIndex={selected || (selectedId === null && index === 0) ? 0 : -1}
    >
      <div className="flex items-center gap-2 min-w-0">
        <StatusIcon aria-hidden="true" className={`${s[severity]} block flex-none`} fontSize={22} />
        <span className="sr-only">{t(`dashboard.requests.status.${severity}`)}</span>
        <Text size={300} className="truncate min-w-0 font-mono">
          {record.model ?? t('dashboard.requests.unknownModel')}
        </Text>
        {/* The tooltips below this point are the only ones in the app whose
            trigger is left unfocusable. The row is an `option` under a roving
            tabindex, and a focusable descendant of one both breaks that roving
            stop and contradicts what an option promises assistive technology.
            The aria relationship still carries each hint into the row's
            announcement, which the native title it replaced did not. */}
        <Tooltip content={dateTime(record.startedAt, locale)} relationship="description">
          <Text size={200} className="ml-auto shrink-0 text-fui-fg3">
            {/* The narrow style, alone in the app: this is a trailing column in a
                dense virtualized row, where "4m ago" has to fit beside the model
                name that the row is actually about. */}
            {relativeTime(record.startedAt, locale, { now, style: 'narrow' }) ?? shortDate(record.startedAt, locale)}
          </Text>
        </Tooltip>
      </div>
      <div className="flex items-center gap-2 min-w-0">
        <Tooltip content={`${record.method} ${record.path}`} relationship="description">
          <Text size={200} className="truncate min-w-0 flex-1 text-fui-fg3 font-mono">
            {record.path}
          </Text>
        </Tooltip>
        {record.upstream && <ProviderBadge
          color={record.upstream.color}
          kind={record.upstream.kind}
          label={record.upstream.name}
          size="extra-small"
          title={`${record.upstream.kind} · ${record.upstream.id}`}
        />}
      </div>
      <div className="flex items-center gap-3 min-w-0 text-fui-fg3">
        <Tooltip content={t('dashboard.requests.duration', { value: record.durationMs })} relationship="description">
          <span className="inline-flex items-center gap-1 shrink-0">
            <TimerRegular aria-hidden="true" className="block flex-none" fontSize={18} /> <Text size={200}>{formatDuration(record.durationMs)}</Text>
          </span>
        </Tooltip>
        <Tooltip content={t('dashboard.requests.requestBytes', { value: record.requestBytes })} relationship="description">
          <span className="inline-flex items-center gap-1 shrink-0">
            <ArrowUploadRegular aria-hidden="true" className="block flex-none" fontSize={18} /> <Text size={200}>{formatBytes(record.requestBytes, locale)}</Text>
          </span>
        </Tooltip>
        <Tooltip content={t('dashboard.requests.responseBytes', { value: record.responseBytes })} relationship="description">
          <span className="inline-flex items-center gap-1 shrink-0">
            <ArrowDownloadRegular aria-hidden="true" className="block flex-none" fontSize={18} /> <Text size={200}>{formatBytes(record.responseBytes, locale)}</Text>
          </span>
        </Tooltip>
        {rowError
          ? <Tooltip content={rowError} relationship="label">
              <Text size={200} className={mergeClasses('ml-auto truncate', s.error)}>{rowError}</Text>
            </Tooltip>
          : <Text size={200} className="ml-auto truncate text-fui-fg3">
              {tokens === null ? '-' : `${formatCompactCount(tokens, locale)} tok`}
            </Text>}
      </div>
    </div>
  );
}

export function RequestListPanel(props: RequestListProps) {
  const { t } = useTranslation();
  const s = useStyles();
  const [listRef, setListRef] = useState<ListImperativeAPI | null>(null);
  const scrollHostRef = useRef<HTMLDivElement>(null);
  const overlayScrollbarsEnabled = useOverlayScrollbarsEnabled();
  const now = useNow(30_000);
  const selectedKey = props.apiKeys.find(key => key.id === props.selectedKeyId)!;

  const selectByIndex = useCallback((index: number) => {
    const record = props.records[index];
    if (!record) return;
    props.onRecordChange(record.id);
    listRef?.scrollToRow({ align: 'smart', index });
    window.requestAnimationFrame(() => listRef?.element?.querySelector<HTMLElement>(`[data-record-index="${index}"]`)?.focus());
  }, [listRef, props]);

  useLayoutEffect(() => {
    const host = scrollHostRef.current;
    const viewport = listRef?.element;
    if (!host || !viewport) return;
    return initializeScrollArea(host, viewport, 'vertical', true, overlayScrollbarsEnabled);
  }, [listRef, overlayScrollbarsEnabled]);

  const rowProps = useMemo<RowProps>(() => ({
    now,
    onSelect: props.onRecordChange,
    records: props.records,
    selectedId: props.selectedRecordId,
    selectByIndex,
  }), [now, props.onRecordChange, props.records, props.selectedRecordId, selectByIndex]);

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
        <div className={`${scrollAreaHostClassName} flex-1 min-h-0`} {...(overlayScrollbarsEnabled ? { 'data-overlayscrollbars-initialize': '' } : {})} ref={scrollHostRef}>
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
