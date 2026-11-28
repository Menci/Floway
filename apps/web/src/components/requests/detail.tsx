import { ArrowDownloadRegular, EyeOffRegular, EyeRegular, FlashRegular, InfoRegular, TimerRegular, WarningRegular } from '@fluentui/react-icons';
import { lazy, Suspense, useMemo, useState } from 'react';

import { contentTypeOf, renderBody } from './body-render';
import { EventList } from './events';
import { downloadRecords } from './export';
import { errorLabel, requestSeverity } from './format';
import { isSensitiveHeader, REDACTED_HEADER_VALUE, redactHeaderPairs, redactHeaderValue } from './header-redact';
import { RequestKeyLabel } from './key-label';
import { collectKindFromTargetApi, detectCollectKind, type CollectedStream } from './stream-render';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { formatDuration } from '../../lib/format-duration';
import { useLocale } from '../../lib/use-locale';
import { DialogShell } from '../ui/dialog-shell';
import { EmptyStateLine } from '../ui/empty-state';
import { Dropdown } from '../ui/fluent-form-controls';
import { HttpMethodBadge, HttpStatusBadge } from '../ui/http-badge';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { PANEL_BAND_CLASS } from '../ui/panel';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { copyOutcomeIcon, useCopyLabel, useCopyToClipboard } from '../ui/use-copy-to-clipboard';
import type { DumpRecord, DumpResponseBody } from '@floway-dev/gateway/browser';

const BodyEditor = lazy(() => import('../ui/body-editor'));
const { Button, DialogActions, DialogTitle, Option, Spinner, Text, Tooltip } = fluentComponents;

type Source = 'request' | 'upstreamRequest' | 'upstreamResponse' | 'response';

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const { copy, outcomeFor } = useCopyToClipboard();
  const copyLabel = useCopyLabel();
  return <TooltipIconButton icon={copyOutcomeIcon(outcomeFor())} label={copyLabel(outcomeFor(), t('common.copy.action'))} onClick={() => copy(text)} />;
}

function HeaderTable({ headers, revealable }: { headers: Array<[string, string]>; revealable: boolean }) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  // At a phone's width the name stands over its value: a third of the row
  // cuts names and values alike into a few characters per line.
  return <table className="w-full table-fixed font-mono text-left max-[680px]:block"><colgroup><col className="w-1/3" /><col className="w-2/3" /></colgroup><tbody className="max-[680px]:block">
    {headers.map(([name, value], index) => <tr className="max-[680px]:block max-[680px]:py-2" key={index}>
      <th className="align-top py-2 pr-2 font-normal text-fui-fg3 break-words max-[680px]:block max-[680px]:p-0">{name}</th>
      <td className="py-2 pl-2 break-all max-[680px]:block max-[680px]:p-0">
        {isSensitiveHeader(name) && !revealed.has(index) ? value === REDACTED_HEADER_VALUE ? value : redactHeaderValue(value) : value}
        {isSensitiveHeader(name) && value !== REDACTED_HEADER_VALUE && revealable && <TooltipIconButton
          icon={revealed.has(index) ? <EyeOffRegular /> : <EyeRegular />}
          label={revealed.has(index) ? t('requests.hideValue') : t('requests.revealValue')}
          onClick={() => setRevealed(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })}
        />}
      </td>
    </tr>)}
  </tbody></table>;
}

export function RequestDetailPanel({ collected, upstreamCollected, error, record, recordId, retainLastRecord }: {
  collected: CollectedStream | null;
  upstreamCollected: CollectedStream | null;
  error: string | null;
  record: DumpRecord | null;
  recordId: string | null;
  retainLastRecord: boolean;
}) {
  const [shown, setShown] = useState({ collected, upstreamCollected, error, record, recordId });
  const incoming = retainLastRecord && recordId === null ? shown : { collected, upstreamCollected, error, record, recordId };
  if (shown.record !== incoming.record || shown.error !== incoming.error || shown.recordId !== incoming.recordId) setShown(incoming);
  const { t } = useTranslation();
  if (!shown.recordId) return <EmptyStateLine className="p-4">{t('requests.selectPrompt')}</EmptyStateLine>;
  if (shown.error) return <OutcomeMessageBar className="!m-4">{shown.error}</OutcomeMessageBar>;
  if (!shown.record) return null;
  return <RecordDetail key={shown.record.meta.id} record={shown.record} collected={shown.collected} upstreamCollected={shown.upstreamCollected} />;
}

