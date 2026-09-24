import { ArrowDownloadRegular, EyeOffRegular, EyeRegular, InfoRegular, WarningRegular } from '@fluentui/react-icons';
import { lazy, Suspense, useMemo, useState } from 'react';

import { contentTypeOf, renderBody } from './body-render';
import { EventList } from './events';
import { downloadRecords } from './export';
import { errorLabel, requestSeverity } from './format';
import { isSensitiveHeader, redactHeaderValue } from './header-redact';
import { collectKindFromTargetApi, detectCollectKind, type CollectedStream } from './stream-render';
import { type ExchangeStream } from './upstream-stream';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { DialogShell } from '../ui/dialog-shell';
import { EmptyStateLine } from '../ui/empty-state';
import { Dropdown } from '../ui/fluent-form-controls';
import { HttpMethodBadge, HttpStatusBadge } from '../ui/http-badge';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { PANEL_BAND_CLASS } from '../ui/panel';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { copyOutcomeIcon, useCopyLabel, useCopyToClipboard } from '../ui/use-copy-to-clipboard';
import type { DumpRecord, DumpResponseBody } from '@floway-dev/gateway/dump-types';

const BodyEditor = lazy(() => import('../ui/body-editor'));
const { Button, DialogActions, DialogTitle, Option, Spinner, Text } = fluentComponents;

type Source = 'request' | 'upstreamRequest' | 'upstreamResponse' | 'response';

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const { copy, outcomeFor } = useCopyToClipboard();
  const copyLabel = useCopyLabel();
  return <TooltipIconButton icon={copyOutcomeIcon(outcomeFor())} label={copyLabel(outcomeFor(), t('common.copy.action'))} onClick={() => copy(text)} />;
}

function HeaderTable({ headers }: { headers: Array<[string, string]> }) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  return <table className="w-full table-fixed font-mono text-left"><colgroup><col className="w-1/3" /><col className="w-2/3" /></colgroup><tbody>
    {headers.map(([name, value], index) => <tr key={index}>
      <th className="align-top py-2 pr-2 font-normal text-fui-fg3 break-words">{name}</th>
      <td className="py-2 pl-2 break-all">
        {isSensitiveHeader(name) && !revealed.has(index) ? redactHeaderValue(value) : value}
        {isSensitiveHeader(name) && <TooltipIconButton
          icon={revealed.has(index) ? <EyeOffRegular /> : <EyeRegular />}
          label={revealed.has(index) ? t('dashboard.requests.hideValue') : t('dashboard.requests.revealValue')}
          onClick={() => setRevealed(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })}
        />}
      </td>
    </tr>)}
  </tbody></table>;
}

export function RequestDetailPanel({ collected, upstreamCollected, exchangeStreams, error, record, recordId, retainLastRecord }: {
  collected: CollectedStream | null;
  upstreamCollected: CollectedStream | null;
  exchangeStreams: ExchangeStream[];
  error: string | null;
  record: DumpRecord | null;
  recordId: string | null;
  retainLastRecord: boolean;
}) {
  const [shown, setShown] = useState({ collected, upstreamCollected, exchangeStreams, error, record, recordId });
  const incoming = retainLastRecord && recordId === null ? shown : { collected, upstreamCollected, exchangeStreams, error, record, recordId };
  if (shown.record !== incoming.record || shown.error !== incoming.error || shown.recordId !== incoming.recordId) setShown(incoming);
  const { t } = useTranslation();
  if (!shown.recordId) return <EmptyStateLine className="p-4">{t('dashboard.requests.selectPrompt')}</EmptyStateLine>;
  if (shown.error) return <OutcomeMessageBar className="!m-4">{shown.error}</OutcomeMessageBar>;
  if (!shown.record) return null;
  return <RecordDetail key={shown.record.meta.id} record={shown.record} collected={shown.collected} upstreamCollected={shown.upstreamCollected} exchangeStreams={shown.exchangeStreams} />;
}

