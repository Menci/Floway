import {
  ArrowLeft16Regular,
  Checkmark16Regular,
  CheckmarkCircle16Regular,
  ClipboardPaste16Regular,
  Copy16Regular,
  Delete16Regular,
  Dismiss16Regular,
  ErrorCircle16Regular,
  History16Regular,
  Warning16Regular,
} from '@fluentui/react-icons';
import { Fragment, useEffect, useId, useRef, useState, type Ref } from 'react';

import { EditorIconButton, useCopyEditorPortal } from './editor-icon-button';
import { useEditorTranslation } from './use-editor-t';
import { fluentComponents } from '../../fluent';
import { COPY_EDITOR_ROOT_ATTR } from '../../i18n/copy-editor/dom-registry';
import { useCopyEditorStore, type CopyDraftEntry } from '../../i18n/copy-editor/store';
import { supportedLanguages, type SupportedLanguage } from '../../i18n/languages';
import { dateTime, relativeTime, shortDate } from '../../lib/format-time';
import { useNow } from '../../lib/use-now';
import { copyToClipboard } from '../ui/copy-to-clipboard';

const { Button, Popover, PopoverSurface, PopoverTrigger, Text, Tooltip } = fluentComponents;

const SHORT_LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  'en': 'EN',
  'zh-Hans': '中文',
};

const MAX_HISTORY_PREVIEW_ROWS = 2;

interface PreviewSegment {
  id: string;
  text: string;
}

const getSessionPreviewSegments = (entry: CopyDraftEntry): PreviewSegment[] => {
  const segments: PreviewSegment[] = [];
  for (const language of supportedLanguages) {
    const after = entry.changes[language]?.after;
    if (after !== undefined) {
      const normalized = after.replace(/\s+/g, ' ').trim();
      if (normalized.length > 0) {
        segments.push({ id: `${entry.key}:${language}`, text: normalized });
      }
    }
  }
  if (segments.length === 0 && entry.note.trim().length > 0) {
    segments.push({ id: `${entry.key}:note`, text: entry.note.replace(/\s+/g, ' ').trim() });
  }
  return segments;
};

function StaleSourcePopover({
  mountNode,
  nextOriginal,
  previousOriginal,
  title,
}: {
  mountNode: HTMLElement | null;
  previousOriginal: string;
  nextOriginal: string;
  title: string;
}) {
  return (
    <Popover mountNode={mountNode} mouseLeaveDelay={120} openOnHover positioning={{ position: 'above', align: 'center' }} withArrow={false}>
      <PopoverTrigger disableButtonEnhancement>
        <button
          aria-label={title}
          className="floway-copy-editor-stale-trigger winui-focus-rect"
          type="button"
          onClick={event => event.stopPropagation()}
        >
          <Warning16Regular />
        </button>
      </PopoverTrigger>
      <PopoverSurface onClick={event => event.stopPropagation()}>
        <div className="floway-copy-editor-stale-popover">
          <Text size={200} weight="semibold">{title}</Text>
          <div className="floway-copy-editor-stale-diff">
            <span className="floway-copy-editor-diff-before">{previousOriginal}</span>
            <span className="floway-copy-editor-diff-after">{nextOriginal}</span>
          </div>
        </div>
      </PopoverSurface>
    </Popover>
  );
}

