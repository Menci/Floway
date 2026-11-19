import {
  ArrowImport16Regular,
  ArrowLeft16Regular,
  ArrowUndo16Regular,
  Checkmark16Regular,
  Copy16Regular,
  Delete16Regular,
  Dismiss16Regular,
  Edit16Regular,
  History16Regular,
  Warning16Regular,
} from '@fluentui/react-icons';
import { useEffect, useId, useRef, useState } from 'react';

import { useEditorTranslation } from './use-editor-t';
import { fluentComponents } from '../../fluent';
import { useCopyEditorStore, type CopyDraftEntry } from '../../i18n/copy-editor/store';
import { supportedLanguages, type SupportedLanguage } from '../../i18n/languages';
import { dateTime, relativeTime, shortDate } from '../../lib/format-time';
import { useNow } from '../../lib/use-now';
import { copyToClipboard } from '../ui/copy-to-clipboard';
import { Textarea } from '../ui/fluent-form-controls';

const { Button, Popover, PopoverSurface, PopoverTrigger, Text } = fluentComponents;

const SHORT_LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  'en': 'EN',
  'zh-Hans': '中文',
};

const formatBatchPreview = (entry: CopyDraftEntry): string => {
  const parts: string[] = [];
  for (const language of supportedLanguages) {
    const after = entry.changes[language]?.after;
    if (after !== undefined) {
      parts.push(after.replace(/\s+/g, ' ').trim());
    }
  }
  if (parts.length === 0 && entry.note.trim().length > 0) {
    parts.push(entry.note.replace(/\s+/g, ' ').trim());
  }
  return parts.join(' / ');
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
    <Popover mountNode={mountNode} positioning={{ position: 'above', align: 'center' }} withArrow={false}>
      <PopoverTrigger disableButtonEnhancement>
        <button
          aria-label={title}
          className="floway-copy-editor-stale-trigger winui-focus-rect"
          title={title}
          type="button"
        >
          <Warning16Regular />
        </button>
      </PopoverTrigger>
      <PopoverSurface>
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

function DeleteAllExportsFlyout({
  actionLabel,
  cancelLabel,
  message,
  mountNode,
  onConfirm,
  title,
  triggerLabel,
}: {
  actionLabel: string;
  cancelLabel: string;
  message: string;
  mountNode: HTMLElement | null;
  onConfirm: () => void;
  title: string;
  triggerLabel: string;
}) {
  const titleId = useId();
  const [open, setOpen] = useState(false);

  return (
    <Popover
      mountNode={mountNode}
      open={open}
      positioning={{ position: 'below', align: 'end' }}
      trapFocus
      onOpenChange={(_, data) => setOpen(data.open)}
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button
          appearance="subtle"
          aria-label={triggerLabel}
          icon={<Delete16Regular />}
          size="small"
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

export interface DraftsPanelProps {
  mountNode: HTMLElement | null;
  onClose: () => void;
  onEditKey: (key: string, route: string) => void;
}

type PanelView = 'list' | 'exported' | 'import';

export function DraftsPanel({ mountNode, onClose, onEditKey }: DraftsPanelProps) {
  const { t, i18n } = useEditorTranslation();
  const now = useNow(30_000);
  const entriesMap = useCopyEditorStore(state => state.entries);
  const exportedBatches = useCopyEditorStore(state => state.exports);
  const getOriginal = useCopyEditorStore(state => state.getOriginal);
  const revertEntry = useCopyEditorStore(state => state.revertEntry);
  const clearActive = useCopyEditorStore(state => state.clearActive);
  const buildExportPayload = useCopyEditorStore(state => state.buildExportPayload);
  const buildBatchExportPayload = useCopyEditorStore(state => state.buildBatchExportPayload);
  const archiveActiveAsExport = useCopyEditorStore(state => state.archiveActiveAsExport);
  const restoreExportBatch = useCopyEditorStore(state => state.restoreExportBatch);
  const deleteExportBatch = useCopyEditorStore(state => state.deleteExportBatch);
  const clearExports = useCopyEditorStore(state => state.clearExports);
  const importFromJson = useCopyEditorStore(state => state.importFromJson);

  const [view, setView] = useState<PanelView>('list');
  const [importText, setImportText] = useState('');
  const [importStatus, setImportStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [copiedBatchId, setCopiedBatchId] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
  }, []);

  const activeEntries = Object.values(entriesMap).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const locale = i18n.language;

  const handleExport = async () => {
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
    setCopyState('copied');
    copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1600);
  };

  const handleCopyBatch = async (batchId: string) => {
    const payload = buildBatchExportPayload(batchId);
    if (!payload) return;
    const ok = await copyToClipboard(JSON.stringify(payload, null, 2));
    if (!ok) return;
    setCopiedBatchId(batchId);
    window.setTimeout(() => {
      setCopiedBatchId(current => (current === batchId ? null : current));
    }, 1500);
  };

  const handleRestoreBatch = (batchId: string) => {
    restoreExportBatch(batchId);
    setView('list');
  };

  const handleImport = () => {
    try {
      const result = importFromJson(importText);
      setImportStatus({
        ok: true,
        text: t('common.copyEditor.importSuccess', {
          imported: result.imported,
          skipped: result.skippedUpToDate,
        }),
      });
      setImportText('');
      if (result.imported > 0) setView('list');
    } catch (error) {
      setImportStatus({
        ok: false,
        text: t('common.copyEditor.importError', {
          message: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  };

  const headerTitle = view === 'list'
    ? t('common.copyEditor.panelTitle')
    : view === 'exported'
      ? t('common.copyEditor.exportedTitle')
      : t('common.copyEditor.importTitle');

  return (
    <div
      aria-label={headerTitle}
      className="floway-copy-editor-surface floway-copy-editor-panel"
      role="dialog"
    >
      <div className="floway-copy-editor-header">
        <div className="floway-copy-editor-header-main">
          {view !== 'list' && (
            <Button
              appearance="subtle"
              aria-label={t('common.errors.back')}
              className="floway-copy-editor-header-back"
              icon={<ArrowLeft16Regular />}
              size="small"
              onClick={() => setView('list')}
            />
          )}
          <Text size={400} weight="semibold">{headerTitle}</Text>
        </div>
        <div className="floway-copy-editor-header-actions">
          {view === 'list' && exportedBatches.length > 0 && (
            <Button
              appearance="subtle"
              aria-label={t('common.copyEditor.exportedTitle')}
              icon={<History16Regular />}
              size="small"
              title={t('common.copyEditor.exportedTitle')}
              onClick={() => setView('exported')}
            />
          )}
          {view === 'list' && (
            <Button
              appearance="subtle"
              aria-label={t('common.copyEditor.importTitle')}
              icon={<ArrowImport16Regular />}
              size="small"
              title={t('common.copyEditor.importTitle')}
              onClick={() => setView('import')}
            />
          )}
          {view === 'exported' && exportedBatches.length > 0 && (
            <DeleteAllExportsFlyout
              actionLabel={t('common.copyEditor.deleteAllExportsAction')}
              cancelLabel={t('common.cancel')}
              message={t('common.copyEditor.deleteAllExportsMessage')}
              mountNode={mountNode}
              title={t('common.copyEditor.deleteAllExportsTitle')}
              triggerLabel={t('common.copyEditor.deleteAllExports')}
              onConfirm={() => {
                clearExports();
                setView('list');
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

      {view === 'list' && (
        <>
          <div className="floway-copy-editor-body floway-copy-editor-body--list">
            {activeEntries.length === 0 ? (
              <div className="floway-copy-editor-empty-stack">
                <span className="floway-copy-editor-meta">{t('common.copyEditor.emptyDrafts')}</span>
                {exportedBatches.length > 0 && (
                  <Button
                    appearance="subtle"
                    icon={<History16Regular />}
                    size="small"
                    onClick={() => setView('exported')}
                  >
                    {t('common.copyEditor.exportedTitle')}
                  </Button>
                )}
              </div>
            ) : (
              activeEntries.map(entry => (
                <div key={entry.key} className="floway-copy-editor-draft-item">
                  <div className="floway-copy-editor-draft-head">
                    <span className="floway-copy-editor-draft-key" title={entry.key}>
                      {entry.key}
                    </span>
                    <div className="flex items-center gap-0.5 flex-none">
                      <Button
                        appearance="subtle"
                        aria-label={t('common.copyEditor.flyoutTitle')}
                        icon={<Edit16Regular />}
                        size="small"
                        title={t('common.copyEditor.flyoutTitle')}
                        onClick={() => onEditKey(entry.key, entry.route)}
                      />
                      <Button
                        appearance="subtle"
                        aria-label={t('common.copyEditor.revert')}
                        icon={<ArrowUndo16Regular />}
                        size="small"
                        title={t('common.copyEditor.revert')}
                        onClick={() => revertEntry(entry.key)}
                      />
                    </div>
                  </div>

                  <div className="floway-copy-editor-diff-list">
                    {supportedLanguages.map(language => {
                      const change = entry.changes[language];
                      if (!change) return null;
                      const currentOriginal = getOriginal(language, entry.key);
                      const isStale = currentOriginal !== undefined
                        && currentOriginal !== change.before
                        && currentOriginal !== change.after;
                      return (
                        <div key={language} className="floway-copy-editor-diff-row">
                          <span className="floway-copy-editor-diff-lang">
                            {SHORT_LANGUAGE_LABELS[language]}
                          </span>
                          <div className="floway-copy-editor-diff-values">
                            <span className="floway-copy-editor-diff-before-line">
                              <span className="floway-copy-editor-diff-before">{change.before}</span>
                              {isStale && (
                                <StaleSourcePopover
                                  mountNode={mountNode}
                                  nextOriginal={currentOriginal}
                                  previousOriginal={change.before}
                                  title={t('common.copyEditor.staleNotice')}
                                />
                              )}
                            </span>
                            <span className="floway-copy-editor-diff-after">{change.after}</span>
                          </div>
                        </div>
                      );
                    })}

                    {entry.note.trim().length > 0 && (
                      <span className="floway-copy-editor-meta">{entry.note}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="floway-copy-editor-footer">
            <div className="floway-copy-editor-footer-start">
              {activeEntries.length > 0 && (
                <Button appearance="subtle" onClick={clearActive}>
                  {t('common.copyEditor.discardEdits', { count: activeEntries.length })}
                </Button>
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
      )}

      {view === 'exported' && (
        <div className="floway-copy-editor-body floway-copy-editor-body--list">
          {exportedBatches.length === 0 ? (
            <div className="floway-copy-editor-empty">
              {t('common.copyEditor.emptyExports')}
            </div>
          ) : (
            exportedBatches.map(batch => {
              const relative = relativeTime(batch.exportedAt, locale, { now }) ?? shortDate(batch.exportedAt, locale);
              return (
                <div key={batch.id} className="floway-copy-editor-draft-item">
                  <div className="floway-copy-editor-draft-head">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span
                        className="floway-copy-editor-batch-time"
                        title={dateTime(batch.exportedAt, locale)}
                      >
                        {relative}
                      </span>
                      <span className="floway-copy-editor-batch-count">
                        ×{batch.entries.length}
                      </span>
                    </div>
                    <div className="flex items-center gap-0.5 flex-none">
                      <Button
                        appearance="subtle"
                        aria-label={t('common.copyEditor.restoreBatch')}
                        icon={<ArrowUndo16Regular />}
                        size="small"
                        title={t('common.copyEditor.restoreBatch')}
                        onClick={() => handleRestoreBatch(batch.id)}
                      />
                      <Button
                        appearance="subtle"
                        aria-label={copiedBatchId === batch.id ? t('common.copy.copied') : t('common.copyEditor.export')}
                        icon={copiedBatchId === batch.id ? <Checkmark16Regular /> : <Copy16Regular />}
                        size="small"
                        title={copiedBatchId === batch.id ? t('common.copy.copied') : t('common.copyEditor.export')}
                        onClick={() => void handleCopyBatch(batch.id)}
                      />
                      <Button
                        appearance="subtle"
                        aria-label={t('common.copyEditor.deleteBatch')}
                        icon={<Delete16Regular />}
                        size="small"
                        title={t('common.copyEditor.deleteBatch')}
                        onClick={() => deleteExportBatch(batch.id)}
                      />
                    </div>
                  </div>
                  <div className="floway-copy-editor-batch-lines">
                    {batch.entries.map(item => {
                      const preview = formatBatchPreview(item);
                      return (
                        <div
                          key={item.key}
                          className="floway-copy-editor-batch-line"
                          title={preview ? `${item.key}  ${preview}` : item.key}
                        >
                          <span className="floway-copy-editor-batch-key">{item.key}</span>
                          {preview && (
                            <span className="floway-copy-editor-batch-preview">{preview}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {view === 'import' && (
        <>
          <div className="floway-copy-editor-body">
            <Textarea
              className="w-full"
              placeholder={t('common.copyEditor.importPlaceholder')}
              rows={10}
              value={importText}
              onChange={(_, data) => setImportText(data.value)}
            />
            {importStatus && (
              <span
                className="floway-copy-editor-meta"
                style={importStatus.ok ? undefined : { color: 'var(--winui-system-fill-critical)' }}
              >
                {importStatus.text}
              </span>
            )}
          </div>
          <div className="floway-copy-editor-footer">
            <div />
            <Button
              appearance="primary"
              disabled={importText.trim().length === 0}
              icon={<ArrowImport16Regular />}
              onClick={handleImport}
            >
              {t('common.copyEditor.importAction')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
