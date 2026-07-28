import { ArrowUpRight16Regular } from '@fluentui/react-icons';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiDocsEndpoints, apiDocsGroups, authCurlExample } from './api-docs-data';
import { fluentComponents } from '../../fluent';
import { CodeBlock } from '../ui/code-block';
import { Panel } from '../ui/panel';
import { ScrollArea } from '../ui/scroll-area';

const {
  Badge,
  Link,
  MessageBar,
  MessageBarBody,
  Text,
} = fluentComponents;

export function ApiDocsContent() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState<string | null>(null);
  const copy = async (id: string, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyFailed(null);
      setCopied(id);
    } catch {
      setCopied(null);
      setCopyFailed(id);
    }
  };
  const authExample = authCurlExample(window.location.origin);

  return <>
    <Panel className="grid gap-4 !p-[22px_24px] max-[680px]:!p-[18px]">
      <Text as="h2" size={500} weight="semibold" className="!m-0">{t('dashboard.apiDocs.authentication.title')}</Text>
      <Text className="text-fui-fg2">{t('dashboard.apiDocs.authentication.description')}</Text>
      <div className="grid gap-2 text-sm">
        <Text><strong>{t('dashboard.apiDocs.authentication.baseUrl')}:</strong> <code>{window.location.origin}</code></Text>
      </div>
      <MessageBar intent="warning"><MessageBarBody>{t('dashboard.apiDocs.authentication.warning')}</MessageBarBody></MessageBar>
      <CodeBlock code={authExample} copied={copied === 'auth'} copyFailed={copyFailed === 'auth'} language="bash" onCopy={() => void copy('auth', authExample)} />
    </Panel>

    <Panel className="grid gap-5 !p-[22px_24px] max-[680px]:!p-[18px]">
      <div className="grid gap-1">
        <Text as="h2" size={500} weight="semibold" className="!m-0">{t('dashboard.apiDocs.endpointsTitle')}</Text>
        <Text size={300} className="text-fui-fg2">{t('dashboard.apiDocs.endpointsDescription')}</Text>
      </div>
      {apiDocsGroups.map(group => {
        const endpoints = apiDocsEndpoints.filter(endpoint => endpoint.group === group);
        return <section className="grid gap-2" key={group}>
          <Text as="h3" size={400} weight="semibold" className="!m-0">{t(`dashboard.apiDocs.groups.${group}`)}</Text>
          <ScrollArea axes="horizontal" className="min-w-0">
            <div className="grid grid-cols-[70px_minmax(360px,1fr)_minmax(260px,320px)_74px] min-w-[780px]">
              {endpoints.map((endpoint, index) => {
                const cellClassName = `min-w-0 px-2 py-2 ${index === endpoints.length - 1 ? '' : 'border-b border-fui-subtle'}`;
                return <Fragment key={`${endpoint.method} ${endpoint.path}`}>
                  <div className={`flex items-center ${cellClassName}`}><MethodBadge method={endpoint.method} /></div>
                  <code className={`${cellClassName} flex items-center font-mono text-fui-base300`} translate="no">{endpoint.path}</code>
                  <Text className={`${cellClassName} !flex !items-center`} size={300}>{t(`dashboard.apiDocs.endpointNames.${endpoint.name}`)}</Text>
                  <div className={`flex items-center ${cellClassName}`}>
                    <Link href={endpoint.docs} target="_blank">
                      {t('dashboard.apiDocs.docsLink')} <ArrowUpRight16Regular aria-hidden="true" />
                    </Link>
                  </div>
                </Fragment>;
              })}
            </div>
          </ScrollArea>
        </section>;
      })}
    </Panel>
  </>;
}

function MethodBadge({ method }: { method: 'GET' | 'POST' }) {
  return <Badge
    appearance="tint"
    className="!font-bold !font-mono !justify-center !min-w-[48px]"
    color={method === 'GET' ? 'brand' : 'success'}
    size="medium"
    translate="no"
  >{method}</Badge>;
}
