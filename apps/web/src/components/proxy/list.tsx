import { DeleteRegular, EditRegular } from '@fluentui/react-icons';

import { hostPortLabel, KIND_HUES } from './config';
import type { ProxyRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { useBadgeHue } from '../ui/badge-hue';
import { Chip } from '../ui/chip';
import { ResourceListEmptyState } from '../ui/resource-list';
import { ScrollArea } from '../ui/scroll-area';
import { TABLE_ACTIONS_WIDTH, TableActions, TableTrailingHeader } from '../ui/table-actions';
import { TableColumns } from '../ui/table-columns';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { TruncationTooltip } from '../ui/truncation-tooltip';
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
      <Table aria-label={t('dashboard.proxy.listTitle')} className="min-w-[640px]">
        <TableColumns widths={[null, null, TABLE_ACTIONS_WIDTH]} />
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t('dashboard.proxy.form.name')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.proxy.form.address')}</TableHeaderCell>
            <TableTrailingHeader>{t('dashboard.proxy.columns.actions')}</TableTrailingHeader>
          </TableRow>
        </TableHeader>
        <TableBody>
          {proxies.map(proxy => {
            const kind = kindFromUri(proxy.url);
            const address = hostPortLabel(proxy.url) ?? t('dashboard.proxy.unknownAddress');

            return (
              <TableRow key={proxy.id}>
                <TableCell className="overflow-hidden">
                  <div className="flex items-center gap-2 min-w-0">
                    <KindChip kind={kind} />
                    <TruncationTooltip content={proxy.name} relationship="label">
                      {measureRef => <Text block className="winui-focus-rect min-w-0" ref={measureRef} tabIndex={0} truncate wrap={false}>{proxy.name}</Text>}
                    </TruncationTooltip>
                  </div>
                </TableCell>
                <TableCell className="overflow-hidden">
                  <TruncationTooltip content={address} relationship="label">
                    {measureRef => <Text block className="winui-focus-rect text-fui-fg2" ref={measureRef} tabIndex={0} truncate wrap={false}>
                      {address}
                    </Text>}
                  </TruncationTooltip>
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

// Its own component because the hue reaches the chip through a hook, which a
// row inside the table's map cannot call.
function KindChip({ kind }: { kind: ReturnType<typeof kindFromUri> }) {
  const { t } = useTranslation();
  const labelKey: string = `dashboard.proxy.kind.${kind}`;
  // A kind the table has no hue for is still a proxy, so it takes a mid grey
  // and is painted by the same algorithm rather than left unpainted.
  const hue = useBadgeHue(KIND_HUES[kind] ?? '#616161');

  return (
    <Chip className={`flex-none ${hue.className}`} style={hue.style}>
      {t(labelKey, kind)}
    </Chip>
  );
}
