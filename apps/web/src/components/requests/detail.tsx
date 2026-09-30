import { ArrowDownloadRegular, FlashRegular, TimerRegular } from '@fluentui/react-icons';
import { lazy, Suspense, useMemo, useState } from 'react';

import { RenderedEventList } from './events';
import { downloadRecords } from './export';
import { errorLabel, requestSeverity } from './format';
import { renderRunEvents } from './run-render';
import type { CollectedStream } from './stream-render';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { formatDuration } from '../../lib/format-duration';
import { EmptyStateLine } from '../ui/empty-state';
import { Dropdown } from '../ui/fluent-form-controls';
import { HttpStatusBadge } from '../ui/http-badge';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { PANEL_BAND_CLASS } from '../ui/panel';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import type { DumpMetadata, DumpRecord } from '@floway-dev/gateway/dump-types';

const BodyEditor = lazy(() => import('../ui/body-editor'));
const { Option, Spinner, Text, Tooltip } = fluentComponents;

export function RequestDetailPanel({ collected, error, record, recordId, retainLastRecord }: {
  collected: CollectedStream | null;
  error: string | null;
  record: DumpRecord | null;
  recordId: string | null;
  retainLastRecord: boolean;
}) {
  const [shown, setShown] = useState({ collected, error, record, recordId });
  const incoming = retainLastRecord && recordId === null ? shown : { collected, error, record, recordId };
  if (shown.record !== incoming.record || shown.error !== incoming.error || shown.recordId !== incoming.recordId) setShown(incoming);
  const { t } = useTranslation();
  if (!shown.recordId) return <EmptyStateLine className="p-4">{t('dashboard.requests.selectPrompt')}</EmptyStateLine>;
  if (shown.error) return <OutcomeMessageBar className="!m-4">{shown.error}</OutcomeMessageBar>;
  if (!shown.record) return null;
  return <RunRecordDetail key={shown.record.meta.id} record={shown.record} collected={shown.collected} />;
}

function RecordTiming({ meta }: { meta: DumpMetadata }) {
  const { t } = useTranslation();
  return <>
    <Tooltip content={t('dashboard.requests.duration', { value: meta.durationMs })} relationship="description">
      <span className="inline-flex items-center gap-1 shrink-0 text-fui-fg3">
        <TimerRegular aria-hidden="true" className="block flex-none" fontSize={16} /> <Text size={200}>{formatDuration(meta.durationMs)}</Text>
      </span>
    </Tooltip>
    {meta.ttftMs != null && (
      <Tooltip content={t('dashboard.requests.ttft', { value: meta.ttftMs })} relationship="description">
        <span className="inline-flex items-center gap-1 shrink-0 text-fui-fg3">
          <FlashRegular aria-hidden="true" className="block flex-none" fontSize={16} /> <Text size={200}>{formatDuration(meta.ttftMs)}</Text>
        </span>
      </Tooltip>
    )}
  </>;
}

function RunRecordDetail({ record, collected }: { record: DumpRecord; collected: CollectedStream | null }) {
  const { t } = useTranslation();
  const events = useMemo(() => renderRunEvents(record.events).map(event => ({
    event: `${event.type} ${event.subject ?? ''}`.trim(), text: event.text, parseError: event.parseError,
  })), [record.events]);
  const failure = errorLabel(record.meta.error) ?? collected?.error;
  const [view, setView] = useState('run');
  return <div className="h-full min-h-0 flex flex-col">
    <div className={`${PANEL_BAND_CLASS} flex items-center gap-2 min-w-0 shrink-0 border-b border-[var(--winui-divider-stroke-default)]`}>
      <Dropdown className="flex-1" size="small" aria-label={t('dashboard.requests.streamView')} value={view === 'run' ? t('dashboard.requests.run') : t('dashboard.requests.collected')} selectedOptions={[view]} onOptionSelect={(_, data) => { if (data.optionValue) setView(data.optionValue); }}>
        <Option value="run">{t('dashboard.requests.run')}</Option>
        {collected?.result != null && <Option value="collected">{t('dashboard.requests.collected')}</Option>}
      </Dropdown>
      <HttpStatusBadge severity={requestSeverity(record.meta.status, record.meta.error)}>{record.meta.status ?? t('dashboard.requests.noStatus')}</HttpStatusBadge>
      <RecordTiming meta={record.meta} />
      <TooltipIconButton icon={<ArrowDownloadRegular />} label={t('dashboard.requests.exportRecord')} onClick={() => downloadRecords([record])} />
    </div>
    {failure && <OutcomeMessageBar>{failure}</OutcomeMessageBar>}
    <div className="flex-1 min-h-0">
      {view === 'run' ? <RenderedEventList events={events} copyText={record.events} toolbarStart={<Text>{t('dashboard.requests.events', { count: events.length })}</Text>} emptyText={t('dashboard.requests.noRunEvents')} />
        : <Suspense fallback={<Spinner />}><BodyEditor text={JSON.stringify(collected!.result, null, 2)} json label={t('dashboard.requests.collected')} /></Suspense>}
    </div>
  </div>;
}
