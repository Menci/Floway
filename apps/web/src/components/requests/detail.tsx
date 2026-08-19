import { useMemo, useState } from 'react';
import type { PropsWithChildren, ReactNode } from 'react';

import { type RenderedBody } from './body-render';
import { errorLabel, requestSeverity } from './format';
import { renderRunEvents } from './run-render';
import { detectCollectKind, type CollectedStream } from './stream-render';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { useDangerTextClass } from '../ui/danger';
import { EmptyStateLine } from '../ui/empty-state';
import { HttpMethodBadge, HttpStatusBadge } from '../ui/http-badge';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { highlight, prismTokenStyles } from '../ui/prism';
import { ScrollArea } from '../ui/scroll-area';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { copyOutcomeIcon, useCopyLabel, useCopyToClipboard } from '../ui/use-copy-to-clipboard';
import type { DumpRecord } from '@floway-dev/gateway/dump-types';

const { Text, makeStyles, mergeClasses } = fluentComponents;

// Region dividers take WinUI's divider brush (`colorNeutralStroke3`), not the
// control outline; the two only differ in the dark dictionary.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L53
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L257
//
// The band is the one surface here that fills: it holds still while the region
// below it scrolls, so it has to occlude. WinUI's counterpart is ContentDialog's
// fixed band over its scrolling content, `ContentDialogTopOverlay` =
// LayerFillColorAlt, which is #FFFFFF in light and #0DFFFFFF (WinUI ARGB) over
// the dialog's
// #202020 in dark -- the flat #FFFFFF/#2C2C2C that `colorNeutralBackground1`
// already carries. WinUI seams that band with CardStrokeColorDefault; the
// divider stands in because the card stroke is black-alpha and disappears into a
// dark surface, which is the reading every other separator in this dashboard
// takes.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L6-L8
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L61
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L265
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L46
const useStyles = makeStyles({
  sectionHeader: {
    alignItems: 'center',
    backgroundColor: 'var(--colorNeutralBackground1)',
    borderBottom: '1px solid var(--colorNeutralStroke3)',
    display: 'flex',
    gap: '8px',
    minHeight: '42px',
    padding: '5px 16px',
    position: 'sticky',
    top: 0,
    zIndex: 2,
  },
  // The seam between two sections is drawn by the body rather than by the
  // section box, so it lands on the same pixel row as the band's own seam once a
  // section scrolls past: `position: sticky` parks the band on its section's
  // bottom edge, and a border on the section box would sit one row below the
  // band's and read as a two-pixel rule for the length of that scroll.
  section: {
    '&:not(:last-child) > :last-child': { borderBottom: '1px solid var(--colorNeutralStroke3)' },
  },
  // No fill: a scrolling content region inside a surface takes the surface's
  // own, and painting the band's fill here made band and body one slab with the
  // seam lost inside it. WinUI fills a content region only where that region is
  // its own framed box -- the Expander's, at CardBackgroundFillColorSecondary --
  // and this one is the body of a section the band already heads.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L25-L26
  code: {
    color: 'var(--colorNeutralForeground1)',
    margin: 0,
    overflow: 'visible',
    padding: '14px 16px 18px',
    tabSize: 2,
    whiteSpace: 'pre',
  },
  highlightedCode: prismTokenStyles,
  headers: { borderCollapse: 'collapse', fontFamily: 'var(--fontFamilyMonospace)', fontSize: 'var(--floway-font-size-mono)', lineHeight: 'var(--floway-line-height-mono)', width: '100%' },
  headerRow: {
    borderBottom: '1px solid var(--colorNeutralStroke3)',
    ':last-child': { borderBottom: 'none' },
  },
  headerName: { color: 'var(--colorNeutralForeground3)', fontWeight: 'var(--fontWeightRegular)', padding: '7px 14px 7px 16px', textAlign: 'left', verticalAlign: 'top', whiteSpace: 'nowrap' },
  headerValue: { color: 'var(--colorNeutralForeground1)', overflowWrap: 'anywhere', padding: '7px 16px 7px 0', verticalAlign: 'top', whiteSpace: 'normal' },
});

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const { copy, outcomeFor } = useCopyToClipboard();
  const copyLabel = useCopyLabel();
  const label = copyLabel(outcomeFor(), t('common.copy.action'));
  return (
    <TooltipIconButton
      icon={copyOutcomeIcon(outcomeFor())}
      label={label}
      onClick={() => copy(text)}
    />
  );
}

function CodeView({ body }: { body: RenderedBody }) {
  const s = useStyles();
  const highlighted = useMemo(
    () => highlight(body.text, body.isJson ? 'json' : 'plain'),
    [body],
  );
  return <pre className={mergeClasses(s.code, `language-${body.isJson ? 'json' : 'plain'}`)}><code className={s.highlightedCode} dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>;
}

// Deliberately not `SectionHeader`: this bar is sticky and holds a fixed
// height, which that primitive's narrow-viewport rule would stack away, and it
// carries a detail slot beside the title that the primitive has no prop for.
function DetailSectionHeader({ title, detail, actions, copyText }: { title: string; detail?: ReactNode; actions?: ReactNode; copyText?: string }) {
  const s = useStyles();
  return <header className={s.sectionHeader}><div className="flex items-center gap-3 min-w-0"><Text as="h3" size={400} weight="semibold" className="m-0">{title}</Text>{detail}</div>{(actions !== undefined || copyText !== undefined) && <div className="ml-auto flex items-center gap-1">{actions}{copyText !== undefined && <CopyButton text={copyText} />}</div>}</header>;
}

