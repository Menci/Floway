import {
  CheckmarkRegular,
  CopyRegular,
  DismissRegular,
  EyeOffRegular,
  EyeRegular,
} from '@fluentui/react-icons';
import Prism from 'prismjs';
import { useMemo, useState } from 'react';
import type { PropsWithChildren, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { contentTypeOf, EMPTY_BODY, renderBody, type RenderedBody } from './body-render';
import { requestSeverity } from './format';
import { isSensitiveHeader, redactHeaderValue } from './header-redact';
import {
  detectCollectKind,
  renderStreamEvents,
  streamEventsCopyText,
  type CollectedStream,
} from './stream-render';
import { fluentComponents } from '../../fluent';
import { EmptyState, EmptyStateLine } from '../ui/empty-state';
import { HttpMethodBadge, HttpStatusBadge } from '../ui/http-badge';
import { prismTokenStyles } from '../ui/prism-token-styles';
import { ScrollArea } from '../ui/scroll-area';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { useCopyToClipboard } from '../ui/use-copy-to-clipboard';
import type { DumpRecord, DumpStreamEvent } from '@floway-dev/gateway/dump-types';
import 'prismjs/components/prism-json';

const { MessageBar, MessageBarBody, Tab, TabList, Text, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  sectionHeader: {
    alignItems: 'center',
    backgroundColor: 'var(--colorNeutralBackground1)',
    borderBottom: '1px solid var(--colorNeutralStroke1)',
    display: 'flex',
    gap: '8px',
    minHeight: '42px',
    padding: '5px 16px',
    position: 'sticky',
    top: 0,
    zIndex: 2,
  },
  sectionTitle: { lineHeight: '20px' },
  section: { borderBottom: '1px solid var(--colorNeutralStroke1)' },
  code: {
    backgroundColor: 'var(--colorNeutralBackground1)',
    color: 'var(--colorNeutralForeground1)',
    fontFamily: 'var(--fontFamilyMonospace)',
    fontSize: 'var(--floway-font-size-mono)',
    lineHeight: 'var(--lineHeightBase300)',
    margin: 0,
    overflow: 'visible',
    padding: '14px 16px 18px',
    tabSize: 2,
    whiteSpace: 'pre',
  },
  highlightedCode: prismTokenStyles,
  headers: { borderCollapse: 'collapse', fontFamily: 'var(--fontFamilyMonospace)', fontSize: 'var(--floway-font-size-mono)', width: '100%' },
  headerRow: { borderBottom: '1px solid var(--colorNeutralStroke3)' },
  headerName: { color: 'var(--colorNeutralForeground3)', fontWeight: 'var(--fontWeightRegular)', padding: '7px 14px 7px 16px', textAlign: 'left', verticalAlign: 'top', whiteSpace: 'nowrap' },
  headerValue: { color: 'var(--colorNeutralForeground1)', overflowWrap: 'anywhere', padding: '7px 16px 7px 0', verticalAlign: 'top', whiteSpace: 'normal' },
  error: { color: 'var(--colorPaletteRedForeground1)' },
});

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const { copiedTag, copy, copyFailedTag } = useCopyToClipboard();
  const label = copyFailedTag !== null
    ? t('dashboard.apiKeys.copy.failed')
    : copiedTag !== null ? t('dashboard.requests.copied') : t('dashboard.requests.copy');
  return (
    <TooltipIconButton
      icon={copyFailedTag !== null ? <DismissRegular /> : copiedTag !== null ? <CheckmarkRegular /> : <CopyRegular />}
      label={label}
      onClick={() => copy(text)}
    />
  );
}

function CodeView({ body }: { body: RenderedBody }) {
  const s = useStyles();
  const highlighted = useMemo(() => {
    const grammar = body.isJson ? Prism.languages.json : Prism.languages.plain;
    return grammar ? Prism.highlight(body.text, grammar, body.isJson ? 'json' : 'plain') : escapeHtml(body.text);
  }, [body]);
  return <pre className={mergeClasses(s.code, `language-${body.isJson ? 'json' : 'plain'}`)}><code className={s.highlightedCode} dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>;
}

