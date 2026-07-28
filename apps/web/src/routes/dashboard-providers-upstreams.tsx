import {
  AddRegular,
  ArrowClockwiseRegular,
  ArrowDownRegular,
  ArrowUpRegular,
  CheckmarkCircleRegular,
  ChevronDownRegular,
  DeleteRegular,
  EditRegular,
  WarningRegular,
} from '@fluentui/react-icons';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, redirect, useLocation, useNavigate } from 'react-router';

import type { Route } from './+types/dashboard-providers-upstreams';
import { useDashboardOutletContext } from './dashboard';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import { upstreamRecordsFromWire } from '../api/types';
import type {
  ControlPlaneModel,
  UpstreamProviderKind,
  UpstreamRecord,
} from '../api/types';
import { getSessionToken } from '../auth/session';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Panel } from '../components/ui/panel';
import { ScrollArea } from '../components/ui/scroll-area';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { ProviderBadge, ProviderIcon } from '../components/upstreams/provider-badge';
import { fluentComponents } from '../fluent';
import { dateTime } from '../lib/format-time';

const {
  Button,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Toast,
  Toaster,
  ToastTitle,
  Tooltip,
  makeStyles,
  useToastController,
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
  const toasterId = useId();
  const mutationToastId = useId();
  const { dismissToast, dispatchToast } = useToastController(toasterId);
  const [data, setData] = useState(loaderData);
  const [pageError, setPageError] = useState(loaderData.loadError);
  const [mutation, setMutation] = useState<Mutation | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UpstreamRecord | null>(null);

  const busy = mutation !== null;

  useEffect(() => {
    const search = new URLSearchParams(location.search);
    if (search.get('missing') !== '1') return;

    dispatchToast(
      <Toast>
        <ToastTitle>{t('dashboard.upstreams.toast.missing')}</ToastTitle>
      </Toast>,
      { intent: 'warning' },
    );
    void navigate(location.pathname, { replace: true });
  }, [dispatchToast, location.pathname, location.search, navigate, t]);

  useEffect(() => {
    if (!mutation) {
      dismissToast(mutationToastId);
      return;
    }

    dispatchToast(
      <Toast>
        <ToastTitle media={<Spinner size="tiny" />}>
          {t(`dashboard.upstreams.busy.${mutation.kind}`)}
        </ToastTitle>
      </Toast>,
      { toastId: mutationToastId, timeout: -1 },
    );
  }, [dismissToast, dispatchToast, mutation, mutationToastId, t]);

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
    setPageError(null);
    const result = await callApi(() =>
      api.api.upstreams[':id'].$delete({ param: { id: record.id } }));
    if (result.error) {
      setPageError(t('dashboard.upstreams.errors.delete', { message: result.error.message }));
      setMutation(null);
      return;
    }
    setDeleteTarget(null);
    await reload();
    setMutation(null);
    dispatchToast(
      <Toast>
        <ToastTitle>
          {t('dashboard.upstreams.toast.deleted', { name: record.name })}
        </ToastTitle>
      </Toast>,
      { intent: 'success' },
    );
  };

  if (!user.isAdmin) {
    return <Navigate replace to="/dashboard/services/api-keys" />;
  }

  return (
    <div className="grid gap-[18px] min-w-0">
      <Toaster toasterId={toasterId} position="top-end" />

      <DashboardPageHeader
        actions={<>
          <Tooltip content={t('dashboard.upstreams.actions.refresh')} relationship="label">
            <Button
              appearance="subtle"
              aria-label={t('dashboard.upstreams.actions.refresh')}
              disabled={busy}
              icon={mutation?.kind === 'reload' ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />}
              onClick={() => void handleReload()}
            />
          </Tooltip>
          <Menu positioning={{ autoSize: true }}>
            <MenuTrigger disableButtonEnhancement>
              <Button appearance="primary" disabled={busy} icon={<AddRegular />}>
                {t('dashboard.upstreams.actions.create')}
                <ChevronDownRegular className="ml-1.5" />
              </Button>
            </MenuTrigger>
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
        </>}
        description={t('dashboard.pages.upstreams')}
        eyebrow={t('dashboard.groups.providers')}
        title={t('dashboard.nav.upstreams')}
      />

      {pageError && (
        <MessageBar intent="error">
          <MessageBarBody>{pageError}</MessageBarBody>
          <MessageBarActions>
            <Button appearance="transparent" disabled={busy} onClick={() => void handleReload()}>
              {t('dashboard.upstreams.actions.retry')}
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {data.modelsError && (
        <MessageBar intent="warning">
          <MessageBarBody>
            {t('dashboard.upstreams.errors.models', { message: data.modelsError })}
          </MessageBarBody>
        </MessageBar>
      )}

      <Panel className="grid gap-[14px] min-w-0 !p-[18px] !pt-[10px]">
        <UpstreamsTable
          busy={busy}
          data={data}
          mutation={mutation}
          onDelete={setDeleteTarget}
          onEdit={record => void navigate(`/dashboard/providers/upstreams/${encodeURIComponent(record.id)}`)}
          onMove={(record, direction) => void move(record, direction)}
          onToggle={(record, enabled) => void setEnabled(record, enabled)}
        />
      </Panel>

      <ConfirmDialog
        actionLabel={
          mutation?.kind === 'delete'
            ? t('dashboard.upstreams.actions.deleting')
            : t('dashboard.upstreams.actions.delete')
        }
        busy={mutation?.kind === 'delete'}
        message={t('dashboard.upstreams.delete.message', { name: deleteTarget?.name ?? '' })}
        onConfirm={() => {
          if (deleteTarget && !busy) void deleteUpstream(deleteTarget);
        }}
        onOpenChange={open => {
          if (!open && mutation?.kind !== 'delete') setDeleteTarget(null);
        }}
        open={deleteTarget !== null}
        title={t('dashboard.upstreams.delete.title')}
      />
    </div>
  );
}

function UpstreamsTable({
  busy,
  data,
  mutation,
  onDelete,
  onEdit,
  onMove,
  onToggle,
}: {
  busy: boolean;
  data: UpstreamsPageData;
  mutation: Mutation | null;
  onDelete: (record: UpstreamRecord) => void;
  onEdit: (record: UpstreamRecord) => void;
  onMove: (record: UpstreamRecord, direction: -1 | 1) => void;
  onToggle: (record: UpstreamRecord, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const modelCounts = useMemo(() => buildModelCounts(data.upstreams, data.models), [data.models, data.upstreams]);

  if (data.upstreams.length === 0) {
    return (
      <div className="grid justify-items-center gap-3 text-center p-[28px_18px]">
        <Text size={300} className="text-fui-fg3">{t('dashboard.upstreams.empty')}</Text>
      </div>
    );
  }

  return (
    <ScrollArea axes="horizontal" className="min-w-0">
      <Table size="small" aria-label={t('dashboard.upstreams.table.title')} className="min-w-[930px]">
        <TableHeader>
          <TableRow>
            <TableHeaderCell className="!w-[130px]">{t('dashboard.upstreams.table.priority')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.upstreams.table.upstream')}</TableHeaderCell>
            <TableHeaderCell className="!w-[150px]">{t('dashboard.upstreams.table.provider')}</TableHeaderCell>
            <TableHeaderCell className="!w-[180px]">{t('dashboard.upstreams.table.models')}</TableHeaderCell>
            <TableHeaderCell className="!w-[110px]">{t('dashboard.upstreams.table.enabled')}</TableHeaderCell>
            <TableHeaderCell className="!w-[68px]">{t('dashboard.upstreams.table.actions')}</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.upstreams.map((record, index) => (
            <TableRow className="h-[58px]" key={record.id}>
              <TableCell>
                <div className="inline-flex items-center gap-1">
                  <Text size={200} className="text-fui-fg3 min-w-[22px] text-center">{index + 1}</Text>
                  <TooltipIconButton
                    disabled={busy || index === 0}
                    icon={<ArrowUpRegular />}
                    label={t('dashboard.upstreams.actions.moveUp', { name: record.name })}
                    onClick={() => onMove(record, -1)}
                  />
                  <TooltipIconButton
                    disabled={busy || index === data.upstreams.length - 1}
                    icon={<ArrowDownRegular />}
                    label={t('dashboard.upstreams.actions.moveDown', { name: record.name })}
                    onClick={() => onMove(record, 1)}
                  />
                </div>
              </TableCell>
              <TableCell>
                <div className="grid gap-[3px] min-w-0 max-w-[420px]">
                  <Link
                    className="text-fui-fg1 font-fui-semibold no-underline hover:underline truncate"
                    title={record.name}
                    to={`/dashboard/providers/upstreams/${encodeURIComponent(record.id)}`}
                  >
                    {record.name}
                  </Link>
                  <Text size={200} className="text-fui-fg3 truncate" title={upstreamSummary(record, t)}>
                    {upstreamSummary(record, t)}
                  </Text>
                </div>
              </TableCell>
              <TableCell><ProviderBadge color={record.color} kind={record.kind} /></TableCell>
              <TableCell>
                <ModelStatus count={modelCounts.get(record.id)!} modelsAvailable={data.models !== null} record={record} />
              </TableCell>
              <TableCell>
                <Switch
                  aria-label={t('dashboard.upstreams.actions.toggle', { name: record.name })}
                  checked={record.enabled}
                  disabled={busy}
                  onChange={(_, detail) => onToggle(record, detail.checked)}
                  size="small"
                />
              </TableCell>
              <TableCell>
                <div className="inline-flex items-center gap-[2px]">
                  <TooltipIconButton
                    disabled={busy}
                    icon={<EditRegular />}
                    label={t('dashboard.upstreams.actions.editNamed', { name: record.name })}
                    onClick={() => onEdit(record)}
                  />
                  <TooltipIconButton
                    danger
                    disabled={busy}
                    icon={mutation?.kind === 'delete' && mutation.id === record.id ? <Spinner size="tiny" /> : <DeleteRegular />}
                    label={t('dashboard.upstreams.actions.deleteNamed', { name: record.name })}
                    onClick={() => onDelete(record)}
                  />
                </div>
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
  const s = useStyles();
  const cacheStatus = record.modelsCache.lastError
    ? 'failed'
    : record.modelsCache.fetchedAt === null ? 'empty' : 'ready';
  const healthy = modelsAvailable && count > 0 && !record.modelsCache.lastError;
  const detail = record.modelsCache.lastError
    ? t('dashboard.upstreams.cache.failedDetail', {
        message: record.modelsCache.lastError.message,
        time: dateTime(record.modelsCache.lastError.at),
      })
    : record.modelsCache.fetchedAt !== null
      ? t('dashboard.upstreams.cache.readyDetail', { time: dateTime(record.modelsCache.fetchedAt) })
      : t('dashboard.upstreams.cache.emptyDetail');

  return (
    <Tooltip content={detail} relationship="description">
      <span className="inline-flex items-center gap-[6px] min-w-0 w-fit max-w-full">
        <Text size={200} weight="semibold" className="whitespace-nowrap">
          {modelsAvailable
            ? t('dashboard.upstreams.models.count', { count })
            : t('dashboard.upstreams.models.unavailable')}
        </Text>
        {healthy
          ? <CheckmarkCircleRegular className={`${s.ready} flex-none`} aria-label={t('dashboard.upstreams.cache.ready')} />
          : <WarningRegular className={`${s.warning} flex-none`} aria-label={t(`dashboard.upstreams.cache.${cacheStatus}`)} />}
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
    upstreams: upstreamRecordsFromWire(upstreamsResult.data ?? []).sort(compareUpstreams),
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
