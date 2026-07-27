import { ArrowUpRight16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';

import { Panel } from '../components/ui/panel';
import { fluentComponents } from '../fluent';

const { Link, Text } = fluentComponents;

type EndpointRow = {
  method: 'GET' | 'POST';
  path: string;
  name: string;
  docs: string;
};

// Static reference for the public gateway endpoints exposed by Floway.
const endpoints: EndpointRow[] = [
  {
    method: 'POST',
    path: '/v1/messages',
    name: 'Anthropic Messages',
    docs: 'https://docs.anthropic.com/en/api/messages',
  },
  {
    method: 'POST',
    path: '/v1/messages/count_tokens',
    name: 'Anthropic Count Tokens',
    docs: 'https://docs.anthropic.com/en/api/messages-count-tokens',
  },
  {
    method: 'POST',
    path: '/v1/responses',
    name: 'OpenAI Responses',
    docs: 'https://platform.openai.com/docs/api-reference/responses/create',
  },
  {
    method: 'POST',
    path: '/v1/responses/compact',
    name: 'OpenAI Responses Compact',
    docs: 'https://platform.openai.com/docs/api-reference/responses/compact',
  },
  {
    method: 'GET',
    path: '/v1/responses',
    name: 'OpenAI Responses (WebSocket)',
    docs: 'https://developers.openai.com/api/docs/guides/websocket-mode',
  },
  {
    method: 'POST',
    path: '/v1/chat/completions',
    name: 'OpenAI Chat Completions',
    docs: 'https://platform.openai.com/docs/api-reference/chat/create',
  },
  {
    method: 'POST',
    path: '/v1/embeddings',
    name: 'OpenAI Embeddings',
    docs: 'https://platform.openai.com/docs/api-reference/embeddings/create',
  },
  {
    method: 'POST',
    path: '/v1/images/generations',
    name: 'OpenAI Image Generations',
    docs: 'https://platform.openai.com/docs/api-reference/images/create',
  },
  {
    method: 'POST',
    path: '/v1/images/edits',
    name: 'OpenAI Image Edits',
    docs: 'https://platform.openai.com/docs/api-reference/images/createEdit',
  },
  {
    method: 'GET',
    path: '/v1/models',
    name: 'OpenAI Models',
    docs: 'https://platform.openai.com/docs/api-reference/models/list',
  },
  {
    method: 'POST',
    path: '/v1beta/models/{model}:{action}',
    name: 'Google Gemini',
    docs: 'https://ai.google.dev/api/generate-content',
  },
];

export function meta() {
  return [{ title: 'API Docs | Floway' }];
}

export default function DashboardServicesApiDocs() {
  const { t } = useTranslation();

  return (
    <section className="grid gap-[18px] max-w-[960px] min-w-0">
      <header className="grid gap-[6px]">
        <Text size={200} weight="semibold" className="text-fui-fg2 leading-[1.2] uppercase">
          {t('dashboard.groups.services')}
        </Text>
        <Text size={700} weight="semibold">
          {t('dashboard.nav.apiDocs')}
        </Text>
        <Text size={300} className="text-fui-fg2 leading-[1.45] max-w-[760px]">
          {t('dashboard.pages.apiDocs')}
        </Text>
      </header>
      <Panel className="grid gap-[14px] !p-[22px_24px] max-[680px]:!p-[18px]">
        <Text size={400} weight="semibold">
          {t('dashboard.apiDocs.endpointsTitle')}
        </Text>
        <div className="grid min-w-0">
          {endpoints.map(endpoint => (
            <div
              className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-2 py-[6px] px-2 border-b border-fui-subtle last:border-b-0 min-w-0"
              key={`${endpoint.method} ${endpoint.path}`}
            >
              <span
                className="rounded inline-flex font-mono text-[11px] font-bold justify-center leading-none p-[4px_7px] w-[46px]"
                style={{
                  color: endpoint.method === 'GET'
                    ? 'light-dark(#0f6cbd, #75b6f7)'
                    : 'light-dark(#107c41, #7fd99a)',
                  background: endpoint.method === 'GET'
                    ? 'light-dark(#e6f2fb, rgba(71,158,245,0.18))'
                    : 'light-dark(#e8f5ee, rgba(84,179,111,0.18))',
                }}
              >
                {endpoint.method}
              </span>
              <code className="font-mono text-xs min-w-0 truncate">{endpoint.path}</code>
              <span className="text-xs min-w-0 truncate">{endpoint.name}</span>
              <Link href={endpoint.docs} target="_blank">
                {t('dashboard.apiDocs.docsLink')}
                <ArrowUpRight16Regular aria-hidden="true" />
              </Link>
            </div>
          ))}
        </div>
      </Panel>
    </section>
  );
}
