import { DeleteRegular, EditRegular } from '@fluentui/react-icons';

import type { OAuth2Provider } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { ResourceListEmptyState } from '../ui/resource-list';
import { ScrollArea } from '../ui/scroll-area';
import { StatusBadge } from '../ui/status-badge';
import { TABLE_ACTIONS_WIDTH, TableActions, TableTrailingHeader } from '../ui/table-actions';
import { TableColumns } from '../ui/table-columns';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { TruncationTooltip } from '../ui/truncation-tooltip';

const { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text } = fluentComponents;

export const oauth2CallbackUrl = (publicBaseUrl: string, providerId: string): string | null =>
  publicBaseUrl === '' ? null : `${publicBaseUrl}/auth/oauth2/${encodeURIComponent(providerId)}/callback`;

export function OAuth2ProviderList({ disabled, onDelete, onEdit, providers, publicBaseUrl }: {
  disabled: boolean;
  onDelete: (provider: OAuth2Provider) => void;
  onEdit: (provider: OAuth2Provider) => void;
  providers: OAuth2Provider[];
  publicBaseUrl: string;
}) {
  const { t } = useTranslation();

  if (providers.length === 0) {
    return <ResourceListEmptyState>{t('dashboard.oauth2.empty')}</ResourceListEmptyState>;
  }

  return <ScrollArea axes="horizontal" className="min-w-0">
    <Table aria-label={t('dashboard.oauth2.table.label')} className="min-w-[880px]">
      <TableColumns widths={[null, '160px', '120px', null, TABLE_ACTIONS_WIDTH]} />
      <TableHeader><TableRow>
        <TableHeaderCell>{t('dashboard.oauth2.table.name')}</TableHeaderCell>
        <TableHeaderCell>{t('dashboard.oauth2.table.id')}</TableHeaderCell>
        <TableHeaderCell>{t('dashboard.oauth2.table.status')}</TableHeaderCell>
        <TableHeaderCell>{t('dashboard.oauth2.table.callback')}</TableHeaderCell>
        <TableTrailingHeader>{t('dashboard.oauth2.table.actions')}</TableTrailingHeader>
      </TableRow></TableHeader>
      <TableBody>{providers.map(provider => {
        const callbackUrl = oauth2CallbackUrl(publicBaseUrl, provider.id);
        return <TableRow key={provider.id}>
          <TableCell className="overflow-hidden">
            <TruncationTooltip content={provider.display_name} relationship="label">
              {measureRef => <Text block className="winui-focus-rect min-w-0" ref={measureRef} tabIndex={0} truncate wrap={false}>{provider.display_name}</Text>}
            </TruncationTooltip>
          </TableCell>
          <TableCell className="font-mono">{provider.id}</TableCell>
          <TableCell><StatusBadge tone={provider.enabled ? 'success' : 'neutral'}>
            {t(`dashboard.oauth2.status.${provider.enabled ? 'enabled' : 'disabled'}`)}
          </StatusBadge></TableCell>
          <TableCell className="overflow-hidden">
            {callbackUrl === null
              ? <Text className="text-fui-fg2">{t('dashboard.oauth2.callbackUnavailable')}</Text>
              : <TruncationTooltip content={callbackUrl} relationship="label">
                  {measureRef => <Text block className="winui-focus-rect min-w-0 font-mono text-fui-fg2" ref={measureRef} tabIndex={0} truncate wrap={false}>{callbackUrl}</Text>}
                </TruncationTooltip>}
          </TableCell>
          <TableCell><TableActions>
            <TooltipIconButton
              disabled={disabled}
              icon={<EditRegular />}
              label={t('dashboard.oauth2.actions.editNamed', { name: provider.display_name })}
              onClick={() => onEdit(provider)}
            />
            <TooltipIconButton
              danger
              disabled={disabled}
              icon={<DeleteRegular />}
              label={t('dashboard.oauth2.actions.deleteNamed', { name: provider.display_name })}
              onClick={() => onDelete(provider)}
            />
          </TableActions></TableCell>
        </TableRow>;
      })}</TableBody>
    </Table>
  </ScrollArea>;
}
