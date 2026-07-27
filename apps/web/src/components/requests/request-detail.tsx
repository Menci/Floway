import { useEffect, useMemo, useState } from "react";
import type { DumpRecord, DumpStreamEvent } from "@floway-dev/gateway/dump-types";
import {
  ArrowDownloadRegular,
  ArrowUploadRegular,
  CheckmarkRegular,
  CopyRegular,
  DocumentArrowDownRegular,
  DocumentArrowUpRegular,
  EyeOffRegular,
  EyeRegular,
} from "@fluentui/react-icons";
import Prism from "prismjs";
import { useTranslation } from "react-i18next";

import { authFetch } from "../../api/auth";
import { fluentComponents } from "../../fluent";
import { contentTypeOf, EMPTY_BODY, renderBody, type RenderedBody } from "./body-render";
import { errorLabel, requestSeverity } from "./format";
import { isSensitiveHeader, redactHeaderValue } from "./header-redact";
import {
  collectStream,
  detectCollectKind,
  renderStreamEvents,
  streamEventsCopyText,
  type CollectedStream,
} from "./stream-render";

const { Button, MessageBar, MessageBarBody, Spinner, Tab, TabList, Text, Tooltip, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  sectionHeader: {
    alignItems: "center",
    backgroundColor: "var(--colorNeutralBackground1)",
    borderBottom: "1px solid var(--colorNeutralStroke1)",
    display: "flex",
    gap: "8px",
    minHeight: "42px",
    padding: "5px 0",
    position: "sticky",
    top: 0,
    zIndex: 2,
  },
  section: { borderBottom: "1px solid var(--colorNeutralStroke1)" },
  code: {
    backgroundColor: "var(--colorNeutralBackground1)",
    color: "var(--colorNeutralForeground1)",
    fontFamily: "monospace",
    fontSize: "12px",
    lineHeight: 1.55,
    margin: 0,
    overflow: "visible",
    padding: "14px 16px 18px",
    tabSize: 2,
    whiteSpace: "pre",
  },
  headers: { borderCollapse: "collapse", fontFamily: "monospace", fontSize: "12px", width: "100%" },
  headerRow: { borderBottom: "1px solid var(--colorNeutralStroke3)" },
  headerName: { color: "var(--colorNeutralForeground3)", padding: "7px 14px 7px 16px", textAlign: "left", verticalAlign: "top", whiteSpace: "nowrap", width: "190px" },
  headerValue: { color: "var(--colorNeutralForeground1)", padding: "7px 16px 7px 0", verticalAlign: "top", whiteSpace: "nowrap" },
  success: { color: "var(--colorPaletteGreenForeground1)" },
  warning: { color: "var(--colorPaletteDarkOrangeForeground1)" },
  error: { color: "var(--colorPaletteRedForeground1)" },
});

interface DetailProps {
  keyId: string;
  recordId: string | null;
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Tooltip content={copied ? t("dashboard.requests.copied") : t("dashboard.requests.copy")} relationship="label">
      <Button appearance="subtle" icon={copied ? <CheckmarkRegular /> : <CopyRegular />} onClick={() => void copy()} size="small" />
    </Tooltip>
  );
}

function CodeView({ body }: { body: RenderedBody }) {
  const s = useStyles();
  const highlighted = useMemo(() => {
    const grammar = body.isJson ? Prism.languages.json : Prism.languages.plain;
    return grammar ? Prism.highlight(body.text, grammar, body.isJson ? "json" : "plain") : escapeHtml(body.text);
  }, [body]);
  return <pre className={mergeClasses(s.code, `language-${body.isJson ? "json" : "plain"}`)}><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>;
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
                <Tooltip content={visible ? t("dashboard.requests.hideValue") : t("dashboard.requests.revealValue")} relationship="label">
                  <Button
                    appearance="subtle"
                    icon={visible ? <EyeOffRegular /> : <EyeRegular />}
                    onClick={() => setRevealed((current) => {
                      const next = new Set(current);
                      if (next.has(index)) next.delete(index); else next.add(index);
                      return next;
                    })}
                    size="small"
                    className="!ml-1"
                  />
                </Tooltip>
              )}
            </td>
          </tr>
        );
      })}
    </tbody></table>
  );
}

