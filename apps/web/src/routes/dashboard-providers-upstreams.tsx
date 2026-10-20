import {
  CheckmarkCircleRegular,
  ChevronDownRegular,
  CopyRegular,
  DeleteRegular,
  DataTrendingRegular,
  EditRegular,
  ProhibitedRegular,
  WarningRegular,
} from '@fluentui/react-icons';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';

import { type TFunction, useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-providers-upstreams';
import { useDashboardOutletContext } from './dashboard';
import { requireDashboardUser } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import { api, callApi } from '../api/client';
import type { ControlPlaneModel, ListedUpstreamRecord } from '../api/types';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { moveItem, ReorderHandle, useReorderList } from '../components/ui/reorder-list';
import { ResourceListActions, ResourceListEmptyState, ResourceListPanel } from '../components/ui/resource-list';
import { RouteMenuItem } from '../components/ui/route-menu-item';
import { ScrollArea } from '../components/ui/scroll-area';
import { TABLE_ACTIONS_WITH_LEADING_WIDTH, TableActions, TableActionsHeader, TableCentredCell, TableCentredHeader } from '../components/ui/table-actions';
import { TableColumns } from '../components/ui/table-columns';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { TruncationTooltip } from '../components/ui/truncation-tooltip';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { usePollWhileVisible } from '../components/ui/use-poll-while-visible';
import { useRefresh } from '../components/ui/use-refresh';
import { shortAccountId } from '../components/upstreams/account-id';
import { planLabel } from '../components/upstreams/codex-account';
import { MODEL_ERROR_TOOLTIP_LENGTH, modelErrorExcerpt } from '../components/upstreams/model-error';
import { ProviderBadge, ProviderIcon } from '../components/upstreams/provider-badge';
import { UpstreamSignals } from '../components/upstreams/signals';
import { UpstreamTelemetryRow, loadUpstreamTelemetry, type UpstreamTelemetryData, type UpstreamTelemetryQuery } from '../components/upstreams/telemetry';
import { fluentComponents } from '../fluent';
import { dateTime } from '../lib/format-time';
import { useEntryRewrite } from '../lib/page-navigation';
import { useLocale } from '../lib/use-locale';
import { usageUpstreamDimensionValue } from '@floway-dev/protocols/browser';
import { ALL_PROVIDER_KINDS, type UpstreamProviderKind } from '@floway-dev/provider/browser';

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
  switchClassNames,
} = fluentComponents;

interface LoaderData {
  /** `null` when the fetch failed, not the same as none configured. */
  upstreams: ListedUpstreamRecord[] | null;
  models: ControlPlaneModel[] | null;
  loadError: string | null;
  modelsError: string | null;
}

type Mutation =
  | { kind: 'toggle'; id: string }
  | { kind: 'reorder'; id: string }
  | { kind: 'delete'; id: string };

interface ReorderPlan {
  from: number;
  to: number;
  movedId: string;
  expectedIds: string[];
  ids: string[];
  next: ListedUpstreamRecord[];
}

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
const upstreamEditorPath = (record: ListedUpstreamRecord) => `/dashboard/providers/upstreams/${encodeURIComponent(record.id)}`;
const upstreamCopyPath = (record: ListedUpstreamRecord) => `/dashboard/providers/upstreams/${encodeURIComponent(record.id)}/copy`;

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
  await requireDashboardUser();
  return await loadPageData();
}

