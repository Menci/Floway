import { Trans, useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router';
// Prism grammars register themselves onto Prism as a module side effect, so `prismjs` must import first.
import 'prismjs';
import 'prismjs/components/prism-bash';

import { apiDocsEndpoints, apiDocsGroups, authCurlExample } from './api-docs-data';
import { fluentComponents } from '../../fluent';
import { pageNavigation } from '../../lib/page-navigation';
import { CodeBlock } from '../ui/code-block';
import { HttpMethodBadge } from '../ui/http-badge';
import { OpenLinkLabel } from '../ui/open-link-label';
import { Panel } from '../ui/panel';
import { ScrollArea } from '../ui/scroll-area';
import { SectionHeader } from '../ui/section-header';
import { TableActionsHeader, useTrailingCellClass } from '../ui/table-actions';
import { useCopyToClipboard } from '../ui/use-copy-to-clipboard';

const {
  Link,
  MessageBar,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} = fluentComponents;

export function ApiDocsContent() {
  const { t } = useTranslation();
  const { copy, outcomeFor } = useCopyToClipboard();
  const trailingCell = useTrailingCellClass();
  const authExample = authCurlExample(window.location.origin);

  return <>
    <Panel className="!grid !gap-4">
      <SectionHeader
        description={<Trans
          components={[<RouterLink {...pageNavigation} className="text-fui-brand1 no-underline hover:underline" key="api-keys" to="/dashboard/services/api-keys" />]}
          i18nKey="dashboard.apiDocs.authentication.description"
        />}
        level={2}
        title={t('dashboard.apiDocs.authentication.title')}
      />
      <div className="grid gap-2 text-sm">
        <Text><strong>{t('dashboard.apiDocs.authentication.baseUrl')}:</strong> <code>{window.location.origin}</code></Text>
      </div>
      <MessageBar intent="warning"><MessageBarBody>{t('dashboard.apiDocs.authentication.warning')}</MessageBarBody></MessageBar>
      <CodeBlock code={authExample} copyOutcome={outcomeFor('auth')} language="bash" onCopy={() => copy(authExample, 'auth')} />
    </Panel>

    <Panel className="!grid !gap-5">
      <SectionHeader description={t('dashboard.apiDocs.endpointsDescription')} level={2} title={t('dashboard.apiDocs.endpointsTitle')} />
      {apiDocsGroups.map(group => {
        const endpoints = apiDocsEndpoints.filter(endpoint => endpoint.group === group);
        return <section className="grid gap-2" key={group}>
          <SectionHeader level={3} title={t(`dashboard.apiDocs.groups.${group}`)} />
          <ScrollArea axes="horizontal" className="min-w-0">
            <Table aria-label={t(`dashboard.apiDocs.groups.${group}`)} className="min-w-[780px] table-fixed" size="small">
              <colgroup><col className="w-[72px]" /><col /><col className="w-[300px]" /><col className="w-[144px]" /></colgroup>
              <TableHeader><TableRow>
                <TableHeaderCell>{t('dashboard.apiDocs.columns.method')}</TableHeaderCell>
                <TableHeaderCell>{t('dashboard.apiDocs.columns.endpoint')}</TableHeaderCell>
                <TableHeaderCell>{t('dashboard.apiDocs.columns.description')}</TableHeaderCell>
                <TableActionsHeader>{t('dashboard.apiDocs.columns.docs')}</TableActionsHeader>
              </TableRow></TableHeader>
              <TableBody>{endpoints.map(endpoint => <TableRow key={`${endpoint.method} ${endpoint.path}`}>
                <TableCell><HttpMethodBadge method={endpoint.method} /></TableCell>
                <TableCell><code translate="no">{endpoint.path}</code></TableCell>
                <TableCell>{t(`dashboard.apiDocs.endpointNames.${endpoint.name}`)}</TableCell>
                <TableCell className={trailingCell}><Link href={endpoint.docs} target="_blank"><OpenLinkLabel>{t('dashboard.apiDocs.docsLink')}</OpenLinkLabel></Link></TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </ScrollArea>
        </section>;
      })}
    </Panel>
  </>;
}
