import { apiDocsEndpoints, apiDocsGroups, authCurlExample } from './data';
import { fluentComponents } from '../../fluent';
import { Trans, useTranslation } from '../../i18n/translation';
import { CodeBlock } from '../ui/code-block';
import { HttpMethodBadge } from '../ui/http-badge';
import { SECTION_STACK_CLASS } from '../ui/layout';
import { OpenLinkLabel } from '../ui/open-link-label';
import { Panel } from '../ui/panel';
import { RouteLink } from '../ui/route-link';
import { ScrollArea } from '../ui/scroll-area';
import { SectionHeader } from '../ui/section-header';
import { TableTrailingCell, TableTrailingHeader } from '../ui/table-actions';
import { TableColumns } from '../ui/table-columns';
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

// `SECTION_STACK_CLASS` restated so it beats `Card`'s own display and gap.
// Named apart from the exported `PANEL_STACK_CLASS`, which every other panel in
// the tree takes and which states a wider step than these two do.
const PANEL_SECTION_STACK_CLASS = '!grid !gap-2';

// WinUI separates one settings section from the next by 30 of header margin
// over a 4 stack spacing, and leaves only 6 + 4 under the header, so the two
// distances cannot both be a container gap: the groups take the larger one.
// https://github.com/microsoft/WinUI-Gallery/blob/f4dc3eb367f4bcecac1793829d9a221e924e5bfb/WinUIGallery/Pages/SettingsPage.xaml#L10-L21
const ENDPOINT_GROUP_GAP = 'grid gap-[34px]';

export function ApiDocsContent() {
  const { t } = useTranslation();
  const { copy, outcomeFor } = useCopyToClipboard();
  const authExample = authCurlExample(window.location.origin);

  return <>
    <Panel className={PANEL_SECTION_STACK_CLASS}>
      <SectionHeader
        description={<Trans
          components={[<RouteLink key="api-keys" to="/dashboard/services/api-keys" />]}
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

    <Panel className={PANEL_SECTION_STACK_CLASS}>
      <SectionHeader description={t('dashboard.apiDocs.endpointsDescription')} level={2} title={t('dashboard.apiDocs.endpointsTitle')} />
      <div className={ENDPOINT_GROUP_GAP}>{apiDocsGroups.map(group => {
        const endpoints = apiDocsEndpoints.filter(endpoint => endpoint.group === group);
        return <section className={SECTION_STACK_CLASS} key={group}>
          <SectionHeader level={3} title={t(`dashboard.apiDocs.groups.${group}`)} />
          <ScrollArea axes="horizontal" className="min-w-0">
            <Table aria-label={t(`dashboard.apiDocs.groups.${group}`)} className="min-w-[780px]" size="small">
              <TableColumns widths={['72px', null, '300px', '144px']} />
              <TableHeader><TableRow>
                <TableHeaderCell>{t('dashboard.apiDocs.columns.method')}</TableHeaderCell>
                <TableHeaderCell>{t('dashboard.apiDocs.columns.endpoint')}</TableHeaderCell>
                <TableHeaderCell>{t('dashboard.apiDocs.columns.description')}</TableHeaderCell>
                <TableTrailingHeader>{t('dashboard.apiDocs.columns.docs')}</TableTrailingHeader>
              </TableRow></TableHeader>
              <TableBody>{endpoints.map(endpoint => <TableRow key={`${endpoint.method} ${endpoint.path}`}>
                <TableCell><HttpMethodBadge method={endpoint.method} /></TableCell>
                <TableCell><code translate="no">{endpoint.path}</code></TableCell>
                <TableCell>{t(`dashboard.apiDocs.endpointNames.${endpoint.name}`)}</TableCell>
                <TableTrailingCell><Link href={endpoint.docs} target="_blank" rel="noopener noreferrer"><OpenLinkLabel>{t('dashboard.apiDocs.docsLink')}</OpenLinkLabel></Link></TableTrailingCell>
              </TableRow>)}</TableBody>
            </Table>
          </ScrollArea>
        </section>;
      })}</div>
    </Panel>
  </>;
}
