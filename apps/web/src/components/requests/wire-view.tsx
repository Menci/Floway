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
import { encodeBase64BinaryString } from '../../lib/base-encoding';
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
  projectWireView,
  type ProjectedWireRequest,
  type ProjectedWireResponse,
  type UpstreamAttemptProjection,
} from '@floway-dev/pipeline/browser';

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

function attemptLabel(attempt: UpstreamAttemptProjection, attempts: readonly UpstreamAttemptProjection[], t: ReturnType<typeof useTranslation>['t']): string {
  const candidate = [attempt.candidate?.upstreamId, attempt.candidate?.modelId].filter(Boolean).join(' / ');
  const call = t('requests.callNumber', {
    number: String(attempt.attemptIndex + 1),
    count: String(attempts.length),
  });
  return [call, attempt.request?.method, candidate, attempt.response?.status].filter(value => value !== undefined && value !== '').join(' ');
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

function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return encodeBase64BinaryString(binary);
}

function rawResponse(bytes: Uint8Array | null): { text: string; decodeError: string | null; base64: boolean } | null {
  if (bytes === null) return null;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), decodeError: null, base64: false };
  } catch (error) {
    return { text: encodeBytes(bytes), decodeError: errorMessage(error), base64: true };
  }
}

function requestForSource(source: Source, downstream: ProjectedWireRequest | null, attempt: UpstreamAttemptProjection | null): ProjectedWireRequest | null {
  if (source === 'request') return downstream;
  if (source === 'upstreamRequest') return attempt?.request ?? null;
  return null;
}

function responseForSource(source: Source, downstream: ProjectedWireResponse | null, attempt: UpstreamAttemptProjection | null): ProjectedWireResponse | null {
  if (source === 'response') return downstream;
  if (source === 'upstreamResponse') return attempt?.response ?? null;
  return null;
}

function owningStageId(source: Source, artifact: LoadedDumpArtifact, attempt: UpstreamAttemptProjection | null): number | null {
  if (source === 'upstreamRequest' || source === 'upstreamResponse') return attempt?.stageId ?? null;
  if (source === 'request') return [...artifact.viewModel.stages.values()].find(stage => stage.tap === 'downstream')?.stageId ?? null;
  return [...artifact.viewModel.stages.values()]
    .filter(stage => stage.tap === 'downstream' && (stage.outcome !== undefined || stage.error !== undefined))
    .at(-1)?.stageId ?? artifact.viewModel.rootStageIds[0] ?? null;
}

