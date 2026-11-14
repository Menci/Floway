import { DeleteRegular, EditRegular } from '@fluentui/react-icons';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';

import { recordSegments } from './order';
import type { RecordSegment } from './order';
import { RulePermissions } from './permission-list';
import { PrincipalIdentity } from './principal';
import { principalKey, principalName } from './principals';
import { ScopeExpression, type ScopeExpressionData } from './scope-expression';
import type { AccessRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { ConfirmFlyout } from '../ui/confirm-flyout';
import { ReorderHandle, useReorderList } from '../ui/reorder-list';
import { ScrollArea } from '../ui/scroll-area';
import { TableActions } from '../ui/table-actions';
import { TableColumns } from '../ui/table-columns';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import type { AccessScope, PermissionDecisions } from '@floway-dev/gateway/browser';

const { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, makeStyles } = fluentComponents;

const useStyles = makeStyles({
  table: {
    '& .fui-TableCell': { verticalAlign: 'top', paddingTop: '10px', paddingBottom: '10px' },
    '& .floway-scope-expression-part': { minHeight: '30px', boxSizing: 'border-box' },
    '& [data-permissions]': { paddingTop: '3px' },
    '& .fui-TableCell:last-child > div': { minHeight: '30px' },
  },
});

interface RulesTableProps {
  admin: boolean;
  busy: boolean;
  data: ScopeExpressionData;
  decisions: ReadonlyMap<number, PermissionDecisions> | null;
  onEdit: (record: AccessRecord) => void;
  onRemove: (record: AccessRecord) => Promise<string | null>;
  onReorder: (ids: number[], from: number, to: number) => Promise<AccessRecord[]>;
  onReordered: (records: AccessRecord[]) => void;
  onReorderError: (error: unknown) => void | Promise<void>;
  onScopeSelect: (scope: AccessScope | null) => void;
  params: URLSearchParams;
  records: AccessRecord[];
}

export function RulesTable(props: RulesTableProps) {
  const { t } = useTranslation();
  const styles = useStyles();
  return <ScrollArea axes="horizontal" className="min-w-0"><Table aria-label={t('dashboard.accessControl.tableLabel')} className={`min-w-[860px] ${styles.table}`} style={{ tableLayout: 'fixed' }}>
    <TableColumns widths={props.admin ? ['52px', '38%', '18%', null, '88px'] : ['52px', '42%', '20%', null]} />
    <TableHeader><TableRow>
      <TableHeaderCell><span className="sr-only">{t('dashboard.accessControl.actions.reorder')}</span></TableHeaderCell>
      <TableHeaderCell>{t('dashboard.accessControl.fields.scope')}</TableHeaderCell>
      <TableHeaderCell>{t('dashboard.accessControl.fields.principal')}</TableHeaderCell>
      <TableHeaderCell>{t('dashboard.accessControl.fields.permissions')}</TableHeaderCell>
      {props.admin && <TableHeaderCell><span className="sr-only">{t('dashboard.accessControl.actions.column')}</span></TableHeaderCell>}
    </TableRow></TableHeader>
    {recordSegments(props.records).map(segment => <RulesSegment {...props} key={segment.key} segment={segment} />)}
  </Table></ScrollArea>;
}

function RulesSegment({ admin, busy, data, decisions, onEdit, onRemove, onReorder, onReordered, onReorderError, onScopeSelect, params, segment }: RulesTableProps & { segment: RecordSegment }) {
  const { t } = useTranslation();
  const mounted = useRef(false);
  const pendingDrop = useRef<AccessRecord[] | null>(null);
  // Filtering can remove a segment while its real write or settle is pending.
  // The write still commits once, even when its visual controller is gone.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pendingDrop.current !== null) { onReordered(pendingDrop.current); pendingDrop.current = null; }
    };
  }, [onReordered]);
  const reorder = useReorderList({
    busy, disabled: !admin || !segment.movable, length: segment.records.length,
    onDrop: async (from, to) => {
      try {
        const records = await onReorder(segment.records.map(record => record.id), from, to);
        if (mounted.current) pendingDrop.current = records; else onReordered(records);
      } catch (error) {
        if (!mounted.current) await onReorderError(error);
        throw error;
      }
    },
    onDropError: onReorderError,
    onReorder: (from, to) => {
      const records = pendingDrop.current;
      if (records !== null) { pendingDrop.current = null; onReordered(records); } else void onReorder(segment.records.map(record => record.id), from, to).then(onReordered).catch(onReorderError);
    },
  });
  return <TableBody {...reorder.listProps()} data-scope-segment={segment.key}>
    {segment.records.map((record, index) => {
      const next = new URLSearchParams(params);
      next.set('principal', principalKey(record.principal));
      next.delete('page');
      return <TableRow {...(segment.movable ? reorder.itemProps(index) : {})} data-rule-id={record.id} key={record.id}>
        <TableCell><div className="flex h-[30px] items-center"><ReorderHandle {...reorder.handleProps(admin && segment.movable ? index : -1)} label={t('dashboard.accessControl.actions.reorder')} /></div></TableCell>
        <TableCell><ScopeExpression data={data} onNavigate={onScopeSelect} readOnly value={record.scope} /></TableCell>
        <TableCell><div className="flex min-h-[30px] items-center min-w-0">
          <Link aria-label={t(`dashboard.accessControl.principal.${record.principal.kind}`, { name: principalName(record.principal, data) })} className="winui-focus-rect inline-flex min-w-0 max-w-full w-fit no-underline text-inherit" to={{ search: next.toString() }}><PrincipalIdentity data={data} principal={record.principal} /></Link>
        </div></TableCell>
        <TableCell><RulePermissions context={decisions === null ? undefined : { record, data, decisions: decisions.get(record.id) ?? {} }} values={record.values} /></TableCell>
        {admin && <TableCell><TableActions>
          <TooltipIconButton disabled={busy} icon={<EditRegular />} label={t('dashboard.accessControl.actions.edit')} onClick={() => onEdit(record)} />
          <ConfirmFlyout actionLabel={t('dashboard.accessControl.actions.delete')} disabled={busy} icon={<DeleteRegular />} message={t(record.principal.kind === 'group' ? 'dashboard.accessControl.delete.groupMessage' : 'dashboard.accessControl.delete.message', { name: principalName(record.principal, data) })} onConfirm={() => onRemove(record)} title={t(record.principal.kind === 'group' ? 'dashboard.accessControl.delete.groupTitle' : 'dashboard.accessControl.delete.title')} triggerLabel={t('dashboard.accessControl.actions.delete')} />
        </TableActions></TableCell>}
      </TableRow>;
    })}
  </TableBody>;
}
