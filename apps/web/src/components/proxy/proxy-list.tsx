import { DeleteRegular, EditRegular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';

import { hostPortLabel, KIND_COLORS } from './proxy-config';
import type { ProxyRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { ResourceListEmptyState } from '../ui/resource-list';
import { ScrollArea } from '../ui/scroll-area';
import { TableActions, TableActionsHeader } from '../ui/table-actions';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { kindFromUri } from '@floway-dev/proxy/url-kind';

const {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Tooltip,
} = fluentComponents;

export function ProxyList({
  disabled,
  onDelete,
  onEdit,
  proxies,
}: {
  disabled: boolean;
  onDelete: (proxy: ProxyRecord) => void;
  onEdit: (proxy: ProxyRecord) => void;
  proxies: ProxyRecord[];
}) {
  const { t } = useTranslation();

  if (proxies.length === 0) {
    return <ResourceListEmptyState>{t('dashboard.proxy.empty')}</ResourceListEmptyState>;
  }

  return (
    <ScrollArea axes="horizontal" className="min-w-0">
      <Table aria-label={t('dashboard.proxy.listTitle')} className="w-full min-w-[620px] table-fixed">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t('dashboard.proxy.form.name')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.proxy.form.address')}</TableHeaderCell>
            <TableActionsHeader className="!w-[88px]">{t('dashboard.proxy.columns.actions')}</TableActionsHeader>
          </TableRow>
        </TableHeader>
        <TableBody>
          {proxies.map(proxy => {
            const kind = kindFromUri(proxy.url);
            const colors = KIND_COLORS[kind] ?? {
              bg: 'light-dark(#f3f4f6, #374151)',
              fg: 'light-dark(#6b7280, #9ca3af)',
            };

            return (
              <TableRow key={proxy.id}>
                <TableCell className="overflow-hidden">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge
                      appearance="tint"
                      className="uppercase flex-none"
                      shape="rounded"
                      size="large"
                      style={{ backgroundColor: colors.bg, color: colors.fg }}
                    >
                      {t(`dashboard.proxy.kind.${kind}` as never, kind)}
                    </Badge>
                    <Tooltip content={proxy.name} relationship="label">
                      <Text className="truncate" tabIndex={0}>{proxy.name}</Text>
                    </Tooltip>
                  </div>
                </TableCell>
                <TableCell className="overflow-hidden">
                  <Tooltip content={hostPortLabel(proxy.url)} relationship="label">
                    <Text block className="text-fui-fg2 truncate" tabIndex={0}>
                      {hostPortLabel(proxy.url)}
                    </Text>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  <TableActions>
                    <TooltipIconButton
                      disabled={disabled}
                      icon={<EditRegular />}
                      label={t('dashboard.proxy.actions.editNamed', { name: proxy.name })}
                      onClick={() => onEdit(proxy)}
                    />
                    <TooltipIconButton
                      danger
                      disabled={disabled}
                      icon={<DeleteRegular />}
                      label={t('dashboard.proxy.actions.deleteNamed', { name: proxy.name })}
                      onClick={() => onDelete(proxy)}
                    />
                  </TableActions>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}
