import { ArrowDownloadRegular, ArrowUploadRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { requireDashboardAdmin } from './route-guards';
import { api, callApi } from '../api/client';
import type { BackupImportCounts } from '../api/types';
import { BACKUP_FILE_VERSION, parseBackupFile, type BackupFile, type BackupFileData } from '../components/backup-restore/backup-file';
import { useDropzoneStyles } from '../components/backup-restore/dropzone-styles';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { SectionHeader } from '../components/ui/section-header';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { fluentComponents } from '../fluent';
import { formatBytes } from '../lib/format-number';
import { useLocale } from '../lib/use-locale';

const {
  Button,
  Checkbox,
  Field,
  mergeClasses,
  Radio,
  RadioGroup,
  Spinner,
  Text,
} = fluentComponents;

export async function clientLoader() {
  await requireDashboardAdmin();
  return null;
}

const PREVIEW_LABEL_KEYS = [
  'users',
  'apiKeys',
  'upstreams',
  'proxies',
  'usage',
  'searchUsage',
  'performance',
] as const;
const countRecords = (data: BackupFileData): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const key of PREVIEW_LABEL_KEYS) {
    const value = data[key];
    counts[key] = Array.isArray(value) ? value.length : 0;
  }
  return counts;
};

// What the server says it took, in the same vocabulary as the preview the
// operator read before pressing Import. Empty entities are dropped: a backup
// rarely carries all seven, and naming the ones it did not carry buries the
// ones it did.
const importedSummary = (
  counts: BackupImportCounts,
  t: ReturnType<typeof useTranslation>['t'],
): string => {
  return PREVIEW_LABEL_KEYS
    .filter(key => counts[key] > 0)
    .map(key => t('dashboard.backupRestore.import.summaryItem', {
      n: counts[key],
      label: t(`dashboard.backupRestore.import.previewLabel.${key}`),
    }))
    .join(', ');
};

