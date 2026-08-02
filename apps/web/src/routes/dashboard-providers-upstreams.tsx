import {
  CheckmarkCircleRegular,
  ChevronDownRegular,
  DeleteRegular,
  EditRegular,
  WarningRegular,
} from '@fluentui/react-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';

import type { Route } from './+types/dashboard-providers-upstreams';
import { requireDashboardAdmin } from './route-guards';
import { api, callApi } from '../api/client';
import type {
  ControlPlaneModel,
  UpstreamProviderKind,
  UpstreamRecord,
} from '../api/types';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { ReorderButtons } from '../components/ui/reorder-buttons';
import { ResourceListActions, ResourceListEmptyState, ResourceListPanel } from '../components/ui/resource-list';
import { useRowTitleClass } from '../components/ui/row-title';
import { ScrollArea } from '../components/ui/scroll-area';
import { TableActions, TableActionsHeader, TableCentredCell, TableCentredHeader } from '../components/ui/table-actions';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { ProviderBadge, ProviderIcon } from '../components/upstreams/provider-badge';
import { fluentComponents } from '../fluent';
import { dateTime } from '../lib/format-time';
import { pageNavigation } from '../lib/page-navigation';
import { useLocale } from '../lib/use-locale';
import { ALL_PROVIDER_KINDS } from '@floway-dev/provider';

const {
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableCellLayout,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Tooltip,
} = fluentComponents;

interface LoaderData {
  /** `null` when the fetch failed, not the same as none configured. */
  upstreams: UpstreamRecord[] | null;
  models: ControlPlaneModel[] | null;
  loadError: string | null;
  modelsError: string | null;
}

// The record name travels with the mutation so the pending toast keeps naming
// the same subject while the list underneath it is optimistically rewritten.
type Mutation =
  | { kind: 'toggle'; id: string; name: string }
  | { kind: 'reorder'; id: string; name: string }
  | { kind: 'delete'; id: string; name: string }
  | { kind: 'reload' };

const PROVIDER_MENU_ORDER: readonly UpstreamProviderKind[] = [
  'custom',
  'azure',
  'copilot',
  'codex',
  'claude-code',
  'ollama',
];

const menuRank = (kind: UpstreamProviderKind) => {
  const index = PROVIDER_MENU_ORDER.indexOf(kind);
  return index === -1 ? PROVIDER_MENU_ORDER.length : index;
};

const providers = ALL_PROVIDER_KINDS.toSorted((a, b) => menuRank(a) - menuRank(b));

const loadPageData = async (): Promise<LoaderData> => {
  const [upstreamsResult, modelsResult] = await Promise.all([
    callApi(() => api.api.upstreams.$get()),
    callApi(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } })),
  ]);
  return {
    upstreams: upstreamsResult.data?.sort(compareUpstreams) ?? null,
    models: modelsResult.data?.data ?? null,
    loadError: upstreamsResult.error?.message ?? null,
    modelsError: modelsResult.error?.message ?? null,
  };
};

export async function clientLoader(): Promise<LoaderData> {
  await requireDashboardAdmin();
  return await loadPageData();
}