function SectionBody({ children }: PropsWithChildren) {
  return <ScrollArea axes="horizontal" className="min-w-0" contentClassName="min-w-full w-max">{children}</ScrollArea>;
}

export function RequestDetailPanel({ collected: loadedCollected, error: loadedError, record: loadedRecord, recordId: selectedRecordId, retainLastRecord }: {
  collected: CollectedStream | null;
  error: string | null;
  record: DumpRecord | null;
  recordId: string | null;
  /** True when the surface outlives the selection: a drawer loses the record from the URL before its slide-out runs. */
  retainLastRecord: boolean;
}) {
  const { t } = useTranslation();
  const s = useStyles();
  const dangerText = useDangerTextClass();

  // Deriving the retained record during render rather than in an effect keeps
  // the swap out of the first frame of the leave animation.
  const [shown, setShown] = useState({ collected: loadedCollected, error: loadedError, record: loadedRecord, recordId: selectedRecordId });
  const incoming = retainLastRecord && selectedRecordId === null
    ? shown
    : { collected: loadedCollected, error: loadedError, record: loadedRecord, recordId: selectedRecordId };
  if (shown.recordId !== incoming.recordId) {
    setShown(incoming);
  } else if (shown.record !== incoming.record || shown.error !== incoming.error) {
    // Recollecting the same events only rebuilds an equal value, so a reload of
    // the same record keeps the collected stream and the tab showing it.
    setShown({ ...incoming, collected: shown.collected });
  }
  const { collected, error, record, recordId } = shown;

  // A record is a whole run — every stage, both directions — and its event stream is the whole
  // of what it holds.
  const runEvents = useMemo(() => (record ? renderRunEvents(record.events) : []), [record]);
  const collectKind = record ? detectCollectKind(record.meta.path) : null;
  const collectedCopyText = collected?.result === null || collected?.result === undefined
    ? undefined
    : JSON.stringify(collected.result, null, 2);

  if (!recordId) return <div className="grid h-full place-items-center p-4"><EmptyStateLine>{t('dashboard.requests.selectPrompt')}</EmptyStateLine></div>;
  // This replaces every section rather than sitting in one, so it takes the
  // panel inset. The bars further down are inside a section body and sit at 12;
  // that is a different placement, not a drift from this one.
  if (error) return <OutcomeMessageBar className="!m-4">{error}</OutcomeMessageBar>;
  if (!record) return null;

  const severity = requestSeverity(record.meta.status, record.meta.error);
  const responseError = errorLabel(record.meta.error);

  return (
    <ScrollArea axes="vertical" className="h-full" contentClassName="min-h-full" noTabIndex>
      <section>
        <DetailSectionHeader
          title={t('dashboard.requests.run')}
          detail={<>
            <HttpMethodBadge method={record.meta.method} />
            <Text size={300} className="font-mono">{record.meta.path}</Text>
            <HttpStatusBadge severity={severity}>{record.meta.status ?? t('dashboard.requests.noStatus')}</HttpStatusBadge>
            {responseError && <Text size={200} className={dangerText}>{responseError}</Text>}
          </>}
          copyText={record.events || undefined}
        />
        <SectionBody>
          {runEvents.length === 0 ? <EmptyStateLine className="p-4">{t('dashboard.requests.noRunEvents')}</EmptyStateLine> : runEvents.map((event, index) => (
            <div className={s.section} key={index}>
              <div className="flex items-center gap-2 px-4 pt-3">
                <Text size={100} className="font-mono mono-size-100 text-fui-fg2">{event.type || t('dashboard.requests.unlabeled')}</Text>
                {event.subject && <Text size={100} className="font-mono mono-size-100 text-fui-fg3">{event.subject}</Text>}
                {event.parseError && <Text size={100} className={dangerText}>{t('dashboard.requests.jsonParseFailed')}</Text>}
              </div>
              <CodeView body={{ text: event.text, copyText: event.text, decodeError: event.parseError, isJson: !event.parseError }} />
            </div>
          ))}
        </SectionBody>
      </section>
      {/* The frames are in the run's own stream above; what this adds is the one value they add
          up to, which is what a reader compares an answer against. A path no collector reads —
          an endpoint that never streams — says so rather than showing an empty section. */}
      <section className={s.section}>
        <DetailSectionHeader title={t('dashboard.requests.collected')} copyText={collectedCopyText} />
        <SectionBody>
          {collectKind === null
            ? <OutcomeMessageBar className="!m-3" intent="warning">{t('dashboard.requests.noCollector')}</OutcomeMessageBar>
            : collected === null ? <EmptyStateLine className="p-4">{t('dashboard.requests.noRunEvents')}</EmptyStateLine>
              : <>
                  {collected.error && <OutcomeMessageBar className="!m-3">{collected.error}</OutcomeMessageBar>}
                  {!collected.error && collected.truncated && <OutcomeMessageBar className="!m-3" intent="warning">{t('dashboard.requests.truncatedStream')}</OutcomeMessageBar>}
                  {collected.result !== null && <CodeView body={{ text: JSON.stringify(collected.result, null, 2), copyText: '', decodeError: null, isJson: true }} />}
                </>}
        </SectionBody>
      </section>
    </ScrollArea>
  );
}