function HeaderTable({ headers }: { headers: Array<[string, string]> }) {
  const { t } = useTranslation();
  const s = useStyles();
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  return (
    <table className={s.headers}><tbody>
      {headers.map(([name, value], index) => {
        const sensitive = isSensitiveHeader(name);
        const visible = revealed.has(index);
        return (
          <tr className={s.headerRow} key={`${name}-${index}`}>
            <th className={s.headerName}>{name}</th>
            <td className={s.headerValue}>
              {sensitive && !visible ? redactHeaderValue(value) : value}
              {sensitive && (
                <TooltipIconButton
                  className="!ml-1"
                  icon={visible ? <EyeOffRegular /> : <EyeRegular />}
                  label={visible ? t('dashboard.requests.hideValue') : t('dashboard.requests.revealValue')}
                  onClick={() => setRevealed(current => {
                    const next = new Set(current);
                    if (next.has(index)) next.delete(index); else next.add(index);
                    return next;
                  })}
                />
              )}
            </td>
          </tr>
        );
      })}
    </tbody></table>
  );
}

function DetailSectionHeader({ title, detail, actions, copyText }: { title: string; detail?: ReactNode; actions?: ReactNode; copyText?: string }) {
  const s = useStyles();
  return <header className={s.sectionHeader}><div className="flex items-center gap-3 min-w-0"><Text as="h3" size={400} weight="semibold" className={mergeClasses('m-0', s.sectionTitle)}>{title}</Text>{detail}</div>{(actions !== undefined || copyText !== undefined) && <div className="ml-auto flex items-center gap-1">{actions}{copyText !== undefined && <CopyButton text={copyText} />}</div>}</header>;
}

function SectionBody({ children }: PropsWithChildren) {
  return <ScrollArea axes="horizontal" className="min-w-0" contentClassName="min-w-full w-max" noTabIndex>{children}</ScrollArea>;
}

function HeaderSectionBody({ children }: PropsWithChildren) {
  return <ScrollArea axes="horizontal" className="min-w-0" contentClassName="min-w-full" noTabIndex>{children}</ScrollArea>;
}