export default function DashboardProvidersUpstreams({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const toasts = useOutcomeToasts();
  // Seeded from the loader, then owned by the page: the effect below strips the
  // missing-upstream flag from the URL, which re-runs the loader, so deriving
  // from the loader payload would wipe the message the effect just wrote.
  const [data, setData] = useState(loaderData);
  const [pageError, setPageError] = useState(loaderData.loadError);
  const [mutation, setMutation] = useState<Mutation | null>(null);
  const deleteDialog = useDialogInvocation<UpstreamRecord>();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const mutating = mutation !== null;

  const openDeleteDialog = (record: UpstreamRecord) => {
    setDeleteError(null);
    deleteDialog.open(record);
  };

  // The effect runs twice under StrictMode, so the ref stops the second run
  // repeating the message before the URL-stripping navigation has landed.
  const announcedMissing = useRef(false);
  useEffect(() => {
    const search = new URLSearchParams(location.search);
    if (search.get('missing') !== '1' || announcedMissing.current) return;

    announcedMissing.current = true;
    setPageError(t('dashboard.upstreams.errors.missing'));
    void navigate(location.pathname, { replace: true });
  }, [location.pathname, location.search, navigate, t]);

  // Delete is excluded because it owns its handle: it has a success line to
  // announce, and that has to update the toast the pending line already holds.
  const mutationKind = mutation?.kind ?? null;
  const mutationName = mutation !== null && mutation.kind !== 'reload' ? mutation.name : null;
  useEffect(() => {
    if (!mutationKind || mutationKind === 'delete') return;
    const handle = toasts.start(t(`dashboard.upstreams.toast.${mutationKind}.pending`, { name: mutationName }));
    return () => handle.settle();
  }, [mutationKind, mutationName, t, toasts]);

  const reload = async (): Promise<LoaderData> => {
    const next = await loadPageData();
    setData(next);
    setPageError(next.loadError);
    return next;
  };

  const handleReload = async () => {
    setMutation({ kind: 'reload' });
    setPageError(null);
    await reload();
    setMutation(null);
  };

  const setEnabled = async (record: UpstreamRecord, enabled: boolean) => {
    const snapshot = data.upstreams;
    if (snapshot === null) return;
    setMutation({ kind: 'toggle', id: record.id, name: record.name });
    setPageError(null);
    setData(current => ({
      ...current,
      upstreams: (current.upstreams ?? []).map(candidate =>
        candidate.id === record.id ? { ...candidate, enabled } : candidate),
    }));

    const result = await patchUpstream(record.id, { enabled });
    if (result.error) {
      setData(current => ({ ...current, upstreams: snapshot }));
      setPageError(t('dashboard.upstreams.errors.toggle', { message: result.error.message }));
      setMutation(null);
      return;
    }

    await reload();
    setMutation(null);
  };

  const move = async (record: UpstreamRecord, direction: -1 | 1) => {
    const snapshot = data.upstreams;
    if (snapshot === null) return;
    const index = snapshot.findIndex(candidate => candidate.id === record.id);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= snapshot.length) return;

    const target = snapshot[targetIndex];
    const next = [...snapshot];
    next[index] = target;
    next[targetIndex] = record;
    setMutation({ kind: 'reorder', id: record.id, name: record.name });
    setPageError(null);
    setData(current => ({ ...current, upstreams: next }));

    const [first, second] = await Promise.all([
      patchUpstream(record.id, { sort_order: target.sort_order }),
      patchUpstream(target.id, { sort_order: record.sort_order }),
    ]);
    const error = first.error ?? second.error;
    if (error) {
      setData(current => ({ ...current, upstreams: snapshot }));
      const synced = await reload();
      setPageError(
        t('dashboard.upstreams.errors.reorder', {
          message: error.message,
          sync: synced.loadError ? t('dashboard.upstreams.errors.syncFailed') : '',
        }),
      );
      setMutation(null);
      return;
    }

    await reload();
    setMutation(null);
  };

  const deleteUpstream = async (record: UpstreamRecord) => {
    setMutation({ kind: 'delete', id: record.id, name: record.name });
    setDeleteError(null);
    const handle = toasts.start(t('dashboard.upstreams.toast.delete.pending', { name: record.name }));
    const result = await callApi(() =>
      api.api.upstreams[':id'].$delete({ param: { id: record.id } }));
    if (result.error) {
      handle.settle();
      setDeleteError(t('dashboard.upstreams.errors.delete', { message: result.error.message }));
      setMutation(null);
      return;
    }
    deleteDialog.close();
    await reload();
    setMutation(null);
    handle.succeed(t('dashboard.upstreams.toast.delete.success', { name: record.name }));
  };

  return (
    <section className="dashboard-page">
      <DashboardPageHeader
        actions={<ResourceListActions
          createLabel={t('dashboard.upstreams.actions.create')}
          createTrailingIcon={<ChevronDownRegular className="ml-1.5" />}
          createTrigger={button => (
            <Menu positioning={{ autoSize: true }}>
              <MenuTrigger disableButtonEnhancement>{button}</MenuTrigger>
              <MenuPopover>
                <MenuList>
                  {providers.map(kind => (
                    <MenuItem
                      icon={{
                        children: <ProviderIcon kind={kind} className="h-5 w-5" />,
                        className: 'self-center',
                      }}
                      key={kind}
                      onClick={() => void navigate(`/dashboard/providers/upstreams/new/${kind}`, pageNavigation)}
                      subText={t(`dashboard.upstreams.providers.${kind}`)}
                    >
                      {t(`provider.${kind}`)}
                    </MenuItem>
                  ))}
                </MenuList>
              </MenuPopover>
            </Menu>
          )}
          disabled={mutating}
          onRefresh={() => void handleReload()}
          refreshLabel={t('dashboard.upstreams.actions.refresh')}
          refreshing={mutation?.kind === 'reload'}
        />}
        description={t('dashboard.pages.upstreams')}
        title={t('dashboard.nav.upstreams')}
      />

      {pageError && (
        <OutcomeMessageBar onDismiss={() => setPageError(null)}>{pageError}</OutcomeMessageBar>
      )}

      {data.modelsError && (
        <OutcomeMessageBar intent="warning" onDismiss={() => setData(current => ({ ...current, modelsError: null }))}>
          {t('dashboard.upstreams.errors.models', { message: data.modelsError })}
        </OutcomeMessageBar>
      )}

      <ResourceListPanel rowHeight="56px">
        <UpstreamsTable
          data={data}
          mutating={mutating}
          mutation={mutation}
          onDelete={openDeleteDialog}
          onEdit={record => void navigate(`/dashboard/providers/upstreams/${encodeURIComponent(record.id)}`, pageNavigation)}
          onMove={(record, direction) => void move(record, direction)}
          onToggle={(record, enabled) => void setEnabled(record, enabled)}
        />
      </ResourceListPanel>

      {deleteDialog.invocation && <ConfirmDialog
        open={deleteDialog.isOpen}
        actionLabel={t('dashboard.upstreams.actions.delete')}
        busy={mutation?.kind === 'delete'}
        error={deleteError}
        key={deleteDialog.invocation.key}
        message={t('dashboard.upstreams.delete.message', { name: deleteDialog.invocation.value.name })}
        onConfirm={() => void deleteUpstream(deleteDialog.invocation!.value)}
        onDismissError={() => setDeleteError(null)}
        onOpenChange={open => { if (!open) deleteDialog.close(); }}
        title={t('dashboard.upstreams.delete.title')}
      />}
    </section>
  );
}

