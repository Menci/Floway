import { EyeOffRegular, EyeRegular, InfoRegular, WarningRegular } from '@fluentui/react-icons';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { EMPTY_BODY, renderWireBody } from './body-render';
import { EventList } from './events';
import { errorLabel } from './format';
import { formatDecodedJson, formatErrorValue } from './format-value';
import { isSensitiveHeader, REDACTED_HEADER_VALUE, redactHeaderValue } from './header-redact';
import {
  collectKindFromTargetApi,
  collectStream,
  detectCollectKind,
  extractRawWireBytes,
  extractWireStreamFrames,
  type CollectedStream,
} from './stream-render';
import type { LoadedDumpArtifact } from './use-dump-artifact';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { errorMessage } from '../../lib/error-message';
import { CodeBlock } from '../ui/code-block';
import { DialogShell } from '../ui/dialog-shell';
import { EmptyStateLine } from '../ui/empty-state';
import { Dropdown } from '../ui/fluent-form-controls';
import { HttpMethodBadge } from '../ui/http-badge';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { PANEL_BAND_CLASS } from '../ui/panel';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { copyOutcomeIcon, useCopyLabel, useCopyToClipboard } from '../ui/use-copy-to-clipboard';
import {
  formatCurlCommand,
  formatWireUrl,
  isDecodedSecret,
  type ProjectedWireRequest,
  type ProjectedWireResponse,
  type UpstreamExchange,
} from '@floway-dev/dump/browser';
import { encodeBase64 } from '@floway-dev/protocols/browser';

const BodyEditor = lazy(() => import('../ui/body-editor'));
const { Button, DialogActions, DialogTitle, Option, Spinner, Text, Tooltip } = fluentComponents;

type Source = 'response' | 'request' | 'upstreamRequest' | 'upstreamResponse';
type ResponseView = 'collected' | 'events' | 'raw';

const SOURCE_LABEL_KEYS = {
  response: 'requests.clientResponse',
  request: 'requests.clientRequest',
  upstreamRequest: 'requests.upstreamRequest',
  upstreamResponse: 'requests.upstreamResponse',
} as const;

export interface WireViewProps {
  artifact: LoadedDumpArtifact;
  isLiveStreaming: boolean;
  onInspectStage: (stageId: number) => void;
}

function exchangeLabel(exchange: UpstreamExchange, index: number, count: number, t: ReturnType<typeof useTranslation>['t']): string {
  const call = t('requests.callNumber', {
    number: String(index + 1),
    count: String(count),
  });
  return `${call} ${exchange.request.method} ${exchange.request.url.pathname} ${exchange.response.status}`;
}

function safeHeaderPairs(headers: ReadonlyArray<readonly [string, unknown]>): string {
  return headers.map(([name, value]) => {
    if (isDecodedSecret(value)) return `${name}: ${value.$secret.redacted.slice(0, 12)}`;
    if (typeof value === 'string' && isSensitiveHeader(name)) return `${name}: ${redactHeaderValue(value)}`;
    return `${name}: ${typeof value === 'string' ? value : formatDecodedJson(value)}`;
  }).join('\n');
}

function HeaderTable({ headers }: { headers: ReadonlyArray<readonly [string, unknown]> }) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  return <table className="w-full table-fixed font-mono text-left">
    <colgroup><col className="w-1/3" /><col className="w-2/3" /></colgroup>
    <tbody>
      {headers.map(([name, value], index) => {
        const secret = isDecodedSecret(value);
        const sensitiveString = typeof value === 'string' && isSensitiveHeader(name);
        const shown = secret
          ? value.$secret.redacted.slice(0, 12)
          : sensitiveString
            ? revealed.has(index) ? value : value === REDACTED_HEADER_VALUE ? value : redactHeaderValue(value)
            : typeof value === 'string' ? value : formatDecodedJson(value);
        return <tr key={`${name}-${index}`}>
          <th className="align-top py-2 pr-2 font-normal text-fui-fg3 break-words">{name}</th>
          <td className="py-2 pl-2 break-all">
            {secret
              ? <Tooltip
                  content={t('requests.secretBadge', {
                    length: String(value.$secret.length),
                    hash: value.$secret.hash.slice(0, 12),
                  })}
                  relationship="description"
                ><span className="winui-focus-rect inline-block rounded-sm" tabIndex={0}>{shown}</span></Tooltip>
              : shown}
            {sensitiveString && value !== REDACTED_HEADER_VALUE && <TooltipIconButton
              icon={revealed.has(index) ? <EyeOffRegular /> : <EyeRegular />}
              label={revealed.has(index) ? t('requests.hideValue') : t('requests.revealValue')}
              onClick={() => setRevealed(current => {
                const next = new Set(current);
                if (next.has(index)) next.delete(index); else next.add(index);
                return next;
              })}
            />}
          </td>
        </tr>;
      })}
    </tbody>
  </table>;
}

