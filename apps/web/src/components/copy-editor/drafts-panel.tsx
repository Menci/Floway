import {
  ArrowImport16Regular,
  ArrowUndo16Regular,
  Checkmark16Regular,
  Copy16Regular,
  Delete16Regular,
  Dismiss16Regular,
  Edit16Regular,
  Warning16Regular,
} from '@fluentui/react-icons';
import { useState } from 'react';

import { useEditorTranslation } from './use-editor-t';
import { fluentComponents } from '../../fluent';
import { useCopyEditorStore } from '../../i18n/copy-editor/store';
import { supportedLanguages } from '../../i18n/languages';
import { copyToClipboard } from '../ui/copy-to-clipboard';
import { Textarea } from '../ui/fluent-form-controls';

const { Button, Tab, TabList, Text } = fluentComponents;

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
  const [copyBanner, setCopyBanner] = useState<{ ok: boolean; count: number; message?: string } | null>(null);

  const allEntries = Object.values(entriesMap).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const pendingEntries = allEntries.filter(entry => entry.exportedAt === null);
  const exportedEntries = allEntries.filter(entry => entry.exportedAt !== null);

  const handleCopy = async (scope: 'unexported' | 'all') => {
    const payload = buildExportPayload(scope);
    if (payload.entries.length === 0) return;
    const ok = await copyToClipboard(JSON.stringify(payload, null, 2));
    if (!ok) {
      setCopyBanner({ ok: false, count: 0, message: t('common.copyEditor.copyFailed') });
      return;
    }
    markExported(payload.entries.map(item => item.key), payload.exportedAt);
    setCopyBanner({ ok: true, count: payload.entries.length });
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

  return (
    <div
      aria-label={t('common.copyEditor.panelTitle')}
      className="floway-copy-editor-surface floway-copy-editor-panel"
      role="dialog"
    >
      <div className="floway-copy-editor-header">
        <div className="flex items-center gap-2 min-w-0">
          <Text size={400} weight="semibold">{t('common.copyEditor.panelTitle')}</Text>
          {allEntries.length > 0 && (
            <span className="floway-copy-editor-pill" data-tone="accent">
              {allEntries.length}
            </span>
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
          <div className="floway-copy-editor-body">
            {autoPrunedCount > 0 && (
              <span className="floway-copy-editor-original">
                {t('common.copyEditor.autoPruned', { count: autoPrunedCount })}
              </span>
            )}

            {copyBanner && (
              <div className="floway-copy-editor-banner">
                <div className="flex items-center gap-1.5 min-w-0">
                  {copyBanner.ok ? <Checkmark16Regular /> : <Warning16Regular />}
                  <span>
                    {copyBanner.ok
                      ? t('common.copyEditor.copiedCount', { count: copyBanner.count })
                      : copyBanner.message}
                  </span>
                </div>
                {copyBanner.ok && exportedEntries.length > 0 && (
                  <Button
                    appearance="subtle"
                    icon={<Delete16Regular />}
                    size="small"
                    onClick={() => {
                      clearExported();
                      setCopyBanner(null);
                    }}
                  >
                    {t('common.copyEditor.clearExported')}
                  </Button>
                )}
              </div>
            )}

            {allEntries.length === 0 ? (
              <span className="floway-copy-editor-original">
                {t('common.copyEditor.emptyDrafts')}
              </span>
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
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 grid gap-1.5">
                        <span className="floway-copy-editor-key-text" title={entry.key}>
                          {entry.key}
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className="floway-copy-editor-pill"
                            data-tone={isExported ? undefined : 'accent'}
                          >
                            {isExported ? t('common.copyEditor.statusExported') : t('common.copyEditor.statusPending')}
                          </span>
                          <span className="floway-copy-editor-pill" data-mono="true">{entry.route}</span>
                          {stale.length > 0 && (
                            <span className="floway-copy-editor-pill" data-tone="caution">
                              {t('common.copyEditor.staleNotice')}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-none">
                        <Button
                          appearance="subtle"
                          aria-label={t('common.copyEditor.flyoutTitle')}
                          icon={<Edit16Regular />}
                          size="small"
                          onClick={() => onEditKey(entry.key, entry.route)}
                        />
                        <Button
                          appearance="subtle"
                          aria-label={t('common.copyEditor.revert')}
                          icon={<ArrowUndo16Regular />}
                          size="small"
                          onClick={() => revertEntry(entry.key)}
                        />
                      </div>
                    </div>

                    {supportedLanguages.map(language => {
                      const change = entry.changes[language];
                      if (!change) return null;
                      return (
                        <div key={language} className="floway-copy-editor-diff-row">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="floway-copy-editor-pill" data-mono="true">{language}</span>
                            <span className="floway-copy-editor-diff-before">{change.before}</span>
                          </div>
                          <div className="floway-copy-editor-diff-after">{change.after}</div>
                        </div>
                      );
                    })}

                    {entry.note.trim().length > 0 && (
                      <span className="floway-copy-editor-original">
                        {t('common.copyEditor.noteLabel')}: {entry.note}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className="floway-copy-editor-footer">
            <div className="flex items-center gap-1">
              {exportedEntries.length > 0 && (
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
                  icon={<Copy16Regular />}
                  onClick={() => void handleCopy('all')}
                >
                  {t('common.copyEditor.copyAllJson')}
                </Button>
              )}
              <Button
                appearance="primary"
                disabled={allEntries.length === 0}
                icon={<Copy16Regular />}
                onClick={() => void handleCopy(pendingEntries.length > 0 ? 'unexported' : 'all')}
              >
                {pendingEntries.length > 0
                  ? t('common.copyEditor.copyUnexportedJson')
                  : t('common.copyEditor.copyAllJson')}
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
                className="floway-copy-editor-original"
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
