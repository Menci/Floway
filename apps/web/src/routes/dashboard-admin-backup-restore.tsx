import { ArrowDownloadRegular, ArrowUploadRegular } from '@fluentui/react-icons';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-admin-backup-restore';
import { authFetch, callApi } from '../api/auth';
import type {
  BackupExportData,
  BackupExportResponse,
  BackupImportCounts,
  BackupImportResponse,
} from '../api/types';
import { getSessionToken } from '../auth/session';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
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

// ---------------------------------------------------------------------------
// makeStyles
// ---------------------------------------------------------------------------

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
    borderStyle: 'none',
    ...shorthands.borderRadius('8px'),
    cursor: 'pointer',
    display: 'grid',
    color: 'inherit',
    font: 'inherit',
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PREVIEW_LABEL_KEYS = [
  'users',
  'apiKeys',
  'upstreams',
  'proxies',
  'usage',
  'searchUsage',
  'performance',
] as const;
const EXPORT_VERSION = 17;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countRecords(data: BackupExportData): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of PREVIEW_LABEL_KEYS) {
    const value = data[key as keyof BackupExportData];
    counts[key] = Array.isArray(value) ? value.length : 0;
  }
  return counts;
}

function parseBackupFile(
  raw: string,
): { ok: true; payload: BackupExportResponse } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'dashboard.backupRestore.import.errorInvalidFile' };
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    !('data' in parsed) ||
    !('exportedAt' in parsed)
  ) {
    return { ok: false, error: 'dashboard.backupRestore.import.errorInvalidFile' };
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== EXPORT_VERSION) {
    return { ok: false, error: 'dashboard.backupRestore.import.errorInvalidFile' };
  }

  return { ok: true, payload: parsed as BackupExportResponse };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DashboardAdminBackupRestore() {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();

  // Export state
  const [includePerformance, setIncludePerformance] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Import state
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importParsedData, setImportParsedData] = useState<BackupExportResponse | null>(null);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<BackupImportCounts | null>(null);

  // Drop zone
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Confirm dialog
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Styles
  const dz = useDropzoneStyles();
  const pg = usePreviewGridStyles();
  const mc = useModeCardStyles();

  // ---- admin guard ----

  // ---- export handler ----
  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);

    const qs = includePerformance ? '?include_performance=1' : '';
    const result = await callApi<BackupExportResponse>(() => authFetch(`/api/export${qs}`));

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

  // ---- import file handling ----
  const handleFile = useCallback(
    (file: File) => {
      setImportError(null);
      setImportSuccess(null);

      const reader = new FileReader();
      reader.onload = () => {
        const result = parseBackupFile(reader.result as string);
        if (!result.ok) {
          setImportError(result.error);
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

  // ---- import submit ----
  const doImport = useCallback(async () => {
    if (!importParsedData) return;
    setImporting(true);
    setImportError(null);
    setImportSuccess(null);

    const result = await callApi<BackupImportResponse>(() =>
      authFetch('/api/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: EXPORT_VERSION,
          mode: importMode,
          data: importParsedData.data,
        }),
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
  }, [importParsedData, importMode]);

  const handleImportClick = useCallback(() => {
    if (!importParsedData) return;
    if (importMode === 'replace') {
      setConfirmOpen(true);
      return;
    }
    void doImport();
  }, [importParsedData, importMode]);

  // ---- render ----
  const previewCounts = importParsedData ? countRecords(importParsedData.data) : null;

  if (!user.isAdmin) {
    return (
      <section className="grid gap-[18px] max-w-[960px] min-w-0">
        <header className="grid gap-[6px]">
          <Text size={200} weight="semibold" className="text-fui-fg2 leading-[1.2] uppercase">
            {t('dashboard.groups.admin')}
          </Text>
          <Text size={700} weight="semibold">
            {t('dashboard.backupRestore.heading')}
          </Text>
        </header>
        <Panel className="!p-[22px_24px]">
          <div className="grid gap-[10px] max-w-[680px]">
            <Text size={300} weight="semibold" style={{ color: 'light-dark(#0f6cbd, #75b6f7)' }}>
              {t('dashboard.pages.adminOnly')}
            </Text>
            <Text size={300} className="text-fui-fg3">
              {t('dashboard.pages.adminOnlyDescription')}
            </Text>
          </div>
        </Panel>
      </section>
    );
  }

  return (
    <section className="grid gap-[18px] max-w-[960px] min-w-0">
      {/* Page header */}
      <header className="grid gap-[6px]">
        <Text size={200} weight="semibold" className="text-fui-fg2 leading-[1.2] uppercase">
          {t('dashboard.groups.admin')}
        </Text>
        <Text size={700} weight="semibold">
          {t('dashboard.backupRestore.heading')}
        </Text>
      </header>

      {/* Export panel */}
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

      {/* Import panel */}
      <Panel className="!p-[22px_24px] grid gap-[16px]">
        <Text size={400} weight="semibold">
          {t('dashboard.backupRestore.import.heading')}
        </Text>
        <Text size={300} className="text-fui-fg3">
          {t('dashboard.backupRestore.import.description')}
        </Text>

        {/* Drop zone */}
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

        {/* File info & preview */}
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

            {/* Preview grid */}
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

            {/* Mode selector */}
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

            {/* Replace warning */}
            {importMode === 'replace' && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  {t('dashboard.backupRestore.import.replaceWarning')}
                </MessageBarBody>
              </MessageBar>
            )}

            {/* Import button */}
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

        {/* Messages */}
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

      {/* Confirm dialog for replace mode */}
      <ConfirmDialog
        actionLabel={t('dashboard.backupRestore.import.button')}
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