function ConfirmDeleteIconFlyout({
  actionLabel,
  align = 'end',
  cancelLabel,
  message,
  mountNode,
  onConfirm,
  position = 'below',
  title,
  triggerLabel,
}: {
  actionLabel: string;
  align?: 'start' | 'end';
  cancelLabel: string;
  message: string;
  mountNode: HTMLElement | null;
  onConfirm: () => void;
  position?: 'above' | 'below';
  title: string;
  triggerLabel: string;
}) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [tooltipVisible, setTooltipVisible] = useState(false);

  return (
    <Popover
      mountNode={mountNode}
      open={open}
      positioning={{ position, align }}
      trapFocus
      onOpenChange={(_, data) => {
        setOpen(data.open);
        setTooltipVisible(false);
      }}
    >
      <PopoverTrigger disableButtonEnhancement>
        {props => (
          <Tooltip
            content={triggerLabel}
            mountNode={mountNode}
            relationship="label"
            visible={!open && tooltipVisible}
            onVisibleChange={(_, data) => setTooltipVisible(!open && data.visible)}
          >
            <Button
              {...props}
              ref={props.ref as Ref<HTMLButtonElement>}
              appearance="subtle"
              aria-label={triggerLabel}
              as="button"
              icon={<Delete16Regular />}
              size="small"
            />
          </Tooltip>
        )}
      </PopoverTrigger>
      <PopoverSurface
        aria-labelledby={titleId}
        className="w-[min(320px,calc(100vw-32px))] grid gap-3 [overflow-wrap:anywhere]"
      >
        <Text id={titleId} weight="semibold">{title}</Text>
        <Text>{message}</Text>
        <div className="flex justify-end gap-2">
          <Button autoFocus onClick={() => setOpen(false)}>{cancelLabel}</Button>
          <Button
            appearance="primary"
            onClick={() => {
              onConfirm();
              setOpen(false);
            }}
          >
            {actionLabel}
          </Button>
        </div>
      </PopoverSurface>
    </Popover>
  );
}

function SessionPreviewLines({
  copiedLabel,
  copiedSegmentId,
  copyActionLabel,
  entries,
  moreLabel,
  onCopySegment,
  scopeKey,
}: {
  copiedLabel: string;
  copiedSegmentId: string | null;
  copyActionLabel: string;
  entries: CopyDraftEntry[];
  moreLabel: (count: number) => string;
  onCopySegment: (segmentId: string, text: string) => void;
  scopeKey: string;
}) {
  const visibleEntries = entries.slice(0, MAX_HISTORY_PREVIEW_ROWS);
  const extraCount = entries.length - visibleEntries.length;

  return (
    <div className="floway-copy-editor-batch-lines">
      {visibleEntries.map(item => {
        const segments = getSessionPreviewSegments(item);
        return (
          <div key={item.key} className="floway-copy-editor-batch-line">
            {segments.map((seg, index) => {
              const segId = `${scopeKey}:${seg.id}`;
              return (
                <Fragment key={segId}>
                  {index > 0 && (
                    <span aria-hidden="true" className="floway-copy-editor-batch-preview-sep">
                      {' / '}
                    </span>
                  )}
                  <span
                    className="floway-copy-editor-batch-preview-part"
                    data-copied={copiedSegmentId === segId ? 'true' : 'false'}
                    title={copiedSegmentId === segId ? copiedLabel : `${copyActionLabel}: ${seg.text}`}
                    onClick={event => {
                      event.stopPropagation();
                      onCopySegment(segId, seg.text);
                    }}
                  >
                    {seg.text}
                  </span>
                </Fragment>
              );
            })}
            <span
              className="floway-copy-editor-batch-key"
              data-leading={segments.length === 0 ? 'true' : 'false'}
              title={item.key}
            >
              {item.key}
            </span>
          </div>
        );
      })}
      {extraCount > 0 && (
        <span className="floway-copy-editor-batch-more">
          {moreLabel(extraCount)}
        </span>
      )}
    </div>
  );
}

const isInsideCopyEditor = (target: EventTarget | null): boolean => {
  if (!(target instanceof Node)) return false;
  let current: Node | null = target;
  while (current) {
    if (current instanceof Element && current.hasAttribute(COPY_EDITOR_ROOT_ATTR)) return true;
    current = current.parentNode;
  }
  return false;
};

export interface DraftsPanelProps {
  exportedNotice: boolean;
  onClearExportedNotice: () => void;
  onClose: () => void;
  onEditKey: (key: string) => void;
  onExported: () => void;
}

