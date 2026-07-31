import { useTranslation } from 'react-i18next';

import { apiDocsEndpoints, apiDocsGroups, authCurlExample } from './api-docs-data';
import { fluentComponents } from '../../fluent';
import { CodeBlock } from '../ui/code-block';
import { HttpMethodBadge } from '../ui/http-badge';
import { OpenLinkLabel } from '../ui/open-link-label';
import { Panel } from '../ui/panel';
import { ScrollArea } from '../ui/scroll-area';
import { TableActionsHeader } from '../ui/table-actions';
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
  const { copiedTag, copy, copyFailedTag } = useCopyToClipboard();
  const authExample = authCurlExample(window.location.origin);

  return <>
    <Panel className="grid gap-4 !p-[22px_24px] max-[680px]:!p-[18px]">
      <Text as="h2" size={500} weight="semibold" className="m-0">{t('dashboard.apiDocs.authentication.title')}</Text>
      <Text className="text-fui-fg2">{t('dashboard.apiDocs.authentication.description')}</Text>
      <div className="grid gap-2 text-sm">
        <Text><strong>{t('dashboard.apiDocs.authentication.baseUrl')}:</strong> <code>{window.location.origin}</code></Text>
      </div>
      <MessageBar intent="warning"><MessageBarBody>{t('dashboard.apiDocs.authentication.warning')}</MessageBarBody></MessageBar>
      <CodeBlock code={authExample} copied={copiedTag === 'auth'} copyFailed={copyFailedTag === 'auth'} language="bash" onCopy={() => copy(authExample, 'auth')} />
    </Panel>

    <Panel className="grid gap-5 !p-[22px_24px] max-[680px]:!p-[18px]">
      <div className="grid gap-1">
        <Text as="h2" size={500} weight="semibold" className="m-0">{t('dashboard.apiDocs.endpointsTitle')}</Text>
        <Text size={300} className="text-fui-fg2">{t('dashboard.apiDocs.endpointsDescription')}</Text>
      </div>
      {apiDocsGroups.map(group => {
        const endpoints = apiDocsEndpoints.filter(endpoint => endpoint.group === group);
        return <section className="grid gap-2" key={group}>
          <Text as="h3" size={400} weight="semibold" className="m-0">{t(`dashboard.apiDocs.groups.${group}`)}</Text>
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
                <TableCell><Text size={300}>{t(`dashboard.apiDocs.endpointNames.${endpoint.name}`)}</Text></TableCell>
                <TableCell className="text-right"><Link href={endpoint.docs} target="_blank"><OpenLinkLabel>{t('dashboard.apiDocs.docsLink')}</OpenLinkLabel></Link></TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </ScrollArea>
        </section>;
      })}
    </Panel>
  </>;
}