function UpstreamsTable({
  data,
  mutating,
  mutation,
  onDelete,
  onEdit,
  onMove,
  onToggle,
}: {
  data: LoaderData;
  mutating: boolean;
  mutation: Mutation | null;
  onDelete: (record: UpstreamRecord) => void;
  onEdit: (record: UpstreamRecord) => void;
  onMove: (record: UpstreamRecord, direction: -1 | 1) => void;
  onToggle: (record: UpstreamRecord, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const rowTitle = useRowTitleClass();
  const upstreams = data.upstreams;
  const modelCounts = useMemo(() => buildModelCounts(upstreams ?? [], data.models), [data.models, upstreams]);

  // A failed fetch is not an empty list: the message bar carries the reason.
  if (upstreams === null) return null;
  if (upstreams.length === 0) {
    return <ResourceListEmptyState>{t('dashboard.upstreams.empty')}</ResourceListEmptyState>;
  }

  return (
    <ScrollArea axes="horizontal" className="min-w-0">
      <Table aria-label={t('dashboard.upstreams.table.title')} className="min-w-[860px] table-fixed">
        <colgroup><col className="w-[120px]" /><col className="w-[140px]" /><col className="w-[300px]" /><col className="w-[140px]" /><col className="w-[90px]" /><col className="w-[70px]" /></colgroup>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t('dashboard.upstreams.table.priority')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.upstreams.table.provider')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.upstreams.table.upstream')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.upstreams.table.models')}</TableHeaderCell>
            <TableCentredHeader>{t('dashboard.upstreams.table.enabled')}</TableCentredHeader>
            <TableActionsHeader>{t('dashboard.upstreams.table.actions')}</TableActionsHeader>
          </TableRow>
        </TableHeader>
        <TableBody>
          {upstreams.map((record, index) => {
            const deleting = mutation?.kind === 'delete' && mutation.id === record.id;
            return <TableRow key={record.id}>
              <TableCell>
                <div className="inline-flex items-center gap-1">
                  <Text className="text-fui-fg3 min-w-[22px] text-center">{index + 1}</Text>
                  <ReorderButtons
                    disabled={mutating}
                    downLabel={t('dashboard.upstreams.actions.moveDown', { name: record.name })}
                    isFirst={index === 0}
                    isLast={index === upstreams.length - 1}
                    onMove={direction => onMove(record, direction)}
                    upLabel={t('dashboard.upstreams.actions.moveUp', { name: record.name })}
                  />
                </div>
              </TableCell>
              <TableCell><ProviderBadge color={record.color} kind={record.kind} /></TableCell>
              <TableCell className="overflow-hidden">
                <TableCellLayout
                  className="max-w-[520px]"
                  description={<Tooltip content={upstreamSummary(record, t)} relationship="label">
                    <Text block tabIndex={0} truncate wrap={false}>{upstreamSummary(record, t)}</Text>
                  </Tooltip>}
                  truncate
                >
                  <Tooltip content={record.name} relationship="label">
                    <Link
                      {...pageNavigation}
                      className={`${rowTitle} truncate`}
                      to={`/dashboard/providers/upstreams/${encodeURIComponent(record.id)}`}
                    >
                      {record.name}
                    </Link>
                  </Tooltip>
                </TableCellLayout>
              </TableCell>
              <TableCell>
                <ModelStatus count={modelCounts.get(record.id)!} modelsAvailable={data.models !== null} record={record} />
              </TableCell>
              <TableCentredCell>
                <Switch
                  aria-label={t('dashboard.upstreams.actions.toggle', { name: record.name })}
                  checked={record.enabled}
                  disabled={mutating}
                  onChange={(_, detail) => onToggle(record, detail.checked)}
                />
              </TableCentredCell>
              <TableCell>
                <TableActions>
                  <TooltipIconButton
                    disabled={mutating}
                    icon={<EditRegular />}
                    label={t('dashboard.upstreams.actions.editNamed', { name: record.name })}
                    onClick={() => onEdit(record)}
                  />
                  <TooltipIconButton
                    danger
                    disabled={mutating && !deleting}
                    disabledFocusable={deleting}
                    icon={deleting ? <Spinner size="tiny" /> : <DeleteRegular />}
                    label={t('dashboard.upstreams.actions.deleteNamed', { name: record.name })}
                    onClick={() => onDelete(record)}
                  />
                </TableActions>
              </TableCell>
            </TableRow>;
          })}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

function ModelStatus({
  count,
  modelsAvailable,
  record,
}: {
  count: number;
  modelsAvailable: boolean;
  record: UpstreamRecord;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const cacheStatus = record.modelsCache.lastError
    ? 'failed'
    : record.modelsCache.fetchedAt === null ? 'empty' : 'ready';
  const healthy = modelsAvailable && count > 0 && !record.modelsCache.lastError;
  const detail = record.modelsCache.lastError
    ? t('dashboard.upstreams.cache.failedDetail', {
        message: record.modelsCache.lastError.message,
        time: dateTime(record.modelsCache.lastError.at, locale),
      })
    : record.modelsCache.fetchedAt !== null
      ? t('dashboard.upstreams.cache.readyDetail', { time: dateTime(record.modelsCache.fetchedAt, locale) })
      : t('dashboard.upstreams.cache.emptyDetail');

  return (
    <Tooltip content={detail} relationship="description">
      <span className="inline-flex items-center gap-1.5 min-w-0 w-fit max-w-full" tabIndex={0}>
        <Text size={300} className="whitespace-nowrap">
          {modelsAvailable
            ? t('dashboard.upstreams.models.count', { count })
            : t('dashboard.upstreams.models.unavailable')}
        </Text>
        {healthy
          ? <CheckmarkCircleRegular className="block flex-none text-[var(--colorPaletteGreenForeground1)]" fontSize={18} aria-label={t('dashboard.upstreams.cache.ready')} />
          : <WarningRegular className="block flex-none text-[var(--colorPaletteDarkOrangeForeground1)]" fontSize={18} aria-label={t(`dashboard.upstreams.cache.${cacheStatus}`)} />}
      </span>
    </Tooltip>
  );
}

const patchUpstream = (id: string, body: { enabled?: boolean; sort_order?: number }) =>
  callApi(() => api.api.upstreams[':id'].$patch({ param: { id }, json: body }));

const compareUpstreams = (a: UpstreamRecord, b: UpstreamRecord) =>
  a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

const buildModelCounts = (
  upstreams: UpstreamRecord[],
  models: ControlPlaneModel[] | null,
): Map<string, number> => {
  const byId = new Map(upstreams.map(record => [record.id, record]));
  const counts = new Map(upstreams.map(record => [record.id, record.kind === 'azure' ? record.config.models.length : 0]));
  if (!models) return counts;
  for (const model of models) {
    for (const binding of model.upstreams) {
      const record = byId.get(binding.id);
      if (record && record.kind !== 'azure') counts.set(record.id, counts.get(record.id)! + 1);
    }
  }
  return counts;
};

const upstreamSummary = (record: UpstreamRecord, t: ReturnType<typeof useTranslation>['t']): string => {
  switch (record.kind) {
  case 'custom': return record.config.baseUrl;
  case 'azure': return record.config.endpoint;
  case 'ollama': return record.config.baseUrl || t('dashboard.upstreams.summary.ollama');
  case 'copilot': return record.config.user.login ? `@${record.config.user.login}` : t('dashboard.upstreams.summary.copilot');
  case 'codex': {
    const account = record.config.accounts[0];
    return account ? [account.email, account.planType].filter(Boolean).join(' - ') : t('dashboard.upstreams.summary.noAccount');
  }
  case 'claude-code': {
    const account = record.config.accounts[0];
    if (!account) return t('dashboard.upstreams.summary.noAccount');
    return account.email ?? account.accountUuid.slice(0, 8);
  }
  }
};
