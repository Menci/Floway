import { EyeOffRegular, EyeRegular } from '@fluentui/react-icons';
import { lazy, Suspense, useMemo, useState } from 'react';

import { contentTypeOf, renderBody } from './body-render';
import { downloadRecords } from './export';
import { errorLabel, requestSeverity } from './format';
import { isSensitiveHeader, redactHeaderValue } from './header-redact';
import { collectKindFromTargetApi, detectCollectKind, renderStreamEvents, type CollectedStream, type CollectKind } from './stream-render';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { EmptyStateLine } from '../ui/empty-state';
import { Dropdown } from '../ui/fluent-form-controls';
import { HttpMethodBadge, HttpStatusBadge } from '../ui/http-badge';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { PANEL_BAND_CLASS } from '../ui/panel';
import { ScrollArea } from '../ui/scroll-area';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { copyOutcomeIcon, useCopyLabel, useCopyToClipboard } from '../ui/use-copy-to-clipboard';
import type { DumpCapture, DumpRecord, DumpResponseBody } from '@floway-dev/gateway/dump-types';

const BodyEditor = lazy(() => import('../ui/body-editor'));
const { Button, Option, Spinner, Tab, TabList, Text } = fluentComponents;

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const { copy, outcomeFor } = useCopyToClipboard();
  const copyLabel = useCopyLabel();
  return <TooltipIconButton icon={copyOutcomeIcon(outcomeFor())} label={copyLabel(outcomeFor(), t('common.copy.action'))} onClick={() => copy(text)} />;
}

function HeadersView({ headers }: { headers: Array<[string, string]> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  return <>
    <div className={`${PANEL_BAND_CLASS} flex items-center gap-2`}>
      <Button size="small" aria-expanded={open} onClick={() => setOpen(!open)}>{t('dashboard.requests.headers', { count: String(headers.length) })}</Button>
      {open && <CopyButton text={headers.map(([name, value]) => `${name}: ${value}`).join('\n')} />}
    </div>
    {open && <ScrollArea axes="both" className="max-h-[25vh] shrink-0">
      <table className="w-full font-mono text-left"><tbody>
        {headers.map(([name, value], index) => <tr key={index}>
          <th className="align-top py-2 pl-[var(--floway-panel-inset)] pr-2 font-normal text-fui-fg3">{name}</th>
          <td className="py-2 pl-2 pr-[var(--floway-panel-inset)] break-all">
            {isSensitiveHeader(name) && !revealed.has(index) ? redactHeaderValue(value) : value}
            {isSensitiveHeader(name) && <TooltipIconButton
              icon={revealed.has(index) ? <EyeOffRegular /> : <EyeRegular />}
              label={revealed.has(index) ? t('dashboard.requests.hideValue') : t('dashboard.requests.revealValue')}
              onClick={() => setRevealed(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })}
            />}
          </td>
        </tr>)}
      </tbody></table>
    </ScrollArea>}
  </>;
}

function BodyPane({ body, headers, collected, kind, raw }: {
  body: DumpResponseBody;
  headers: Array<[string, string]>;
  collected?: CollectedStream | null;
  kind?: CollectKind | null;
  raw?: NonNullable<DumpCapture['response']>;
}) {
  const { t } = useTranslation();
  const [selectedView, setView] = useState('collected');
  const displayed = useMemo(() => {
    if (selectedView === 'raw' && raw) return { text: raw.body.data, isJson: false, decodeError: null };
    if (body.type === 'bytes') return renderBody(body.body, contentTypeOf(headers));
    if (body.type === 'stream' && selectedView === 'events') {
      const text = renderStreamEvents(kind ?? null, body.events).map((event, index) =>
        `# ${index + 1} +${event.timestamp}ms ${event.event ?? ''}\n${event.text}`).join('\n\n');
      return { text, isJson: false, decodeError: null };
    }
    return { text: collected?.result == null ? '' : JSON.stringify(collected.result, null, 2), isJson: true, decodeError: null };
  }, [body, collected, headers, kind, raw, selectedView]);
  return <div className="flex-1 min-h-0 flex flex-col">
    <HeadersView headers={headers} />
    <div className={`${PANEL_BAND_CLASS} flex flex-wrap items-center gap-2`}>
      {(body.type === 'stream' || raw) && <TabList aria-label={t('dashboard.requests.streamView')} selectedValue={selectedView} onTabSelect={(_, data) => setView(String(data.value))} size="small">
        <Tab value="collected">{t('dashboard.requests.collected')}</Tab>
        {body.type === 'stream' && <Tab value="events">{t('dashboard.requests.events', { count: body.events.length })}</Tab>}
        {raw && <Tab value="raw">{t('dashboard.requests.raw')}</Tab>}
      </TabList>}
      {selectedView === 'raw' && raw && <Text size={200}>{raw.body.encoding === 'base64' ? t('dashboard.requests.base64') : t('dashboard.requests.raw')}</Text>}
      <span className="ml-auto"><CopyButton text={displayed.text} /></span>
    </div>
    <ScrollArea axes="vertical" className="max-h-[25vh] shrink-0">
      {raw && !raw.complete && <OutcomeMessageBar intent="warning">{t('dashboard.requests.partialCapture')}</OutcomeMessageBar>}
      {raw?.error && <OutcomeMessageBar>{raw.error}</OutcomeMessageBar>}
      {selectedView === 'collected' && collected?.error && <OutcomeMessageBar>{collected.error}</OutcomeMessageBar>}
      {selectedView === 'collected' && collected?.truncated && !collected.error && <OutcomeMessageBar intent="warning">{t('dashboard.requests.truncatedStream')}</OutcomeMessageBar>}
      {displayed.decodeError && <OutcomeMessageBar intent="warning">{t('dashboard.requests.decodeError', { error: displayed.decodeError })}</OutcomeMessageBar>}
    </ScrollArea>
    <div className="flex-1 min-h-0">
      {displayed.text ? <Suspense fallback={<Spinner />}><BodyEditor text={displayed.text} json={displayed.isJson} label={t('dashboard.requests.responseBody')} /></Suspense>
        : <EmptyStateLine className="p-4">{t('dashboard.requests.emptyBody')}</EmptyStateLine>}
    </div>
  </div>;
}

