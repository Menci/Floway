import { AddRegular, ArrowSyncRegular, DeleteRegular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';

import { hostPortLabel, KIND_COLORS } from './proxy-config';
import type { ProxyRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { Panel } from '../ui/panel';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { kindFromUri } from '@floway-dev/proxy/url-kind';
const { Button, Table, TableBody, TableCell, TableCellLayout, TableHeader, TableHeaderCell, TableRow, Text, Tooltip } = fluentComponents;

export function ProxyList({ onAdd, onDelete, onEdit, onRefresh, proxies }: { onAdd: () => void; onDelete: (proxy: ProxyRecord) => void; onEdit: (proxy: ProxyRecord) => void; onRefresh: () => void; proxies: ProxyRecord[] }) {
  const { t } = useTranslation();
  return <Panel className="!p-[22px_24px] grid gap-[14px] !max-w-none min-w-0">
    <div className="flex items-center justify-between gap-[12px]">
      <div className="flex items-center gap-[8px]"><Text size={400} weight="semibold">{t('dashboard.proxy.listTitle')}</Text>{proxies.length > 0 && <span className="text-fui-base200 font-fui-semibold px-[6px] py-[1px] rounded-[3px] bg-fui-bg2 text-fui-fg3">{proxies.length}</span>}</div>
      <div className="flex items-center gap-[4px]"><Tooltip content={t('dashboard.proxy.addTitle')} relationship="label"><Button appearance="transparent" icon={<AddRegular />} onClick={onAdd} size="small" /></Tooltip><Tooltip content={t('dashboard.proxy.actions.refresh')} relationship="label"><Button appearance="transparent" icon={<ArrowSyncRegular />} onClick={onRefresh} size="small" /></Tooltip></div>
    </div>
    {proxies.length === 0 ? <Text size={300} className="text-fui-fg3 !m-0 py-[8px]">{t('dashboard.proxy.empty')}</Text> : <Table className="-ml-[2px] !w-[calc(100%+2px)]"><TableHeader><TableRow><TableHeaderCell>{t('dashboard.proxy.form.name')}</TableHeaderCell><TableHeaderCell>{t('dashboard.proxy.form.address')}</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader><TableBody>{proxies.map(proxy => {
      const kind = kindFromUri(proxy.url); const colors = KIND_COLORS[kind] ?? { bg: 'light-dark(#f3f4f6, #374151)', fg: 'light-dark(#6b7280, #9ca3af)' };
      return <TableRow aria-label={`${t('dashboard.proxy.actions.edit')}: ${proxy.name}`} className="cursor-pointer hover:bg-fui-bg2" key={proxy.id} onClick={() => onEdit(proxy)} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onEdit(proxy); } }} tabIndex={0}>
        <TableCell><TableCellLayout><div className="flex items-center gap-[8px] min-w-0"><span className="text-fui-base200 font-fui-semibold uppercase px-[6px] py-[2px] rounded-[3px] flex-none" style={{ backgroundColor: colors.bg, color: colors.fg }}>{t(`dashboard.proxy.kind.${kind}` as never, kind)}</span><Text size={300} weight="semibold" className="truncate">{proxy.name}</Text></div></TableCellLayout></TableCell>
        <TableCell><Text size={200} className="text-fui-fg3">{hostPortLabel(proxy.url)}</Text></TableCell>
        <TableCell><div className="flex items-center justify-end"><TooltipIconButton danger icon={<DeleteRegular />} label={t('dashboard.proxy.actions.delete')} onClick={event => { event.stopPropagation(); onDelete(proxy); }} /></div></TableCell>
      </TableRow>;
    })}</TableBody></Table>}
  </Panel>;
}