// The page strips the missing-upstream flag from the search after announcing
// it, and that navigation must not refetch what the loader already delivered.
export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardProvidersUpstreams({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();
  const [initialQuery] = useState<UpstreamTelemetryQuery>({ upstreamId: null, range: 'today', groupBy: 'model', filters: { model: [], upstream: [], userId: [], keyId: [] } });
  const queryRef = useRef(initialQuery);
  const loadedQueryRef = useRef(initialQuery);
  const [telemetry, setTelemetry] = useState<UpstreamTelemetryData | null>(null);
  const [editingRange, setEditingRange] = useState(false);
  const [immediateCollapse, setImmediateCollapse] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const rewrite = useEntryRewrite();
  const toasts = useOutcomeToasts();
  // Seeded from the loader, then owned by the page: every refresh and every
  // optimistic mutation writes here, so the loader payload is only first paint.
  const [data, setData] = useState(loaderData);
  // What an operator's own action reported, kept apart from what the fetch
  // reports: they are retired by different events, and a refresh that shares
  // the slot silently takes the other one with it.
  const [pageError, setPageError] = useState<string | null>(null);
  const [mutation, setMutation] = useState<Mutation | null>(null);
  // The switch answers the pointer at once; the models column does not follow
  // it. That column reads the catalog listing, which still describes the
  // upstream as it was, so moving the flag into the record would have the
  // column derive a live count for an upstream the listing has not been told
  // about yet -- a warning beside a zero, for as long as the round trip takes.
  const [pendingEnabled, setPendingEnabled] = useState<{ id: string; enabled: boolean } | null>(null);
  const deleteDialog = useDialogInvocation<ListedUpstreamRecord>();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // `move` words its own failure differently when the resync behind it also
  // failed, and it has to read that outcome after awaiting rather than out of a
  // state it just wrote.
  const lastLoadError = useRef<string | null>(null);
  // A pointer drop starts its write before the settle animation ends. The rows
  // keep rendering their pre-drop order under transforms until this plan is
  // accepted, then commit `next` in the same render that removes the preview.
  const pendingReorder = useRef<ReorderPlan | null>(null);

  const openDeleteDialog = (record: ListedUpstreamRecord) => {
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

  const { cancel, poll, refresh: reload, refreshing } = useRefresh(useCallback(async (signal: AbortSignal) => {
    const requested = queryRef.current;
    const [next, readings] = await Promise.all([
      loadPageData(signal),
      requested.upstreamId === null ? Promise.resolve(null) : loadUpstreamTelemetry(requested, Date.now(), signal),
    ]);
    if (signal.aborted) return;
    setData(current => ({
      upstreams: pendingReorder.current === null ? next.upstreams ?? current.upstreams : current.upstreams,
      models: next.models ?? current.models,
      loadError: next.loadError,
      modelsError: next.modelsError,
    }));
    lastLoadError.current = next.loadError;
    if (next.loadError !== null) { queryRef.current = loadedQueryRef.current; return; }
    if (requested.upstreamId !== null && !next.upstreams!.some(record => record.id === requested.upstreamId)) {
      queryRef.current = loadedQueryRef.current = { ...requested, upstreamId: null };
      setTelemetry(null);
      return;
    }
    if (readings !== null) {
      if (readings.error) { setPageError(readings.error.message); queryRef.current = loadedQueryRef.current; return; }
      setTelemetry(readings.data);
    }
    loadedQueryRef.current = requested;
  }, []));

  const reorderBusy = mutation !== null || refreshing;
  const surfaceBusy = refreshing;
  usePollWhileVisible(poll, 60_000, !editingRange && !reorderBusy);

  const closeTelemetry = (immediate: boolean) => {
    cancel();
    queryRef.current = loadedQueryRef.current = { ...loadedQueryRef.current, upstreamId: null };
    setImmediateCollapse(immediate);
    setEditingRange(false);
    setTelemetry(null);
  };
  const toggleTelemetry = (record: ListedUpstreamRecord) => {
    setPageError(null);
    if (telemetry?.query.upstreamId === record.id) { closeTelemetry(false); return; }
    setImmediateCollapse(false);
    queryRef.current = {
      ...loadedQueryRef.current, upstreamId: record.id,
      groupBy: 'model', filters: { model: [], upstream: [usageUpstreamDimensionValue(record.id)], userId: [], keyId: [] },
    };
    void reload();
  };
  const changeTelemetryQuery = (next: UpstreamTelemetryQuery) => {
    setPageError(null);
    queryRef.current = next;
    void reload();
  };

  const handleRefresh = async () => {
    setPageError(null);
    const handle = toasts.start(t('dashboard.upstreams.toast.reload.pending'));
    await reload();
    handle.settle();
  };

  const setEnabled = async (record: ListedUpstreamRecord, enabled: boolean) => {
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

  // The server validates the complete Full-access segment and atomically maps
  // its reordered IDs back onto the segment's existing sort-order slots.
  const move = async (from: number, to: number) => {
    const snapshot = data.upstreams;
    const plan = snapshot === null ? null : planReorder(snapshot, from, to);
    if (plan === null) return;

    closeTelemetry(true);
    setMutation({ kind: 'reorder', id: plan.movedId });
    setPageError(null);
    setData(current => ({ ...current, upstreams: plan.next }));

    const result = await reorderUpstreams(plan);
    if (result.error) {
      setData(current => ({ ...current, upstreams: snapshot }));
      await reload();
      setPageError(t('dashboard.upstreams.errors.reorder', {
        message: result.error.message,
        sync: lastLoadError.current !== null ? t('dashboard.upstreams.errors.syncFailed') : '',
      }));
      setMutation(null);
      return;
    }

    await reload();
    setMutation(null);
  };

  const persistDroppedMove = async (from: number, to: number) => {
    const snapshot = data.upstreams;
    const plan = snapshot === null ? null : planReorder(snapshot, from, to);
    if (plan === null) return;
    if (pendingReorder.current !== null) throw new Error('An upstream reorder is already in flight.');

    pendingReorder.current = plan;
    setMutation({ kind: 'reorder', id: plan.movedId });
    setPageError(null);
    const result = await reorderUpstreams(plan);
    if (result.error) throw new Error(result.error.message, { cause: result.error });
  };

  const commitDroppedMove = (from: number, to: number) => {
    const plan = pendingReorder.current;
    // Keyboard reordering has no pointer-settle phase and therefore no pending
    // plan; it keeps the immediate optimistic path it had before drag support.
    if (plan === null) {
      void move(from, to);
      return;
    }
    if (plan.from !== from || plan.to !== to) {
      throw new Error(`The settled upstream reorder ${from}->${to} does not match its pending plan ${plan.from}->${plan.to}.`);
    }
    setData(current => ({ ...current, upstreams: plan.next }));
    pendingReorder.current = null;
    setMutation(null);
  };

  const rejectDroppedMove = async (error: unknown) => {
    const failure = error instanceof Error ? error : new Error('The upstream reorder failed.', { cause: error });
    pendingReorder.current = null;
    await reload();
    setPageError(t('dashboard.upstreams.errors.reorder', {
      message: failure.message,
      sync: lastLoadError.current !== null ? t('dashboard.upstreams.errors.syncFailed') : '',
    }));
    setMutation(null);
  };

  const deleteUpstream = async (record: ListedUpstreamRecord) => {
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
    <section aria-busy={surfaceBusy} className="dashboard-page">
      <DashboardPageHeader
        actions={user.isAdmin ? <ResourceListActions
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
          disabled={surfaceBusy}
          onRefresh={() => void handleRefresh()}
          refreshLabel={t('dashboard.upstreams.actions.refresh')}
          refreshing={refreshing}
        /> : <ResourceListActions
          disabled={surfaceBusy}
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

      {data.loadError && (
        <OutcomeMessageBar onDismiss={() => setData(current => ({ ...current, loadError: null }))}>
          {data.loadError}
        </OutcomeMessageBar>
      )}

      {data.modelsError && (
        <OutcomeMessageBar intent="warning" onDismiss={() => setData(current => ({ ...current, modelsError: null }))}>
          {t('dashboard.upstreams.errors.models', { message: data.modelsError })}
        </OutcomeMessageBar>
      )}

      <ResourceListPanel inert={surfaceBusy} rowHeight="56px">
        <UpstreamsTable
          administrator={user.isAdmin}
          data={data}
          busy={mutation !== null || refreshing}
          currentUserId={String(user.id)}
          telemetry={telemetry}
          expandedId={telemetry?.query.upstreamId ?? null}
          immediateCollapse={immediateCollapse}
          onDragStart={() => flushSync(() => closeTelemetry(true))}
          onTelemetry={toggleTelemetry}
          onTelemetryQueryChange={changeTelemetryQuery}
          onRangeEditingChange={setEditingRange}
          mutation={mutation}
          onDelete={openDeleteDialog}
          onDrop={persistDroppedMove}
          onDropError={rejectDroppedMove}
          onMove={commitDroppedMove}
          reorderBusy={reorderBusy}
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

// The row's two lines are what the upstream says about itself: who it connects
// as, and whatever live readings its provider publishes. The name is not among
// them -- it names the badge, which is also what opens the record.
function UpstreamDetailsCell({ record }: { record: ListedUpstreamRecord }) {
  const { t } = useTranslation();
  const summary = upstreamSummary(record, t);

  // No width of its own: the column is what states it, and a cap here would
  // ellipsise a line the column had room for.
  return <TableCellLayout
    // Fluent stacks the two lines with no gap at all, which leaves the second
    // reading as a wrapped continuation of the first rather than as its own
    // line. One step of the vertical ramp separates them.
    //
    // The same step below, because `truncate` has Fluent clip the layout's
    // content box, and each ring on that line is set on the cap height of the
    // text beside it -- which carries the ring under the baseline by more than
    // the font's own descent, and into the clip.
    description={{ children: <UpstreamSignals record={record} />, className: 'py-[var(--spacingVerticalXXS)]' }}
    truncate
  >
    <TruncationTooltip content={summary} relationship="label">
      {measureRef => <Text block className="winui-focus-rect" ref={measureRef} tabIndex={0} truncate wrap={false}>{summary}</Text>}
    </TruncationTooltip>
  </TableCellLayout>;
}

function UpstreamsTable({
  administrator,
  busy,
  data,
  mutation,
  onDelete,
  onDrop,
  onDropError,
  onMove,
  onToggle,
  pendingEnabled,
  reorderBusy,
  currentUserId, telemetry, expandedId, immediateCollapse, onDragStart, onTelemetry, onTelemetryQueryChange, onRangeEditingChange,
}: {
  administrator: boolean;
  busy: boolean;
  data: LoaderData;
  mutation: Mutation | null;
  onDelete: (record: ListedUpstreamRecord) => void;
  onDrop: (from: number, to: number) => Promise<void>;
  onDropError: (error: unknown, from: number, to: number) => void | Promise<void>;
  onMove: (from: number, to: number) => void;
  onToggle: (record: ListedUpstreamRecord, enabled: boolean) => void;
  pendingEnabled: { id: string; enabled: boolean } | null;
  reorderBusy: boolean;
  currentUserId: string;
  telemetry: UpstreamTelemetryData | null;
  expandedId: string | null;
  immediateCollapse: boolean;
  onDragStart: () => void;
  onTelemetry: (record: ListedUpstreamRecord) => void;
  onTelemetryQueryChange: (query: UpstreamTelemetryQuery) => void;
  onRangeEditingChange: (editing: boolean) => void;
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
        <TableColumns widths={['96px', '200px', null, '140px', '90px', TABLE_ACTIONS_WITH_LEADING_WIDTH]} />
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t('dashboard.upstreams.table.priority')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.upstreams.table.upstream')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.upstreams.table.details')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.upstreams.table.models')}</TableHeaderCell>
            <TableCentredHeader>{t('dashboard.upstreams.table.enabled')}</TableCentredHeader>
            <TableActionsHeader />
          </TableRow>
        </TableHeader>
        {upstreamSegments(upstreams).map(segment => <UpstreamSegment
          administrator={administrator}
          busy={busy}
          currentUserId={currentUserId}
          expandedId={expandedId}
          immediateCollapse={immediateCollapse}
          key={segment.key}
          modelCounts={modelCounts}
          mutation={mutation}
          onDelete={onDelete}
          onDragStart={onDragStart}
          onDrop={onDrop}
          onDropError={onDropError}
          onMove={onMove}
          onRangeEditingChange={onRangeEditingChange}
          onTelemetry={onTelemetry}
          onTelemetryQueryChange={onTelemetryQueryChange}
          onToggle={onToggle}
          pendingEnabled={pendingEnabled}
          reorderBusy={reorderBusy}
          segment={segment}
          telemetry={telemetry}
        />)}
      </Table>
    </ScrollArea>
  );
}

interface UpstreamSegment { key: string; records: ListedUpstreamRecord[]; movable: boolean; rankBase: number }

const upstreamSegments = (upstreams: readonly ListedUpstreamRecord[]): UpstreamSegment[] => {
  const segments: UpstreamSegment[] = [];
  for (const [index, record] of upstreams.entries()) {
    const movable = record.editLevel === 'full' && record.reorderGroup !== null;
    const previous = segments.at(-1);
    if ((movable && previous?.key === `full:${record.reorderGroup}`) || (!movable && previous?.movable === false)) {
      previous.records.push(record);
    } else {
      segments.push({ key: movable ? `full:${record.reorderGroup}` : `locked:${record.id}`, movable, records: [record], rankBase: index });
    }
  }
  return segments;
};

function UpstreamSegment({
  administrator, busy, currentUserId, expandedId, immediateCollapse, modelCounts, mutation, onDelete, onDragStart, onDrop, onDropError, onMove,
  onRangeEditingChange, onTelemetry, onTelemetryQueryChange, onToggle, pendingEnabled, reorderBusy, segment, telemetry,
}: {
  administrator: boolean;
  busy: boolean;
  currentUserId: string;
  expandedId: string | null;
  immediateCollapse: boolean;
  modelCounts: ReadonlyMap<string, number | null>;
  mutation: Mutation | null;
  onDelete: (record: ListedUpstreamRecord) => void;
  onDragStart: () => void;
  onDrop: (from: number, to: number) => Promise<void>;
  onDropError: (error: unknown, from: number, to: number) => void | Promise<void>;
  onMove: (from: number, to: number) => void;
  onRangeEditingChange: (editing: boolean) => void;
  onTelemetry: (record: ListedUpstreamRecord) => void;
  onTelemetryQueryChange: (query: UpstreamTelemetryQuery) => void;
  onToggle: (record: ListedUpstreamRecord, enabled: boolean) => void;
  pendingEnabled: { id: string; enabled: boolean } | null;
  reorderBusy: boolean;
  segment: UpstreamSegment;
  telemetry: UpstreamTelemetryData | null;
}) {
  const { t } = useTranslation();
  const reorder = useReorderList({
    busy: reorderBusy, disabled: !segment.movable, grabOnly: segment.records.length === 1, length: segment.records.length,
    onDragStart,
    onDrop: async (from, to) => {
      await onDrop(segment.rankBase + from, segment.rankBase + to);
    },
    onDropError: (error, from, to) => {
      return onDropError(error, segment.rankBase + from, segment.rankBase + to);
    },
    onReorder: (from, to) => {
      onMove(segment.rankBase + from, segment.rankBase + to);
    },
  });
  return <TableBody {...reorder.listProps()} data-upstream-segment={segment.key}>
    {segment.records.map((record, index) => {
      const deleting = mutation?.kind === 'delete' && mutation.id === record.id;
      const canAudit = administrator || record.audit;
      const canEdit = administrator || record.editLevel !== 'off';
      const canFullEdit = administrator || record.editLevel === 'full';
      return <Fragment key={record.id}><TableRow {...reorder.itemProps(index)}
        aria-controls={canAudit ? `upstream-telemetry-${encodeURIComponent(record.id)}` : undefined} aria-expanded={canAudit ? expandedId === record.id : undefined}
        aria-label={canAudit ? t('dashboard.upstreams.actions.metricsNamed', { name: record.name }) : undefined} tabIndex={canAudit && !busy ? 0 : undefined}
        onClickCapture={event => {
          const target = event.target as Element;
          if (!canAudit || busy || !event.currentTarget.contains(target) || target.closest(`a, button, .${switchClassNames.root}`) || !window.getSelection()!.isCollapsed) return;
          onTelemetry(record);
        }} onKeyDown={event => {
          if (!canAudit || busy || event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onTelemetry(record); }
        }}>
        <TableCell>
          <div className="inline-flex items-center gap-1">
            <Text className="text-fui-fg3 min-w-[22px] text-center">{segment.rankBase + reorder.position(index) + 1}</Text>
            <ReorderHandle {...reorder.handleProps(segment.movable ? index : -1)} label={t('dashboard.upstreams.actions.reorder', { name: record.name })} />
          </div>
        </TableCell>
        <TableCell className="overflow-hidden">
          <ProviderBadge label={record.name} to={canAudit || canEdit ? upstreamEditorPath(record) : undefined} upstream={record} />
        </TableCell>
        <TableCell className="overflow-hidden"><UpstreamDetailsCell record={record} /></TableCell>
        <TableCell><ModelStatus count={modelCounts.get(record.id)!} record={record} /></TableCell>
        <TableCentredCell>
          <Switch aria-label={t('dashboard.upstreams.actions.toggle', { name: record.name })} checked={pendingEnabled?.id === record.id ? pendingEnabled.enabled : record.enabled}
            disabled={busy || !canFullEdit} onChange={(_, detail) => onToggle(record, detail.checked)} />
        </TableCentredCell>
        <TableCell>
          <TableActions leading={<TooltipIconButton aria-controls={canAudit ? `upstream-telemetry-${encodeURIComponent(record.id)}` : undefined} aria-expanded={canAudit ? expandedId === record.id : undefined}
            disabled={reorderBusy || !canAudit} icon={<DataTrendingRegular />} label={t('dashboard.upstreams.actions.metricsNamed', { name: record.name })} onClick={() => onTelemetry(record)} />}>
            <TooltipIconButton disabled={busy} icon={<EditRegular />} label={t('dashboard.upstreams.actions.editNamed', { name: record.name })} to={upstreamEditorPath(record)} />
            {administrator && <TooltipIconButton disabled={busy} icon={<CopyRegular />} label={t('dashboard.upstreams.actions.copyNamed', { name: record.name })} to={upstreamCopyPath(record)} />}
            {administrator && <TooltipIconButton danger disabled={busy && !deleting} disabledFocusable={deleting} icon={deleting ? <Spinner size="tiny" /> : <DeleteRegular />}
              label={t('dashboard.upstreams.actions.deleteNamed', { name: record.name })} onClick={() => onDelete(record)} />}
          </TableActions>
        </TableCell>
      </TableRow>
      {canAudit && <UpstreamTelemetryRow immediateCollapse={immediateCollapse} busy={busy} currentUserId={currentUserId} data={expandedId === record.id ? telemetry : null} record={record}
        onQueryChange={onTelemetryQueryChange} onRangeEditingChange={onRangeEditingChange} />}
      </Fragment>;
    })}
  </TableBody>;
}

function ModelStatus({
  count,
  record,
}: {
  count: number | null;
  record: ListedUpstreamRecord;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const cacheStatus = record.modelsCache.lastError
    ? 'failed'
    : record.modelsCache.fetchedAt === null ? 'empty' : 'ready';
  const healthy = count !== null && count > 0 && !record.modelsCache.lastError;
  const cacheDetail = record.modelsCache.lastError
    ? t('dashboard.upstreams.cache.failedDetail', {
        message: modelErrorExcerpt(record.modelsCache.lastError.message, MODEL_ERROR_TOOLTIP_LENGTH),
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
        <Text size={300} className="tabular-nums" wrap={false}>
          {count === null
            ? t('dashboard.upstreams.models.unavailable')
            : t('dashboard.upstreams.models.count', { count })}
        </Text>
      </span>
    </Tooltip>
  );
}

const patchUpstream = (id: string, body: { enabled: boolean }) =>
  callApi(() => api.api.upstreams[':id'].$patch({ param: { id }, json: body }));

const reorderUpstreams = (plan: ReorderPlan) => callApi(() => api.api.upstreams.reorder.$post({
  json: { expectedIds: plan.expectedIds, ids: plan.ids },
}));

const compareUpstreams = (a: ListedUpstreamRecord, b: ListedUpstreamRecord) =>
  a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

export const planReorder = (snapshot: readonly ListedUpstreamRecord[], from: number, to: number): ReorderPlan | null => {
  if (from === to || from < 0 || from >= snapshot.length || to < 0 || to >= snapshot.length) return null;
  const reorderGroup = snapshot[from]!.reorderGroup;
  if (reorderGroup === null || snapshot[from]!.editLevel !== 'full' || snapshot[to]!.reorderGroup !== reorderGroup) return null;
  const segmentStart = snapshot.slice(0, from).findLastIndex(record => record.reorderGroup !== reorderGroup) + 1;
  const segmentEnd = snapshot.findIndex((record, index) => index > from && record.reorderGroup !== reorderGroup);
  const end = segmentEnd < 0 ? snapshot.length : segmentEnd;
  if (to < segmentStart || to >= end) return null;
  const segment = snapshot.slice(segmentStart, end);
  const slots = segment.map(record => record.sort_order).toSorted((left, right) => left - right);
  const reordered = moveItem(segment, from - segmentStart, to - segmentStart);
  const next = snapshot.map((record, index) => index >= segmentStart && index < end
    ? { ...reordered[index - segmentStart]!, sort_order: slots[index - segmentStart]! }
    : record);
  return {
    from,
    to,
    movedId: snapshot[from].id,
    expectedIds: segment.map(record => record.id),
    ids: reordered.map(record => record.id),
    next,
  };
};

const buildModelCounts = (
  upstreams: ListedUpstreamRecord[],
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
  const countFor = (record: ListedUpstreamRecord): number | null => {
    // Azure's catalog is the operator's own configured list, so it is known
    // without the listing.
    if (record.kind === 'azure') return record.config.models.length;
    // The live catalog is filtered by Model.Use. Auditors still see the size
    // of the catalog the upstream stored while it was on, without gaining the
    // catalog rows themselves.
    if (!record.modelUse) return record.modelsCache.modelCount;
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

// Who the upstream connects as. A subscription names an account; an endpoint
// the operator configured names itself. A codex account appends its plan,
// through the same label the signals line uses, so the two lines agree.
const upstreamSummary = (record: ListedUpstreamRecord, t: TFunction): string => {
  switch (record.kind) {
  case 'custom': return record.config.baseUrl;
  case 'azure': return record.config.endpoint;
  // A cloud key belongs to an account, and that account says more than the one
  // endpoint every cloud upstream shares. A self-hosted daemon has no account,
  // so its address is the whole identity.
  case 'ollama': return record.state?.account?.email ?? (record.config.baseUrl || t('dashboard.upstreams.summary.ollama'));
  case 'copilot': return record.config.user.login ? `${record.config.githubHost}/${record.config.user.login}` : t('dashboard.upstreams.summary.copilot');
  case 'codex': {
    const account = record.config.accounts[0];
    if (!account) return t('dashboard.upstreams.summary.noAccount');
    const identity = account.email
      ?? (account.chatgptAccountId === null ? null : shortAccountId(account.chatgptAccountId));
    return [identity, planLabel(account)].filter(Boolean).join(' - ')
      || t('dashboard.upstreams.summary.noAccount');
  }
  case 'claude-code': {
    const account = record.config.accounts[0];
    if (!account) return t('dashboard.upstreams.summary.noAccount');
    return account.email ?? shortAccountId(account.accountUuid);
  }
  }
};