function RecordDetail({ record, collected, upstreamCollected }: { record: DumpRecord; collected: CollectedStream | null; upstreamCollected: CollectedStream | null }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [source, setSource] = useState<Source>('response');
  const [view, setView] = useState('collected');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const exchanges = record.capture?.exchanges ?? [];
  const [index, setIndex] = useState(Math.max(0, exchanges.length - 1));
  const upstream = source === 'upstreamRequest' || source === 'upstreamResponse';
  const request = source === 'request' || source === 'upstreamRequest';
  const exchange = upstream ? exchanges[index] : undefined;
  const legacy = record.response.upstream;
  const headers = useMemo(() => upstream ? (request ? exchange?.request.headers : exchange?.response?.headers ?? legacy?.headers) ?? []
    : request ? record.request.headers : record.response.headers, [exchange, legacy, record, request, upstream]);
  const status = upstream ? exchange?.response?.status ?? legacy?.status ?? null : record.response.status;
  const endpoint = upstream ? exchange?.request.url : record.request.path;
  const method = upstream ? exchange?.request.method : record.request.method;
  const raw = request ? undefined : upstream ? exchange?.response ?? undefined : record.capture?.response;
  const result = request ? null : upstream ? (!exchange || index === exchanges.length - 1 ? upstreamCollected : null) : collected;
  const kind = upstream ? collectKindFromTargetApi(record.meta.targetApi) : detectCollectKind(record.meta.path);
  const body = useMemo<DumpResponseBody>(() => upstream
    ? request ? exchange ? { type: 'bytes', body: exchange.request.body } : { type: 'none' }
      : (!exchange || index === exchanges.length - 1) && legacy ? legacy.body : raw ? { type: 'bytes', body: raw.body } : { type: 'none' }
    : request ? { type: 'bytes', body: record.request.body } : record.response.body, [upstream, request, exchange, index, exchanges.length, legacy, raw, record]);
  const displayed = useMemo(() => {
    if (view === 'raw' && raw) return { text: raw.body.data, isJson: false, decodeError: null };
    if (body.type === 'bytes') return renderBody(body.body, contentTypeOf(headers));
    return { text: result?.result == null ? '' : JSON.stringify(result.result, null, 2), isJson: true, decodeError: null };
  }, [body, headers, raw, result, view]);
  const diagnostics = [...new Set([
    errorLabel(record.meta.error), exchange?.error, raw?.error, result?.error,
    raw && !raw.complete ? t('requests.partialCapture') : null,
    result?.truncated && !result.error ? t('requests.truncatedStream') : null,
    displayed.decodeError ? t('requests.decodeError', { error: displayed.decodeError }) : null,
  ].filter((value): value is string => Boolean(value)))];
  const labels: Record<Source, string> = {
    request: t('requests.clientRequest'), upstreamRequest: t('requests.upstreamRequest'),
    upstreamResponse: t('requests.upstreamResponse'), response: t('requests.clientResponse'),
  };
  const viewLabels: Record<string, string> = {
    collected: t(body.type === 'stream' ? 'requests.collected' : 'requests.formattedBody'), events: t('requests.events', { count: body.type === 'stream' ? body.events.length : 0 }),
    raw: raw?.body.encoding === 'base64' ? t('requests.base64') : t('requests.raw'),
  };
  const chooseSource = (value: string | undefined) => {
    if (value === undefined) return;
    setSource(value as Source);
    setView('collected');
  };
  const toolbar = <div className="flex items-center gap-2 min-w-0">
    {upstream && exchanges.length > 1 && <Dropdown size="small" aria-label={t('requests.upstreamCall')} selectedOptions={[String(index)]} value={`${index + 1} / ${exchanges.length}`} onOptionSelect={(_, data) => { setIndex(Number(data.optionValue)); setView('collected'); }}>
      {exchanges.map((item, i) => <Option key={i} value={String(i)} text={String(i + 1)}>{t('requests.callNumber', { number: String(i + 1), count: String(exchanges.length) })}. {item.request.method} {item.response?.status ?? '—'}</Option>)}
    </Dropdown>}
    {(body.type === 'stream' || raw) ? <Dropdown size="small" aria-label={t('requests.streamView')} selectedOptions={[view]} value={viewLabels[view]} onOptionSelect={(_, data) => { if (data.optionValue) setView(data.optionValue); }}>
      <Option value="collected">{viewLabels.collected}</Option>
      {body.type === 'stream' && <Option value="events">{viewLabels.events}</Option>}
      {raw && <Option value="raw">{viewLabels.raw}</Option>}
    </Dropdown> : <Text size={200} className="text-fui-fg3">{t(request ? 'requests.requestBody' : 'requests.responseBody')}</Text>}
  </div>;
  return <div className="h-full min-h-0 flex flex-col">
    {/* Wraps instead of squeezing: the source picker asks for its label's room
        before the badges and readings beside it are laid out, and whatever no
        longer fits moves to a second line. */}
    <div className={`${PANEL_BAND_CLASS} flex flex-wrap items-center gap-2 min-w-0 shrink-0 border-b border-[var(--winui-divider-stroke-default)]`}>
      <Dropdown size="small" className="grow basis-40" aria-label={t('requests.detailTitle')} selectedOptions={[source]} value={labels[source]} onOptionSelect={(_, data) => chooseSource(data.optionValue)}>
        {Object.entries(labels).map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}
      </Dropdown>
      <HttpStatusBadge severity={requestSeverity(status, record.meta.error)}>{status ?? t('requests.noStatus')}</HttpStatusBadge>
      <Tooltip content={t('requests.duration', { value: formatDuration(record.meta.durationMs, locale) })} relationship="description">
        <span className="inline-flex items-center gap-1 shrink-0 text-fui-fg3">
          <TimerRegular aria-hidden="true" className="block flex-none" fontSize={16} /> <Text size={200} className="tabular-nums">{formatDuration(record.meta.durationMs, locale)}</Text>
        </span>
      </Tooltip>
      {record.meta.ttftMs != null && (
        <Tooltip content={t('requests.ttft', { value: formatDuration(record.meta.ttftMs, locale) })} relationship="description">
          <span className="inline-flex items-center gap-1 shrink-0 text-fui-fg3">
            <FlashRegular aria-hidden="true" className="block flex-none" fontSize={16} /> <Text size={200} className="tabular-nums">{formatDuration(record.meta.ttftMs, locale)}</Text>
          </span>
        </Tooltip>
      )}
      {/* Spelled out with its suffix: on a phone the details cover the list,
          whose row was the only other place naming the key. */}
      <RequestKeyLabel apiKey={record.meta.key} className="min-w-0" withSuffix />
      <Button size="small" appearance="subtle" icon={diagnostics.length ? <WarningRegular /> : <InfoRegular />} onClick={() => setDetailsOpen(true)}>
        {diagnostics.length ? t('requests.diagnostics', { count: String(diagnostics.length) }) : t('requests.metadata')}
      </Button>
      <TooltipIconButton icon={<ArrowDownloadRegular />} label={t('requests.exportRecord')} onClick={() => downloadRecords([record])} />
    </div>
    <div className="flex-1 min-h-0">
      {view === 'events' && body.type === 'stream'
        ? <EventList key={`${source}-${index}`} events={body.events} kind={kind} toolbarStart={toolbar} />
        : <Suspense fallback={<Spinner />}><BodyEditor
            text={displayed.text} json={displayed.isJson} label={labels[source]}
            emptyText={upstream && !exchange && !legacy ? t('requests.noUpstreamCapture') : t('requests.emptyBody')}
            toolbarStart={toolbar}
          /></Suspense>}
    </div>
    <DialogShell width="editor" open={detailsOpen} onOpenChange={(_, data) => setDetailsOpen(data.open)} title={<DialogTitle>{labels[source]}</DialogTitle>} actions={<DialogActions><Button onClick={() => setDetailsOpen(false)}>{t('common.dismiss')}</Button></DialogActions>}>
      <div className="flex items-center gap-2"><HttpMethodBadge method={method ?? record.request.method} /><Text className="font-mono break-all">{endpoint ?? record.request.path}</Text><CopyButton text={endpoint ?? record.request.path} /></div>
      {diagnostics.map((message, i) => <OutcomeMessageBar key={i} intent="warning">{message}</OutcomeMessageBar>)}
      {upstream && !exchange && !legacy && <EmptyStateLine>{t('requests.noUpstreamCapture')}</EmptyStateLine>}
      <div className="flex items-center justify-between gap-2"><Text weight="semibold">{t('requests.headers', { count: String(headers.length) })}</Text><CopyButton text={redactHeaderPairs(headers).map(([name, value]) => `${name}: ${value}`).join('\n')} /></div>
      <HeaderTable key={`${source}-${index}`} headers={headers} revealable={!upstream} />
    </DialogShell>
  </div>;
}
