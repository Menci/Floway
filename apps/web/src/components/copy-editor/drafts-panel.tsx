import {
  ArrowLeft16Regular,
  Checkmark16Regular,
  CheckmarkCircle16Regular,
  ClipboardPaste16Regular,
  Copy16Regular,
  Delete16Regular,
  Dismiss16Regular,
  History16Regular,
  Warning16Regular,
} from '@fluentui/react-icons';
import { Fragment, useEffect, useId, useRef, useState } from 'react';

import { useEditorTranslation } from './use-editor-t';
import { fluentComponents } from '../../fluent';
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

function ConfirmActionFlyout({
  actionLabel,
  align = 'end',
  appearance = 'subtle',
  cancelLabel,
  message,
  mountNode,
  onConfirm,
  position = 'below',
  size = 'small',
  title,
  triggerLabel,
}: {
  actionLabel: string;
  align?: 'start' | 'end';
  appearance?: 'subtle' | 'secondary';
  cancelLabel: string;
  message: string;
  mountNode: HTMLElement | null;
  onConfirm: () => void;
  position?: 'above' | 'below';
  size?: 'small' | 'medium';
  title: string;
  triggerLabel: string;
}) {
  const titleId = useId();
  const [open, setOpen] = useState(false);

  return (
    <Popover
      mountNode={mountNode}
      open={open}
      positioning={{ position, align }}
      trapFocus
      onOpenChange={(_, data) => setOpen(data.open)}
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button
          appearance={appearance}
          aria-label={triggerLabel}
          icon={<Delete16Regular />}
          size={size}
          title={triggerLabel}
        />
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
  copiedSegmentId,
  copyActionLabel,
  copiedLabel,
  entries,
  moreLabel,
  onCopySegment,
  scopeKey,
}: {
  copiedSegmentId: string | null;
  copyActionLabel: string;
  copiedLabel: string;
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
            <span className="floway-copy-editor-batch-key" title={item.key}>{item.key}</span>
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

export interface DraftsPanelProps {
  dockRef: React.RefObject<HTMLDivElement | null>;
  mountNode: HTMLElement | null;
  onClose: () => void;
  onEditKey: (key: string) => void;
}

export function DraftsPanel({ dockRef, mountNode, onClose, onEditKey }: DraftsPanelProps) {
  const { t, i18n } = useEditorTranslation();
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
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
  const [copiedSegmentId, setCopiedSegmentId] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
  }, []);

  // Close the panel when clicking anywhere outside the panel, its internal
  // popovers/flyouts, and the floating dock.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (mountNode?.contains(target)) return;
      if (dockRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [dockRef, mountNode, onClose]);

  const activeEntries = Object.values(entriesMap).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const locale = i18n.language;

  // Opening the panel with no active edits goes straight to History edits;
  // when active edits exist it opens on Edits.
  const isRootHistory = activeEntries.length === 0 && historySessions.length > 0;
  const viewingHistory = isRootHistory || (showHistory && historySessions.length > 0);
  const showBackButton = viewingHistory && activeEntries.length > 0;

  const handleExport = async () => {
    setPasteError(null);
    const payload = buildExportPayload();
    if (payload.entries.length === 0) return;
    const ok = await copyToClipboard(JSON.stringify(payload, null, 2));
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    if (!ok) {
      setCopyState('failed');
      copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 2000);
      return;
    }
    archiveActiveAsExport(payload.exportedAt);
    setShowHistory(false);
    setCopyState('copied');
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
    setPasteError(null);
    restoreHistorySession(sessionId);
    setShowHistory(false);
  };

  const handlePasteImport = async () => {
    setPasteError(null);
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      setPasteError(t('common.copyEditor.pasteReadError'));
      return;
    }
    let rawText: string;
    try {
      rawText = await navigator.clipboard.readText();
    } catch {
      setPasteError(t('common.copyEditor.pasteReadError'));
      return;
    }
    if (rawText.trim().length === 0) {
      setPasteError(t('common.copyEditor.pasteEmptyError'));
      return;
    }
    try {
      const result = importFromJson(rawText);
      if (result.changed) {
        setShowHistory(false);
      }
    } catch (error) {
      setPasteError(t('common.copyEditor.importError', {
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
            <Button
              appearance="subtle"
              aria-label={t('common.errors.back')}
              className="floway-copy-editor-header-back"
              icon={<ArrowLeft16Regular />}
              size="small"
              onClick={() => setShowHistory(false)}
            />
          )}
          <Text size={400} weight="semibold">{headerTitle}</Text>
        </div>
        <div className="floway-copy-editor-header-actions">
          {!viewingHistory && historySessions.length > 0 && (
            <Button
              appearance="subtle"
              aria-label={t('common.copyEditor.historyTitle')}
              icon={<History16Regular />}
              size="small"
              title={t('common.copyEditor.historyTitle')}
              onClick={() => {
                setPasteError(null);
                setShowHistory(true);
              }}
            />
          )}
          <Button
            appearance="subtle"
            aria-label={t('common.copyEditor.pasteJson')}
            icon={<ClipboardPaste16Regular />}
            size="small"
            title={t('common.copyEditor.pasteJson')}
            onClick={() => void handlePasteImport()}
          />
          {viewingHistory && historySessions.length > 0 && (
            <ConfirmActionFlyout
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
          <Button
            appearance="subtle"
            aria-label={t('common.copyEditor.close')}
            icon={<Dismiss16Regular />}
            size="small"
            onClick={onClose}
          />
        </div>
      </div>

      {pasteError && (
        <div className="floway-copy-editor-error-bar" role="alert">
          <span className="min-w-0 flex-1">{pasteError}</span>
          <Button
            appearance="subtle"
            aria-label={t('common.copyEditor.close')}
            icon={<Dismiss16Regular />}
            size="small"
            onClick={() => setPasteError(null)}
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
              activeEntries.map(entry => (
                <div
                  key={entry.key}
                  className="floway-copy-editor-draft-item floway-copy-editor-interactive-item winui-focus-rect"
                  role="button"
                  tabIndex={0}
                  onClick={() => onEditKey(entry.key)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onEditKey(entry.key);
                    }
                  }}
                >
                  <div className="floway-copy-editor-draft-head">
                    <span className="floway-copy-editor-draft-key" title={entry.key}>
                      {entry.key}
                    </span>
                    <div
                      className="flex items-center gap-0.5 flex-none"
                      onClick={event => event.stopPropagation()}
                    >
                      <Button
                        appearance="subtle"
                        aria-label={t('common.copyEditor.revert')}
                        icon={<Delete16Regular />}
                        size="small"
                        title={t('common.copyEditor.revert')}
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
              ))
            )}
          </div>

          <div className="floway-copy-editor-footer">
            <div className="floway-copy-editor-footer-start">
              {activeEntries.length > 0 && (
                <ConfirmActionFlyout
                  actionLabel={t('common.copyEditor.discardEdits')}
                  align="start"
                  appearance="secondary"
                  cancelLabel={t('common.cancel')}
                  message={t('common.copyEditor.discardEditsMessage')}
                  mountNode={mountNode}
                  position="above"
                  size="medium"
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
                  <Button
                    appearance="subtle"
                    aria-label={copyState === 'copied' ? t('common.copy.copied') : t('common.copyEditor.export')}
                    icon={copyState === 'copied' ? <Checkmark16Regular /> : <Copy16Regular />}
                    size="small"
                    title={copyState === 'copied' ? t('common.copy.copied') : t('common.copyEditor.export')}
                    onClick={() => void handleExport()}
                  />
                  <ConfirmActionFlyout
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
            const relative = relativeTime(session.archivedAt, locale, { now }) ?? shortDate(session.archivedAt, locale);
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
                    <Button
                      appearance="subtle"
                      aria-label={copiedSessionId === session.id ? t('common.copy.copied') : t('common.copyEditor.export')}
                      icon={copiedSessionId === session.id ? <Checkmark16Regular /> : <Copy16Regular />}
                      size="small"
                      title={copiedSessionId === session.id ? t('common.copy.copied') : t('common.copyEditor.export')}
                      onClick={() => void handleCopySession(session.id)}
                    />
                    <Button
                      appearance="subtle"
                      aria-label={t('common.copyEditor.deleteHistory')}
                      icon={<Delete16Regular />}
                      size="small"
                      title={t('common.copyEditor.deleteHistory')}
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