export function WireView({ artifact, isLiveStreaming, onInspectStage }: WireViewProps) {
  const { t } = useTranslation();
  const wire = useMemo(() => projectWireView(artifact.viewModel), [artifact.viewModel]);
  const attempts = wire.upstreamAttempts;
  const defaultSource: Source = wire.downstreamResponse !== null || !isLiveStreaming ? 'response' : 'request';
  const [chosenSource, setChosenSource] = useState<Source | null>(null);
  const source = chosenSource ?? defaultSource;
  const upstream = source === 'upstreamRequest' || source === 'upstreamResponse';
  const defaultAttempt = attempts.findLast(attempt => attempt.winning) ?? attempts.at(-1) ?? null;
  const [chosenAttemptIndex, setChosenAttemptIndex] = useState<number | null>(null);
  const activeAttempt = attempts.find(attempt => attempt.attemptIndex === chosenAttemptIndex) ?? defaultAttempt;
  const request = requestForSource(source, wire.downstreamRequest, activeAttempt);
  const response = responseForSource(source, wire.downstreamResponse, activeAttempt);
  const direction = source === 'upstreamResponse' ? 'upstream' : 'downstream';
  const kind = source === 'upstreamResponse'
    ? collectKindFromTargetApi(artifact.meta?.targetApi) ?? detectCollectKind(artifact.meta?.path ?? '')
    : detectCollectKind(artifact.meta?.path ?? '');
  const streamFrames = response === null ? [] : extractWireStreamFrames(response, direction);
  const streamFrameCount = streamFrames.length;
  const raw = rawResponse(response === null ? null : extractRawWireBytes(response));
  const renderedBody = request !== null
    ? renderWireBody(request.body, request.headers)
    : response === null ? EMPTY_BODY : renderWireBody(response.body, response.headers);
  const responseStream = response === null ? undefined : artifact.viewModel.streams.get(response.protocolStreamId ?? response.rawStreamId ?? -1);
  const partialCapture = responseStream !== undefined && responseStream.frames.length > 0
    && (responseStream.end === undefined || responseStream.end.how === 'errored' || responseStream.end.how === 'closed');
  const [chosenView, setChosenView] = useState<ResponseView | null>(null);
  const availableView = chosenView === 'events' && streamFrames.length === 0
    ? 'collected'
    : chosenView === 'raw' && raw === null ? 'collected' : chosenView ?? 'collected';
  const collectionKey = [source, activeAttempt?.attemptIndex, kind, streamFrames.length, streamFrames.at(-1)?.ts].join(':');
  const [collection, setCollection] = useState<{ key: string; result: CollectedStream } | null>(null);
  const collected = collection?.key === collectionKey ? collection.result : null;
  const collecting = availableView === 'collected' && streamFrames.length > 0 && kind !== null && collected === null;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { copy, outcomeFor } = useCopyToClipboard();
  const copyLabel = useCopyLabel();
  const truncatedTrace = artifact.viewModel.run?.truncated;
  const truncatedTraceMessage = truncatedTrace === undefined
    ? null
    : t('requests.truncatedTrace', { dropped: truncatedTrace.droppedEvents });
  const decodeError = source === 'upstreamResponse' || source === 'response'
    ? renderedBody.decodeError ?? (availableView === 'raw' ? raw?.decodeError ?? null : null)
    : null;
  const diagnostics = [...new Set([
    errorLabel(artifact.meta?.error ?? null),
    activeAttempt?.error === undefined ? null : formatErrorValue(activeAttempt.error),
    truncatedTraceMessage,
    partialCapture ? t('requests.partialCapture') : null,
    collected?.truncated === true ? t('requests.truncatedStream') : null,
    collected?.error ?? null,
    decodeError === null ? null : t('requests.decodeError', { error: decodeError }),
  ].filter((value): value is string => value !== null))];
  const sourceLabel = t(SOURCE_LABEL_KEYS[source]);
  const bodyLabel = request !== null ? t('requests.requestBody') : t('requests.responseBody');
  const selectedAttemptLabel = activeAttempt === null ? '' : attemptLabel(activeAttempt, attempts, t);
  const owningStage = owningStageId(source, artifact, activeAttempt);
  const url = request === null ? null : formatWireUrl(request.url, { maskSecrets: true });

  useEffect(() => {
    if (availableView !== 'collected' || streamFrameCount === 0 || kind === null) return;
    const frames = response === null ? [] : extractWireStreamFrames(response, direction);
    let active = true;
    void collectStream(kind, frames).then(result => {
      if (active) setCollection({ key: collectionKey, result });
    });
    return () => { active = false; };
  }, [availableView, collectionKey, direction, kind, response, streamFrameCount]);

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
    {upstream && attempts.length > 0 && activeAttempt !== null && <Dropdown
      aria-label={t('requests.upstreamCall')}
      className="min-w-[220px] max-w-[360px]"
      selectedOptions={[String(activeAttempt.attemptIndex)]}
      value={selectedAttemptLabel}
      onOptionSelect={(_, data) => {
        if (data.optionValue !== undefined) setChosenAttemptIndex(Number(data.optionValue));
      }}
    >{attempts.map(attempt => <Option key={attempt.attemptIndex} value={String(attempt.attemptIndex)} text={attemptLabel(attempt, attempts, t)}>
        <span className="inline-flex flex-wrap items-center gap-1">
          <span>{attemptLabel(attempt, attempts, t)}</span>
          {attempt.isSubRun && <span>[{t('requests.subrunBadge')}]</span>}
          {!attempt.winning && !attempt.isSubRun && attempts.some(candidate => candidate.winning) && <span className="opacity-60">[{t('requests.failoverBadge')}]</span>}
        </span>
      </Option>)}</Dropdown>}
    {response !== null && <Dropdown
      aria-label={t('requests.streamView')}
      className="min-w-[160px] max-w-[240px]"
      selectedOptions={[availableView]}
      value={viewLabel}
      onOptionSelect={(_, data) => {
        if (data.optionValue !== undefined) setChosenView(data.optionValue as ResponseView);
      }}
    >
      <Option key="collected" value="collected" text={streamFrames.length > 0 ? t('requests.collected') : t('requests.formattedBody')}>
        {streamFrames.length > 0 ? t('requests.collected') : t('requests.formattedBody')}
      </Option>
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
      {owningStage !== null && <Button appearance="subtle" size="small" onClick={() => onInspectStage(owningStage)}>
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
        ? <EventList events={streamFrames} kind={kind} toolbarStart={null} />
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
                text={streamFrames.length > 0 ? formatDecodedJson(collected?.result ?? null) : renderedBody.text}
                json={streamFrames.length > 0 || renderedBody.isJson}
                label={bodyLabel}
                emptyText={upstream && activeAttempt === null ? t('requests.noUpstreamCapture') : t('requests.emptyBody')}
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
      {upstream && attempts.length === 0 && <EmptyStateLine>{t('requests.noUpstreamCapture')}</EmptyStateLine>}
      {response !== null && <div className="flex items-center justify-between gap-2">
        <Text weight="semibold">{t('requests.headers', { count: String(response.headers.length) })}</Text>
        <TooltipIconButton
          icon={copyOutcomeIcon(outcomeFor('headers'))}
          label={copyLabel(outcomeFor('headers'), t('common.copy.action'))}
          onClick={() => copy(safeHeaderPairs(response.headers), 'headers')}
        />
      </div>}
      {response !== null && <HeaderTable key={`${source}-${activeAttempt?.attemptIndex ?? ''}`} headers={response.headers} />}
      {request !== null && <div className="flex items-center justify-between gap-2">
        <Text weight="semibold">{t('requests.headers', { count: String(request.headers.length) })}</Text>
        <TooltipIconButton
          icon={copyOutcomeIcon(outcomeFor('request-headers'))}
          label={copyLabel(outcomeFor('request-headers'), t('common.copy.action'))}
          onClick={() => copy(safeHeaderPairs(request.headers), 'request-headers')}
        />
      </div>}
      {request !== null && <HeaderTable key={`${source}-${activeAttempt?.attemptIndex ?? ''}-request`} headers={request.headers} />}
    </DialogShell>
  </div>;
}
