import {
  ArrowImport16Regular,
  ArrowUndo16Regular,
  Checkmark16Regular,
  Copy16Regular,
  Dismiss16Regular,
  Edit16Regular,
  Warning16Regular,
} from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';

import { useEditorTranslation } from './use-editor-t';
import { fluentComponents } from '../../fluent';
import { useCopyEditorStore } from '../../i18n/copy-editor/store';
import { supportedLanguages, type SupportedLanguage } from '../../i18n/languages';
import { copyToClipboard } from '../ui/copy-to-clipboard';
import { Textarea } from '../ui/fluent-form-controls';

const { Button, Tab, TabList, Text } = fluentComponents;

const SHORT_LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  'en': 'EN',
  'zh-Hans': '中文',
};

export interface DraftsPanelProps {
  onClose: () => void;
  onEditKey: (key: string, route: string) => void;
}

export function DraftsPanel({ onClose, onEditKey }: DraftsPanelProps) {
  const { t } = useEditorTranslation();
  const entriesMap = useCopyEditorStore(state => state.entries);
  const autoPrunedCount = useCopyEditorStore(state => state.autoPrunedCount);
  const getStaleLanguages = useCopyEditorStore(state => state.getStaleLanguages);
  const revertEntry = useCopyEditorStore(state => state.revertEntry);
  const clearExported = useCopyEditorStore(state => state.clearExported);
  const clearAll = useCopyEditorStore(state => state.clearAll);
  const buildExportPayload = useCopyEditorStore(state => state.buildExportPayload);
  const markExported = useCopyEditorStore(state => state.markExported);
  const importFromJson = useCopyEditorStore(state => state.importFromJson);

  const [tab, setTab] = useState<'list' | 'import'>('list');
  const [importText, setImportText] = useState('');
  const [importStatus, setImportStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
  }, []);

  const allEntries = Object.values(entriesMap).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const pendingEntries = allEntries.filter(entry => entry.exportedAt === null);
  const exportedEntries = allEntries.filter(entry => entry.exportedAt !== null);

  const handleCopy = async (scope: 'unexported' | 'all') => {
    const payload = buildExportPayload(scope);
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
    markExported(payload.entries.map(item => item.key), payload.exportedAt);
    setCopyState('copied');
    copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1600);
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
      if (result.imported > 0) setTab('list');
    } catch (error) {
      setImportStatus({
        ok: false,
        text: t('common.copyEditor.importError', {
          message: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  };

  const showClearExported = exportedEntries.length > 0 && pendingEntries.length > 0;

  return (
    <div
      aria-label={t('common.copyEditor.panelTitle')}
      className="floway-copy-editor-surface floway-copy-editor-panel"
      role="dialog"
    >
      <div className="floway-copy-editor-header">
        <div className="floway-copy-editor-header-main">
          <Text size={400} weight="semibold">{t('common.copyEditor.panelTitle')}</Text>
          {allEntries.length > 0 && (
            <span className="floway-copy-editor-header-count">{allEntries.length}</span>
          )}
        </div>
        <Button
          appearance="subtle"
          aria-label={t('common.copyEditor.close')}
          icon={<Dismiss16Regular />}
          size="small"
          onClick={onClose}
        />
      </div>

      <div className="floway-copy-editor-tabs">
        <TabList
          selectedValue={tab}
          size="small"
          onTabSelect={(_, data) => setTab(data.value as 'list' | 'import')}
        >
          <Tab value="list">{t('common.copyEditor.listTab')}</Tab>
          <Tab value="import">{t('common.copyEditor.importTab')}</Tab>
        </TabList>
      </div>

      {tab === 'list' ? (
        <>
          <div className="floway-copy-editor-body floway-copy-editor-body--list">
            {autoPrunedCount > 0 && (
              <div className="floway-copy-editor-list-notice">
                {t('common.copyEditor.autoPruned', { count: autoPrunedCount })}
              </div>
            )}

            {allEntries.length === 0 ? (
              <div className="floway-copy-editor-empty">
                {t('common.copyEditor.emptyDrafts')}
              </div>
            ) : (
              allEntries.map(entry => {
                const stale = getStaleLanguages(entry.key);
                const isExported = entry.exportedAt !== null;
                return (
                  <div
                    key={entry.key}
                    className="floway-copy-editor-draft-item"
                    data-exported={isExported ? 'true' : 'false'}
                  >
                    <div className="floway-copy-editor-draft-head">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="floway-copy-editor-draft-key" title={entry.key}>
                          {entry.key}
                        </span>
                        {isExported && (
                          <span className="floway-copy-editor-draft-status">
                            {t('common.copyEditor.statusExported')}
                          </span>
                        )}
                      </div>
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
                        return (
                          <div key={language} className="floway-copy-editor-diff-row">
                            <span className="floway-copy-editor-diff-lang">
                              {SHORT_LANGUAGE_LABELS[language]}
                            </span>
                            <div className="floway-copy-editor-diff-values">
                              <span className="floway-copy-editor-diff-before">{change.before}</span>
                              <span className="floway-copy-editor-diff-after">{change.after}</span>
                            </div>
                          </div>
                        );
                      })}

                      {entry.note.trim().length > 0 && (
                        <span className="floway-copy-editor-meta">
                          {t('common.copyEditor.noteLabel')}: {entry.note}
                        </span>
                      )}

                      {stale.length > 0 && (
                        <span className="floway-copy-editor-caution">
                          <Warning16Regular />
                          <span>{t('common.copyEditor.staleNotice')}</span>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="floway-copy-editor-footer">
            <div className="floway-copy-editor-footer-start">
              {showClearExported && (
                <Button appearance="subtle" size="small" onClick={clearExported}>
                  {t('common.copyEditor.clearExported')}
                </Button>
              )}
              {allEntries.length > 0 && (
                <Button appearance="subtle" size="small" onClick={clearAll}>
                  {t('common.copyEditor.clearAll')}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {pendingEntries.length > 0 && exportedEntries.length > 0 && (
                <Button
                  appearance="secondary"
                  onClick={() => void handleCopy('all')}
                >
                  {t('common.copyEditor.copyAllJson')}
                </Button>
              )}
              <Button
                appearance="primary"
                disabled={allEntries.length === 0}
                icon={copyState === 'copied' ? <Checkmark16Regular /> : <Copy16Regular />}
                onClick={() => void handleCopy(pendingEntries.length > 0 ? 'unexported' : 'all')}
              >
                {copyState === 'copied'
                  ? t('common.copy.copied')
                  : copyState === 'failed'
                    ? t('common.copy.failed')
                    : pendingEntries.length > 0 && exportedEntries.length > 0 ? t('common.copyEditor.copyPendingJson') : t('common.copyEditor.copyJson')}
              </Button>
            </div>
          </div>
        </>
      ) : (
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