function CopyUrlButton({ url }: { url: string }) {
  const { copy, outcomeFor } = useCopyToClipboard();
  const { t } = useTranslation();
  const copyLabel = useCopyLabel();
  return <TooltipIconButton
    icon={copyOutcomeIcon(outcomeFor('url'))}
    label={copyLabel(outcomeFor('url'), t('common.copy.action'))}
    onClick={() => copy(url, 'url')}
  />;
}

function rawResponse(bytes: Uint8Array | null): { text: string; decodeError: string | null; base64: boolean } | null {
  if (bytes === null) return null;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), decodeError: null, base64: false };
  } catch (error) {
    return { text: encodeBase64(bytes), decodeError: errorMessage(error), base64: true };
  }
}

function requestForSource(source: Source, downstream: ProjectedWireRequest | null, exchange: UpstreamExchange | undefined): ProjectedWireRequest | null {
  if (source === 'request') return downstream;
  if (source === 'upstreamRequest') return exchange?.request ?? null;
  return null;
}

function responseForSource(source: Source, downstream: ProjectedWireResponse | null, exchange: UpstreamExchange | undefined): ProjectedWireResponse | null {
  if (source === 'response') return downstream;
  if (source === 'upstreamResponse') return exchange?.response ?? null;
  return null;
}