function SectionHeader({ title, icon, detail, actions, copyText }: { title: string; icon: React.ReactNode; detail?: React.ReactNode; actions?: React.ReactNode; copyText?: string }) {
  const s = useStyles();
  return <header className={s.sectionHeader}><span className="inline-flex text-fui-base400 text-fui-fg3">{icon}</span><Text size={400} weight="semibold">{title}</Text>{detail}{(actions || copyText !== undefined) && <div className="ml-auto flex items-center gap-1">{actions}{copyText !== undefined && <CopyButton text={copyText} />}</div>}</header>;
}

export function RequestDetailPanel({ keyId, recordId }: DetailProps) {
  const { t } = useTranslation();
  const s = useStyles();
  const [record, setRecord] = useState<DumpRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamView, setStreamView] = useState<"collected" | "events">("collected");
  const [collected, setCollected] = useState<CollectedStream | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setRecord(null);
    setError(null);
    setCollected(null);
    setStreamView("collected");
    if (!recordId) return () => controller.abort();
    setLoading(true);
    void authFetch(`/api/dump/keys/${encodeURIComponent(keyId)}/records/${encodeURIComponent(recordId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setRecord(await response.json() as DumpRecord);
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [keyId, recordId]);

  const requestBody = record ? renderBody(record.request.body, contentTypeOf(record.request.headers)) : EMPTY_BODY;
  const responseBody = record?.response.body.type === "bytes" ? renderBody(record.response.body.body, contentTypeOf(record.response.headers)) : EMPTY_BODY;
  const streamEvents: DumpStreamEvent[] = record?.response.body.type === "stream" ? record.response.body.events : [];
  const collectKind = record ? detectCollectKind(record.meta.path) : null;
  const renderedEvents = useMemo(() => renderStreamEvents(collectKind, streamEvents), [collectKind, streamEvents]);

  useEffect(() => {
    let active = true;
    if (!collectKind || streamEvents.length === 0) return;
    void collectStream(collectKind, streamEvents).then((value) => { if (active) setCollected(value); });
    return () => { active = false; };
  }, [collectKind, streamEvents]);

  if (!recordId) return <div className="h-full grid place-items-center p-8 text-center"><Text className="text-fui-fg3">{t("dashboard.requests.selectPrompt")}</Text></div>;
  if (loading) return <div className="h-full grid place-items-center"><Spinner size="tiny" label={t("common.loading")} /></div>;
  if (error) return <div className="p-4"><MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar></div>;
  if (!record) return null;

  const severity = requestSeverity(record.response.status, record.meta.error);
  const responseError = errorLabel(record.meta.error, record.response.status);
  const requestHeadersCopy = record.request.headers.map(([name, value]) => `${name}: ${value}`).join("\n");
  const responseHeadersCopy = record.response.headers.map(([name, value]) => `${name}: ${value}`).join("\n");
  const collectedCopyText = collected?.result === null || collected?.result === undefined
    ? undefined
    : JSON.stringify(collected.result, null, 2);

  return (
    <div className="h-full overflow-auto">
      <section className={s.section}>
        <SectionHeader title={t("dashboard.requests.request")} icon={<ArrowUploadRegular />} detail={<><Text size={400} weight="semibold" className="font-mono">{record.request.method}</Text><Text size={400} className="font-mono">{record.request.path}</Text></>} copyText={requestHeadersCopy} />
        <HeaderTable key={`request-${record.meta.id}`} headers={record.request.headers} />
      </section>
      <section className={s.section}>
        <SectionHeader title={t("dashboard.requests.requestBody")} icon={<DocumentArrowUpRegular />} copyText={requestBody.text ? requestBody.copyText : undefined} />
        {requestBody.decodeError && <MessageBar intent="warning" className="!m-3"><MessageBarBody>{t("dashboard.requests.decodeError", { error: requestBody.decodeError })}</MessageBarBody></MessageBar>}
        {requestBody.text ? <CodeView body={requestBody} /> : <Text size={200} className="block !p-4 text-fui-fg3">{t("dashboard.requests.noRequestBody")}</Text>}
      </section>
      <section className={s.section}>
        <SectionHeader title={t("dashboard.requests.response")} icon={<ArrowDownloadRegular />} detail={<><Text size={400} weight="semibold" className={s[severity]}>{record.response.status ?? t("dashboard.requests.noStatus")}</Text>{responseError && <Text size={200} className={s.error}>{responseError}</Text>}</>} copyText={record.response.headers.length ? responseHeadersCopy : undefined} />
        {record.response.headers.length ? <HeaderTable key={`response-${record.meta.id}`} headers={record.response.headers} /> : <Text size={200} className="block !p-4 text-fui-fg3">{t("dashboard.requests.noResponseHeaders")}</Text>}
      </section>
      <section>
        <SectionHeader
          title={t("dashboard.requests.responseBody")}
          icon={<DocumentArrowDownRegular />}
          actions={record.response.body.type === "stream" ? (
            <TabList selectedValue={streamView} onTabSelect={(_, data) => setStreamView(data.value as "collected" | "events")} size="small">
              <Tab value="collected">{t("dashboard.requests.collected")}</Tab>
              <Tab value="events">{t("dashboard.requests.events", { count: streamEvents.length })}</Tab>
            </TabList>
          ) : undefined}
          copyText={record.response.body.type === "bytes" && responseBody.text
            ? responseBody.copyText
            : record.response.body.type === "stream" && streamView === "events"
              ? streamEventsCopyText(collectKind, streamEvents)
              : record.response.body.type === "stream" && streamView === "collected"
                ? collectedCopyText
                : undefined}
        />
        {record.response.body.type === "none" ? <Text size={200} className="block !p-4 text-fui-fg3">{t("dashboard.requests.noResponseBody")}</Text> : null}
        {record.response.body.type === "bytes" && (responseBody.text ? <CodeView body={responseBody} /> : <Text size={200} className="block !p-4 text-fui-fg3">{t("dashboard.requests.emptyBody")}</Text>)}
        {record.response.body.type === "stream" && streamView === "collected" && (
          collectKind === null ? <MessageBar intent="warning" className="!m-3"><MessageBarBody>{t("dashboard.requests.noCollector")}</MessageBarBody></MessageBar>
            : collected === null ? <div className="p-5"><Spinner size="tiny" /></div>
              : collected.error ? <MessageBar intent="error" className="!m-3"><MessageBarBody>{collected.error}</MessageBarBody></MessageBar>
                : <CodeView body={{ text: JSON.stringify(collected.result, null, 2), copyText: "", decodeError: null, isJson: true }} />
        )}
        {record.response.body.type === "stream" && streamView === "events" && renderedEvents.map((event, index) => (
          <div className={s.section} key={index}>
            <div className="flex items-center gap-2 px-4 pt-3"><Text size={100} className="font-mono text-fui-fg2">{event.event ?? t("dashboard.requests.unlabeled")}</Text>{event.parseError && <Text size={100} className={s.error}>{t("dashboard.requests.jsonParseFailed")}</Text>}<Text size={100} className="ml-auto font-mono text-fui-fg3">+{event.timestamp.toFixed(event.timestamp < 1 ? 3 : 0)}ms</Text></div>
            <CodeView body={{ text: event.text, copyText: event.text, decodeError: event.parseError, isJson: !event.parseError }} />
          </div>
        ))}
      </section>
    </div>
  );
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
