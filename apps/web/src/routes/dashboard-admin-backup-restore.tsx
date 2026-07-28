import { ArrowDownloadRegular, ArrowUploadRegular } from '@fluentui/react-icons';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-admin-backup-restore';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import type { BackupImportCounts } from '../api/types';
import { getSessionToken } from '../auth/session';
import { AdminOnlyNotice } from '../components/admin-only-notice';
import { BACKUP_FILE_VERSION, parseBackupFile, type BackupFile, type BackupFileData } from '../components/backup-restore/backup-file';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Panel } from '../components/ui/panel';
import { fluentComponents } from '../fluent';
import { useDashboardOutletContext } from './dashboard';

const {
  Button,
  Checkbox,
  makeStyles,
  MessageBar,
  MessageBarBody,
  shorthands,
  Spinner,
  Text,
} = fluentComponents;

export async function clientLoader() {
  if (!getSessionToken()) throw redirect('/');
  return null;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Backup and Restore | Floway' }];
}

const useDropzoneStyles = makeStyles({
  root: {
    alignItems: 'center',
    ...shorthands.border('2px', 'dashed', 'var(--colorNeutralStroke1)'),
    ...shorthands.borderRadius('8px'),
    cursor: 'pointer',
    color: 'inherit',
    display: 'flex',
    font: 'inherit',
    flexDirection: 'column',
    gap: '8px',
    justifyContent: 'center',
    minHeight: '120px',
    padding: '24px',
    textAlign: 'center',
    transition: 'border-color .15s, background-color .15s',
    ':hover': {
      ...shorthands.borderColor('var(--colorBrandForeground1)'),
      backgroundColor: 'var(--colorBrandBackground2)',
    },
  },
  active: {
    ...shorthands.borderColor('var(--colorBrandForeground1)'),
    backgroundColor: 'var(--colorBrandBackground2)',
  },
  disabled: {
    cursor: 'not-allowed',
    opacity: '.6',
  },
});

const usePreviewGridStyles = makeStyles({
  grid: {
    display: 'grid',
    gap: '10px',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
  },
  cell: {
    alignItems: 'center',
    backgroundColor: 'var(--colorNeutralBackground2)',
    ...shorthands.borderRadius('6px'),
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '12px 10px',
    textAlign: 'center',
  },
});

const useModeCardStyles = makeStyles({
  wrapper: {
    display: 'grid',
    gap: '12px',
    gridTemplateColumns: '1fr 1fr',
  },
  card: {
    backgroundColor: 'var(--colorNeutralBackground2)',
    ...shorthands.border('0'),
    ...shorthands.borderRadius('8px'),
    cursor: 'pointer',
    display: 'grid',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    gap: '4px',
    padding: '14px 16px',
    textAlign: 'left',
    transition: 'box-shadow .15s',
    ':hover': {
      boxShadow: '0 0 0 1px var(--colorNeutralStroke1)',
    },
  },
  cardSelected: {
    boxShadow: '0 0 0 2px var(--colorBrandForeground1)',
    ':hover': {
      boxShadow: '0 0 0 2px var(--colorBrandForeground1)',
    },
  },
});

const PREVIEW_LABEL_KEYS = [
  'users',
  'apiKeys',
  'upstreams',
  'proxies',
  'usage',
  'searchUsage',
  'performance',
] as const;
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countRecords(data: BackupFileData): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of PREVIEW_LABEL_KEYS) {
    const value = data[key];
    counts[key] = Array.isArray(value) ? value.length : 0;
  }
  return counts;
}

