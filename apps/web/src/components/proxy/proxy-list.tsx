import { DeleteRegular, EditRegular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';

import { hostPortLabel, KIND_COLORS } from './proxy-config';
import type { ProxyRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { ScrollArea } from '../ui/scroll-area';
import { ResourceListEmptyState } from '../ui/resource-list-toolbar';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { kindFromUri } from '@floway-dev/proxy/url-kind';

const {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
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
            <TableHeaderCell className="!w-[88px] !text-center">{t('dashboard.proxy.columns.actions')}</TableHeaderCell>
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
              <TableRow className="h-14" key={proxy.id}>
                <TableCell className="!overflow-hidden">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="text-fui-base200 font-fui-semibold uppercase px-[6px] py-[2px] rounded-[3px] flex-none"
                      style={{ backgroundColor: colors.bg, color: colors.fg }}
                    >
                      {t(`dashboard.proxy.kind.${kind}` as never, kind)}
                    </span>
                    <Text className="truncate" title={proxy.name} weight="semibold">{proxy.name}</Text>
                  </div>
                </TableCell>
                <TableCell className="!overflow-hidden">
                  <Text block className="text-fui-fg2 truncate" title={hostPortLabel(proxy.url)}>
                    {hostPortLabel(proxy.url)}
                  </Text>
                </TableCell>
                <TableCell>
                  <div className="flex justify-center gap-1">
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
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}