function RecordDetail({ record, collected, upstreamCollected, exchangeStreams }: { record: DumpRecord; collected: CollectedStream | null; upstreamCollected: CollectedStream | null; exchangeStreams: ExchangeStream[] }) {
  const { t } = useTranslation();
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
  const exchangeStream = upstream && exchange ? exchangeStreams[index] ?? null : null;
  const legacyBodyUsed = !request && (!exchange || index === exchanges.length - 1) && Boolean(legacy);
  const result = request ? null : upstream ? (legacyBodyUsed ? upstreamCollected : exchangeStream?.collected ?? null) : collected;
  const kind = upstream
    ? legacyBodyUsed ? collectKindFromTargetApi(record.meta.targetApi)
      : exchangeStream?.events ? detectCollectKind(new URL(exchange!.request.url).pathname) : null
    : detectCollectKind(record.meta.path);
  const body = useMemo<DumpResponseBody>(() => upstream
    ? request ? exchange ? { type: 'bytes', body: exchange.request.body } : { type: 'none' }
      : legacyBodyUsed && legacy ? legacy.body
        : exchangeStream?.events ? { type: 'stream', events: exchangeStream.events }
          : raw ? { type: 'bytes', body: raw.body } : { type: 'none' }
    : request ? { type: 'bytes', body: record.request.body } : record.response.body, [upstream, request, exchange, legacyBodyUsed, legacy, exchangeStream, raw, record]);
  const displayed = useMemo(() => {
    if (view === 'raw' && raw) return { text: raw.body.data, isJson: false, decodeError: null };
    if (body.type === 'bytes') return renderBody(body.body, contentTypeOf(headers));
    return { text: result?.result == null ? '' : JSON.stringify(result.result, null, 2), isJson: true, decodeError: null };
  }, [body, headers, raw, result, view]);
  const diagnostics = [...new Set([
    errorLabel(record.meta.error), exchange?.error, raw?.error, result?.error, exchangeStream?.error,
    raw && !raw.complete ? t('dashboard.requests.partialCapture') : null,
    result?.truncated && !result.error ? t('dashboard.requests.truncatedStream') : null,
    displayed.decodeError ? t('dashboard.requests.decodeError', { error: displayed.decodeError }) : null,
  ].filter((value): value is string => Boolean(value)))];
  const labels: Record<Source, string> = {
    request: t('dashboard.requests.clientRequest'), upstreamRequest: t('dashboard.requests.upstreamRequest'),
    upstreamResponse: t('dashboard.requests.upstreamResponse'), response: t('dashboard.requests.clientResponse'),
  };
  const viewLabels: Record<string, string> = {
    collected: t(body.type === 'stream' ? 'dashboard.requests.collected' : 'dashboard.requests.formattedBody'), events: t('dashboard.requests.events', { count: body.type === 'stream' ? body.events.length : 0 }),
    raw: raw?.body.encoding === 'base64' ? t('dashboard.requests.base64') : t('dashboard.requests.raw'),
  };
  const chooseSource = (value: string | undefined) => {
    if (value === undefined) return;
    setSource(value as Source);
    setView('collected');
  };
  const toolbar = <div className="flex items-center gap-2 min-w-0">
    {upstream && exchanges.length > 1 && <Dropdown size="small" aria-label={t('dashboard.requests.upstreamCall')} selectedOptions={[String(index)]} value={`${index + 1} / ${exchanges.length}`} onOptionSelect={(_, data) => { setIndex(Number(data.optionValue)); setView('collected'); }}>
      {exchanges.map((item, i) => <Option key={i} value={String(i)} text={String(i + 1)}>{t('dashboard.requests.callNumber', { number: String(i + 1), count: String(exchanges.length) })}. {item.request.method} {item.response?.status ?? '—'}</Option>)}
    </Dropdown>}
    {(body.type === 'stream' || raw) ? <Dropdown size="small" aria-label={t('dashboard.requests.streamView')} selectedOptions={[view]} value={viewLabels[view]} onOptionSelect={(_, data) => { if (data.optionValue) setView(data.optionValue); }}>
      <Option value="collected">{viewLabels.collected}</Option>
      {body.type === 'stream' && <Option value="events">{viewLabels.events}</Option>}
      {raw && <Option value="raw">{viewLabels.raw}</Option>}
    </Dropdown> : <Text size={200} className="text-fui-fg3">{t(request ? 'dashboard.requests.requestBody' : 'dashboard.requests.responseBody')}</Text>}
  </div>;
  return <div className="h-full min-h-0 flex flex-col">
    <div className={`${PANEL_BAND_CLASS} flex items-center gap-2 min-w-0 shrink-0 border-b border-[var(--winui-divider-stroke-default)]`}>
      <Dropdown size="small" className="flex-1" aria-label={t('dashboard.requests.detailTitle')} selectedOptions={[source]} value={labels[source]} onOptionSelect={(_, data) => chooseSource(data.optionValue)}>
        {Object.entries(labels).map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}
      </Dropdown>
      <HttpStatusBadge severity={requestSeverity(status, record.meta.error)}>{status ?? t('dashboard.requests.noStatus')}</HttpStatusBadge>
      <Button size="small" appearance="subtle" icon={diagnostics.length ? <WarningRegular /> : <InfoRegular />} onClick={() => setDetailsOpen(true)}>
        {diagnostics.length ? t('dashboard.requests.diagnostics', { count: String(diagnostics.length) }) : t('dashboard.requests.metadata')}
      </Button>
      <TooltipIconButton icon={<ArrowDownloadRegular />} label={t('dashboard.requests.exportRecord')} onClick={() => downloadRecords([record])} />
    </div>
    <div className="flex-1 min-h-0">
      {view === 'events' && body.type === 'stream'
        ? <EventList key={`${source}-${index}`} events={body.events} kind={kind} toolbarStart={toolbar} />
        : <Suspense fallback={<Spinner />}><BodyEditor
            text={displayed.text} json={displayed.isJson} label={labels[source]}
            emptyText={upstream && !exchange && !legacy ? t('dashboard.requests.noUpstreamCapture') : t('dashboard.requests.emptyBody')}
            toolbarStart={toolbar}
          /></Suspense>}
    </div>
    <DialogShell width="editor" open={detailsOpen} onOpenChange={(_, data) => setDetailsOpen(data.open)} title={<DialogTitle>{labels[source]}</DialogTitle>} actions={<DialogActions><Button onClick={() => setDetailsOpen(false)}>{t('common.dismiss')}</Button></DialogActions>}>
      <div className="flex items-center gap-2"><HttpMethodBadge method={method ?? record.request.method} /><Text className="font-mono break-all">{endpoint ?? record.request.path}</Text><CopyButton text={endpoint ?? record.request.path} /></div>
      {diagnostics.map((message, i) => <OutcomeMessageBar key={i} intent="warning">{message}</OutcomeMessageBar>)}
      {upstream && !exchange && !legacy && <EmptyStateLine>{t('dashboard.requests.noUpstreamCapture')}</EmptyStateLine>}
      <div className="flex items-center justify-between gap-2"><Text weight="semibold">{t('dashboard.requests.headers', { count: String(headers.length) })}</Text><CopyButton text={headers.map(([name, value]) => `${name}: ${value}`).join('\n')} /></div>
      <HeaderTable key={`${source}-${index}`} headers={headers} />
    </DialogShell>
  </div>;
}