export default function DashboardAdminBackupRestore() {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();

  const [includePerformance, setIncludePerformance] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [importFile, setImportFile] = useState<File | null>(null);
  const [importParsedData, setImportParsedData] = useState<BackupFile | null>(null);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<BackupImportCounts | null>(null);

  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const dz = useDropzoneStyles();
  const pg = usePreviewGridStyles();
  const mc = useModeCardStyles();

  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);

    const result = await callApi(() => api.api.export.$get({
      query: includePerformance ? { include_performance: '1' } : {},
    }));

    if (result.error) {
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
  }, [includePerformance]);

  const handleFile = useCallback(
    (file: File) => {
      setImportError(null);
      setImportSuccess(null);

      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? parseBackupFile(reader.result) : { ok: false as const };
        if (!result.ok) {
          setImportError('dashboard.backupRestore.import.errorInvalidFile');
          setImportFile(null);
          setImportParsedData(null);
          return;
        }
        setImportFile(file);
        setImportParsedData(result.payload);
      };
      reader.onerror = () => {
        setImportError('dashboard.backupRestore.import.errorReadFile');
      };
      reader.readAsText(file);
    },
    [],
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
    setImportSuccess(null);
    fileInputRef.current?.click();
  }, []);

  const doImport = useCallback(async () => {
    if (!importParsedData) return;
    setImporting(true);
    setImportError(null);
    setImportSuccess(null);

    const result = await callApi(() => api.api.import.$post({
      json: {
        version: BACKUP_FILE_VERSION,
        mode: importMode,
        data: importParsedData.data,
      },
    }));

    if (result.error) {
      setImportError(result.error.message);
      setImporting(false);
      return;
    }

    setImportSuccess(result.data.imported);
    setImportFile(null);
    setImportParsedData(null);
    setImporting(false);
  }, [importMode, importParsedData]);

  const handleImportClick = useCallback(() => {
    if (!importParsedData) return;
    if (importMode === 'replace') {
      setConfirmOpen(true);
      return;
    }
    void doImport();
  }, [doImport, importMode, importParsedData]);

  const previewCounts = importParsedData ? countRecords(importParsedData.data) : null;

  if (!user.isAdmin) {
    return (
      <section className="dashboard-page max-w-[960px]">
        <DashboardPageHeader eyebrow={t('dashboard.groups.admin')} title={t('dashboard.backupRestore.heading')} />
        <AdminOnlyNotice />
      </section>
    );
  }

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader eyebrow={t('dashboard.groups.admin')} title={t('dashboard.backupRestore.heading')} />

      <Panel className="!p-[22px_24px] grid gap-[16px]">
        <Text size={400} weight="semibold">
          {t('dashboard.backupRestore.export.heading')}
        </Text>
        <Text size={300} className="text-fui-fg3">
          {t('dashboard.backupRestore.export.description')}
        </Text>

        <Checkbox
          label={t('dashboard.backupRestore.export.includePerformance')}
          checked={includePerformance}
          onChange={(_, data) => setIncludePerformance(!!data.checked)}
        />
        <Text size={200} className="text-fui-fg3">
          {t('dashboard.backupRestore.export.includePerformanceHint')}
        </Text>

        {exportError && (
          <MessageBar intent="error">
            <MessageBarBody>{exportError}</MessageBarBody>
          </MessageBar>
        )}

        <div>
          <Button
            appearance="primary"
            disabled={exporting}
            icon={exporting ? <Spinner size="tiny" /> : <ArrowDownloadRegular />}
            onClick={() => void handleExport()}
          >
            {exporting
              ? t('dashboard.backupRestore.export.buttonExporting')
              : t('dashboard.backupRestore.export.button')}
          </Button>
        </div>
      </Panel>

      <Panel className="!p-[22px_24px] grid gap-[16px]">
        <Text size={400} weight="semibold">
          {t('dashboard.backupRestore.import.heading')}
        </Text>
        <Text size={300} className="text-fui-fg3">
          {t('dashboard.backupRestore.import.description')}
        </Text>

        <button
          className={`${dz.root} ${dragOver ? dz.active : ''} ${importing ? dz.disabled : ''}`}
          disabled={importing}
          onClick={openFilePicker}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          aria-label={t('dashboard.backupRestore.import.dropzone')}
          type="button"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleFileSelect}
          />
          <ArrowUploadRegular
            className="text-fui-fg3"
            style={{ fontSize: '28px' }}
          />
          <Text size={300} className="text-fui-fg3">
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
                  size: formatFileSize(importFile.size),
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
              <div className={`${pg.grid} mt-[8px]`}>
                {PREVIEW_LABEL_KEYS.map(key => (
                  <div key={key} className={pg.cell}>
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

            <div>
              <Text size={300} weight="semibold">
                {t('dashboard.backupRestore.import.mode')}
              </Text>
              <div className={`${mc.wrapper} mt-[8px]`}>
                <button
                  className={`${mc.card} ${importMode === 'merge' ? mc.cardSelected : ''}`}
                  disabled={importing}
                  onClick={() => setImportMode('merge')}
                  type="button"
                >
                  <Text size={300} weight="semibold">
                    {t('dashboard.backupRestore.import.modeMerge')}
                  </Text>
                  <Text size={200} className="text-fui-fg3">
                    {t('dashboard.backupRestore.import.modeMergeDesc')}
                  </Text>
                </button>
                <button
                  className={`${mc.card} ${importMode === 'replace' ? mc.cardSelected : ''}`}
                  disabled={importing}
                  onClick={() => setImportMode('replace')}
                  type="button"
                >
                  <Text size={300} weight="semibold">
                    {t('dashboard.backupRestore.import.modeReplace')}
                  </Text>
                  <Text size={200} className="text-fui-fg3">
                    {t('dashboard.backupRestore.import.modeReplaceDesc')}
                  </Text>
                </button>
              </div>
            </div>

            {importMode === 'replace' && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  {t('dashboard.backupRestore.import.replaceWarning')}
                </MessageBarBody>
              </MessageBar>
            )}

            <div>
              <Button
                appearance={importMode === 'replace' ? 'primary' : 'primary'}
                disabled={importing}
                icon={importing ? <Spinner size="tiny" /> : <ArrowUploadRegular />}
                onClick={handleImportClick}
              >
                {importing
                  ? t('dashboard.backupRestore.import.buttonImporting')
                  : t('dashboard.backupRestore.import.button')}
              </Button>
            </div>
          </>
        )}

        {importError && (
          <MessageBar intent="error">
            <MessageBarBody>
              {t(importError)}
            </MessageBarBody>
          </MessageBar>
        )}

        {importSuccess && (
          <MessageBar intent="success">
            <MessageBarBody>
              {t('dashboard.backupRestore.import.success')}
            </MessageBarBody>
          </MessageBar>
        )}
      </Panel>

      <ConfirmDialog
        actionLabel={t('dashboard.backupRestore.import.button')}
        actionIntent="primary"
        busy={importing}
        cancelLabel={t('common.cancel')}
        message={t('dashboard.backupRestore.confirmMessage')}
        onConfirm={() => {
          setConfirmOpen(false);
          void doImport();
        }}
        onOpenChange={setConfirmOpen}
        open={confirmOpen}
        title={t('dashboard.backupRestore.confirmTitle')}
      />
    </section>
  );
}
