import {
  CheckmarkCircleRegular,
  ChevronDownRegular,
  DeleteRegular,
  EditRegular,
  ProhibitedRegular,
  WarningRegular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { type TFunction, useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-providers-upstreams';
import { requireDashboardAdmin } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import { api, callApi } from '../api/client';
import type { ControlPlaneModel, UpstreamRecord } from '../api/types';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { ReorderButtons } from '../components/ui/reorder-buttons';
import { ResourceListActions, ResourceListEmptyState, ResourceListPanel } from '../components/ui/resource-list';
import { RouteMenuItem } from '../components/ui/route-menu-item';
import { rowTitleClass } from '../components/ui/row-title';
import { ScrollArea } from '../components/ui/scroll-area';
import { TABLE_ACTIONS_WIDTH, TableActions, TableCentredCell, TableCentredHeader, TableTrailingHeader } from '../components/ui/table-actions';
import { TableColumns } from '../components/ui/table-columns';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { TruncationTooltip, useTruncation } from '../components/ui/truncation-tooltip';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { useRefresh } from '../components/ui/use-refresh';
import { ProviderBadge, ProviderIcon } from '../components/upstreams/provider-badge';
import { fluentComponents } from '../fluent';
import { dateTime } from '../lib/format-time';
import { pageNavigation, useEntryRewrite } from '../lib/page-navigation';
import { useLocale } from '../lib/use-locale';
import { ALL_PROVIDER_KINDS } from '@floway-dev/provider';
import type { UpstreamProviderKind } from '@floway-dev/provider/model';

const {
  Menu,
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

type Mutation =
  | { kind: 'toggle'; id: string }
  | { kind: 'reorder'; id: string }
  | { kind: 'delete'; id: string };

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

// Both affordances that open a record — the row's name and its edit button —
// address it from here, so the two cannot come apart.
const upstreamEditorPath = (record: UpstreamRecord) => `/dashboard/providers/upstreams/${encodeURIComponent(record.id)}`;

const loadPageData = async (signal?: AbortSignal): Promise<LoaderData> => {
  const [upstreamsResult, modelsResult] = await Promise.all([
    callApi(() => api.api.upstreams.$get(undefined, { init: { signal } })),
    callApi(() => api.api.models.$get(
      { query: { aliases: 'false', include_unlisted: 'true' } },
      { init: { signal } },
    )),
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

// The page strips the missing-upstream flag from the search after announcing
// it, and that navigation must not refetch what the loader already delivered.
export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardProvidersUpstreams({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const rewrite = useEntryRewrite();
  const toasts = useOutcomeToasts();
  // Seeded from the loader, then owned by the page: every refresh and every
  // optimistic mutation writes here, so the loader payload is only first paint.
  const [data, setData] = useState(loaderData);
  const [pageError, setPageError] = useState(loaderData.loadError);
  const [mutation, setMutation] = useState<Mutation | null>(null);
  // The switch answers the pointer at once; the models column does not follow
  // it. That column reads the catalog listing, which still describes the
  // upstream as it was, so moving the flag into the record would have the
  // column derive a live count for an upstream the listing has not been told
  // about yet -- a warning beside a zero, for as long as the round trip takes.
  const [pendingEnabled, setPendingEnabled] = useState<{ id: string; enabled: boolean } | null>(null);
  const deleteDialog = useDialogInvocation<UpstreamRecord>();
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
    void navigate(location.pathname, rewrite);
  }, [location.pathname, location.search, navigate, rewrite, t]);

  // Delete is excluded because it owns its handle: it has a success line to
  // announce, and that has to update the toast the pending line already holds.
  const mutationKind = mutation?.kind ?? null;
  useEffect(() => {
    if (!mutationKind || mutationKind === 'delete') return;
    const handle = toasts.start(t(`dashboard.upstreams.toast.${mutationKind}.pending`));
    return () => handle.settle();
  }, [mutationKind, t, toasts]);

  const { refresh: reload, refreshing } = useRefresh(useCallback(async (signal: AbortSignal) => {
    const next = await loadPageData(signal);
    if (signal.aborted) return;
    setData(next);
    setPageError(next.loadError);
  }, []));

  // Row controls stay locked through the resync a mutation ends with, and
  // through a refresh the operator asked for on its own.
  const busy = mutation !== null || refreshing;

  const handleRefresh = async () => {
    setPageError(null);
    const handle = toasts.start(t('dashboard.upstreams.toast.reload.pending'));
    await reload();
    handle.settle();
  };

  const setEnabled = async (record: UpstreamRecord, enabled: boolean) => {
    if (data.upstreams === null) return;
    setMutation({ kind: 'toggle', id: record.id });
    setPageError(null);
    setPendingEnabled({ id: record.id, enabled });

    const result = await patchUpstream(record.id, { enabled });
    if (result.error) {
      setPageError(t('dashboard.upstreams.errors.toggle', { message: result.error.message }));
      setPendingEnabled(null);
      setMutation(null);
      return;
    }

    await reload();
    setPendingEnabled(null);
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
      await reload();
      // The resync has already written its own outcome into the page error, so
      // the updater reads it to decide whether the list on screen is trustworthy.
      setPageError(syncError =>
        t('dashboard.upstreams.errors.reorder', {
          message: error.message,
          sync: syncError ? t('dashboard.upstreams.errors.syncFailed') : '',
        }));
      setMutation(null);
      return;
    }

    await reload();
    setMutation(null);
  };

  const deleteUpstream = async (record: UpstreamRecord) => {
    setMutation({ kind: 'delete', id: record.id });
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
                    <RouteMenuItem
                      icon={{
                        children: <ProviderIcon kind={kind} className="h-5 w-5" />,
                        className: 'self-center',
                      }}
                      key={kind}
                      subText={t(`dashboard.upstreams.providers.${kind}`)}
                      to={`/dashboard/providers/upstreams/new/${kind}`}
                    >
                      {t(`provider.${kind}`)}
                    </RouteMenuItem>
                  ))}
                </MenuList>
              </MenuPopover>
            </Menu>
          )}
          disabled={busy}
          onRefresh={() => void handleRefresh()}
          refreshLabel={t('dashboard.upstreams.actions.refresh')}
          refreshing={refreshing}
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
          busy={busy}
          mutation={mutation}
          onDelete={openDeleteDialog}
          onMove={(record, direction) => void move(record, direction)}
          onToggle={(record, enabled) => void setEnabled(record, enabled)}
          pendingEnabled={pendingEnabled}
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

// The name is clipped by the layout's `main` slot rather than by the link
// inside it, so that slot is what the tooltip has to measure.
function UpstreamNameCell({ record }: { record: UpstreamRecord }) {
  const { t } = useTranslation();
  const name = useTruncation(record.name, 'label');

  return <TableCellLayout
    className="max-w-[520px]"
    description={<TruncationTooltip content={upstreamSummary(record, t)} relationship="label">
      {measureRef => <Text block className="winui-focus-rect" ref={measureRef} tabIndex={0} truncate wrap={false}>{upstreamSummary(record, t)}</Text>}
    </TruncationTooltip>}
    main={{ ref: name.measureRef }}
    truncate
  >
    <Tooltip {...name.tooltipProps}>
      <Link
        {...pageNavigation}
        className={rowTitleClass}
        to={upstreamEditorPath(record)}
      >
        {record.name}
      </Link>
    </Tooltip>
  </TableCellLayout>;
}

function UpstreamsTable({
  busy,
  data,
  mutation,
  onDelete,
  onMove,
  onToggle,
  pendingEnabled,
}: {
  busy: boolean;
  data: LoaderData;
  mutation: Mutation | null;
  onDelete: (record: UpstreamRecord) => void;
  onMove: (record: UpstreamRecord, direction: -1 | 1) => void;
  onToggle: (record: UpstreamRecord, enabled: boolean) => void;
  pendingEnabled: { id: string; enabled: boolean } | null;
}) {
  const { t } = useTranslation();
  const upstreams = data.upstreams;
  const modelCounts = useMemo(() => buildModelCounts(upstreams ?? [], data.models), [data.models, upstreams]);

  // A failed fetch is not an empty list: the message bar carries the reason.
  if (upstreams === null) return null;
  if (upstreams.length === 0) {
    return <ResourceListEmptyState>{t('dashboard.upstreams.empty')}</ResourceListEmptyState>;
  }

  return (
    <ScrollArea axes="horizontal" className="min-w-0">
      <Table aria-label={t('dashboard.upstreams.table.title')} className="min-w-[900px]">
        <TableColumns widths={['120px', '140px', '300px', '140px', '90px', TABLE_ACTIONS_WIDTH]} />
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t('dashboard.upstreams.table.priority')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.upstreams.table.provider')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.upstreams.table.upstream')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.upstreams.table.models')}</TableHeaderCell>
            <TableCentredHeader>{t('dashboard.upstreams.table.enabled')}</TableCentredHeader>
            <TableTrailingHeader>{t('dashboard.upstreams.table.actions')}</TableTrailingHeader>
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
                    disabled={busy}
                    downLabel={t('dashboard.upstreams.actions.moveDown', { name: record.name })}
                    isFirst={index === 0}
                    isLast={index === upstreams.length - 1}
                    onMove={direction => onMove(record, direction)}
                    upLabel={t('dashboard.upstreams.actions.moveUp', { name: record.name })}
                  />
                </div>
              </TableCell>
              <TableCell><ProviderBadge upstream={record} /></TableCell>
              <TableCell className="overflow-hidden"><UpstreamNameCell record={record} /></TableCell>
              <TableCell>
                <ModelStatus count={modelCounts.get(record.id)!} record={record} />
              </TableCell>
              <TableCentredCell>
                <Switch
                  aria-label={t('dashboard.upstreams.actions.toggle', { name: record.name })}
                  checked={pendingEnabled?.id === record.id ? pendingEnabled.enabled : record.enabled}
                  disabled={busy}
                  onChange={(_, detail) => onToggle(record, detail.checked)}
                />
              </TableCentredCell>
              <TableCell>
                <TableActions>
                  <TooltipIconButton
                    disabled={busy}
                    icon={<EditRegular />}
                    label={t('dashboard.upstreams.actions.editNamed', { name: record.name })}
                    to={upstreamEditorPath(record)}
                  />
                  <TooltipIconButton
                    danger
                    disabled={busy && !deleting}
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
  record,
}: {
  count: number | null;
  record: UpstreamRecord;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const cacheStatus = record.modelsCache.lastError
    ? 'failed'
    : record.modelsCache.fetchedAt === null ? 'empty' : 'ready';
  const healthy = count !== null && count > 0 && !record.modelsCache.lastError;
  const cacheDetail = record.modelsCache.lastError
    ? t('dashboard.upstreams.cache.failedDetail', {
        message: record.modelsCache.lastError.message,
        time: dateTime(record.modelsCache.lastError.at, locale),
      })
    : record.modelsCache.fetchedAt !== null
      ? t('dashboard.upstreams.cache.readyDetail', { time: dateTime(record.modelsCache.fetchedAt, locale) })
      : t('dashboard.upstreams.cache.emptyDetail');
  // A disabled upstream's cache freshness is a statement about the past, so the
  // tooltip says the upstream is off before it says when it last refreshed.
  const detail = record.enabled ? cacheDetail : t('dashboard.upstreams.cache.disabledDetail', { detail: cacheDetail });

  return (
    <Tooltip content={detail} relationship="description">
      <span className="winui-focus-rect inline-flex items-center gap-1.5 min-w-0 w-fit max-w-full" tabIndex={0}>
        {!record.enabled
          ? <ProhibitedRegular className="block flex-none text-fui-fg2" fontSize={18} aria-label={t('dashboard.upstreams.cache.disabled')} />
          : healthy
            ? <CheckmarkCircleRegular className="block flex-none text-[var(--colorPaletteGreenForeground1)]" fontSize={18} aria-label={t('dashboard.upstreams.cache.ready')} />
            : <WarningRegular className="block flex-none text-[var(--colorPaletteDarkOrangeForeground1)]" fontSize={18} aria-label={t(`dashboard.upstreams.cache.${cacheStatus}`)} />}
        <Text size={300} wrap={false}>
          {count === null
            ? t('dashboard.upstreams.models.unavailable')
            : t('dashboard.upstreams.models.count', { count })}
        </Text>
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
): Map<string, number | null> => {
  const byId = new Map(upstreams.map(record => [record.id, record]));
  const listed = new Map(upstreams.map(record => [record.id, 0]));
  for (const model of models ?? []) {
    for (const binding of model.upstreams) {
      const record = byId.get(binding.id);
      if (record) listed.set(record.id, listed.get(record.id)! + 1);
    }
  }
  const countFor = (record: UpstreamRecord): number | null => {
    // Azure's catalog is the operator's own configured list, so it is known
    // without the listing.
    if (record.kind === 'azure') return record.config.models.length;
    // The model registry builds providers from enabled upstreams only, so the
    // listing has nothing to say about a disabled upstream: the size of the
    // catalog it stored while it was on is the count instead, and null when it
    // never cached one.
    if (!record.enabled) return record.modelsCache.modelCount;
    // Null is a count nobody knows — here, because the listing failed.
    return models === null ? null : listed.get(record.id)!;
  };
  return new Map(upstreams.map(record => [record.id, countFor(record)]));
};

const upstreamSummary = (record: UpstreamRecord, t: TFunction): string => {
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