export function RequestDetailPanel({ collected: loadedCollected, error, record, recordId }: {
  collected: CollectedStream | null;
  error: string | null;
  record: DumpRecord | null;
  recordId: string | null;
}) {
  const { t } = useTranslation();
  const s = useStyles();
  const [streamView, setStreamView] = useState<'collected' | 'events'>('collected');
  const [collected, setCollected] = useState(loadedCollected);

  const [shownRecordId, setShownRecordId] = useState(recordId);
  if (shownRecordId !== recordId) {
    setShownRecordId(recordId);
    setCollected(loadedCollected);
    setStreamView('collected');
  }

  const requestBody = record ? renderBody(record.request.body, contentTypeOf(record.request.headers)) : EMPTY_BODY;
  const responseBody = record?.response.body.type === 'bytes' ? renderBody(record.response.body.body, contentTypeOf(record.response.headers)) : EMPTY_BODY;
  const streamEvents = useMemo<DumpStreamEvent[]>(
    () => record?.response.body.type === 'stream' ? record.response.body.events : [],
    [record],
  );
  const collectKind = record ? detectCollectKind(record.meta.path) : null;
  const renderedEvents = useMemo(() => renderStreamEvents(collectKind, streamEvents), [collectKind, streamEvents]);

  if (!recordId) return <EmptyState className="h-full p-8" title={t('dashboard.requests.selectPrompt')} />;
  if (error) return <div className="p-4"><MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar></div>;
  if (!record) return null;

  const severity = requestSeverity(record.response.status, record.meta.error);
  const responseError = record.meta.error?.kind === 'failed'
    ? record.meta.error.reason
    : record.meta.error ? `${record.meta.error.kind} error` : null;
  const requestHeadersCopy = record.request.headers.map(([name, value]) => `${name}: ${value}`).join('\n');
  const responseHeadersCopy = record.response.headers.map(([name, value]) => `${name}: ${value}`).join('\n');
  const collectedCopyText = collected?.result === null || collected?.result === undefined
    ? undefined
    : JSON.stringify(collected.result, null, 2);

  return (
    <ScrollArea axes="vertical" className="h-full" contentClassName="min-h-full" noTabIndex>
      <section className={s.section}>
        <DetailSectionHeader title={t('dashboard.requests.request')} detail={<><HttpMethodBadge method={record.request.method} /><Text size={300} className="font-mono">{record.request.path}</Text></>} copyText={requestHeadersCopy} />
        <HeaderSectionBody><HeaderTable key={`request-${record.meta.id}`} headers={record.request.headers} /></HeaderSectionBody>
      </section>
      <section className={s.section}>
        <DetailSectionHeader title={t('dashboard.requests.requestBody')} copyText={requestBody.text ? requestBody.copyText : undefined} />
        <SectionBody>
          {requestBody.decodeError && <MessageBar intent="warning" className="!m-3"><MessageBarBody>{t('dashboard.requests.decodeError', { error: requestBody.decodeError })}</MessageBarBody></MessageBar>}
          {requestBody.text ? <CodeView body={requestBody} /> : <EmptyStateLine className="p-4">{t('dashboard.requests.noRequestBody')}</EmptyStateLine>}
        </SectionBody>
      </section>
      <section className={s.section}>
        <DetailSectionHeader title={t('dashboard.requests.response')} detail={<><HttpStatusBadge color={severity === 'success' ? 'success' : severity === 'warning' ? 'warning' : 'danger'}>{record.response.status ?? t('dashboard.requests.noStatus')}</HttpStatusBadge>{responseError && <Text size={200} className={s.error}>{responseError}</Text>}</>} copyText={record.response.headers.length ? responseHeadersCopy : undefined} />
        <HeaderSectionBody>
          {record.response.headers.length ? <HeaderTable key={`response-${record.meta.id}`} headers={record.response.headers} /> : <EmptyStateLine className="p-4">{t('dashboard.requests.noResponseHeaders')}</EmptyStateLine>}
        </HeaderSectionBody>
      </section>
      <section>
        <DetailSectionHeader
          title={t('dashboard.requests.responseBody')}
          actions={record.response.body.type === 'stream' ? (
            <TabList selectedValue={streamView} onTabSelect={(_, data) => setStreamView(data.value as 'collected' | 'events')} size="small">
              <Tab value="collected">{t('dashboard.requests.collected')}</Tab>
              <Tab value="events">{t('dashboard.requests.events', { count: streamEvents.length })}</Tab>
            </TabList>
          ) : undefined}
          copyText={record.response.body.type === 'bytes' && responseBody.text
            ? responseBody.copyText
            : record.response.body.type === 'stream' && streamView === 'events'
              ? streamEventsCopyText(collectKind, streamEvents)
              : record.response.body.type === 'stream' && streamView === 'collected'
                ? collectedCopyText
                : undefined}
        />
        <SectionBody>
          {record.response.body.type === 'none' ? <EmptyStateLine className="p-4">{t('dashboard.requests.noResponseBody')}</EmptyStateLine> : null}
          {record.response.body.type === 'bytes' && (responseBody.text ? <CodeView body={responseBody} /> : <EmptyStateLine className="p-4">{t('dashboard.requests.emptyBody')}</EmptyStateLine>)}
          {record.response.body.type === 'stream' && streamView === 'collected' && (
            collectKind === null ? <MessageBar intent="warning" className="!m-3"><MessageBarBody>{t('dashboard.requests.noCollector')}</MessageBarBody></MessageBar>
              : collected === null ? null
                : <>
                    {collected.error && <MessageBar intent="error" className="!m-3"><MessageBarBody>{collected.error}</MessageBarBody></MessageBar>}
                    {!collected.error && collected.truncated && <MessageBar intent="warning" className="!m-3"><MessageBarBody>{t('dashboard.requests.truncatedStream')}</MessageBarBody></MessageBar>}
                    {collected.result !== null && <CodeView body={{ text: JSON.stringify(collected.result, null, 2), copyText: '', decodeError: null, isJson: true }} />}
                  </>
          )}
          {record.response.body.type === 'stream' && streamView === 'events' && renderedEvents.map((event, index) => (
            <div className={s.section} key={index}>
              <div className="flex items-center gap-2 px-4 pt-3"><Text size={100} className="font-mono mono-size-100 text-fui-fg2">{event.event ?? t('dashboard.requests.unlabeled')}</Text>{event.parseError && <Text size={100} className={s.error}>{t('dashboard.requests.jsonParseFailed')}</Text>}<Text size={100} className="ml-auto font-mono mono-size-100 text-fui-fg3">+{event.timestamp.toFixed(event.timestamp < 1 ? 3 : 0)}ms</Text></div>
              <CodeView body={{ text: event.text, copyText: event.text, decodeError: event.parseError, isJson: !event.parseError }} />
            </div>
          ))}
        </SectionBody>
      </section>
    </ScrollArea>
  );
}

const escapeHtml = (value: string): string => {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};