export default function DashboardAdminBackupRestore() {
  const { t } = useTranslation();
  const locale = useLocale();
  const toasts = useOutcomeToasts();

  const [includePerformance, setIncludePerformance] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [importFile, setImportFile] = useState<File | null>(null);
  const [importParsedData, setImportParsedData] = useState<BackupFile | null>(null);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const confirmDialog = useDialogInvocation<void>();
  const dz = useDropzoneStyles();

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

  // A second file dropped while the first is still being read would otherwise
  // leave two reads racing, and the later-finishing one would win whichever
  // file the operator dropped last. The read in flight is aborted instead --
  // `abort()` raises neither `load` nor `error`, so the losing read reaches no
  // state at all -- and an unmount takes the pending read with it.
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

  const openFilePicker = useCallback(() => {
    if (!importing) fileInputRef.current?.click();
  }, [importing]);

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
        mode: importMode,
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
    const summary = importedSummary(result.data.imported, t);
    handle.succeed(summary
      ? t('dashboard.backupRestore.import.success', { summary })
      : t('dashboard.backupRestore.import.successEmpty'));
  }, [importMode, importParsedData, t, toasts]);

  const handleImportClick = useCallback(() => {
    if (!importParsedData) return;
    if (importMode === 'replace') {
      confirmDialog.open();
      return;
    }
    void doImport();
  }, [confirmDialog, doImport, importMode, importParsedData]);

  const previewCounts = importParsedData ? countRecords(importParsedData.data) : null;

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader title={t('dashboard.backupRestore.heading')} />

      <Panel className="!grid !gap-3">
        <SectionHeader description={t('dashboard.backupRestore.export.description')} level={2} title={t('dashboard.backupRestore.export.heading')} />

        <Checkbox
          label={t('dashboard.backupRestore.export.includePerformance')}
          checked={includePerformance}
          onChange={(_, data) => setIncludePerformance(!!data.checked)}
        />
        <Text size={200} className="text-fui-fg3">
          {t('dashboard.backupRestore.export.includePerformanceHint')}
        </Text>

        {exportError && (
          <OutcomeMessageBar onDismiss={() => setExportError(null)}>{exportError}</OutcomeMessageBar>
        )}

        <div>
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

      <Panel className="!grid !gap-3">
        <SectionHeader description={t('dashboard.backupRestore.import.description')} level={2} title={t('dashboard.backupRestore.import.heading')} />

        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={handleFileSelect}
        />
        <button
          className={mergeClasses(dz.root, dragOver && dz.active, importing && dz.disabled)}
          disabled={importing}
          onClick={openFilePicker}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          aria-label={t('dashboard.backupRestore.import.dropzone')}
          type="button"
        >
          <ArrowUploadRegular style={{ fontSize: '28px' }} />
          <Text size={300}>
            {dragOver
              ? t('dashboard.backupRestore.import.dropzoneActive')
              : t('dashboard.backupRestore.import.dropzone')}
          </Text>
        </button>

        {importParsedData && importFile && (
          <>
            <div className="flex items-center gap-[12px]">
              <Text size={300} weight="semibold">
                {t('dashboard.backupRestore.import.fileSelected', {
                  name: importFile.name,
                  size: formatBytes(importFile.size, locale),
                })}
              </Text>
              <Button
                appearance="outline"
                disabled={importing}
                onClick={handleChangeFile}
                size="small"
              >
                {t('dashboard.backupRestore.import.change')}
              </Button>
            </div>

            <div>
              <Text size={300} weight="semibold">
                {t('dashboard.backupRestore.import.preview')}
              </Text>
              <div className="mt-[8px] grid gap-[10px] grid-cols-[repeat(auto-fill,minmax(140px,1fr))]">
                {PREVIEW_LABEL_KEYS.map(key => (
                  // One tile per counted entity. It is the Expander's content
                  // region -- the secondary step of the card ramp -- at the
                  // control corner rather than the overlay one, because these
                  // sit inside a card rather than being one. Nothing here is
                  // interactive, so the fill is the only state it has, and both
                  // dictionaries name the same brush.
                  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L25
                  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L49
                  <div
                    key={key}
                    className="flex flex-col items-center gap-[2px] rounded-[var(--winui-control-corner-radius)] bg-[var(--winui-card-background-fill-secondary)] p-[12px_10px] text-center"
                  >
                    <Text size={500} weight="semibold">
                      {previewCounts?.[key] ?? 0}
                    </Text>
                    <Text size={200} className="text-fui-fg3">
                      {t(`dashboard.backupRestore.import.previewLabel.${key}`)}
                    </Text>
                  </div>
                ))}
              </div>
            </div>

            <Field label={t('dashboard.backupRestore.import.mode')}>
              {/* Each mode carries a sentence, so the options stack: side by
                  side the two descriptions met in the middle and the trailing
                  radio read as part of the preceding sentence.

                  The two lines are the same pair ../components/ui/settings-card.tsx
                  builds -- the control content size at the regular weight over
                  the caption in the secondary fill, with no gap between them.
                  WinUI's RadioButton states the size and states no weight, so
                  the label is body regular and the emphasis lives in the fill
                  step rather than in a heavier face.
                  https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L193
                  https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L424 */}
              <RadioGroup disabled={importing} value={importMode} onChange={(_, data) => setImportMode(data.value as 'merge' | 'replace')}>
                <Radio label={<span className="grid"><Text block>{t('dashboard.backupRestore.import.modeMerge')}</Text><Text block size={200} className="text-fui-fg2">{t('dashboard.backupRestore.import.modeMergeDesc')}</Text></span>} value="merge" />
                <Radio label={<span className="grid"><Text block>{t('dashboard.backupRestore.import.modeReplace')}</Text><Text block size={200} className="text-fui-fg2">{t('dashboard.backupRestore.import.modeReplaceDesc')}</Text></span>} value="replace" />
              </RadioGroup>
            </Field>

            {importMode === 'replace' && (
              <OutcomeMessageBar intent="warning">
                {t('dashboard.backupRestore.import.replaceWarning')}
              </OutcomeMessageBar>
            )}

            <div>
              <Button
                appearance="primary"
                disabledFocusable={importing}
                icon={importing ? <Spinner size="tiny" /> : <ArrowUploadRegular />}
                onClick={handleImportClick}
              >
                {t('dashboard.backupRestore.import.button')}
              </Button>
            </div>
          </>
        )}

        {importError && (
          <OutcomeMessageBar
            onDismiss={() => setImportError(null)}
            title={t('dashboard.backupRestore.import.error')}
          >
            {importError}
          </OutcomeMessageBar>
        )}
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
