import {
  ArrowDownRegular,
  ArrowUpRegular,
  CheckmarkCircleRegular,
  ChevronDownRegular,
  DeleteRegular,
  EditRegular,
  WarningRegular,
} from '@fluentui/react-icons';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, redirect, useLocation, useNavigate } from 'react-router';

import type { Route } from './+types/dashboard-providers-upstreams';
import { useDashboardOutletContext } from './dashboard';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import type {
  ControlPlaneModel,
  UpstreamProviderKind,
  UpstreamRecord,
} from '../api/types';
import { getSessionToken } from '../auth/session';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { ResourceListActions, ResourceListEmptyState, ResourceListPanel } from '../components/ui/resource-list';
import { ScrollArea } from '../components/ui/scroll-area';
import { TableActions, TableActionsHeader, TableCentredCell, TableCentredHeader } from '../components/ui/table-actions';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { ProviderBadge, ProviderIcon } from '../components/upstreams/provider-badge';
import { fluentComponents } from '../fluent';
import { dateTime } from '../lib/format-time';
import { useLocale } from '../lib/use-locale';

const {
  Button,
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
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Tooltip,
  makeStyles,
} = fluentComponents;

interface UpstreamsPageData {
  upstreams: UpstreamRecord[];
  models: ControlPlaneModel[] | null;
  loadError: string | null;
  modelsError: string | null;
}

type Mutation =
  | { kind: 'toggle'; id: string }
  | { kind: 'reorder'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'reload' };

const providers: readonly UpstreamProviderKind[] = [
  'custom',
  'azure',
  'copilot',
  'codex',
  'claude-code',
  'ollama',
];

const useStyles = makeStyles({
  ready: { color: 'var(--colorPaletteGreenForeground1)' },
  warning: { color: 'var(--colorPaletteDarkOrangeForeground1)' },
});

export async function clientLoader(): Promise<UpstreamsPageData> {
  if (!getSessionToken()) throw redirect('/');
  return await loadUpstreamsPageData();
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Upstreams | Floway' }];
}

