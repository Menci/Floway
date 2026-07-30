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
  Field,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Radio,
  RadioGroup,
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

// A drop target has no counterpart in either library, so it is composed from
// the WinUI families the rest of the dashboard already spends. It is a button,
// and WinUI paints a chromeless button by stepping the subtle fill ramp, which
// is what the pointer and the drag both do here. The stroke is the strong
// control stroke rather than the card stroke a surface would take: this outline
// has to be seen, the same reason an unchecked check box reads that family. The
// radius is the overlay step, matching the card the zone sits in, and the
// dashed pattern is the one thing with no WinUI provenance -- it is the
// affordance itself, and nothing in the corpus describes a drop target.
//
// Dragging a file over it is the accepting state, so it takes the accent
// stroke; disablement steps the fill and the foreground rather than fading the
// whole element, which is how WinUI disables everything except a list item.
const useDropzoneStyles = makeStyles({
  root: {
    alignItems: 'center',
    ...shorthands.border('2px', 'dashed', 'var(--winui-control-strong-stroke-default)'),
    ...shorthands.borderRadius('var(--winui-overlay-corner-radius)'),
    backgroundColor: 'var(--winui-subtle-fill-transparent)',
    color: 'var(--winui-text-fill-secondary)',
    cursor: 'pointer',
    display: 'flex',
    font: 'inherit',
    flexDirection: 'column',
    gap: '8px',
    justifyContent: 'center',
    minHeight: '120px',
    padding: '24px',
    textAlign: 'center',
    transitionDuration: 'var(--winui-control-faster-animation-duration)',
    transitionProperty: 'border-color, background-color',
    transitionTimingFunction: 'var(--winui-control-fast-out-slow-in-easing)',
    ':hover': { backgroundColor: 'var(--winui-subtle-fill-secondary)' },
    ':active': { backgroundColor: 'var(--winui-subtle-fill-tertiary)' },
  },
  active: {
    ...shorthands.borderColor('var(--winui-accent-fill-default)'),
    backgroundColor: 'var(--winui-subtle-fill-secondary)',
  },
  disabled: {
    ...shorthands.borderColor('var(--winui-control-strong-stroke-disabled)'),
    backgroundColor: 'var(--winui-control-fill-disabled)',
    color: 'var(--winui-text-fill-disabled)',
    cursor: 'not-allowed',
  },
});

const usePreviewGridStyles = makeStyles({
  grid: {
    display: 'grid',
    gap: '10px',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
  },
  // One tile per counted entity. It is the Expander's content region -- the
  // secondary step of the card ramp -- at the control corner rather than the
  // overlay one, because these sit inside a card rather than being one.
  cell: {
    alignItems: 'center',
    backgroundColor: 'var(--winui-card-background-fill-secondary)',
    ...shorthands.borderRadius('var(--winui-control-corner-radius)'),
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '12px 10px',
    textAlign: 'center',
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

      <Panel className="!p-[22px_24px] grid">
        <Text as="h2" size={400} weight="semibold" className="m-0">
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

      <Panel className="!p-[22px_24px] grid">
        <Text as="h2" size={400} weight="semibold" className="m-0">
          {t('dashboard.backupRestore.import.heading')}
        </Text>
        <Text size={300} className="text-fui-fg3">
          {t('dashboard.backupRestore.import.description')}
        </Text>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={handleFileSelect}
        />
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

            <Field label={t('dashboard.backupRestore.import.mode')}>
              <RadioGroup disabled={importing} layout="horizontal" value={importMode} onChange={(_, data) => setImportMode(data.value as 'merge' | 'replace')}>
                <Radio label={<span className="grid gap-0.5"><Text weight="semibold">{t('dashboard.backupRestore.import.modeMerge')}</Text><Text size={200} className="text-fui-fg3">{t('dashboard.backupRestore.import.modeMergeDesc')}</Text></span>} value="merge" />
                <Radio label={<span className="grid gap-0.5"><Text weight="semibold">{t('dashboard.backupRestore.import.modeReplace')}</Text><Text size={200} className="text-fui-fg3">{t('dashboard.backupRestore.import.modeReplaceDesc')}</Text></span>} value="replace" />
              </RadioGroup>
            </Field>

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
        open={confirmOpen}
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
        title={t('dashboard.backupRestore.confirmTitle')}
      />
    </section>
  );
}
