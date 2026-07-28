import { ArrowUpRight16Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiDocsEndpoints, apiDocsExamples, apiDocsGroups, authCurlExample, type ApiDocsExampleId } from './api-docs-data';
import { fluentComponents } from '../../fluent';
import { CodeBlock } from '../ui/code-block';
import { Panel } from '../ui/panel';
import { ScrollArea } from '../ui/scroll-area';

const {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Link,
  MessageBar,
  MessageBarBody,
  Text,
} = fluentComponents;

const referenceSections = [
  { id: 'openai', examples: ['completions', 'chat', 'responses'], notes: ['openaiSurface', 'modelSelection'] },
  { id: 'anthropic', examples: ['messages'], notes: ['anthropicHeaders', 'anthropicStreaming'] },
  { id: 'gemini', examples: ['gemini'], notes: ['geminiActions', 'geminiDiscovery'] },
  { id: 'media', examples: ['embeddings', 'imageGeneration', 'imageEdit', 'audio'], notes: ['imageInputs', 'audioResponses'] },
  { id: 'rerank', examples: ['rerank'], notes: ['rerankDialects'] },
  { id: 'search', examples: ['search'], notes: ['searchCommands'] },
  { id: 'websocket', examples: ['websocket'], notes: ['websocketUpgrade', 'websocketFrames', 'statefulResponses'] },
] as const satisfies ReadonlyArray<{
  examples: readonly ApiDocsExampleId[];
  id: string;
  notes: readonly string[];
}>;

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
        <Text><code>?key=</code> → <code>x-api-key</code> → <code>x-goog-api-key</code> → <code>Authorization: Bearer</code></Text>
      </div>
      <MessageBar intent="warning"><MessageBarBody>{t('dashboard.apiDocs.authentication.warning')}</MessageBarBody></MessageBar>
      <CodeBlock code={authExample} copied={copied === 'auth'} copyFailed={copyFailed === 'auth'} language="bash" onCopy={() => void copy('auth', authExample)} />
    </Panel>

    <Panel className="grid gap-5 !p-[22px_24px] max-[680px]:!p-[18px]">
      <div className="grid gap-1">
        <Text as="h2" size={500} weight="semibold" className="!m-0">{t('dashboard.apiDocs.endpointsTitle')}</Text>
        <Text size={300} className="text-fui-fg2">{t('dashboard.apiDocs.endpointsDescription')}</Text>
      </div>
      {apiDocsGroups.map(group => <section className="grid gap-2" key={group}>
        <Text as="h3" size={300} weight="semibold" className="!m-0">{t(`dashboard.apiDocs.groups.${group}`)}</Text>
        <ScrollArea axes="horizontal" className="min-w-0">
          <div className="grid min-w-[780px]">
            {apiDocsEndpoints.filter(endpoint => endpoint.group === group).map(endpoint => (
              <div className="grid grid-cols-[54px_minmax(260px,1fr)_minmax(190px,auto)_74px] items-center gap-3 py-2 px-2 border-b border-fui-subtle last:border-b-0" key={`${endpoint.method} ${endpoint.path}`}>
                <MethodBadge method={endpoint.method} />
                <code className="font-mono text-xs">{endpoint.path}</code>
                <Text size={200}>{t(`dashboard.apiDocs.endpointNames.${endpoint.name}`)}</Text>
                <Link href={endpoint.docs} target="_blank">
                  {t('dashboard.apiDocs.docsLink')} <ArrowUpRight16Regular aria-hidden="true" />
                </Link>
              </div>
            ))}
          </div>
        </ScrollArea>
      </section>)}
    </Panel>

    <Panel className="grid gap-3 !p-[22px_24px] max-[680px]:!p-[18px]">
      <Text as="h2" size={500} weight="semibold" className="!m-0">{t('dashboard.apiDocs.examplesTitle')}</Text>
      <Accordion collapsible multiple>
        {referenceSections.map(section => <AccordionItem key={section.id} value={section.id}>
          <AccordionHeader>{t(`dashboard.apiDocs.reference.${section.id}.title`)}</AccordionHeader>
          <AccordionPanel>
            <div className="grid gap-4 pb-2">
              <ul className="m-0 grid gap-1 pl-5 text-sm text-fui-fg2">
                {section.notes.map(note => <li key={note}>{t(`dashboard.apiDocs.notes.${note}`)}</li>)}
              </ul>
              {section.examples.map(exampleId => {
                const example = apiDocsExamples[exampleId];
                return <div className="grid gap-2" key={exampleId}>
                  <Text size={300} weight="semibold">{t(`dashboard.apiDocs.examples.${example.title}`)}</Text>
                  <CodeBlock code={example.code} copied={copied === example.id} copyFailed={copyFailed === example.id} language={example.language} onCopy={() => void copy(example.id, example.code)} />
                </div>;
              })}
            </div>
          </AccordionPanel>
        </AccordionItem>)}
      </Accordion>
    </Panel>
  </>;
}

function MethodBadge({ method }: { method: 'GET' | 'POST' }) {
  return <span className="rounded inline-flex font-mono text-[11px] font-bold justify-center leading-none p-[4px_7px] w-[46px]" style={{
    color: method === 'GET' ? 'light-dark(#0f6cbd, #75b6f7)' : 'light-dark(#107c41, #7fd99a)',
    background: method === 'GET' ? 'light-dark(#e6f2fb, rgba(71,158,245,0.18))' : 'light-dark(#e8f5ee, rgba(84,179,111,0.18))',
  }}>{method}</span>;
}