function UpstreamPane({ record, collected }: { record: DumpRecord; collected: CollectedStream | null }) {
  const { t } = useTranslation();
  const exchanges = record.capture?.exchanges ?? [];
  const [index, setIndex] = useState(Math.max(0, exchanges.length - 1));
  const [side, setSide] = useState('response');
  const exchange = exchanges[index];
  const legacy = record.response.upstream;
  if (!exchange) return legacy
    ? <BodyPane body={legacy.body} headers={legacy.headers} collected={collected} kind={collectKindFromTargetApi(record.meta.targetApi)} />
    : <EmptyStateLine className="p-4">{t('dashboard.requests.noUpstreamCapture')}</EmptyStateLine>;
  const response = exchange.response;
  const body: DumpResponseBody = side === 'request' ? { type: 'bytes', body: exchange.request.body }
    : index === exchanges.length - 1 && legacy ? legacy.body
      : response ? { type: 'bytes', body: response.body } : { type: 'none' };
  return <>
    <div className={`${PANEL_BAND_CLASS} flex flex-wrap items-center gap-2`}>
      <Dropdown aria-label={t('dashboard.requests.upstreamCall')} selectedOptions={[String(index)]} value={t('dashboard.requests.callNumber', { number: String(index + 1), count: String(exchanges.length) })} onOptionSelect={(_, data) => setIndex(Number(data.optionValue))}>
        {exchanges.map((item, i) => <Option key={i} value={String(i)} text={String(i + 1)}>{i + 1}. {item.request.method} {item.response?.status ?? '—'}</Option>)}
      </Dropdown>
      <TabList aria-label={t('dashboard.requests.upstreamCall')} selectedValue={side} onTabSelect={(_, data) => setSide(String(data.value))} size="small">
        <Tab value="request">{t('dashboard.requests.request')}</Tab><Tab value="response">{t('dashboard.requests.response')}</Tab>
      </TabList>
      {response && <HttpStatusBadge severity={requestSeverity(response.status, null)}>{response.status}</HttpStatusBadge>}
    </div>
    <Text className={`${PANEL_BAND_CLASS} break-all font-mono`} size={200}>{exchange.request.method} {exchange.request.url}</Text>
    {exchange.error && <OutcomeMessageBar>{exchange.error}</OutcomeMessageBar>}
    <BodyPane key={`${index}-${side}`} body={body} headers={side === 'request' ? exchange.request.headers : response?.headers ?? []} raw={side === 'response' ? response ?? undefined : undefined} collected={collected} kind={collectKindFromTargetApi(record.meta.targetApi)} />
  </>;
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
  if (!shown.recordId) return <EmptyStateLine className="p-4">{t('dashboard.requests.selectPrompt')}</EmptyStateLine>;
  if (shown.error) return <OutcomeMessageBar className="!m-4">{shown.error}</OutcomeMessageBar>;
  if (!shown.record) return null;
  return <RecordDetail key={shown.record.meta.id} record={shown.record} collected={shown.collected} upstreamCollected={shown.upstreamCollected} />;
}

function RecordDetail({ record, collected, upstreamCollected }: { record: DumpRecord; collected: CollectedStream | null; upstreamCollected: CollectedStream | null }) {
  const { t } = useTranslation();
  const [section, setSection] = useState('response');
  const responseError = errorLabel(record.meta.error);
  return <div className="h-full min-h-0 flex flex-col">
    <div className={`${PANEL_BAND_CLASS} flex flex-wrap items-center gap-2`}>
      <HttpMethodBadge method={record.request.method} />
      <HttpStatusBadge severity={requestSeverity(record.response.status, record.meta.error)}>{record.response.status ?? t('dashboard.requests.noStatus')}</HttpStatusBadge>
      <Text className="break-all font-mono" size={200}>{record.request.path}</Text>
      <Button size="small" className="!ml-auto" onClick={() => downloadRecords([record])}>{t('dashboard.requests.exportRecord')}</Button>
    </div>
    {responseError && <OutcomeMessageBar>{responseError}</OutcomeMessageBar>}
    <TabList className="px-[var(--floway-panel-inset)]" aria-label={t('dashboard.requests.detailTitle')} selectedValue={section} onTabSelect={(_, data) => setSection(String(data.value))}>
      <Tab value="request">{t('dashboard.requests.clientRequest')}</Tab>
      <Tab value="upstream">{t('dashboard.requests.upstreamCall')}</Tab>
      <Tab value="response">{t('dashboard.requests.clientResponse')}</Tab>
    </TabList>
    {section === 'request' && <BodyPane key="request" body={{ type: 'bytes', body: record.request.body }} headers={record.request.headers} />}
    {section === 'upstream' && <UpstreamPane record={record} collected={upstreamCollected} />}
    {section === 'response' && <BodyPane key="response" body={record.response.body} headers={record.response.headers} collected={collected} kind={detectCollectKind(record.meta.path)} raw={record.capture?.response} />}
  </div>;
}