export function WireView({ artifact, isLiveStreaming, onInspectStage }: WireViewProps) {
  const { t } = useTranslation();
  const { wire } = artifact;
  const exchanges = wire.upstreamExchanges;
  const defaultSource: Source = wire.downstreamResponse !== null || wire.downstreamRequest === null ? 'response' : 'request';
  const [chosenSource, setChosenSource] = useState<Source | null>(null);
  const source = chosenSource ?? defaultSource;
  const upstream = source === 'upstreamRequest' || source === 'upstreamResponse';
  const [chosenExchangeId, setChosenExchangeId] = useState<number | null>(null);
  const { exchange, request, response, streamFrames, raw, renderedBody } = useMemo(() => {
    const projection = artifact.wire;
    const calls = projection.upstreamExchanges;
    const picked = calls.find(item => item.stageId === chosenExchangeId) ?? calls.at(-1);
    const req = requestForSource(source, projection.downstreamRequest, picked);
    const res = responseForSource(source, projection.downstreamResponse, picked);
    const message = req ?? res;
    return {
      exchange: picked, request: req, response: res,
      streamFrames: extractWireStreamFrames(res),
      raw: rawResponse(extractRawWireBytes(res)),
      renderedBody: message === null ? EMPTY_BODY : renderWireBody(message.body, message.headers),
    };
  }, [artifact, chosenExchangeId, source]);
  const kind = source === 'upstreamResponse'
    ? detectCollectKind(exchange?.request.url.pathname ?? '') ?? collectKindFromTargetApi(artifact.meta?.targetApi)
    : detectCollectKind(wire.downstreamRequest?.url.pathname ?? artifact.meta?.path ?? '');
  const responseStream = response?.stream;
  const ended = responseStream?.end?.how === 'exhausted';
  const partialCapture = !isLiveStreaming && responseStream !== undefined && !ended;
  const [chosenView, setChosenView] = useState<ResponseView | null>(null);
  const canCollect = streamFrames.length > 0 && kind !== null;
  const formattedView = canCollect || raw === null || responseStream === undefined ? 'collected' : 'raw';
  const availableView = chosenView === 'events' && streamFrames.length > 0 ? 'events'
    : chosenView === 'raw' && raw !== null ? 'raw' : formattedView;
  const [collection, setCollection] = useState<{ frames: typeof streamFrames; ended: boolean; result: CollectedStream } | null>(null);
  const collected = collection?.frames === streamFrames && collection.ended === ended ? collection.result : null;
  const collecting = availableView === 'collected' && canCollect && collected === null;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { copy, outcomeFor } = useCopyToClipboard();
  const copyLabel = useCopyLabel();
  const decodeError = source === 'upstreamResponse' || source === 'response'
    ? renderedBody.decodeError ?? (availableView === 'raw' ? raw?.decodeError ?? null : null)
    : null;
  const diagnostics = [...new Set([
    errorLabel(artifact.meta?.error ?? null),
    responseStream?.end?.error === undefined ? null : formatErrorValue(responseStream.end.error),
    partialCapture ? t('requests.partialCapture') : null,
    collected?.truncated === true ? t('requests.truncatedStream') : null,
    collected?.error ?? null,
    decodeError === null ? null : t('requests.decodeError', { error: decodeError }),
  ].filter((value): value is string => value !== null))];
  const sourceLabel = t(SOURCE_LABEL_KEYS[source]);
  const bodyLabel = request !== null ? t('requests.requestBody') : t('requests.responseBody');
  const owningStage = upstream ? exchange?.stageId : wire.downstreamRequest?.stageId ?? artifact.viewModel.rootStageIds[0];
  const url = request === null ? null : formatWireUrl(request.url, { maskSecrets: true });

  useEffect(() => {
    if (availableView !== 'collected' || streamFrames.length === 0 || kind === null) return;
    let active = true;
    void collectStream(kind, streamFrames, ended).then(result => {
      if (active) setCollection({ frames: streamFrames, ended, result });
    });
    return () => { active = false; };
  }, [availableView, ended, kind, streamFrames]);

  const viewLabel = availableView === 'events'
    ? t('requests.events', { count: streamFrames.length })
    : availableView === 'raw'
      ? raw?.base64 === true ? t('requests.base64') : t('requests.raw')
      : streamFrames.length > 0 ? t('requests.collected') : t('requests.formattedBody');

  const sourceOptions = (Object.keys(SOURCE_LABEL_KEYS) as Source[]).map(value => <Option key={value} value={value} text={t(SOURCE_LABEL_KEYS[value])}>
    {t(SOURCE_LABEL_KEYS[value])}
  </Option>);

  const toolbar = <div className="flex flex-wrap items-center gap-2 min-w-0">
    <Dropdown
      aria-label={t('requests.detailTitle')}
      className="min-w-[180px] max-w-[260px]"
      selectedOptions={[source]}
      value={sourceLabel}
      onOptionSelect={(_, data) => {
        if (data.optionValue !== undefined) setChosenSource(data.optionValue as Source);
      }}
    >{sourceOptions}</Dropdown>
    {upstream && exchange !== undefined && <Dropdown
      aria-label={t('requests.upstreamCall')}
      className="min-w-[220px] max-w-[360px]"
      selectedOptions={[String(exchange.stageId)]}
      value={exchangeLabel(exchange, exchanges.indexOf(exchange), exchanges.length, t)}
      onOptionSelect={(_, data) => {
        if (data.optionValue !== undefined) setChosenExchangeId(Number(data.optionValue));
      }}
    >{exchanges.map((item, index) => <Option key={item.stageId} value={String(item.stageId)}>{exchangeLabel(item, index, exchanges.length, t)}</Option>)}</Dropdown>}
    {response !== null && <Dropdown
      aria-label={t('requests.streamView')}
      className="min-w-[160px] max-w-[240px]"
      selectedOptions={[availableView]}
      value={viewLabel}
      onOptionSelect={(_, data) => {
        if (data.optionValue !== undefined) setChosenView(data.optionValue as ResponseView);
      }}
    >
      {(canCollect || formattedView === 'collected') && <Option key="collected" value="collected" text={canCollect ? t('requests.collected') : t('requests.formattedBody')}>
        {canCollect ? t('requests.collected') : t('requests.formattedBody')}
      </Option>}
      {streamFrames.length > 0 && <Option key="events" value="events" text={t('requests.events', { count: streamFrames.length })}>
        {t('requests.events', { count: streamFrames.length })}
      </Option>}
      {raw !== null && <Option key="raw" value="raw" text={raw.base64 ? t('requests.base64') : t('requests.raw')}>
        {raw.base64 ? t('requests.base64') : t('requests.raw')}
      </Option>}
    </Dropdown>}
    <div className="ml-auto flex items-center gap-1">
      {request !== null && <TooltipIconButton
        icon={copyOutcomeIcon(outcomeFor('curl'))}
        label={copyLabel(outcomeFor('curl'), t('requests.copyCurl'))}
        onClick={() => copy(formatCurlCommand(request), 'curl')}
      />}
      {owningStage !== undefined && <Button appearance="subtle" size="small" onClick={() => onInspectStage(owningStage)}>
        {t('requests.inspectStage')}
      </Button>}
      <Button
        size="small"
        appearance="subtle"
        icon={diagnostics.length > 0 ? <WarningRegular /> : <InfoRegular />}
        onClick={() => setDetailsOpen(true)}
      >{diagnostics.length > 0 ? t('requests.diagnostics', { count: String(diagnostics.length) }) : t('requests.metadata')}</Button>
    </div>
  </div>;

  const warnings: ReactNode = <>
    {partialCapture && <OutcomeMessageBar intent="warning">{t('requests.partialCapture')}</OutcomeMessageBar>}
    {collected?.truncated === true && <OutcomeMessageBar intent="warning">{t('requests.truncatedStream')}</OutcomeMessageBar>}
    {collected?.error !== null && collected?.error !== undefined && <OutcomeMessageBar intent="warning">{collected.error}</OutcomeMessageBar>}
    {decodeError !== null && <OutcomeMessageBar intent="warning">{t('requests.decodeError', { error: decodeError })}</OutcomeMessageBar>}
  </>;

  return <div className="h-full min-h-0 flex flex-col">
    <div className={`${PANEL_BAND_CLASS} flex flex-wrap items-center gap-2 min-w-0 shrink-0 border-b border-b-solid border-b-[var(--winui-divider-stroke-default)]`}>{toolbar}</div>
    <div className="flex-1 min-h-0">
      {availableView === 'events'
        ? <EventList events={streamFrames} kind={kind} toolbarStart={warnings} />
        : availableView === 'raw' && raw !== null
          ? <div className="h-full min-h-0 flex flex-col">
              {warnings && <div className="p-3">{warnings}</div>}
              <div className="flex-1 min-h-0 p-3">
                <CodeBlock
                  code={raw.text}
                  copyOutcome={outcomeFor('raw')}
                  language="plain"
                  onCopy={() => copy(raw.text, 'raw')}
                />
              </div>
            </div>
          : collecting
            ? <div className="h-full min-h-0 flex flex-col">
                <div className="flex-1 grid place-items-center"><Spinner size="tiny" /></div>
              </div>
            : <Suspense fallback={<Spinner />}><BodyEditor
                text={canCollect ? formatDecodedJson(collected?.result ?? null) : renderedBody.text}
                copyText={canCollect ? undefined : renderedBody.copyText}
                json={canCollect || renderedBody.isJson}
                label={bodyLabel}
                emptyText={upstream && exchange === undefined ? t('requests.noUpstreamCapture') : t('requests.emptyBody')}
                toolbarStart={warnings}
              /></Suspense>}
    </div>
    <DialogShell
      width="editor"
      open={detailsOpen}
      onOpenChange={(_, data) => setDetailsOpen(data.open)}
      title={<DialogTitle>{sourceLabel}</DialogTitle>}
      actions={<DialogActions><Button onClick={() => setDetailsOpen(false)}>{t('common.dismiss')}</Button></DialogActions>}
    >
      {request !== null && url !== null && <div className="flex items-center gap-2 min-w-0">
        <HttpMethodBadge method={request.method} />
        <Text className="min-w-0 font-mono break-all">{url}</Text>
        <CopyUrlButton url={url} />
      </div>}
      {diagnostics.map(message => <OutcomeMessageBar key={message} intent="warning">{message}</OutcomeMessageBar>)}
      {upstream && exchanges.length === 0 && <EmptyStateLine>{t('requests.noUpstreamCapture')}</EmptyStateLine>}
      {response !== null && <div className="flex items-center justify-between gap-2">
        <Text weight="semibold">{t('requests.headers', { count: String(response.headers.length) })}</Text>
        <TooltipIconButton
          icon={copyOutcomeIcon(outcomeFor('headers'))}
          label={copyLabel(outcomeFor('headers'), t('common.copy.action'))}
          onClick={() => copy(safeHeaderPairs(response.headers), 'headers')}
        />
      </div>}
      {response !== null && <HeaderTable key={`${source}-${exchange?.stageId ?? ''}`} headers={response.headers} />}
      {request !== null && <div className="flex items-center justify-between gap-2">
        <Text weight="semibold">{t('requests.headers', { count: String(request.headers.length) })}</Text>
        <TooltipIconButton
          icon={copyOutcomeIcon(outcomeFor('request-headers'))}
          label={copyLabel(outcomeFor('request-headers'), t('common.copy.action'))}
          onClick={() => copy(safeHeaderPairs(request.headers), 'request-headers')}
        />
      </div>}
      {request !== null && <HeaderTable key={`${source}-${exchange?.stageId ?? ''}-request`} headers={request.headers} />}
    </DialogShell>
  </div>;
}