export default function DashboardProvidersUpstreams({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();
  const navigate = useNavigate();
  const location = useLocation();
  const toasts = useOutcomeToasts();
  const [data, setData] = useState(loaderData);
  const [pageError, setPageError] = useState(loaderData.loadError);
  const [mutation, setMutation] = useState<Mutation | null>(null);
  const deleteDialog = useDialogInvocation<UpstreamRecord>();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const mutating = mutation !== null;

  // The error belongs to the attempt that produced it. Opening the dialog for
  // another upstream starts a new attempt, so the previous one's failure is
  // cleared here rather than waiting for a dismissal that may never come.
  const openDeleteDialog = (record: UpstreamRecord) => {
    setDeleteError(null);
    deleteDialog.open(record);
  };

  useEffect(() => {
    const search = new URLSearchParams(location.search);
    if (search.get('missing') !== '1') return;

    toasts.succeed(t('dashboard.upstreams.toast.missing'));
    void navigate(location.pathname, { replace: true });
  }, [location.pathname, location.search, navigate, t, toasts]);

  const mutationKind = mutation?.kind ?? null;
  useEffect(() => {
    if (!mutationKind) return;
    const handle = toasts.start(t(`dashboard.upstreams.busy.${mutationKind}`));
    return () => handle.settle();
  }, [mutationKind, t, toasts]);

  const reload = async (): Promise<UpstreamsPageData> => {
    const next = await loadUpstreamsPageData();
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
    setMutation({ kind: 'toggle', id: record.id });
    setPageError(null);
    setData(current => ({
      ...current,
      upstreams: current.upstreams.map(item =>
        item.id === record.id ? { ...item, enabled } : item),
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
    const index = snapshot.findIndex(item => item.id === record.id);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= snapshot.length) return;

    const target = snapshot[targetIndex];
    const next = [...snapshot];
    next[index] = target;
    next[targetIndex] = record;
    setMutation({ kind: 'reorder', id: record.id });
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
    setMutation({ kind: 'delete', id: record.id });
    setDeleteError(null);
    const result = await callApi(() =>
      api.api.upstreams[':id'].$delete({ param: { id: record.id } }));
    if (result.error) {
      setDeleteError(t('dashboard.upstreams.errors.delete', { message: result.error.message }));
      setMutation(null);
      return;
    }
    deleteDialog.close();
    await reload();
    setMutation(null);
    toasts.succeed(t('dashboard.upstreams.toast.deleted', { name: record.name }));
  };

  if (!user.isAdmin) {
    return <Navigate replace to="/dashboard/services/api-keys" />;
  }

  return (
    <div className="dashboard-page">
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
                        className: '!self-center',
                      }}
                      key={kind}
                      onClick={() => void navigate(`/dashboard/providers/upstreams/new/${kind}`)}
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
        <OutcomeMessageBar
          action={<Button appearance="transparent" disabled={mutating} onClick={() => void handleReload()}>
            {t('dashboard.upstreams.actions.retry')}
          </Button>}
          onDismiss={() => setPageError(null)}
        >{pageError}</OutcomeMessageBar>
      )}

      {data.modelsError && (
        <OutcomeMessageBar intent="warning">
          {t('dashboard.upstreams.errors.models', { message: data.modelsError })}
        </OutcomeMessageBar>
      )}

      <ResourceListPanel rowHeight="56px">
        <UpstreamsTable
          data={data}
          mutating={mutating}
          mutation={mutation}
          onDelete={openDeleteDialog}
          onEdit={record => void navigate(`/dashboard/providers/upstreams/${encodeURIComponent(record.id)}`)}
          onMove={(record, direction) => void move(record, direction)}
          onToggle={(record, enabled) => void setEnabled(record, enabled)}
        />
      </ResourceListPanel>

      {deleteDialog.invocation && <ConfirmDialog
        open={deleteDialog.isOpen}
        actionLabel={
          mutation?.kind === 'delete'
            ? t('dashboard.upstreams.actions.deleting')
            : t('dashboard.upstreams.actions.delete')
        }
        busy={mutation?.kind === 'delete'}
        error={deleteError}
        onDismissError={() => setDeleteError(null)}
        key={deleteDialog.invocation.key}
        message={t('dashboard.upstreams.delete.message', { name: deleteDialog.invocation.value.name })}
        onConfirm={() => {
          if (!mutating) void deleteUpstream(deleteDialog.invocation!.value);
        }}
        onOpenChange={open => {
          if (mutation?.kind !== 'delete' && !open) deleteDialog.close();
        }}
        title={t('dashboard.upstreams.delete.title')}
      />}
    </div>
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
  data: UpstreamsPageData;
  mutating: boolean;
  mutation: Mutation | null;
  onDelete: (record: UpstreamRecord) => void;
  onEdit: (record: UpstreamRecord) => void;
  onMove: (record: UpstreamRecord, direction: -1 | 1) => void;
  onToggle: (record: UpstreamRecord, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const modelCounts = useMemo(() => buildModelCounts(data.upstreams, data.models), [data.models, data.upstreams]);

  if (data.upstreams.length === 0) {
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
            <TableCentredHeader>{t('dashboard.upstreams.table.models')}</TableCentredHeader>
            <TableCentredHeader>{t('dashboard.upstreams.table.enabled')}</TableCentredHeader>
            <TableActionsHeader>{t('dashboard.upstreams.table.actions')}</TableActionsHeader>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.upstreams.map((record, index) => (
            <TableRow key={record.id}>
              <TableCell>
                <div className="inline-flex items-center gap-1">
                  <Text size={300} className="text-fui-fg3 min-w-[22px] text-center">{index + 1}</Text>
                  <TooltipIconButton
                    disabled={mutating || index === 0}
                    icon={<ArrowUpRegular />}
                    label={t('dashboard.upstreams.actions.moveUp', { name: record.name })}
                    onClick={() => onMove(record, -1)}
                  />
                  <TooltipIconButton
                    disabled={mutating || index === data.upstreams.length - 1}
                    icon={<ArrowDownRegular />}
                    label={t('dashboard.upstreams.actions.moveDown', { name: record.name })}
                    onClick={() => onMove(record, 1)}
                  />
                </div>
              </TableCell>
              <TableCell><ProviderBadge color={record.color} kind={record.kind} /></TableCell>
              <TableCell className="overflow-hidden">
                <div className="grid gap-[3px] min-w-0 max-w-[520px]">
                  <Link
                    className="text-fui-fg1 no-underline hover:underline truncate"
                    title={record.name}
                    to={`/dashboard/providers/upstreams/${encodeURIComponent(record.id)}`}
                  >
                    {record.name}
                  </Link>
                  <Text size={200} className="text-fui-fg3 truncate max-w-full" title={upstreamSummary(record, t)}>
                    {upstreamSummary(record, t)}
                  </Text>
                </div>
              </TableCell>
              <TableCentredCell>
                <ModelStatus count={modelCounts.get(record.id)!} modelsAvailable={data.models !== null} record={record} />
              </TableCentredCell>
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
                    disabled={mutating}
                    icon={mutation?.kind === 'delete' && mutation.id === record.id ? <Spinner size="tiny" /> : <DeleteRegular />}
                    label={t('dashboard.upstreams.actions.deleteNamed', { name: record.name })}
                    onClick={() => onDelete(record)}
                  />
                </TableActions>
              </TableCell>
            </TableRow>
          ))}
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
  const s = useStyles();
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
      <span className="inline-flex items-center gap-[6px] min-w-0 w-fit max-w-full">
        <Text size={300} className="whitespace-nowrap">
          {modelsAvailable
            ? t('dashboard.upstreams.models.count', { count })
            : t('dashboard.upstreams.models.unavailable')}
        </Text>
        {healthy
          ? <CheckmarkCircleRegular className={`${s.ready} block flex-none`} fontSize={18} aria-label={t('dashboard.upstreams.cache.ready')} />
          : <WarningRegular className={`${s.warning} block flex-none`} fontSize={18} aria-label={t(`dashboard.upstreams.cache.${cacheStatus}`)} />}
      </span>
    </Tooltip>
  );
}

async function loadUpstreamsPageData(): Promise<UpstreamsPageData> {
  const [upstreamsResult, modelsResult] = await Promise.all([
    callApi(() => api.api.upstreams.$get()),
    callApi(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } })),
  ]);
  return {
    upstreams: (upstreamsResult.data ?? []).sort(compareUpstreams),
    models: modelsResult.data?.data ?? null,
    loadError: upstreamsResult.error?.message ?? null,
    modelsError: modelsResult.error?.message ?? null,
  };
}

const patchUpstream = (id: string, body: { enabled?: boolean; sort_order?: number }) =>
  callApi(() => api.api.upstreams[':id'].$patch({ param: { id }, json: body }));

const compareUpstreams = (a: UpstreamRecord, b: UpstreamRecord) =>
  a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

const buildModelCounts = (
  upstreams: UpstreamRecord[],
  models: ControlPlaneModel[] | null,
): Map<string, number> => {
  const counts = new Map(upstreams.map(record => [record.id, record.kind === 'azure' ? record.config.models.length : 0]));
  if (!models) return counts;
  for (const model of models) {
    for (const binding of model.upstreams) {
      const record = upstreams.find(item => item.id === binding.id);
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