export function DraftsPanel({
  exportedNotice,
  onClearExportedNotice,
  onClose,
  onEditKey,
  onExported,
}: DraftsPanelProps) {
  const { t, i18n } = useEditorTranslation();
  const mountNode = useCopyEditorPortal();
  const now = useNow(30_000);
  const entriesMap = useCopyEditorStore(state => state.entries);
  const historySessions = useCopyEditorStore(state => state.history);
  const getOriginal = useCopyEditorStore(state => state.getOriginal);
  const revertEntry = useCopyEditorStore(state => state.revertEntry);
  const clearActive = useCopyEditorStore(state => state.clearActive);
  const buildExportPayload = useCopyEditorStore(state => state.buildExportPayload);
  const buildHistoryExportPayload = useCopyEditorStore(state => state.buildHistoryExportPayload);
  const archiveActiveAsExport = useCopyEditorStore(state => state.archiveActiveAsExport);
  const restoreHistorySession = useCopyEditorStore(state => state.restoreHistorySession);
  const deleteHistorySession = useCopyEditorStore(state => state.deleteHistorySession);
  const clearHistory = useCopyEditorStore(state => state.clearHistory);
  const importFromJson = useCopyEditorStore(state => state.importFromJson);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
  const [copiedSegmentId, setCopiedSegmentId] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
  }, []);

  // Dismiss the panel only when pointer or focus returns to the host page
  // outside the copy editor (keeping it open while focusing EditorFlyout,
  // internal popovers, the dock, or Alt+clicking page text).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.altKey) return;
      if (isInsideCopyEditor(event.target)) return;
      onClose();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target === document.body || event.target === document.documentElement) return;
      if (event.target instanceof Element && 'flowayClipboardHelper' in (event.target as HTMLElement).dataset) return;
      if (isInsideCopyEditor(event.target)) return;
      onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('focusin', onFocusIn, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('focusin', onFocusIn, true);
    };
  }, [onClose]);

  const activeEntries = Object.values(entriesMap).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const locale = i18n.language;

  // Opening the panel with no active edits goes straight to History edits;
  // when active edits exist it opens on Edits.
  const isRootHistory = activeEntries.length === 0 && historySessions.length > 0;
  const viewingHistory = isRootHistory || (showHistory && historySessions.length > 0);
  const showBackButton = viewingHistory && activeEntries.length > 0;

  const clearNotices = () => {
    setErrorNotice(null);
    onClearExportedNotice();
  };

  const handleExport = async () => {
    clearNotices();
    const payload = buildExportPayload();
    if (payload.entries.length === 0) return;
    const ok = await copyToClipboard(JSON.stringify(payload, null, 2));
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    if (!ok) {
      setCopyState('failed');
      setErrorNotice(t('common.copy.failed'));
      copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 2000);
      return;
    }
    archiveActiveAsExport(payload.exportedAt);
    setShowHistory(false);
    setCopyState('copied');
    onExported();
    copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1600);
  };

  const handleCopySession = async (sessionId: string) => {
    const payload = buildHistoryExportPayload(sessionId);
    if (!payload) return;
    const ok = await copyToClipboard(JSON.stringify(payload, null, 2));
    if (!ok) return;
    setCopiedSessionId(sessionId);
    window.setTimeout(() => {
      setCopiedSessionId(current => (current === sessionId ? null : current));
    }, 1500);
  };

  const handleCopySegment = (segmentId: string, text: string) => {
    void copyToClipboard(text).then(ok => {
      if (!ok) return;
      setCopiedSegmentId(segmentId);
      window.setTimeout(() => {
        setCopiedSegmentId(current => (current === segmentId ? null : current));
      }, 1200);
    });
  };

  const handleRestoreSession = (sessionId: string) => {
    clearNotices();
    restoreHistorySession(sessionId);
    setShowHistory(false);
  };

  const handlePasteImport = async () => {
    clearNotices();
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      setErrorNotice(t('common.copyEditor.pasteReadError'));
      return;
    }
    let rawText: string;
    try {
      rawText = await navigator.clipboard.readText();
    } catch {
      setErrorNotice(t('common.copyEditor.pasteReadError'));
      return;
    }
    if (rawText.trim().length === 0) {
      setErrorNotice(t('common.copyEditor.pasteEmptyError'));
      return;
    }
    try {
      const result = importFromJson(rawText);
      if (result.changed) {
        setShowHistory(false);
      }
    } catch (error) {
      setErrorNotice(t('common.copyEditor.importError', {
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const headerTitle = viewingHistory
    ? t('common.copyEditor.historyTitle')
    : t('common.copyEditor.panelTitle');

  return (
    <div
      ref={panelRef}
      aria-label={headerTitle}
      className="floway-copy-editor-surface floway-copy-editor-panel"
      role="dialog"
    >
      <div className="floway-copy-editor-header">
        <div className="floway-copy-editor-header-main">
          {showBackButton && (
            <EditorIconButton
              className="floway-copy-editor-header-back"
              icon={<ArrowLeft16Regular />}
              label={t('common.errors.back')}
              onClick={() => setShowHistory(false)}
            />
          )}
          <Text size={400} weight="semibold">{headerTitle}</Text>
        </div>
        <div className="floway-copy-editor-header-actions">
          {!viewingHistory && historySessions.length > 0 && (
            <EditorIconButton
              icon={<History16Regular />}
              label={t('common.copyEditor.historyTitle')}
              onClick={() => {
                clearNotices();
                setShowHistory(true);
              }}
            />
          )}
          <EditorIconButton
            icon={<ClipboardPaste16Regular />}
            label={t('common.copyEditor.pasteJson')}
            onClick={() => void handlePasteImport()}
          />
          {viewingHistory && historySessions.length > 0 && (
            <ConfirmDeleteIconFlyout
              actionLabel={t('common.copyEditor.deleteAllHistoryAction')}
              cancelLabel={t('common.cancel')}
              message={t('common.copyEditor.deleteAllHistoryMessage')}
              mountNode={mountNode}
              title={t('common.copyEditor.deleteAllHistoryTitle')}
              triggerLabel={t('common.copyEditor.deleteAllHistory')}
              onConfirm={() => {
                clearHistory();
                setShowHistory(false);
              }}
            />
          )}
          <EditorIconButton
            icon={<Dismiss16Regular />}
            label={t('common.copyEditor.close')}
            onClick={onClose}
          />
        </div>
      </div>

      {(errorNotice !== null || exportedNotice) && (
        <div
          className="floway-copy-editor-notice-bar"
          data-tone={errorNotice ? 'error' : 'success'}
          role={errorNotice ? 'alert' : 'status'}
        >
          {!errorNotice && <CheckmarkCircle16Regular className="flex-none" />}
          <span className="min-w-0 flex-1">
            {errorNotice ?? t('common.copyEditor.exportedNotice')}
          </span>
          <EditorIconButton
            icon={<Dismiss16Regular />}
            label={t('common.copyEditor.close')}
            onClick={clearNotices}
          />
        </div>
      )}

      {!viewingHistory ? (
        <>
          <div className="floway-copy-editor-body floway-copy-editor-body--list">
            {activeEntries.length === 0 ? (
              <div className="floway-copy-editor-empty">
                {t('common.copyEditor.emptyDrafts')}
              </div>
            ) : (
              activeEntries.map(entry => {
                const keyExists = supportedLanguages.some(lang => getOriginal(lang, entry.key) !== undefined);
                return (
                  <div
                    key={entry.key}
                    className={keyExists
                      ? 'floway-copy-editor-draft-item floway-copy-editor-interactive-item winui-focus-rect'
                      : 'floway-copy-editor-draft-item'}
                    role={keyExists ? 'button' : undefined}
                    tabIndex={keyExists ? 0 : undefined}
                    onClick={keyExists ? () => onEditKey(entry.key) : undefined}
                    onKeyDown={keyExists
                      ? event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onEditKey(entry.key);
                        }
                      }
                      : undefined}
                  >
                    <div className="floway-copy-editor-draft-head">
                      <span className="floway-copy-editor-draft-key-group">
                        <span
                          className="floway-copy-editor-draft-key"
                          data-missing={keyExists ? 'false' : 'true'}
                          title={entry.key}
                        >
                          {entry.key}
                        </span>
                        {!keyExists && (
                          <Tooltip
                            content={t('common.copyEditor.missingKeyNotice')}
                            mountNode={mountNode}
                            relationship="label"
                          >
                            <span
                              aria-label={t('common.copyEditor.missingKeyNotice')}
                              className="floway-copy-editor-missing-icon"
                            >
                              <ErrorCircle16Regular />
                            </span>
                          </Tooltip>
                        )}
                      </span>
                      <div
                        className="flex items-center gap-0.5 flex-none"
                        onClick={event => event.stopPropagation()}
                      >
                        <EditorIconButton
                          icon={<Delete16Regular />}
                          label={t('common.copyEditor.revert')}
                          onClick={() => revertEntry(entry.key)}
                        />
                      </div>
                    </div>

                    {Object.keys(entry.changes).length > 0 && (
                      <div className="floway-copy-editor-diff-list">
                        {supportedLanguages.map(language => {
                          const change = entry.changes[language];
                          if (!change) return null;
                          const currentOriginal = getOriginal(language, entry.key);
                          const isApplied = currentOriginal !== undefined && currentOriginal === change.after;
                          const isStale = currentOriginal !== undefined
                          && !isApplied
                          && currentOriginal !== change.before;
                          return (
                            <div key={language} className="floway-copy-editor-diff-row">
                              <span className="floway-copy-editor-diff-lang">
                                {SHORT_LANGUAGE_LABELS[language]}
                              </span>
                              <div className="floway-copy-editor-diff-values">
                                <span className="floway-copy-editor-diff-before-line">
                                  <span className="floway-copy-editor-diff-before">{change.before}</span>
                                  {isApplied && (
                                    <Tooltip
                                      content={t('common.copyEditor.appliedNotice')}
                                      mountNode={mountNode}
                                      relationship="label"
                                    >
                                      <span
                                        aria-label={t('common.copyEditor.appliedNotice')}
                                        className="floway-copy-editor-applied-icon"
                                        onClick={event => event.stopPropagation()}
                                      >
                                        <CheckmarkCircle16Regular />
                                      </span>
                                    </Tooltip>
                                  )}
                                  {isStale && (
                                    <StaleSourcePopover
                                      mountNode={mountNode}
                                      nextOriginal={currentOriginal}
                                      previousOriginal={change.before}
                                      title={t('common.copyEditor.staleNotice')}
                                    />
                                  )}
                                </span>
                                {change.after.length > 0 && (
                                  <span className="floway-copy-editor-diff-after">{change.after}</span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {entry.note.trim().length > 0 && (
                      <span className="floway-copy-editor-meta pr-1.5">{entry.note}</span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className="floway-copy-editor-footer">
            <div className="floway-copy-editor-footer-start">
              {activeEntries.length > 0 && (
                <ConfirmDeleteIconFlyout
                  actionLabel={t('common.copyEditor.discardEdits')}
                  align="start"
                  cancelLabel={t('common.cancel')}
                  message={t('common.copyEditor.discardEditsMessage')}
                  mountNode={mountNode}
                  position="above"
                  title={t('common.copyEditor.discardEditsTitle')}
                  triggerLabel={t('common.copyEditor.discardEdits')}
                  onConfirm={clearActive}
                />
              )}
            </div>
            <Button
              appearance="primary"
              disabled={activeEntries.length === 0}
              icon={copyState === 'copied' ? <Checkmark16Regular /> : <Copy16Regular />}
              onClick={() => void handleExport()}
            >
              {copyState === 'copied'
                ? t('common.copy.copied')
                : copyState === 'failed'
                  ? t('common.copy.failed')
                  : t('common.copyEditor.export')}
            </Button>
          </div>
        </>
      ) : (
        <div className="floway-copy-editor-body floway-copy-editor-body--list">
          {activeEntries.length > 0 && (
            <div
              className="floway-copy-editor-draft-item floway-copy-editor-interactive-item winui-focus-rect"
              data-current-session="true"
              role="button"
              tabIndex={0}
              onClick={() => setShowHistory(false)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setShowHistory(false);
                }
              }}
            >
              <div className="floway-copy-editor-draft-head">
                <span className="floway-copy-editor-batch-time">
                  {t('common.copyEditor.currentEdits')}
                </span>
                <div
                  className="flex items-center gap-0.5 flex-none"
                  onClick={event => event.stopPropagation()}
                >
                  <EditorIconButton
                    icon={copyState === 'copied' ? <Checkmark16Regular /> : <Copy16Regular />}
                    label={copyState === 'copied' ? t('common.copy.copied') : t('common.copyEditor.export')}
                    onClick={() => void handleExport()}
                  />
                  <ConfirmDeleteIconFlyout
                    actionLabel={t('common.copyEditor.discardEdits')}
                    cancelLabel={t('common.cancel')}
                    message={t('common.copyEditor.discardEditsMessage')}
                    mountNode={mountNode}
                    title={t('common.copyEditor.discardEditsTitle')}
                    triggerLabel={t('common.copyEditor.discardEdits')}
                    onConfirm={clearActive}
                  />
                </div>
              </div>
              <SessionPreviewLines
                copiedLabel={t('common.copy.copied')}
                copiedSegmentId={copiedSegmentId}
                copyActionLabel={t('common.copy.action')}
                entries={activeEntries}
                moreLabel={count => t('common.copyEditor.moreEdits', { count })}
                scopeKey="current"
                onCopySegment={handleCopySegment}
              />
            </div>
          )}

          {historySessions.map(session => {
            const archivedMs = Date.parse(session.archivedAt);
            const effectiveNow = Number.isNaN(archivedMs) ? now : Math.max(now, archivedMs);
            const relative = relativeTime(session.archivedAt, locale, { now: effectiveNow }) ?? shortDate(session.archivedAt, locale);
            return (
              <div
                key={session.id}
                className="floway-copy-editor-draft-item floway-copy-editor-interactive-item winui-focus-rect"
                role="button"
                tabIndex={0}
                onClick={() => handleRestoreSession(session.id)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    handleRestoreSession(session.id);
                  }
                }}
              >
                <div className="floway-copy-editor-draft-head">
                  <span
                    className="floway-copy-editor-batch-time"
                    title={dateTime(session.archivedAt, locale)}
                  >
                    {relative}
                  </span>
                  <div
                    className="flex items-center gap-0.5 flex-none"
                    onClick={event => event.stopPropagation()}
                  >
                    <EditorIconButton
                      icon={copiedSessionId === session.id ? <Checkmark16Regular /> : <Copy16Regular />}
                      label={copiedSessionId === session.id ? t('common.copy.copied') : t('common.copyEditor.export')}
                      onClick={() => void handleCopySession(session.id)}
                    />
                    <EditorIconButton
                      icon={<Delete16Regular />}
                      label={t('common.copyEditor.deleteHistory')}
                      onClick={() => deleteHistorySession(session.id)}
                    />
                  </div>
                </div>
                <SessionPreviewLines
                  copiedLabel={t('common.copy.copied')}
                  copiedSegmentId={copiedSegmentId}
                  copyActionLabel={t('common.copy.action')}
                  entries={session.entries}
                  moreLabel={count => t('common.copyEditor.moreEdits', { count })}
                  scopeKey={session.id}
                  onCopySegment={handleCopySegment}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
