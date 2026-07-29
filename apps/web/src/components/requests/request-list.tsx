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

import {
  errorLabel,
  formatBytes,
  formatDuration,
  formatFullTime,
  formatRelativeTime,
  formatTokens,
  requestSeverity,
  totalTokens,
} from './format';
import type { ApiKey } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useNow } from '../../lib/use-now';
import { Select } from '../ui/fluent-form-controls';
import { initializeScrollArea, scrollAreaHostClassName, useOverlayScrollbarsEnabled } from '../ui/scroll-area';
import { ProviderBadge } from '../upstreams/provider-badge';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';

const { Field, MessageBar, MessageBarBody, Text, makeStyles, mergeClasses } = fluentComponents;
const ROW_HEIGHT = 84;

const useStyles = makeStyles({
  list: { outlineStyle: 'none' },
  row: {
    backgroundColor: 'transparent',
    borderBottom: '1px solid var(--colorNeutralStroke2)',
    cursor: 'pointer',
    outlineStyle: 'none',
    padding: '6px 10px',
    ':focus-visible': { boxShadow: 'inset 0 0 0 2px var(--colorCompoundBrandStroke)' },
  },
  selected: {
    backgroundColor: 'var(--colorBrandBackgroundInvertedHover)',
    boxShadow: 'inset 3px 0 0 var(--colorBrandStroke1)',
    '@media (prefers-color-scheme: dark)': {
      backgroundColor: 'var(--colorBrandBackground2)',
    },
  },
  success: { color: 'var(--colorPaletteGreenForeground1)' },
  warning: { color: 'var(--colorPaletteDarkOrangeForeground1)' },
  error: { color: 'var(--colorPaletteRedForeground1)' },
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
        <StatusIcon aria-hidden="true" className={s[severity]} />
        <span className="sr-only">{t(`dashboard.requests.status.${severity}`)}</span>
        <Text size={300} className="truncate min-w-0 font-mono">
          {record.model ?? t('dashboard.requests.unknownModel')}
        </Text>
        <Text size={200} className="ml-auto shrink-0 text-fui-fg3" title={formatFullTime(record.startedAt)}>
          {formatRelativeTime(record.startedAt, now)}
        </Text>
      </div>
      <div className="mt-1 flex items-start gap-2 min-w-0">
        <Text size={200} className="truncate min-w-0 flex-1 text-fui-fg3 font-mono" title={`${record.method} ${record.path}`}>
          {record.path}
        </Text>
        {record.upstream && <ProviderBadge
          color={record.upstream.color}
          kind={record.upstream.kind}
          label={record.upstream.name}
          size="extra-small"
          title={`${record.upstream.kind} · ${record.upstream.id}`}
        />}
      </div>
      <div className="mt-1 flex items-center gap-3 min-w-0 text-fui-fg3">
        <span className="inline-flex items-center gap-1 shrink-0" title={t('dashboard.requests.duration', { value: record.durationMs })}>
          <TimerRegular aria-hidden="true" /> <Text size={200}>{formatDuration(record.durationMs)}</Text>
        </span>
        <span className="inline-flex items-center gap-1 shrink-0" title={t('dashboard.requests.requestBytes', { value: record.requestBytes })}>
          <ArrowUploadRegular aria-hidden="true" /> <Text size={200}>{formatBytes(record.requestBytes)}</Text>
        </span>
        <span className="inline-flex items-center gap-1 shrink-0" title={t('dashboard.requests.responseBytes', { value: record.responseBytes })}>
          <ArrowDownloadRegular aria-hidden="true" /> <Text size={200}>{formatBytes(record.responseBytes)}</Text>
        </span>
        <Text size={200} className={mergeClasses('ml-auto truncate', rowError ? s.error : 'text-fui-fg3')} title={rowError ?? undefined}>
          {rowError ?? (tokens === null ? '-' : `${formatTokens(tokens)} tok`)}
        </Text>
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
      <div className="py-3">
        <Field label={t('dashboard.requests.apiKey')}>
          <Select value={props.selectedKeyId} onChange={event => props.onKeyChange(event.target.value)}>
            {props.apiKeys.map(key => <option key={key.id} value={key.id}>{key.name} ({key.key.slice(-4)})</option>)}
          </Select>
        </Field>
      </div>
      {props.error && <MessageBar intent="error" className="!m-2"><MessageBarBody>{props.error}</MessageBarBody></MessageBar>}
      {props.records.length === 0 ? (
        <div className="flex-1 grid place-items-center text-center p-6">
          <Text size={200} className="text-fui-fg3">{t('dashboard.requests.empty')}</Text>
        </div>
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
