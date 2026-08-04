import { ArrowDownloadRegular, ArrowUploadRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { requireDashboardAdmin } from './guards';
import { api, callApi } from '../api/client';
import { BACKUP_FILE_VERSION, parseBackupFile, type BackupFile } from '../components/backup-restore/file';
import { BackupFilePicker, BackupFileStats, BackupFileSummary } from '../components/backup-restore/file-picker';
import { countRecords, PREVIEW_LABEL_KEYS, recordSummary } from '../components/backup-restore/summary';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { SectionHeader } from '../components/ui/section-header';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { fluentComponents } from '../fluent';
import { useTranslation } from '../i18n/translation';
import { formatCount } from '../lib/format-number';
import { useLocale } from '../lib/use-locale';

const {
  Button,
  Checkbox,
  Field,
  Spinner,
} = fluentComponents;

export async function clientLoader() {
  await requireDashboardAdmin();
  return null;
}

export default function DashboardAdminBackupRestore() {
  const { t } = useTranslation();
  const locale = useLocale();
  const toasts = useOutcomeToasts();

  const [includePerformance, setIncludePerformance] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [importFile, setImportFile] = useState<File | null>(null);
  const [importParsedData, setImportParsedData] = useState<BackupFile | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const confirmDialog = useDialogInvocation<void>();

  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);

    const handle = toasts.start(t('dashboard.backupRestore.export.pending'));
    const result = await callApi(() => api.api.export.$get({
      query: includePerformance ? { include_performance: '1' } : {},
    }));

    if (result.error) {
      handle.settle();
      setExportError(result.error.message);
      setExporting(false);
      return;
    }

    const json = JSON.stringify(result.data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const date = result.data.exportedAt.slice(0, 10);
    anchor.download = `floway-export-${date}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);

    setExporting(false);
    handle.succeed(t('dashboard.backupRestore.export.success', { name: anchor.download }));
  }, [includePerformance, t, toasts]);

  // Without aborting, a second file dropped mid-read leaves two reads racing and
  // the later-finishing one wins. `abort()` raises neither `load` nor `error`,
  // so the losing read reaches no state at all.
  const readerRef = useRef<FileReader | null>(null);
  useEffect(() => () => readerRef.current?.abort(), []);

  const handleFile = useCallback(
    (file: File) => {
      setImportError(null);
      readerRef.current?.abort();

      const reader = new FileReader();
      readerRef.current = reader;
      reader.onload = () => {
        readerRef.current = null;
        const result = parseBackupFile(reader.result as string);
        if (!result.ok) {
          setImportError(t('dashboard.backupRestore.import.errorInvalidFile', { message: result.message }));
          setImportFile(null);
          setImportParsedData(null);
          return;
        }
        setImportFile(file);
        setImportParsedData(result.payload);
      };
      reader.onerror = () => {
        readerRef.current = null;
        setImportError(t('dashboard.backupRestore.import.errorReadFile'));
      };
      reader.readAsText(file);
    },
    [t],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
      // Reset so re-selecting the same file triggers onChange again
      e.target.value = '';
    },
    [handleFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => setDragOver(false), []);

  const dropHandlers = useMemo(
    () => ({ onDragLeave: handleDragLeave, onDragOver: handleDragOver, onDrop: handleDrop }),
    [handleDragLeave, handleDragOver, handleDrop],
  );

  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);

  const handleChangeFile = useCallback(() => {
    setImportFile(null);
    setImportParsedData(null);
    setImportError(null);
    fileInputRef.current?.click();
  }, []);

  const doImport = useCallback(async () => {
    if (!importParsedData) return;
    setImporting(true);
    setImportError(null);

    const handle = toasts.start(t('dashboard.backupRestore.import.pending'));
    const result = await callApi(() => api.api.import.$post({
      json: {
        version: BACKUP_FILE_VERSION,
        mode: replaceExisting ? 'replace' : 'merge',
        data: importParsedData.data,
      },
    }));

    if (result.error) {
      handle.settle();
      setImportError(result.error.message);
      setImporting(false);
      return;
    }

    setImportFile(null);
    setImportParsedData(null);
    setImporting(false);
    const summary = recordSummary(result.data.imported, t, locale);
    handle.succeed(summary
      ? t('dashboard.backupRestore.import.success', { summary })
      : t('dashboard.backupRestore.import.successEmpty'));
  }, [importParsedData, locale, replaceExisting, t, toasts]);

  const handleImportClick = useCallback(() => {
    if (!importParsedData) return;
    if (replaceExisting) {
      confirmDialog.open();
      return;
    }
    void doImport();
  }, [confirmDialog, doImport, importParsedData, replaceExisting]);

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader description={t('dashboard.pages.backupRestore')} title={t('dashboard.nav.backupRestore')} />

      <Panel className={PANEL_STACK_CLASS}>
        <SectionHeader description={t('dashboard.backupRestore.export.description')} level={2} title={t('dashboard.backupRestore.export.heading')} />

        {/* A check box rather than a switch, because nothing is exported until
            the command below is pressed: "Use a checkbox when the user has to
            perform extra steps for changes to be effective."
            https://github.com/MicrosoftDocs/windows-dev-docs/blob/d084ff89ad3d6da237a8737e325a6407ddb0ee41/hub/apps/develop/ui/controls/toggles.md#L41 */}
        <Field hint={t('dashboard.backupRestore.export.includePerformanceHint')}>
          <Checkbox
            checked={includePerformance}
            label={t('dashboard.backupRestore.export.includePerformance')}
            onChange={(_, data) => setIncludePerformance(!!data.checked)}
          />
        </Field>

        {exportError && (
          <OutcomeMessageBar onDismiss={() => setExportError(null)}>{exportError}</OutcomeMessageBar>
        )}

        <div className="pt-1">
          <Button
            appearance="primary"
            disabledFocusable={exporting}
            icon={exporting ? <Spinner size="tiny" /> : <ArrowDownloadRegular />}
            onClick={() => void handleExport()}
          >
            {t('dashboard.backupRestore.export.button')}
          </Button>
        </div>
      </Panel>

      <Panel className={PANEL_STACK_CLASS}>
        <SectionHeader description={t('dashboard.backupRestore.import.description')} level={2} title={t('dashboard.backupRestore.import.heading')} />

        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={handleFileSelect}
        />

        {importParsedData && importFile
          ? <BackupFileSummary
              accepting={dragOver}
              action={<Button disabled={importing} onClick={handleChangeFile}>
                {t('dashboard.backupRestore.import.change')}
              </Button>}
              drop={dropHandlers}
              name={t('dashboard.backupRestore.import.fileSelected', {
                name: importFile.name,
                size: importFile.size,
              })}
            />
          : <BackupFilePicker
              accepting={dragOver}
              drop={dropHandlers}
              glyph={<ArrowUploadRegular fontSize={28} />}
              onClick={openFilePicker}
              prompt={dragOver
                ? t('dashboard.backupRestore.import.dropzoneActive')
                : t('dashboard.backupRestore.import.dropzone')}
            />}

        {importParsedData && <BackupFileStats items={PREVIEW_LABEL_KEYS.map(key => ({
          key,
          label: t(`dashboard.backupRestore.import.previewLabel.${key}`),
          value: formatCount(countRecords(importParsedData.data)[key], locale),
        }))} />}

        {importParsedData && <Field hint={t('dashboard.backupRestore.import.replaceHint')}>
          <Checkbox
            checked={replaceExisting}
            disabled={importing}
            label={t('dashboard.backupRestore.import.replace')}
            onChange={(_, data) => setReplaceExisting(!!data.checked)}
          />
        </Field>}

        {importParsedData && replaceExisting && (
          <OutcomeMessageBar intent="warning">
            {t('dashboard.backupRestore.import.replaceWarning')}
          </OutcomeMessageBar>
        )}

        {importError && (
          <OutcomeMessageBar
            onDismiss={() => setImportError(null)}
            title={t('dashboard.backupRestore.import.error')}
          >
            {importError}
          </OutcomeMessageBar>
        )}

        <div className="pt-1">
          <Button
            appearance="primary"
            disabled={!importParsedData}
            disabledFocusable={importing}
            icon={importing ? <Spinner size="tiny" /> : <ArrowUploadRegular />}
            onClick={handleImportClick}
          >
            {t('dashboard.backupRestore.import.button')}
          </Button>
        </div>
      </Panel>

      {confirmDialog.invocation && <ConfirmDialog
        open={confirmDialog.isOpen}
        actionLabel={t('dashboard.backupRestore.import.button')}
        actionIntent="primary"
        busy={importing}
        key={confirmDialog.invocation.key}
        message={t('dashboard.backupRestore.confirmMessage')}
        onConfirm={() => {
          confirmDialog.close();
          void doImport();
        }}
        onOpenChange={open => { if (!open) confirmDialog.close(); }}
        title={t('dashboard.backupRestore.confirmTitle')}
      />}
    </section>
  );
}
