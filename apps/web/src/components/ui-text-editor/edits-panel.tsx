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

import { EditorIconButton, useUiTextEditorPortal } from './editor-icon-button';
import { useEditorTranslation } from './use-editor-t';
import { fluentComponents } from '../../fluent';
import { supportedLanguages } from '../../i18n/languages';
import { isInsideUiTextEditor } from '../../i18n/ui-text-editor/dom-registry';
import { getAltKeyLabel } from '../../i18n/ui-text-editor/mirror';
import {
  SHORT_LANGUAGE_LABELS,
  useUiTextEditorStore,
  type UiTextEditEntry,
} from '../../i18n/ui-text-editor/store';
import { dateTime, relativeTime, shortDate } from '../../lib/format-time';
import { useNow } from '../../lib/use-now';
import { copyToClipboard } from '../ui/copy-to-clipboard';
import { useCopyToClipboard } from '../ui/use-copy-to-clipboard';

const { Button, Popover, PopoverSurface, PopoverTrigger, Text, Tooltip } = fluentComponents;

const MAX_HISTORY_PREVIEW_ROWS = 2;

interface PreviewSegment {
  id: string;
  text: string;
}

const getSessionPreviewSegments = (entry: UiTextEditEntry): PreviewSegment[] => {
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
          className="floway-ui-text-editor-stale-trigger winui-focus-rect"
          type="button"
          onClick={event => event.stopPropagation()}
        >
          <Warning16Regular />
        </button>
      </PopoverTrigger>
      <PopoverSurface onClick={event => event.stopPropagation()}>
        <div className="floway-ui-text-editor-stale-popover">
          <Text size={200} weight="semibold">{title}</Text>
          <div className="floway-ui-text-editor-stale-diff">
            <span className="floway-ui-text-editor-diff-before">{previousOriginal}</span>
            <span className="floway-ui-text-editor-diff-after">{nextOriginal}</span>
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
  align?: 'start' | 'end' | undefined;
  cancelLabel: string;
  message: string;
  mountNode: HTMLElement | null;
  onConfirm: () => void;
  position?: 'above' | 'below' | undefined;
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
        {({ disabled, ...props }) => (
          <Tooltip
            content={triggerLabel}
            mountNode={mountNode}
            relationship="label"
            visible={!open && tooltipVisible}
            onVisibleChange={(_, data) => setTooltipVisible(!open && data.visible)}
          >
            <Button
              {...props}
              {...(disabled === undefined ? {} : { disabled })}
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
  entries: UiTextEditEntry[];
  moreLabel: (count: number) => string;
  onCopySegment: (segmentId: string, text: string) => void;
  scopeKey: string;
}) {
  const visibleEntries = entries.slice(0, MAX_HISTORY_PREVIEW_ROWS);
  const extraCount = entries.length - visibleEntries.length;

  return (
    <div className="floway-ui-text-editor-session-lines">
      {visibleEntries.map(item => {
        const segments = getSessionPreviewSegments(item);
        return (
          <div key={item.key} className="floway-ui-text-editor-session-line">
            {segments.map((seg, index) => {
              const segId = `${scopeKey}:${seg.id}`;
              return (
                <Fragment key={segId}>
                  {index > 0 && (
                    <span aria-hidden="true" className="floway-ui-text-editor-session-preview-sep">
                      {' / '}
                    </span>
                  )}
                  <button
                    className="floway-ui-text-editor-session-preview-part winui-focus-rect"
                    data-copied={copiedSegmentId === segId ? 'true' : 'false'}
                    title={copiedSegmentId === segId ? copiedLabel : `${copyActionLabel}: ${seg.text}`}
                    type="button"
                    onClick={event => {
                      event.stopPropagation();
                      onCopySegment(segId, seg.text);
                    }}
                  >
                    {seg.text}
                  </button>
                </Fragment>
              );
            })}
            <span
              className="floway-ui-text-editor-session-key"
              data-leading={segments.length === 0 ? 'true' : 'false'}
              title={item.key}
            >
              {item.key}
            </span>
          </div>
        );
      })}
      {extraCount > 0 && (
        <span className="floway-ui-text-editor-session-more">
          {moreLabel(extraCount)}
        </span>
      )}
    </div>
  );
}

export interface EditsPanelProps {
  exportedNotice: boolean;
  onClearExportedNotice: () => void;
  onClose: () => void;
  onEditKey: (key: string) => void;
  onExportActive: () => Promise<'empty' | 'copied' | 'failed'>;
}

export function EditsPanel({
  exportedNotice,
  onClearExportedNotice,
  onClose,
  onEditKey,
  onExportActive,
}: EditsPanelProps) {
  const { t, i18n } = useEditorTranslation();
  const mountNode = useUiTextEditorPortal();
  const now = useNow(30_000);
  const entriesMap = useUiTextEditorStore(state => state.entries);
  const historySessions = useUiTextEditorStore(state => state.history);
  const getOriginal = useUiTextEditorStore(state => state.getOriginal);
  const revertEntry = useUiTextEditorStore(state => state.revertEntry);
  const clearActive = useUiTextEditorStore(state => state.clearActive);
  const buildHistoryExportPayload = useUiTextEditorStore(state => state.buildHistoryExportPayload);
  const restoreHistorySession = useUiTextEditorStore(state => state.restoreHistorySession);
  const deleteHistorySession = useUiTextEditorStore(state => state.deleteHistorySession);
  const clearHistory = useUiTextEditorStore(state => state.clearHistory);
  const importFromJson = useUiTextEditorStore(state => state.importFromJson);

  const [showHistory, setShowHistory] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const sessionCopy = useCopyToClipboard();
  const [copiedSegmentId, setCopiedSegmentId] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const segmentTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    if (segmentTimerRef.current !== null) window.clearTimeout(segmentTimerRef.current);
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.altKey) return;
      if (isInsideUiTextEditor(event.target)) return;
      onClose();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target === document.body || event.target === document.documentElement) return;
      if (event.target instanceof Element && 'flowayClipboardHelper' in (event.target as HTMLElement).dataset) return;
      if (isInsideUiTextEditor(event.target)) return;
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

  const isRootHistory = activeEntries.length === 0 && historySessions.length > 0;
  const viewingHistory = isRootHistory || (showHistory && historySessions.length > 0);
  const showBackButton = viewingHistory && activeEntries.length > 0;

  const clearNotices = () => {
    setErrorNotice(null);
    onClearExportedNotice();
  };

  const handleExport = async () => {
    clearNotices();
    const outcome = await onExportActive();
    if (outcome === 'empty') return;
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    if (outcome === 'failed') {
      setCopyState('failed');
      setErrorNotice(t('common.copy.failed'));
      copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 2000);
      return;
    }
    setShowHistory(false);
    setCopyState('copied');
    copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1600);
  };

  const handleCopySession = (sessionId: string) => {
    const payload = buildHistoryExportPayload(sessionId);
    if (!payload) return;
    sessionCopy.copy(JSON.stringify(payload, null, 2), sessionId);
  };

  const handleCopySegment = (segmentId: string, text: string) => {
    void copyToClipboard(text).then(ok => {
      if (!ok) return;
      setCopiedSegmentId(segmentId);
      if (segmentTimerRef.current !== null) window.clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = window.setTimeout(() => {
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
      setErrorNotice(t('common.uiTextEditor.pasteReadError'));
      return;
    }
    let rawText: string;
    try {
      rawText = await navigator.clipboard.readText();
    } catch {
      setErrorNotice(t('common.uiTextEditor.pasteReadError'));
      return;
    }
    if (rawText.trim().length === 0) {
      setErrorNotice(t('common.uiTextEditor.pasteEmptyError'));
      return;
    }
    try {
      const result = importFromJson(rawText);
      if (result.changed) {
        setShowHistory(false);
      }
    } catch (error) {
      setErrorNotice(t('common.uiTextEditor.importError', {
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const headerTitle = viewingHistory
    ? t('common.uiTextEditor.historyTitle')
    : t('common.uiTextEditor.panelTitle');

  return (
    <div
      aria-label={headerTitle}
      className="floway-ui-text-editor-surface floway-ui-text-editor-panel"
      role="dialog"
    >
      <div className="floway-ui-text-editor-header">
        <div className="floway-ui-text-editor-header-main">
          {showBackButton && (
            <EditorIconButton
              className="floway-ui-text-editor-header-back"
              icon={<ArrowLeft16Regular />}
              label={t('common.errors.back')}
              onClick={() => setShowHistory(false)}
            />
          )}
          <Text size={400} weight="semibold">{headerTitle}</Text>
        </div>
        <div className="floway-ui-text-editor-header-actions">
          {!viewingHistory && historySessions.length > 0 && (
            <EditorIconButton
              icon={<History16Regular />}
              label={t('common.uiTextEditor.historyTitle')}
              onClick={() => {
                clearNotices();
                setShowHistory(true);
              }}
            />
          )}
          <EditorIconButton
            icon={<ClipboardPaste16Regular />}
            label={t('common.uiTextEditor.pasteJson')}
            onClick={() => void handlePasteImport()}
          />
          {viewingHistory && historySessions.length > 0 && (
            <ConfirmDeleteIconFlyout
              actionLabel={t('common.uiTextEditor.deleteAllHistoryAction')}
              cancelLabel={t('common.cancel')}
              message={t('common.uiTextEditor.deleteAllHistoryMessage')}
              mountNode={mountNode}
              title={t('common.uiTextEditor.deleteAllHistoryTitle')}
              triggerLabel={t('common.uiTextEditor.deleteAllHistory')}
              onConfirm={() => {
                clearHistory();
                setShowHistory(false);
              }}
            />
          )}
          <EditorIconButton
            icon={<Dismiss16Regular />}
            label={t('common.uiTextEditor.close')}
            onClick={onClose}
          />
        </div>
      </div>

      {(errorNotice !== null || exportedNotice) && (
        <div
          className="floway-ui-text-editor-notice-bar"
          data-tone={errorNotice ? 'error' : 'success'}
          role={errorNotice ? 'alert' : 'status'}
        >
          {!errorNotice && <CheckmarkCircle16Regular className="flex-none" />}
          <span className="min-w-0 flex-1">
            {errorNotice ?? t('common.uiTextEditor.exportedNotice')}
          </span>
          <EditorIconButton
            icon={<Dismiss16Regular />}
            label={t('common.uiTextEditor.close')}
            onClick={clearNotices}
          />
        </div>
      )}

      {!viewingHistory ? (
        <>
          <div className="floway-ui-text-editor-body floway-ui-text-editor-body--list">
            {activeEntries.length === 0 ? (
              <div className="floway-ui-text-editor-empty">
                {t('common.uiTextEditor.emptyHint', { key: getAltKeyLabel() })}
              </div>
            ) : (
              activeEntries.map(entry => {
                const keyExists = supportedLanguages.some(lang => getOriginal(lang, entry.key) !== undefined);
                return (
                  <div
                    key={entry.key}
                    className={keyExists
                      ? 'floway-ui-text-editor-entry-item floway-ui-text-editor-interactive-item winui-focus-rect'
                      : 'floway-ui-text-editor-entry-item'}
                    role={keyExists ? 'button' : undefined}
                    tabIndex={keyExists ? 0 : undefined}
                    onClick={keyExists ? () => onEditKey(entry.key) : undefined}
                    onKeyDown={keyExists
                      ? event => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onEditKey(entry.key);
                        }
                      }
                      : undefined}
                  >
                    <div className="floway-ui-text-editor-entry-head">
                      <span className="floway-ui-text-editor-entry-key-group">
                        <span
                          className="floway-ui-text-editor-entry-key"
                          data-missing={keyExists ? 'false' : 'true'}
                          title={entry.key}
                        >
                          {entry.key}
                        </span>
                        {!keyExists && (
                          <Tooltip
                            content={t('common.uiTextEditor.missingKeyNotice')}
                            mountNode={mountNode}
                            relationship="label"
                          >
                            <span
                              aria-label={t('common.uiTextEditor.missingKeyNotice')}
                              className="floway-ui-text-editor-missing-icon"
                              role="img"
                            >
                              <ErrorCircle16Regular />
                            </span>
                          </Tooltip>
                        )}
                      </span>
                      <div
                        className="floway-ui-text-editor-header-actions"
                        onClick={event => event.stopPropagation()}
                      >
                        <EditorIconButton
                          icon={<Delete16Regular />}
                          label={t('common.uiTextEditor.delete')}
                          onClick={() => revertEntry(entry.key)}
                        />
                      </div>
                    </div>

                    {Object.keys(entry.changes).length > 0 && (
                      <div className="floway-ui-text-editor-diff-list">
                        {supportedLanguages.map(language => {
                          const change = entry.changes[language];
                          if (!change) return null;
                          const currentOriginal = getOriginal(language, entry.key);
                          const alreadyApplied = currentOriginal !== undefined && currentOriginal === change.after;
                          const drifted = currentOriginal !== undefined
                            && !alreadyApplied
                            && currentOriginal !== change.before;
                          return (
                            <div key={language} className="floway-ui-text-editor-diff-row">
                              <span className="floway-ui-text-editor-diff-lang">
                                {SHORT_LANGUAGE_LABELS[language]}
                              </span>
                              <div className="floway-ui-text-editor-diff-values">
                                <span className="floway-ui-text-editor-diff-before-line">
                                  <span className="floway-ui-text-editor-diff-before">{change.before}</span>
                                  {alreadyApplied && (
                                    <Tooltip
                                      content={t('common.uiTextEditor.appliedNotice')}
                                      mountNode={mountNode}
                                      relationship="label"
                                    >
                                      <span
                                        aria-label={t('common.uiTextEditor.appliedNotice')}
                                        className="floway-ui-text-editor-applied-icon"
                                        role="img"
                                      >
                                        <CheckmarkCircle16Regular />
                                      </span>
                                    </Tooltip>
                                  )}
                                  {drifted && (
                                    <StaleSourcePopover
                                      mountNode={mountNode}
                                      nextOriginal={currentOriginal}
                                      previousOriginal={change.before}
                                      title={t('common.uiTextEditor.staleNotice')}
                                    />
                                  )}
                                </span>
                                {!alreadyApplied && (
                                  <span className="floway-ui-text-editor-diff-after">{change.after}</span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {entry.note.trim().length > 0 && (
                      <span className="floway-ui-text-editor-meta pr-1.5">{entry.note}</span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className="floway-ui-text-editor-footer">
            <div className="floway-ui-text-editor-footer-start">
              {activeEntries.length > 0 && (
                <ConfirmDeleteIconFlyout
                  actionLabel={t('common.uiTextEditor.discardEdits')}
                  align="start"
                  cancelLabel={t('common.cancel')}
                  message={t('common.uiTextEditor.discardEditsMessage')}
                  mountNode={mountNode}
                  position="above"
                  title={t('common.uiTextEditor.discardEditsTitle')}
                  triggerLabel={t('common.uiTextEditor.discardEdits')}
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
                  : t('common.uiTextEditor.export')}
            </Button>
          </div>
        </>
      ) : (
        <div className="floway-ui-text-editor-body floway-ui-text-editor-body--list">
          {activeEntries.length > 0 && (
            <div
              className="floway-ui-text-editor-entry-item floway-ui-text-editor-interactive-item winui-focus-rect"
              role="button"
              tabIndex={0}
              onClick={() => setShowHistory(false)}
              onKeyDown={event => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setShowHistory(false);
                }
              }}
            >
              <div className="floway-ui-text-editor-entry-head">
                <span className="floway-ui-text-editor-session-time">
                  {t('common.uiTextEditor.currentEdits')}
                </span>
                <div
                  className="floway-ui-text-editor-header-actions"
                  onClick={event => event.stopPropagation()}
                >
                  <EditorIconButton
                    icon={copyState === 'copied' ? <Checkmark16Regular /> : <Copy16Regular />}
                    label={copyState === 'copied' ? t('common.copy.copied') : t('common.uiTextEditor.export')}
                    onClick={() => void handleExport()}
                  />
                  <ConfirmDeleteIconFlyout
                    actionLabel={t('common.uiTextEditor.discardEdits')}
                    cancelLabel={t('common.cancel')}
                    message={t('common.uiTextEditor.discardEditsMessage')}
                    mountNode={mountNode}
                    title={t('common.uiTextEditor.discardEditsTitle')}
                    triggerLabel={t('common.uiTextEditor.discardEdits')}
                    onConfirm={clearActive}
                  />
                </div>
              </div>
              <SessionPreviewLines
                copiedLabel={t('common.copy.copied')}
                copiedSegmentId={copiedSegmentId}
                copyActionLabel={t('common.copy.action')}
                entries={activeEntries}
                moreLabel={count => t('common.uiTextEditor.moreEdits', { count })}
                scopeKey="current"
                onCopySegment={handleCopySegment}
              />
            </div>
          )}

          {historySessions.map(session => {
            const archivedMs = Date.parse(session.archivedAt);
            const validDate = !Number.isNaN(archivedMs);
            const rel = validDate
              ? relativeTime(session.archivedAt, locale, { now: Math.max(now, archivedMs) })
              : session.archivedAt;
            const timeLabel = rel ?? shortDate(session.archivedAt, locale);
            const titleText = validDate ? dateTime(session.archivedAt, locale) : session.archivedAt;
            return (
              <div
                key={session.id}
                className="floway-ui-text-editor-entry-item floway-ui-text-editor-interactive-item winui-focus-rect"
                role="button"
                tabIndex={0}
                onClick={() => handleRestoreSession(session.id)}
                onKeyDown={event => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    handleRestoreSession(session.id);
                  }
                }}
              >
                <div className="floway-ui-text-editor-entry-head">
                  <span
                    className="floway-ui-text-editor-session-time"
                    title={titleText}
                  >
                    {timeLabel}
                  </span>
                  <div
                    className="floway-ui-text-editor-header-actions"
                    onClick={event => event.stopPropagation()}
                  >
                    <EditorIconButton
                      icon={sessionCopy.outcomeFor(session.id) === 'copied' ? <Checkmark16Regular /> : <Copy16Regular />}
                      label={sessionCopy.outcomeFor(session.id) === 'copied' ? t('common.copy.copied') : t('common.uiTextEditor.export')}
                      onClick={() => handleCopySession(session.id)}
                    />
                    <EditorIconButton
                      icon={<Delete16Regular />}
                      label={t('common.uiTextEditor.deleteHistory')}
                      onClick={() => deleteHistorySession(session.id)}
                    />
                  </div>
                </div>
                <SessionPreviewLines
                  copiedLabel={t('common.copy.copied')}
                  copiedSegmentId={copiedSegmentId}
                  copyActionLabel={t('common.copy.action')}
                  entries={session.entries}
                  moreLabel={count => t('common.uiTextEditor.moreEdits', { count })}
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
