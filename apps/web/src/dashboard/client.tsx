import { html, raw } from 'hono/html';

import { activeCredentialValue, draftFromSearchConfig, searchConfigFromDraft, setActiveCredentialValue } from './search-config.ts';

export function dashboardAssets() {
  return html`
    <style>
      select option {
        background: #13181f;
        color: #e0e0e0;
      }
    </style>

    <script>
      function dashboardApp() {
        const isAdmin = localStorage.getItem('isAdmin') === '1';
        const TABS = isAdmin ? ['settings', 'models', 'keys', 'usage', 'performance'] : ['models', 'keys', 'usage', 'performance'];
        const defaultTab = isAdmin ? 'settings' : 'models';
        const initTab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : defaultTab;

        // Chart instances and key name map stored outside Alpine to avoid reactive proxy wrapping
        const _charts = { key: null, model: null, searchKey: null, performanceModel: null };
        const _keyNameMap = new Map();
        const _detailMaps = { key: null, model: null, searchKey: null };
        let _modelsLoadPromise = null;

        function destroyCharts() {
          for (const k of ['key', 'model', 'searchKey', 'performanceModel']) {
            if (_charts[k]) {
              _charts[k].stop();
              _charts[k].destroy();
              _charts[k] = null;
            }
          }
        }

        const pad2 = n => String(n).padStart(2, '0');

        function chartXAxisTickCallback(bucketKeys, labels, compact4h) {
          return (_value, index) => {
            const label = labels[index] ?? '';
            if (!compact4h) return label;
            const hour = Number(String(bucketKeys[index] ?? '').slice(11, 13));
            return Number.isFinite(hour) && hour % 8 === 0 ? label : '';
          };
        }

        function copyTextWithTextarea(text) {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.setAttribute('readonly', '');
          textarea.style.position = 'fixed';
          textarea.style.top = '0';
          textarea.style.left = '-9999px';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          try {
            if (!document.execCommand('copy')) {
              throw new Error('document.execCommand("copy") failed');
            }
          } finally {
            document.body.removeChild(textarea);
          }
        }

        async function copyText(text) {
          const value = String(text);
          const clipboard = globalThis.navigator?.clipboard;
          // Clipboard API is absent outside secure contexts in some browsers, so
          // dashboard copy buttons keep a click-bound textarea fallback.
          if (clipboard?.writeText) {
            await clipboard.writeText(value);
            return;
          }
          copyTextWithTextarea(value);
        }

        function formatTokenCount(n) {
          return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
        }

        function formatDurationMs(ms) {
          if (ms === null || ms === undefined) return '\\u2014';
          if (ms >= 60000) return (ms / 60000).toFixed(1) + 'm';
          if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
          return Math.round(ms) + 'ms';
        }

        function renderHitRate(cacheRead, cacheCreation) {
          const total = cacheRead + cacheCreation;
          return total > 0 ? ((cacheRead / total) * 100).toFixed(1) + '%' : '\\u2014';
        }

        function renderInputRate(tokens, input) {
          return input > 0 ? ((tokens / input) * 100).toFixed(1) + '%' : '\\u2014';
        }

        function prefillInputTokens(input, cacheRead) {
          return input - cacheRead;
        }

        const TOKEN_CHART_METRICS = {
          requests: { label: 'Requests', kind: 'count' },
          cost: { label: 'Est. Cost', kind: 'cost' },
          total: { label: 'Total Tokens', kind: 'tokens' },
          input: { label: 'Input Tokens', kind: 'tokens' },
          output: { label: 'Output Tokens', kind: 'tokens' },
          cached: { label: 'Cached Input', kind: 'tokens' },
          cachedRate: { label: 'Cached Rate', kind: 'percent' },
          prefill: { label: 'Prefill Input', kind: 'tokens' },
          cacheCreation: { label: 'Cache Write', kind: 'tokens' },
          cacheHitRate: { label: 'Cache Hit Rate', kind: 'percent' },
        };

        const USAGE_CHART_PALETTE = ['#00e5ff', '#00e676', '#ffd740', '#ff5252', '#7c4dff', '#ff6e40', '#64ffda', '#eeff41', '#40c4ff', '#ea80fc'];

        function usageChartColor(slot) {
          return USAGE_CHART_PALETTE[slot % USAGE_CHART_PALETTE.length];
        }

        function compareUsageKeyIds(a, b, keyMetaMap) {
          const am = keyMetaMap.get(a) || {};
          const bm = keyMetaMap.get(b) || {};
          if (am.createdAt && bm.createdAt && am.createdAt !== bm.createdAt) return am.createdAt.localeCompare(bm.createdAt);
          if (am.createdAt !== bm.createdAt) return am.createdAt ? -1 : 1;
          return a.localeCompare(b);
        }

        function usageKeyColorSlots(colorOrder) {
          const explicitSlotById = new Map();
          const futureSlotByIndex = new Map();
          let maxFutureIndex = 0;
          for (let i = 0; i < colorOrder.length; i++) {
            const token = colorOrder[i];
            const futureMatch = token.match(/^future-(\\d+)$/);
            if (futureMatch) {
              const futureIndex = Number(futureMatch[1]);
              futureSlotByIndex.set(futureIndex, i);
              maxFutureIndex = Math.max(maxFutureIndex, futureIndex);
            } else {
              explicitSlotById.set(token, i);
            }
          }
          return { explicitSlotById, futureSlotByIndex, maxFutureIndex };
        }

        function usageFutureColorSlot(futureIndex, colorOrderLength, futureSlotByIndex, maxFutureIndex) {
          return futureSlotByIndex.get(futureIndex) ?? colorOrderLength + futureIndex - maxFutureIndex - 1;
        }

        function usageKeyChartEntries(keyIds, keyMetaMap, keyIdsForOrder = keyIds, colorOrder = []) {
          const present = new Set(keyIds);
          const { explicitSlotById, futureSlotByIndex, maxFutureIndex } = usageKeyColorSlots(colorOrder);
          const futureKeyIds = [...new Set([...keyIdsForOrder, ...keyIds])].filter(keyId => !explicitSlotById.has(keyId)).sort((a, b) => compareUsageKeyIds(a, b, keyMetaMap));
          const futureSlotByKeyId = new Map(futureKeyIds.map((keyId, i) => [keyId, usageFutureColorSlot(i + 1, colorOrder.length, futureSlotByIndex, maxFutureIndex)]));

          return [...present]
            .map(keyId => ({
              keyId,
              colorSlot: explicitSlotById.get(keyId) ?? futureSlotByKeyId.get(keyId),
            }))
            .filter(entry => entry.colorSlot !== undefined)
            .sort((a, b) => a.colorSlot - b.colorSlot || compareUsageKeyIds(a.keyId, b.keyId, keyMetaMap));
        }

        function tokenModelChartEntries(models, knownModels) {
          const present = new Set(models);
          const order = [...new Set([...knownModels, ...models])].sort();
          return order.map((model, slot) => ({ model, colorSlot: slot })).filter(entry => present.has(entry.model));
        }

        function tokenChartMetricRecordValue(record, metric) {
          if (metric === 'requests') return record.requests;
          if (metric === 'cost') return record.cost ?? 0;
          if (metric === 'input') return record.inputTokens;
          if (metric === 'output') return record.outputTokens;
          if (metric === 'cached') return record.cacheReadTokens ?? 0;
          if (metric === 'prefill') return prefillInputTokens(record.inputTokens, record.cacheReadTokens ?? 0);
          if (metric === 'cacheCreation') return record.cacheCreationTokens ?? 0;
          return record.inputTokens + record.outputTokens;
        }

        function tokenChartMetricDetailValue(detail, metric) {
          if (metric === 'cacheHitRate') {
            const total = detail.cacheRead + detail.cacheCreation;
            return total > 0 ? (detail.cacheRead / total) * 100 : null;
          }
          if (metric === 'cachedRate') {
            return detail.input > 0 ? (detail.cacheRead / detail.input) * 100 : null;
          }
          return null;
        }

        function isTokenChartPercentMetric(metric) {
          return TOKEN_CHART_METRICS[metric]?.kind === 'percent';
        }

        function tokenChartMetricLabel(metric) {
          return TOKEN_CHART_METRICS[metric]?.label || TOKEN_CHART_METRICS.total.label;
        }

        function formatTokenChartAxisValue(value, metric) {
          if (TOKEN_CHART_METRICS[metric]?.kind === 'percent') return value.toFixed(0) + '%';
          if (TOKEN_CHART_METRICS[metric]?.kind === 'count') return Math.round(value).toLocaleString();
          if (TOKEN_CHART_METRICS[metric]?.kind === 'cost') return formatCost(value);
          return formatTokenCount(value);
        }

        function tooltipLabelWidth(chart) {
          return chart.data.datasets.reduce((maxLen, ds) => Math.max(maxLen, String(ds.label || '').length), 0);
        }

        function formatTooltipHeader(labelWidth) {
          return (
            '  ' +
            ''.padEnd(labelWidth + 1) +
            'Req'.padStart(5) +
            '  ' +
            'Cost'.padStart(9) +
            '  ' +
            'Total'.padStart(7) +
            '  ' +
            'Cached'.padStart(7) +
            '  ' +
            'Cached%'.padStart(8) +
            '  ' +
            'Prefill'.padStart(7) +
            '  ' +
            'Output'.padStart(7) +
            '  ' +
            'Hit%'.padStart(7)
          );
        }

        function formatTooltipRow(label, labelWidth, detail) {
          const cached = detail.cacheRead;
          const prefill = prefillInputTokens(detail.input, cached);
          return (
            label.padEnd(labelWidth + 1) +
            String(detail.requests).padStart(5) +
            '  ' +
            formatCost(detail.cost).padStart(9) +
            '  ' +
            formatTokenCount(detail.input + detail.output).padStart(7) +
            '  ' +
            formatTokenCount(cached).padStart(7) +
            '  ' +
            renderInputRate(cached, detail.input).padStart(8) +
            '  ' +
            formatTokenCount(prefill).padStart(7) +
            '  ' +
            formatTokenCount(detail.output).padStart(7) +
            '  ' +
            renderHitRate(detail.cacheRead, detail.cacheCreation).padStart(7)
          );
        }

        function formatCost(cost) {
          if (cost >= 1) return '$' + cost.toFixed(2);
          if (cost >= 0.01) return '$' + cost.toFixed(3);
          if (cost > 0) return '$' + cost.toFixed(4);
          return '$0';
        }

        const CLAUDE_TIER = { opus: 0, sonnet: 1, haiku: 2 };

        function modelContextWindow(model) {
          const limits = model.limits;
          return limits?.max_context_window_tokens || (limits?.max_prompt_tokens || 0) + (limits?.max_output_tokens || 0);
        }

        function modelSupportsGeneration(model) {
          return model.kind === 'chat';
        }

        function claudeTier(id) {
          for (const t in CLAUDE_TIER) {
            if (id.includes(t)) return CLAUDE_TIER[t];
          }
          return 99;
        }

        function sortClaudeBig(a, b) {
          const ta = claudeTier(a);
          const tb = claudeTier(b);
          return ta !== tb ? ta - tb : b.localeCompare(a);
        }

        function sortClaudeSmall(a, b) {
          const ta = claudeTier(a);
          const tb = claudeTier(b);
          return ta !== tb ? tb - ta : b.localeCompare(a);
        }

        function sortClaudeSonnet(a, b) {
          const da = Math.abs(claudeTier(a) - CLAUDE_TIER.sonnet);
          const db = Math.abs(claudeTier(b) - CLAUDE_TIER.sonnet);
          return da !== db ? da - db : b.localeCompare(a);
        }

        function sortCodex(a, b) {
          const am = a.includes('mini') ? 1 : 0;
          const bm = b.includes('mini') ? 1 : 0;
          return am !== bm ? am - bm : b.localeCompare(a);
        }

        const UPSTREAM_ENDPOINTS = ['/chat/completions', '/responses', '/v1/messages'];
        const UPSTREAM_ENDPOINT_LABELS = {
          '/chat/completions': 'Chat',
          '/responses': 'Responses',
          '/v1/messages': 'Messages',
          '/embeddings': 'Embeddings',
          '/models': 'Models',
        };
        const UPSTREAM_PROVIDER_LABELS = {
          custom: 'Custom',
          azure: 'Azure',
          copilot: 'Copilot',
        };
        const AZURE_DEPLOYMENT_API_TYPES = ['responses', 'responses_chat', 'chat_completions', 'messages', 'embeddings'];
        const AZURE_DEPLOYMENT_API_TYPE_LABELS = {
          responses: 'Responses',
          responses_chat: 'Responses + Chat',
          chat_completions: 'Chat',
          messages: 'Messages',
          embeddings: 'Embeddings',
        };
        const AZURE_DEPLOYMENT_API_TYPE_ENDPOINTS = {
          responses: ['/responses'],
          responses_chat: ['/responses', '/chat/completions'],
          chat_completions: ['/chat/completions'],
          messages: ['/v1/messages'],
          embeddings: ['/embeddings'],
        };

        function blankPathOverrides() {
          return {
            chat_completions: '',
            responses: '',
            messages: '',
            embeddings: '',
            models: '',
          };
        }

        function blankAzureDeployment() {
          return {
            open: true,
            deployment: '',
            publicModelId: '',
            apiType: 'responses',
            supportedEndpoints: ['/responses'],
            display_name: '',
            limits: {
              max_context_window_tokens: '',
              max_prompt_tokens: '',
              max_output_tokens: '',
            },
            flagOverridesEnabled: false,
            flagOverridesValues: {},
            cost: {
              input: '',
              output: '',
              cache_read: '',
              cache_write: '',
            },
            costError: null,
          };
        }

        function optionalStringForInput(value) {
          if (value === undefined || value === null) return '';
          return String(value);
        }

        function optionalNumberForInput(value) {
          return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
        }

        function normalizeAzureDeploymentForModal(deployment, open = false) {
          const source = cloneJson(deployment || {});
          const limits = source.limits || {};
          const overrides = (source.flagOverrides && typeof source.flagOverrides === 'object') ? source.flagOverrides : null;
          return {
            ...blankAzureDeployment(),
            open,
            deployment: optionalStringForInput(source.deployment),
            publicModelId: optionalStringForInput(source.publicModelId),
            apiType: azureDeploymentApiTypeFromEndpoints(source.supportedEndpoints),
            supportedEndpoints: Array.isArray(source.supportedEndpoints) ? [...source.supportedEndpoints] : ['/responses'],
            display_name: optionalStringForInput(source.display_name),
            limits: {
              max_context_window_tokens: optionalNumberForInput(limits.max_context_window_tokens),
              max_prompt_tokens: optionalNumberForInput(limits.max_prompt_tokens),
              max_output_tokens: optionalNumberForInput(limits.max_output_tokens),
            },
            flagOverridesEnabled: overrides ? overrides.enabled === true : false,
            flagOverridesValues: overrides && overrides.values && typeof overrides.values === 'object' ? { ...overrides.values } : {},
            cost: {
              input: optionalNumberForInput((source.cost || {}).input),
              output: optionalNumberForInput((source.cost || {}).output),
              cache_read: optionalNumberForInput((source.cost || {}).cache_read),
              cache_write: optionalNumberForInput((source.cost || {}).cache_write),
            },
            costError: null,
          };
        }

        function azureDeploymentApiTypeFromEndpoints(endpoints) {
          const set = new Set(Array.isArray(endpoints) ? endpoints : []);
          if (set.has('/v1/messages') || set.has('/messages')) return 'messages';
          if (set.has('/embeddings') || set.has('/v1/embeddings')) return 'embeddings';
          const hasResponses = set.has('/responses') || set.has('/v1/responses');
          const hasChat = set.has('/chat/completions') || set.has('/v1/chat/completions');
          if (hasResponses && hasChat) return 'responses_chat';
          if (hasChat) return 'chat_completions';
          return 'responses';
        }

        function azureDeploymentEndpointsForApiType(type) {
          return [...(AZURE_DEPLOYMENT_API_TYPE_ENDPOINTS[type] || AZURE_DEPLOYMENT_API_TYPE_ENDPOINTS.responses)];
        }

        function trimmedOptionalString(value) {
          if (typeof value !== 'string') return undefined;
          const trimmed = value.trim();
          return trimmed ? trimmed : undefined;
        }

        function trimmedOptionalNumber(value, field) {
          if (value === undefined || value === null || value === '') return undefined;
          const number = Number(value);
          if (!Number.isFinite(number)) throw new Error(field + ' must be a number');
          return number;
        }

        function assignDefined(target, key, value) {
          if (value !== undefined) target[key] = value;
        }

        function cleanAzureDeploymentPayload(deployment) {
          const metadata = {};
          assignDefined(metadata, 'display_name', trimmedOptionalString(deployment.display_name));

          const limits = {};
          assignDefined(limits, 'max_context_window_tokens', trimmedOptionalNumber(deployment.limits?.max_context_window_tokens, 'Context window'));
          assignDefined(limits, 'max_prompt_tokens', trimmedOptionalNumber(deployment.limits?.max_prompt_tokens, 'Prompt token limit'));
          assignDefined(limits, 'max_output_tokens', trimmedOptionalNumber(deployment.limits?.max_output_tokens, 'Output token limit'));
          if (Object.keys(limits).length > 0) metadata.limits = limits;

          const cost = azureDeploymentCostFromInputs(deployment.cost);
          if (cost) metadata.cost = cost;

          return metadata;
        }

        function azureDeploymentCostFromInputs(costInputs) {
          if (!costInputs) return undefined;
          const input = trimmedOptionalNumber(costInputs.input, 'Pricing input');
          const output = trimmedOptionalNumber(costInputs.output, 'Pricing output');
          const cacheRead = trimmedOptionalNumber(costInputs.cache_read, 'Pricing cache read');
          const cacheWrite = trimmedOptionalNumber(costInputs.cache_write, 'Pricing cache write');
          if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
            return undefined;
          }
          if (input === undefined || output === undefined) {
            throw new Error('Pricing input and output must both be filled or both blank');
          }
          if (input < 0 || output < 0 || (cacheRead !== undefined && cacheRead < 0) || (cacheWrite !== undefined && cacheWrite < 0)) {
            throw new Error('Pricing values must be non-negative');
          }
          const cost = { input, output };
          if (cacheRead !== undefined) cost.cache_read = cacheRead;
          if (cacheWrite !== undefined) cost.cache_write = cacheWrite;
          return cost;
        }

        function azureDeploymentPayloadFromModal(deployment) {
          const apiType = deployment.apiType || azureDeploymentApiTypeFromEndpoints(deployment.supportedEndpoints);
          const payload = {
            ...cleanAzureDeploymentPayload(deployment),
            deployment: typeof deployment.deployment === 'string' ? deployment.deployment.trim() : '',
            ...(nonEmptyString(deployment.publicModelId) ? { publicModelId: deployment.publicModelId.trim() } : {}),
            supportedEndpoints: azureDeploymentEndpointsForApiType(apiType),
          };
          const values = deployment.flagOverridesValues ?? {};
          if (deployment.flagOverridesEnabled) {
            payload.flagOverrides = {
              enabled: true,
              values: { ...values },
            };
          }
          return payload;
        }

        function azureDeploymentPayloadsFromUi(deployments) {
          return deployments.map(azureDeploymentPayloadFromModal).filter(deployment => deployment.deployment);
        }

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }

        function parseAzureDeploymentsJson(text) {
          let parsed;
          try {
            parsed = JSON.parse(text || '[]');
          } catch (e) {
            throw new Error('Deployments JSON is invalid: ' + (e.message || String(e)));
          }
          if (!Array.isArray(parsed)) throw new Error('Deployments JSON must be an array');
          return parsed.map((deployment, index) => {
            if (typeof deployment !== 'object' || deployment === null || Array.isArray(deployment)) {
              throw new Error('Deployments JSON item ' + (index + 1) + ' must be an object');
            }
            return azureDeploymentPayloadFromModal(normalizeAzureDeploymentForModal(deployment, false));
          });
        }

        function blankCopilotQuota() {
          return { loading: false, error: null, data: null, percent: 0 };
        }

        function blankUpstreamModal(provider = 'custom', sortOrder = 100) {
          return {
            open: false,
            id: null,
            provider,
            name: '',
            enabled: true,
            sortOrder,
            flagOverrides: {},
            flagOverridesOpen: false,
            saving: false,
            error: null,
            baseUrl: '',
            bearerToken: '',
            authStyle: 'bearer',
            supportedEndpoints: provider === 'custom' ? ['/chat/completions'] : [],
            pathOverrides: blankPathOverrides(),
            pathOverridesOpen: false,
            endpoint: '',
            apiKey: '',
            deployments: [blankAzureDeployment()],
            deploymentsJsonMode: false,
            deploymentsJson: '',
            deploymentsJsonError: null,
            accountType: '',
            copilotUser: null,
            copilotQuota: blankCopilotQuota(),
          };
        }

        function nonEmptyString(value) {
          return typeof value === 'string' && value.trim() ? value.trim() : null;
        }

        function cloneJson(value) {
          return JSON.parse(JSON.stringify(value));
        }

        // Hono escapes interpolated strings in this template, but these helpers are
        // embedded as executable script source, so they must be injected raw.
        const draftFromSearchConfig = ${raw(draftFromSearchConfig.toString())};
        const activeCredentialValue = ${raw(activeCredentialValue.toString())};
        const setActiveCredentialValue = ${raw(setActiveCredentialValue.toString())};
        const searchConfigFromDraft = ${raw(searchConfigFromDraft.toString())};

        return {
          authKey: '',
          isAdmin,
          tab: initTab,
          deviceFlow: { loading: false, userCode: null, verificationUri: null, deviceCode: null, pollTimer: null },
          keys: [],
          keysLoading: false,
          now: Date.now(),
          newKeyName: '',
          selectedKeyId: null,
          keyCreating: false,
          keyDeleting: null,
          keyRotating: null,
          copied: false,
          modelsLoaded: false,
          claudeModelsBig: [],
          claudeModelsSonnet: [],
          claudeModelsSmall: [],
          claudeContextMap: {},
          claudeModel: '',
          claudeSonnetModel: '',
          claudeSmallModel: '',
          codexModels: [],
          codexModel: '',
          tokenRange: 'today',
          tokenChartMetric: 'total',
          tokenData: [],
          tokenKeyMetadata: [],
          tokenKeyColorOrder: [],
          searchUsageData: [],
          searchUsageActiveProvider: 'disabled',
          searchUsageLoading: false,
          searchUsageKeyMetadata: [],
          searchUsageKeyColorOrder: [],
          performanceRange: 'today',
          performanceMetricScope: 'request_total',
          performanceChartView: 'model',
          performancePercentile: 'p95Ms',
          performanceModel: '',
          performanceSeries: [],
          performanceSummaryRows: [],
          performanceModelRows: [],
          performanceRuntimeRows: [],
          performanceLoading: false,
          performanceSummary: { requests: 0, errors: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
          chartsReady: false,
          tokenLoading: false,
          tokenSummary: { requests: 0, total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, prefill: 0 },
          hiddenKeys: new Set(),
          hiddenModels: new Set(),
          redactKeys: false,
          exportLoading: false,
          exportIncludePerformance: false,
          importFile: null,
          importData: null,
          importVersion: null,
          importMode: 'merge',
          importLoading: false,
          importPreview: { ready: false, exportedAt: null, apiKeys: 0, upstreams: 0, usage: 0, searchUsage: 0, performance: 0 },
          // Models tab — chat playground
          allModels: [],
          modelsSearch: '',
          chatModelId: '',
          chatMessages: [], // {role, text, imageUrl?}
          chatInput: '',
          chatImageUrl: '',
          chatShowImage: false,
          chatSending: false,
          chatStreamText: '',
          searchConfigDraft: draftFromSearchConfig({
            provider: 'disabled',
            tavily: { apiKey: '' },
            microsoftGrounding: { apiKey: '' },
          }),
          searchConfigLoaded: false,
          searchConfigSaving: false,
          searchConfigTesting: false,
          searchConfigTestResult: null,
          upstreams: [],
          upstreamsLoaded: false,
          upstreamTestingId: null,
          upstreamFlagCatalog: [],
          upstreamFlagCatalogLoaded: false,
          upstreamTestResult: null,
          upstreamModal: blankUpstreamModal('custom', 100),
          editKeyModal: {
            open: false,
            keyId: null,
            name: '',
            override: false,
            customOrder: [],
            allUpstreams: [],
            saving: false,
            error: null,
            _sortable: null,
          },
          _chatAbort: null,

          get baseUrl() {
            return location.origin;
          },

          get chatModelInfo() {
            return this.allModels.find(m => m.id === this.chatModelId) || null;
          },

          get generationModels() {
            return this.allModels.filter(modelSupportsGeneration);
          },

          get filteredChatModels() {
            let models = this.generationModels;
            if (this.modelsSearch.trim()) {
              const q = this.modelsSearch.toLowerCase();
              models = models.filter(m => m.id.toLowerCase().includes(q) || (m.display_name || '').toLowerCase().includes(q));
            }
            return models;
          },

          get activeKey() {
            const sel = this.selectedKeyId && this.keys.find(k => k.id === this.selectedKeyId);
            if (sel) return sel.key;
            return this.isAdmin ? '<your-api-key>' : this.authKey;
          },

          get searchCredentialValue() {
            return activeCredentialValue(this.searchConfigDraft);
          },

          get searchCredentialLabel() {
            return this.searchConfigDraft.provider === 'tavily' ? 'Tavily API Key' : this.searchConfigDraft.provider === 'microsoft-grounding' ? 'Microsoft Grounding API Key' : 'Credential';
          },

          setSearchCredentialValue(value) {
            this.searchConfigDraft = setActiveCredentialValue(this.searchConfigDraft, value);
            this.searchConfigTestResult = null;
          },

          setSearchConfigProvider(provider) {
            this.searchConfigDraft = { ...this.searchConfigDraft, provider };
            this.searchConfigTestResult = null;
          },

          truncateKey(key) {
            if (!key || key.length <= 12) return key;
            return key.slice(0, 4) + '\\u2026' + key.slice(-4);
          },

          formatHitRate(cacheRead, cacheCreation) {
            return renderHitRate(cacheRead, cacheCreation);
          },

          formatInputRate(tokens, input) {
            return renderInputRate(tokens, input);
          },

          formatDuration(ms) {
            return formatDurationMs(ms);
          },

          // K/M with no trailing .0 for whole values; model-card limit badges
          // render 1000000 as "1M" rather than "1.0M" or "1000K".
          formatTokenLimit(n) {
            if (n >= 1e6) {
              const m = n / 1e6;
              return (m === Math.floor(m) ? m.toFixed(0) : m.toFixed(1)) + 'M';
            }
            const k = n / 1e3;
            return (k === Math.floor(k) ? k.toFixed(0) : k.toFixed(1)) + 'K';
          },

          performancePercentileLabel(metric = this.performancePercentile) {
            if (metric === 'p50Ms') return 'p50';
            if (metric === 'p99Ms') return 'p99';
            return 'p95';
          },

          performanceModelOptions() {
            return [...new Set(this.performanceSeries.map(row => row.group))].sort();
          },

          timeAgo(dateStr) {
            if (!dateStr) return null;
            const date = new Date(dateStr);
            const diff = this.now - date;
            const seconds = Math.floor(diff / 1000);
            if (seconds < 60) return 'just now';
            const minutes = Math.floor(seconds / 60);
            if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
            const hours = Math.floor(minutes / 60);
            if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
            const days = Math.floor(hours / 24);
            if (days <= 30) return days + (days === 1 ? ' day ago' : ' days ago');
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          },

          fullDateTime(dateStr) {
            if (!dateStr) return '';
            const d = new Date(dateStr);
            return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
          },

          claudeCodeSnippet() {
            const addCtx = id => {
              const p = this.claudeContextMap[id];
              return p >= 1000000 ? id + '[1m]' : id;
            };
            const lines = [
              'export ANTHROPIC_BASE_URL=' + this.baseUrl,
              'export ANTHROPIC_AUTH_TOKEN=' + this.activeKey,
              'export ANTHROPIC_MODEL=' + addCtx(this.claudeModel),
              'export ANTHROPIC_DEFAULT_SONNET_MODEL=' + addCtx(this.claudeSonnetModel),
              'export ANTHROPIC_DEFAULT_HAIKU_MODEL=' + this.claudeSmallModel,
            ];
            return lines.join('\\n');
          },

          codexSnippet() {
            const lines = [
              'model = "' + this.codexModel + '"',
              'model_provider = "floway"',
              '',
              '[model_providers.floway]',
              'name = "Floway"',
              'base_url = "' + this.baseUrl + '/"',
              'env_key = "FLOWAY_API_KEY"',
              'wire_api = "responses"',
            ];
            return lines.join('\\n');
          },

          codexEnvSnippet() {
            return 'export FLOWAY_API_KEY=' + this.activeKey;
          },

          init() {
            this.authKey = localStorage.getItem('authKey') || '';
            if (!this.authKey) {
              window.location.href = '/';
              return;
            }

            const modelsReady = this.ensureModelsLoaded();

            if (this.tab === 'settings' && this.isAdmin) {
              this.loadSearchConfig();
              this.loadUpstreams();
            } else if (this.tab === 'keys') {
              this.loadKeys();
              if (this.isAdmin && !this.upstreamsLoaded) this.loadUpstreams();
            } else if (this.tab === 'usage') {
              this.loadUsageTabData(modelsReady);
            } else if (this.tab === 'performance') {
              this.loadPerformanceTabData();
            }

            setInterval(() => {
              if (this.tab === 'usage') this.loadUsageTabData();
              if (this.tab === 'performance') this.loadPerformanceTabData();
            }, 60000);

            setInterval(() => {
              this.now = Date.now();
            }, 30000);

            window.addEventListener('hashchange', () => {
              const h = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : defaultTab;
              if (this.tab !== h) this.switchTab(h);
            });
          },

          authHeaders() {
            return { 'x-api-key': this.authKey };
          },

          async switchTab(t) {
            if (t !== this.tab) {
              destroyCharts();
              this.chartsReady = false;
            }
            this.tab = t;
            location.hash = '#' + t;
            if (t === 'settings' && this.isAdmin) {
              if (!this.searchConfigLoaded) this.loadSearchConfig();
              if (!this.upstreamsLoaded) this.loadUpstreams();
            } else if (t === 'usage') {
              this.tokenLoading = true;
              this.searchUsageLoading = true;
              await this.loadUsageTabData();
            } else if (t === 'performance') {
              this.performanceLoading = true;
              await this.loadPerformanceTabData();
            } else if (t === 'keys') {
              await this.loadKeys();
              if (this.isAdmin && !this.upstreamsLoaded) this.loadUpstreams();
            } else if (t === 'models') {
              if (this.allModels.length === 0) await this.loadAllModels();
            }
          },

          ensureModelsLoaded() {
            if (this.modelsLoaded || this.allModels.length > 0) return Promise.resolve();
            if (!_modelsLoadPromise) {
              _modelsLoadPromise = this.loadModels().finally(() => {
                _modelsLoadPromise = null;
              });
            }
            return _modelsLoadPromise;
          },

          // Force a full reload after admin upstream CRUD/test so the
          // models picker reflects the current upstream set without
          // waiting for an in-process cache refresh.
          reloadModels() {
            this.modelsLoaded = false;
            this.allModels = [];
            return this.ensureModelsLoaded();
          },

          async loadModels() {
            try {
              const resp = await fetch('/api/models', { headers: this.authHeaders() });
              if (!resp.ok) {
                console.error('loadModels: HTTP', resp.status);
                return;
              }
              const { data: rawData } = await resp.json();
              const data = rawData.map(m => ({
                ...m,
                name: m.display_name || m.id,
              }));

              this.allModels = data;
              if (!this.chatModelId) {
                const first = this.filteredChatModels[0];
                if (first) this.chatModelId = first.id;
              }

              // Pickers are scoped to the model families each CLI actually
              // accepts: Claude Code only takes claude-* ids, and Codex only
              // takes gpt-*/codex-* ids. Backend model merging has already
              // collapsed dated and variant aliases (-xhigh, -1m) into base
              // ids, so we just dedupe and apply the picker-specific sort.
              const dedupeIds = ms => [...new Set(ms.map(m => m.id))];

              this.claudeContextMap = Object.fromEntries(
                data.filter(m => m.id.startsWith('claude-') && modelSupportsGeneration(m)).map(m => [m.id, modelContextWindow(m)]),
              );

              const claudeIds = dedupeIds(data.filter(m => m.id.startsWith('claude-') && modelSupportsGeneration(m)));
              this.claudeModelsBig = [...claudeIds].sort(sortClaudeBig);
              this.claudeModelsSonnet = [...claudeIds].sort(sortClaudeSonnet);
              this.claudeModelsSmall = [...claudeIds].sort(sortClaudeSmall);
              this.claudeModel = this.claudeModelsBig[0] || '';
              this.claudeSonnetModel = this.claudeModelsSonnet[0] || '';
              this.claudeSmallModel = this.claudeModelsSmall[0] || '';

              // Codex CLI talks the Responses protocol. The data plane
              // translates between protocols at runtime, so any
              // generation-capable gpt-*/codex-* id qualifies.
              const codexCapable = data.filter(m => (m.id.startsWith('gpt-') || m.id.startsWith('codex-')) && modelSupportsGeneration(m));
              this.codexModels = dedupeIds(codexCapable).sort(sortCodex);
              this.codexModel = this.codexModels[0] || '';

              this.modelsLoaded = true;
              if (this.tab === 'usage' && this.chartsReady) {
                await this.$nextTick();
                this.renderTokenCharts();
              }
            } catch (e) {
              console.error('loadModels:', e);
            }
          },

          async loadSearchConfig() {
            try {
              const resp = await fetch('/api/search-config', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (!resp.ok) {
                console.error('loadSearchConfig: HTTP', resp.status);
                return;
              }
              this.searchConfigDraft = draftFromSearchConfig(await resp.json());
              this.searchConfigLoaded = true;
              this.searchConfigTestResult = null;
            } catch (e) {
              console.error('loadSearchConfig:', e);
            }
          },

          async saveSearchConfig() {
            this.searchConfigSaving = true;
            try {
              const resp = await fetch('/api/search-config', {
                method: 'PUT',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(searchConfigFromDraft(this.searchConfigDraft)),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (!resp.ok) {
                console.error('saveSearchConfig: HTTP', resp.status);
                return;
              }
              this.searchConfigDraft = draftFromSearchConfig(await resp.json());
              this.searchConfigLoaded = true;
            } catch (e) {
              console.error('saveSearchConfig:', e);
            } finally {
              this.searchConfigSaving = false;
            }
          },

          async testSearchConfig() {
            this.searchConfigTesting = true;
            this.searchConfigTestResult = null;
            try {
              const resp = await fetch('/api/search-config/test', {
                method: 'POST',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(searchConfigFromDraft(this.searchConfigDraft)),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              this.searchConfigTestResult = await resp.json();
            } catch (e) {
              console.error('testSearchConfig:', e);
            } finally {
              this.searchConfigTesting = false;
            }
          },

          async loadUpstreams() {
            try {
              const resp = await fetch('/api/upstreams', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (!resp.ok) {
                console.error('loadUpstreams: HTTP', resp.status);
                return;
              }
              const items = await resp.json();
              this.upstreams = Array.isArray(items) ? items : [];
              this.upstreamsLoaded = true;
            } catch (e) {
              console.error('loadUpstreams:', e);
            }
            if (!this.upstreamFlagCatalogLoaded) {
              try {
                const resp = await fetch('/api/upstream-flags', { headers: this.authHeaders() });
                if (resp.status === 401) {
                  this.logout();
                  return;
                }
                if (resp.ok) {
                  this.upstreamFlagCatalog = await resp.json();
                  this.upstreamFlagCatalogLoaded = true;
                } else {
                  console.error('loadUpstreams (flags): HTTP', resp.status);
                }
              } catch (e) {
                console.error('loadUpstreams (flags):', e);
              }
            }
          },

          providerLabel(provider) {
            return UPSTREAM_PROVIDER_LABELS[provider] || provider;
          },

          providerBadgeClass(provider) {
            if (provider === 'copilot') return 'border-accent-cyan/25 bg-accent-cyan/10 text-accent-cyan';
            if (provider === 'azure') return 'border-accent-emerald/25 bg-accent-emerald/10 text-accent-emerald';
            return 'border-accent-amber/25 bg-accent-amber/10 text-accent-amber';
          },

          endpointLabel(endpoint) {
            return UPSTREAM_ENDPOINT_LABELS[endpoint] || endpoint;
          },

          azureDeploymentApiTypes() {
            return AZURE_DEPLOYMENT_API_TYPES;
          },

          azureDeploymentApiTypeLabel(type) {
            return AZURE_DEPLOYMENT_API_TYPE_LABELS[type] || type;
          },

          endpointList() {
            return UPSTREAM_ENDPOINTS;
          },

          nextUpstreamSortOrder() {
            return this.upstreams.reduce((m, u) => Math.max(m, Number(u.sort_order ?? 0)), -1) + 1;
          },

          upstreamConfig(upstream) {
            return upstream?.config && typeof upstream.config === 'object' ? upstream.config : {};
          },

          upstreamSubtitle(upstream) {
            const config = this.upstreamConfig(upstream);
            if (upstream.provider === 'copilot') {
              const user = config.user || {};
              return user.login ? '@' + user.login + ' · ' + (config.accountType || 'copilot') : 'GitHub Copilot account';
            }
            if (upstream.provider === 'azure') {
              const deployments = Array.isArray(config.deployments) ? config.deployments.length : 0;
              return [config.endpoint || 'Azure AI endpoint', deployments + ' deployment' + (deployments === 1 ? '' : 's')].filter(Boolean).join(' · ');
            }
            return config.baseUrl || 'OpenAI-compatible endpoint';
          },

          upstreamModelCount(upstream) {
            const config = this.upstreamConfig(upstream);
            if (upstream.provider === 'azure' && Array.isArray(config.deployments)) return config.deployments.length;
            return this.allModels.filter(model => Array.isArray(model.upstreams) && model.upstreams.some(binding => binding.id === upstream.id)).length;
          },

          upstreamModelSummary(upstream) {
            const count = this.upstreamModelCount(upstream);
            return count + ' model' + (count === 1 ? '' : 's');
          },

          upstreamMoveDisabled(id, delta) {
            const ordered = [...this.upstreams].sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));
            const index = ordered.findIndex(item => item.id === id);
            return index === -1 || index + delta < 0 || index + delta >= ordered.length;
          },

          async moveUpstream(id, delta) {
            const ordered = [...this.upstreams].sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));
            const index = ordered.findIndex(item => item.id === id);
            const target = ordered[index + delta];
            const source = ordered[index];
            if (!source || !target) return;

            const sourceOrder = Number(source.sort_order ?? 0);
            const targetOrder = Number(target.sort_order ?? 0);
            source.sort_order = targetOrder;
            target.sort_order = sourceOrder;
            this.upstreams = ordered.sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));

            try {
              const headers = { ...this.authHeaders(), 'Content-Type': 'application/json' };
              const [sourceResp, targetResp] = await Promise.all([
                fetch('/api/upstreams/' + source.id, { method: 'PATCH', headers, body: JSON.stringify({ sort_order: targetOrder }) }),
                fetch('/api/upstreams/' + target.id, { method: 'PATCH', headers, body: JSON.stringify({ sort_order: sourceOrder }) }),
              ]);
              if (sourceResp.status === 401 || targetResp.status === 401) {
                this.logout();
                return;
              }
              if (!sourceResp.ok || !targetResp.ok) throw new Error('HTTP ' + (!sourceResp.ok ? sourceResp.status : targetResp.status));
              await this.loadUpstreams();
            } catch (e) {
              alert('Reorder failed: ' + (e.message || String(e)));
              await this.loadUpstreams();
            }
          },

          async setUpstreamEnabled(upstream, enabled) {
            const previous = !!upstream.enabled;
            upstream.enabled = enabled;
            try {
              const resp = await fetch('/api/upstreams/' + upstream.id, {
                method: 'PATCH',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled }),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (!resp.ok) throw new Error('HTTP ' + resp.status);
              await this.loadUpstreams();
              this.reloadModels();
            } catch (e) {
              upstream.enabled = previous;
              alert('Update failed: ' + (e.message || String(e)));
            }
          },

          setUpstreamModalProvider(provider) {
            if (this.upstreamModal.id || this.upstreamModal.provider === provider) return;
            const modal = blankUpstreamModal(provider, this.upstreamModal.sortOrder ?? this.nextUpstreamSortOrder());
            modal.open = true;
            modal.name = provider === 'azure' ? 'Azure AI' : provider === 'copilot' ? 'GitHub Copilot' : 'Custom upstream';
            this.upstreamModal = modal;
            this.upstreamTestResult = null;
          },

          openNewUpstreamModal(provider = 'custom') {
            const modal = blankUpstreamModal(provider, this.nextUpstreamSortOrder());
            modal.open = true;
            modal.name = provider === 'azure' ? 'Azure AI' : provider === 'copilot' ? 'GitHub Copilot' : 'Custom upstream';
            this.upstreamModal = modal;
            this.upstreamTestResult = null;
          },

          openUpstreamModal(existing) {
            if (!existing) {
              this.openNewUpstreamModal('custom');
              return;
            }
            const config = this.upstreamConfig(existing);
            const overrides = (existing.flag_overrides && typeof existing.flag_overrides === 'object') ? { ...existing.flag_overrides } : {};
            const modal = blankUpstreamModal(existing.provider, existing.sort_order ?? this.nextUpstreamSortOrder());
            modal.open = true;
            modal.id = existing.id;
            modal.name = existing.name;
            modal.enabled = existing.enabled;
            modal.sortOrder = existing.sort_order;
            modal.flagOverrides = overrides;

            if (existing.provider === 'custom') {
              const overrides = { ...blankPathOverrides(), ...(config.pathOverrides ?? {}) };
              modal.baseUrl = config.baseUrl || '';
              modal.authStyle = config.authStyle === 'anthropic' ? 'anthropic' : 'bearer';
              modal.supportedEndpoints = Array.isArray(config.supportedEndpoints) ? [...config.supportedEndpoints] : ['/chat/completions'];
              modal.pathOverrides = overrides;
            } else if (existing.provider === 'azure') {
              modal.endpoint = config.endpoint || '';
              modal.deployments = Array.isArray(config.deployments) && config.deployments.length > 0
                ? config.deployments.map(deployment => normalizeAzureDeploymentForModal(deployment, false))
                : [blankAzureDeployment()];
            } else if (existing.provider === 'copilot') {
              modal.accountType = config.accountType || '';
              modal.copilotUser = config.user || null;
            }

            this.upstreamModal = modal;
            this.upstreamTestResult = null;
            if (existing.provider === 'copilot') this.loadCopilotQuotaForModal();
          },

          upstreamModalOverrideCount() {
            return Object.values(this.upstreamModal.pathOverrides ?? {}).filter(v => typeof v === 'string' && v.trim()).length;
          },

          closeUpstreamModal() {
            this.upstreamModal.open = false;
          },

          async loadCopilotQuotaForModal() {
            if (!this.upstreamModal.id || this.upstreamModal.provider !== 'copilot') return;
            this.upstreamModal.copilotQuota = { loading: true, error: null, data: null, percent: 0 };
            try {
              const resp = await fetch('/api/upstreams/' + this.upstreamModal.id + '/copilot/quota', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              const body = await resp.json().catch(() => ({}));
              if (!resp.ok) {
                this.upstreamModal.copilotQuota = { loading: false, error: body.error || 'HTTP ' + resp.status, data: null, percent: 0 };
                return;
              }
              const premium = body.quota_snapshots?.premium_interactions;
              const entitlement = Number(premium?.entitlement ?? 0);
              const remaining = Number(premium?.remaining ?? 0);
              const used = entitlement > 0 ? Math.max(0, entitlement - remaining) : 0;
              const percent = entitlement > 0 ? Math.min(100, Math.round((used / entitlement) * 100)) : 0;
              this.upstreamModal.copilotQuota = { loading: false, error: null, data: body, percent };
            } catch (e) {
              this.upstreamModal.copilotQuota = { loading: false, error: e.message || String(e), data: null, percent: 0 };
            }
          },

          toggleUpstreamEndpoint(ep) {
            const list = this.upstreamModal.supportedEndpoints;
            const idx = list.indexOf(ep);
            if (idx === -1) list.push(ep);
            else list.splice(idx, 1);
          },

          addAzureDeployment() {
            this.upstreamModal.deployments.push(blankAzureDeployment());
          },

          setAzureDeploymentsJsonMode(enabled) {
            this.upstreamModal.error = null;
            if (enabled) {
              this.upstreamModal.deploymentsJson = JSON.stringify(azureDeploymentPayloadsFromUi(this.upstreamModal.deployments), null, 2);
              this.upstreamModal.deploymentsJsonError = null;
              this.upstreamModal.deploymentsJsonMode = true;
              return;
            }

            try {
              const deployments = this.parseAzureDeploymentsJsonForPayload();
              this.upstreamModal.deployments = deployments.length > 0
                ? deployments.map(deployment => normalizeAzureDeploymentForModal(deployment, false))
                : [blankAzureDeployment()];
              this.upstreamModal.deploymentsJsonMode = false;
            } catch {
              // Keep the editor open and show the parse error next to the JSON field.
            }
          },

          parseAzureDeploymentsJsonForPayload() {
            try {
              const deployments = parseAzureDeploymentsJson(this.upstreamModal.deploymentsJson);
              this.upstreamModal.deploymentsJsonError = null;
              return deployments;
            } catch (e) {
              this.upstreamModal.deploymentsJsonError = e.message || String(e);
              throw e;
            }
          },

          azureDeploymentsJsonHighlighted() {
            const text = this.upstreamModal.deploymentsJson || '';
            try {
              if (globalThis.Prism?.languages?.json) return globalThis.Prism.highlight(text, globalThis.Prism.languages.json, 'json');
            } catch {}
            return escapeHtml(text);
          },

          syncAzureDeploymentsJsonScroll(event) {
            const target = event?.target;
            const highlight = this.$refs.azureDeploymentsJsonHighlight;
            if (!target || !highlight) return;
            highlight.scrollTop = target.scrollTop;
            highlight.scrollLeft = target.scrollLeft;
          },

          toggleAzureDeployment(index) {
            const deployment = this.upstreamModal.deployments[index];
            if (!deployment) return;
            deployment.open = !deployment.open;
          },

          azureDeploymentTitle(deployment) {
            return nonEmptyString(deployment.display_name)
              || nonEmptyString(deployment.publicModelId)
              || nonEmptyString(deployment.deployment)
              || 'Untitled model';
          },

          removeAzureDeployment(index) {
            if (this.upstreamModal.deployments.length <= 1) {
              this.upstreamModal.deployments.splice(0, 1, blankAzureDeployment());
              return;
            }
            this.upstreamModal.deployments.splice(index, 1);
          },

          upstreamFlagState(id) {
            const v = this.upstreamModal.flagOverrides[id];
            if (v === true) return 'on';
            if (v === false) return 'off';
            return 'inherit';
          },

          setUpstreamFlagState(id, state) {
            const next = { ...this.upstreamModal.flagOverrides };
            if (state === 'on') next[id] = true;
            else if (state === 'off') next[id] = false;
            else delete next[id];
            this.upstreamModal.flagOverrides = next;
          },

          // What the upstream-level "Inherit" radio resolves to: the provider's
          // default for this flag. 'on' if the provider kind is in the flag's
          // defaultFor list, otherwise 'off'.
          upstreamFlagInheritedFrom(flag) {
            const defaults = Array.isArray(flag.defaultFor) ? flag.defaultFor : [];
            return defaults.includes(this.upstreamModal.provider) ? 'on' : 'off';
          },

          // Resolved upstream-effective state for a flag id: applies the
          // upstream modal's overrides on top of provider defaults. Used by
          // the per-deployment override section to label its "Inherit" radio.
          upstreamFlagEffective(id) {
            const explicit = this.upstreamModal.flagOverrides[id];
            if (typeof explicit === 'boolean') return explicit ? 'on' : 'off';
            const flag = this.upstreamFlagCatalog.find(f => f.id === id);
            const defaults = flag && Array.isArray(flag.defaultFor) ? flag.defaultFor : [];
            return defaults.includes(this.upstreamModal.provider) ? 'on' : 'off';
          },

          // CSS class for a flag-state pill. Selected On glows accent-emerald;
          // selected Off glows accent-rose; selected Inherit uses accent-cyan
          // when the inherited resolved state is "on", neutral gray when "off".
          // Unselected pills stay dim regardless of which state they represent.
          flagPillClass(state, selected, inheritedTo) {
            if (!selected) return 'border-white/10 text-gray-500 hover:bg-white/5';
            if (state === 'on') return 'bg-accent-emerald/15 text-accent-emerald border-accent-emerald/40';
            if (state === 'off') return 'bg-accent-rose/15 text-accent-rose border-accent-rose/40';
            return inheritedTo === 'on'
              ? 'bg-accent-cyan/20 text-accent-cyan border-accent-cyan/40'
              : 'bg-white/10 text-gray-200 border-white/20';
          },

          deploymentFlagState(deployment, id) {
            const v = (deployment.flagOverridesValues ?? {})[id];
            if (v === true) return 'on';
            if (v === false) return 'off';
            return 'inherit';
          },

          setDeploymentFlagState(deployment, id, state) {
            const next = { ...(deployment.flagOverridesValues ?? {}) };
            if (state === 'on') next[id] = true;
            else if (state === 'off') next[id] = false;
            else delete next[id];
            deployment.flagOverridesValues = next;
          },

          toggleDeploymentFlagOverridesEnabled(deployment) {
            if (deployment.flagOverridesEnabled) {
              deployment.flagOverridesEnabled = false;
              deployment.flagOverridesValues = {};
            } else {
              deployment.flagOverridesEnabled = true;
            }
          },

          buildCustomUpstreamConfig() {
            const overrides = {};
            for (const [k, v] of Object.entries(this.upstreamModal.pathOverrides ?? {})) {
              if (typeof v === 'string' && v.trim()) overrides[k] = v.trim();
            }
            const config = {
              baseUrl: this.upstreamModal.baseUrl,
              authStyle: this.upstreamModal.authStyle === 'anthropic' ? 'anthropic' : 'bearer',
              supportedEndpoints: this.upstreamModal.supportedEndpoints,
            };
            if (Object.keys(overrides).length > 0) config.pathOverrides = overrides;
            else if (this.upstreamModal.id) config.pathOverrides = null;
            if (nonEmptyString(this.upstreamModal.bearerToken)) config.bearerToken = this.upstreamModal.bearerToken.trim();
            return config;
          },

          buildAzureUpstreamConfig() {
            const deployments = this.upstreamModal.deploymentsJsonMode
              ? this.parseAzureDeploymentsJsonForPayload()
              : azureDeploymentPayloadsFromUi(this.upstreamModal.deployments);
            const config = {
              deployments,
            };
            config.endpoint = typeof this.upstreamModal.endpoint === 'string' ? this.upstreamModal.endpoint.trim() : '';
            if (nonEmptyString(this.upstreamModal.apiKey)) config.apiKey = this.upstreamModal.apiKey.trim();
            return config;
          },

          buildUpstreamPayload() {
            const body = {
              provider: this.upstreamModal.provider,
              name: this.upstreamModal.name,
              enabled: this.upstreamModal.enabled,
              sort_order: this.upstreamModal.sortOrder,
              flag_overrides: { ...this.upstreamModal.flagOverrides },
            };
            if (this.upstreamModal.provider === 'custom') {
              body.config = this.buildCustomUpstreamConfig();
            } else if (this.upstreamModal.provider === 'azure') {
              body.config = this.buildAzureUpstreamConfig();
            }
            return body;
          },

          async saveUpstream() {
            this.upstreamModal.saving = true;
            this.upstreamModal.error = null;
            try {
              const isEdit = !!this.upstreamModal.id;
              const body = this.buildUpstreamPayload();
              const url = isEdit ? '/api/upstreams/' + this.upstreamModal.id : '/api/upstreams';
              const resp = await fetch(url, {
                method: isEdit ? 'PATCH' : 'POST',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                this.upstreamModal.error = err.error || 'HTTP ' + resp.status;
                return;
              }
              this.closeUpstreamModal();
              await this.loadUpstreams();
              this.reloadModels();
            } catch (e) {
              this.upstreamModal.error = e.message || String(e);
            } finally {
              this.upstreamModal.saving = false;
            }
          },

          async deleteUpstream(id, name) {
            if (!confirm('Delete upstream "' + name + '"?')) return;
            try {
              const resp = await fetch('/api/upstreams/' + id, {
                method: 'DELETE',
                headers: this.authHeaders(),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (!resp.ok) {
                alert('Delete failed: HTTP ' + resp.status);
                return;
              }
              await this.loadUpstreams();
              this.reloadModels();
            } catch (e) {
              console.error('deleteUpstream:', e);
            }
          },

          async testUpstream(id) {
            this.upstreamTestingId = id;
            this.upstreamTestResult = null;
            try {
              const resp = await fetch('/api/upstreams/' + id + '/test', {
                method: 'POST',
                headers: this.authHeaders(),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              this.upstreamTestResult = await resp.json();
              if (this.upstreamTestResult?.ok) this.reloadModels();
            } catch (e) {
              this.upstreamTestResult = { ok: false, error: e.message || String(e) };
            } finally {
              this.upstreamTestingId = null;
            }
          },

          upstreamTestTitle(result = this.upstreamTestResult) {
            if (!result) return '';
            const probes = Array.isArray(result.probes) ? result.probes : [];
            if (probes.length > 0) {
              const passed = probes.filter(probe => probe.ok).length;
              const models = Number(result.model_count ?? 0);
              return (result.ok ? 'OK' : 'Error') + ' · ' + passed + '/' + probes.length + ' probes' + (models > 0 ? ' · ' + models + ' models' : '');
            }
            return result.ok ? 'OK · ' + result.model_count + ' models' : 'Error · status ' + (result.status ?? 'n/a');
          },

          upstreamTestDetail(result = this.upstreamTestResult) {
            if (!result) return '';
            const probes = Array.isArray(result.probes) ? result.probes : [];
            if (probes.length > 0) {
              const failed = probes.filter(probe => !probe.ok);
              const source = failed.length > 0 ? failed : probes;
              return source
                .slice(0, 4)
                .map(probe => probe.deployment + ' ' + this.endpointLabel(probe.endpoint) + ' ' + (probe.status ?? probe.error ?? (probe.ok ? 'ok' : 'failed')))
                .join(', ');
            }
            return result.ok ? (result.models || []).slice(0, 8).join(', ') + ((result.models || []).length > 8 ? '…' : '') : (result.body ?? result.error ?? '');
          },

          formatDate(s) {
            return s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
          },

          async startGithubAuth() {
            this.deviceFlow.loading = true;
            try {
              const resp = await fetch('/api/upstreams/copilot/auth/start', { method: 'POST', headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              const d = await resp.json();
              if (d.user_code) {
                Object.assign(this.deviceFlow, {
                  userCode: d.user_code,
                  verificationUri: d.verification_uri,
                  deviceCode: d.device_code,
                });
                this.pollDeviceFlow(d.interval || 5);
              }
            } catch (e) {
              console.error('startGithubAuth:', e);
            } finally {
              this.deviceFlow.loading = false;
            }
          },

          pollDeviceFlow(interval) {
            this.deviceFlow.pollTimer = setInterval(async () => {
              try {
                const resp = await fetch('/api/upstreams/copilot/auth/poll', {
                  method: 'POST',
                  headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                  body: JSON.stringify({ device_code: this.deviceFlow.deviceCode }),
                });
                if (resp.status === 401) {
                  this.logout();
                  return;
                }
                const d = await resp.json();
                if (d.status === 'complete') {
                  this.cancelDeviceFlow();
                  await this.loadUpstreams();
                  await this.reloadModels();
                  if (d.upstream) this.openUpstreamModal(d.upstream);
                } else if (d.status === 'slow_down') {
                  clearInterval(this.deviceFlow.pollTimer);
                  this.pollDeviceFlow((d.interval || interval) + 1);
                } else if (d.status === 'error') {
                  this.cancelDeviceFlow();
                  alert('Authorization failed: ' + d.error);
                }
              } catch (e) {
                console.error('poll:', e);
              }
            }, interval * 1000);
          },

          cancelDeviceFlow() {
            clearInterval(this.deviceFlow.pollTimer);
            Object.assign(this.deviceFlow, {
              pollTimer: null,
              userCode: null,
              verificationUri: null,
              deviceCode: null,
            });
          },

          async loadKeys() {
            this.keysLoading = true;
            try {
              const resp = await fetch('/api/keys', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                this.keys = await resp.json();
                if (this.selectedKeyId && !this.keys.some(k => k.id === this.selectedKeyId)) {
                  this.selectedKeyId = null;
                }
              }
            } catch (e) {
              console.error('loadKeys:', e);
            } finally {
              this.keysLoading = false;
            }
          },

          async createNewKey() {
            const name = this.newKeyName.trim();
            if (!name) return;
            this.keyCreating = true;
            try {
              const resp = await fetch('/api/keys', {
                method: 'POST',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                const created = await resp.json();
                this.selectedKeyId = created.id;
                this.newKeyName = '';
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || 'Failed to create key');
              }
            } catch (e) {
              console.error('createKey:', e);
            } finally {
              this.keyCreating = false;
            }
          },

          async deleteKeyById(id, name) {
            if (!confirm('Delete key "' + name + '"? This cannot be undone.')) return;
            this.keyDeleting = id;
            try {
              const resp = await fetch('/api/keys/' + id, { method: 'DELETE', headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || 'Failed to delete key');
              }
            } catch (e) {
              console.error('deleteKey:', e);
            } finally {
              this.keyDeleting = null;
            }
          },

          async rotateKeyById(id, name) {
            if (!confirm('Rotate key "' + name + '"? The old key will stop working immediately.')) return;
            this.keyRotating = id;
            try {
              const resp = await fetch('/api/keys/' + id + '/rotate', { method: 'POST', headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                this.selectedKeyId = id;
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || 'Failed to rotate key');
              }
            } catch (e) {
              console.error('rotateKey:', e);
            } finally {
              this.keyRotating = null;
            }
          },

          // ---- Per-key upstream override editor ----

          keyUpstreamsText(key) {
            const ids = key.upstream_ids;
            if (!ids) return 'All';
            const upstreams = this.upstreams || [];
            if (upstreams.length === 0) return ids.length + ' upstream' + (ids.length === 1 ? '' : 's');
            const validNames = ids
              .map(id => upstreams.find(u => u.id === id))
              .filter(Boolean)
              .map(u => u.name);
            if (validNames.length === 1) return validNames[0];
            return validNames.length + ' upstreams';
          },

          keyUpstreamsTextClass(key) {
            return key.upstream_ids ? 'text-accent-cyan' : 'text-gray-500';
          },

          keyUpstreamsTitle(key) {
            const ids = key.upstream_ids;
            if (!ids) return 'Default — inherits global upstream order';
            const upstreams = this.upstreams || [];
            const names = ids.map(id => upstreams.find(u => u.id === id)?.name).filter(Boolean);
            return names.length > 0 ? 'Custom whitelist (in order): ' + names.join(' → ') : 'Custom whitelist';
          },

          async openEditKey(key) {
            this.editKeyModal.open = true;
            this.editKeyModal.keyId = key.id;
            this.editKeyModal.name = key.name;
            this.editKeyModal.override = Array.isArray(key.upstream_ids);
            this.editKeyModal.saving = false;
            this.editKeyModal.error = null;

            if (!this.upstreamsLoaded) await this.loadUpstreams();
            if (!this.upstreamsLoaded) {
              this.editKeyModal.error = 'Failed to load upstream list — check network and reopen.';
              this.editKeyModal.allUpstreams = [];
              this.editKeyModal.customOrder = [];
              this.editKeyModal.override = false;
              return;
            }
            this.editKeyModal.allUpstreams = [...this.upstreams];
            this.editKeyModal.customOrder = this._buildEditKeyOrder(key.upstream_ids);

            await this.$nextTick();
            this._rebindEditKeySortable();
          },

          closeEditKey() {
            this.editKeyModal.open = false;
            this.editKeyModal.keyId = null;
            this.editKeyModal.error = null;
            if (this.editKeyModal._sortable) {
              this.editKeyModal._sortable.destroy();
              this.editKeyModal._sortable = null;
            }
          },

          _buildEditKeyOrder(savedIds) {
            const upstreams = this.editKeyModal.allUpstreams;
            const picked = Array.isArray(savedIds) ? savedIds.filter(id => upstreams.some(u => u.id === id)) : [];
            const pickedSet = new Set(picked);
            return [
              ...picked.map(id => ({ ...upstreams.find(u => u.id === id), included: true })),
              ...upstreams.filter(u => !pickedSet.has(u.id)).map(u => ({ ...u, included: false })),
            ];
          },

          async toggleEditKeyOverride() {
            this.editKeyModal.override = !this.editKeyModal.override;
            if (this.editKeyModal.override) {
              await this.$nextTick();
              this._rebindEditKeySortable();
            } else if (this.editKeyModal._sortable) {
              this.editKeyModal._sortable.destroy();
              this.editKeyModal._sortable = null;
            }
          },

          toggleEditKeyRow(id) {
            const row = this.editKeyModal.customOrder.find(r => r.id === id);
            if (row) row.included = !row.included;
          },

          editKeySelectAll() {
            this.editKeyModal.customOrder.forEach(r => (r.included = true));
          },

          editKeySelectNone() {
            this.editKeyModal.customOrder.forEach(r => (r.included = false));
          },

          editKeyOrderPosition(id) {
            let pos = 0;
            for (const r of this.editKeyModal.customOrder) {
              if (r.included) pos++;
              if (r.id === id) return pos;
            }
            return 0;
          },

          editKeyIncludedCount() {
            return this.editKeyModal.customOrder.filter(r => r.included).length;
          },

          canSaveEditKey() {
            if (!this.editKeyModal.name.trim()) return false;
            if (this.editKeyModal.override) return this.editKeyIncludedCount() >= 1;
            return true;
          },

          _rebindEditKeySortable() {
            // Safe to early-return on existing instance: closeEditKey and
            // toggleEditKeyOverride both null out _sortable when the <ul> goes away.
            const el = this.$refs.editKeyList;
            if (!el) return;
            if (this.editKeyModal._sortable) return;
            this.editKeyModal._sortable = Sortable.create(el, {
              handle: '.drag-handle',
              animation: 150,
              ghostClass: 'sortable-ghost',
              chosenClass: 'sortable-chosen',
              dragClass: 'sortable-drag',
              onEnd: () => {
                const ids = [...el.querySelectorAll('[data-id]')].map(li => li.dataset.id);
                this.editKeyModal.customOrder = ids
                  .map(id => this.editKeyModal.customOrder.find(r => r.id === id))
                  .filter(Boolean);
              },
            });
          },

          async saveEditKey() {
            if (!this.canSaveEditKey()) return;
            const id = this.editKeyModal.keyId;
            if (!id) return;
            this.editKeyModal.saving = true;
            this.editKeyModal.error = null;
            try {
              const body = {
                name: this.editKeyModal.name.trim(),
                upstream_ids: this.editKeyModal.override
                  ? this.editKeyModal.customOrder.filter(r => r.included).map(r => r.id)
                  : null,
              };
              const resp = await fetch('/api/keys/' + id, {
                method: 'PATCH',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (!resp.ok) {
                this.editKeyModal.error = (await resp.json()).error || 'Failed to save key';
                return;
              }
              await this.loadKeys();
              this.closeEditKey();
            } catch (e) {
              console.error('saveEditKey:', e);
              this.editKeyModal.error = e instanceof Error ? e.message : String(e);
            } finally {
              this.editKeyModal.saving = false;
            }
          },

          async copySnippet(text, tag) {
            await copyText(text);
            this.copied = tag;
            setTimeout(() => {
              this.copied = false;
            }, 2000);
          },

          localHourKey(d) {
            return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours());
          },

          localDateKey(d) {
            return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
          },

          local8hBucketStart(d) {
            const aligned = new Date(d);
            aligned.setMinutes(0, 0, 0);
            aligned.setHours(aligned.getHours() - (aligned.getHours() % 8));
            return aligned;
          },

          local8hBucketKey(d) {
            return this.localHourKey(this.local8hBucketStart(d));
          },

          local4hBucketStart(d) {
            const aligned = new Date(d);
            aligned.setMinutes(0, 0, 0);
            aligned.setHours(aligned.getHours() - (aligned.getHours() % 4));
            return aligned;
          },

          local4hBucketKey(d) {
            return this.localHourKey(this.local4hBucketStart(d));
          },

          build8hBucketMap(count) {
            const map = new Map();
            const start = this.local8hBucketStart(new Date());
            let prevDateKey = null;
            for (let i = count - 1; i >= 0; i--) {
              const d = new Date(start.getTime() - i * 8 * 3600000);
              const key = this.localHourKey(d);
              const dateKey = this.localDateKey(d);
              const startH = d.getHours();
              const endH = (startH + 8) % 24;
              const time = pad2(startH) + ':00 \\u2013 ' + pad2(endH) + ':00';
              const datePrefix = dateKey !== prevDateKey ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' : '';
              map.set(key, datePrefix + time);
              prevDateKey = dateKey;
            }
            return map;
          },

          build4hBucketMap(count) {
            const map = new Map();
            const start = this.local4hBucketStart(new Date());
            let prevDateKey = null;
            for (let i = count - 1; i >= 0; i--) {
              const d = new Date(start.getTime() - i * 4 * 3600000);
              const key = this.localHourKey(d);
              const h = d.getHours();
              const dateKey = this.localDateKey(d);
              const endH = (h + 4) % 24;
              const time = pad2(h) + ':00 \\u2013 ' + pad2(endH) + ':00';
              const datePrefix = dateKey !== prevDateKey ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' : '';
              map.set(key, datePrefix + time);
              prevDateKey = dateKey;
            }
            return map;
          },

          usageRangeParams() {
            const now = new Date();
            const rangeStart = new Date(now);
            if (this.tokenRange === 'today') {
              rangeStart.setTime(now.getTime() - 23 * 3600000);
              rangeStart.setMinutes(0, 0, 0);
            } else if (this.tokenRange === '7d') {
              rangeStart.setTime(this.local4hBucketStart(now).getTime() - 41 * 4 * 3600000);
            } else {
              rangeStart.setDate(rangeStart.getDate() - 29);
              rangeStart.setHours(0, 0, 0, 0);
            }
            return {
              start: rangeStart.toISOString().slice(0, 13),
              end: new Date(now.getTime() + 3600000).toISOString().slice(0, 13),
            };
          },

          async fetchTokenData(range = this.usageRangeParams()) {
            try {
              const resp = await fetch('/api/token-usage?start=' + encodeURIComponent(range.start) + '&end=' + encodeURIComponent(range.end) + '&include_key_metadata=1', {
                headers: this.authHeaders(),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                const body = await resp.json();
                if (Array.isArray(body)) {
                  this.tokenData = body;
                  this.tokenKeyMetadata = [];
                  this.tokenKeyColorOrder = [];
                } else {
                  this.tokenData = Array.isArray(body.records) ? body.records : [];
                  this.tokenKeyMetadata = Array.isArray(body.keys) ? body.keys : [];
                  this.tokenKeyColorOrder = Array.isArray(body.keyColorOrder) ? body.keyColorOrder : [];
                }
              }
            } catch (e) {
              console.error('fetchTokenData:', e);
            }
          },

          async fetchSearchUsageData(range = this.usageRangeParams()) {
            try {
              const resp = await fetch('/api/search-usage?start=' + encodeURIComponent(range.start) + '&end=' + encodeURIComponent(range.end) + '&include_key_metadata=1', {
                headers: this.authHeaders(),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                const body = await resp.json();
                this.searchUsageData = Array.isArray(body.records) ? body.records : [];
                this.searchUsageKeyMetadata = Array.isArray(body.keys) ? body.keys : [];
                this.searchUsageKeyColorOrder = Array.isArray(body.keyColorOrder) ? body.keyColorOrder : [];
                this.searchUsageActiveProvider = body.activeProvider || 'disabled';
              }
            } catch (e) {
              console.error('fetchSearchUsageData:', e);
            }
          },

          async fetchUsageTabData() {
            const range = this.usageRangeParams();
            await Promise.all([this.fetchTokenData(range), this.fetchSearchUsageData(range)]);
          },

          async loadUsageTabData(modelsReady = this.ensureModelsLoaded()) {
            const expectedRange = this.tokenRange;
            this.tokenLoading = true;
            this.searchUsageLoading = true;
            try {
              await Promise.all([modelsReady, this.fetchUsageTabData()]);
              if (this.tab !== 'usage' || this.tokenRange !== expectedRange) return;
              await this.$nextTick();
              this.renderTokenCharts();
            } finally {
              this.tokenLoading = false;
              this.searchUsageLoading = false;
            }
          },

          performanceRangeParams() {
            const now = new Date();
            const rangeStart = new Date(now);
            if (this.performanceRange === 'today') {
              rangeStart.setTime(now.getTime() - 23 * 3600000);
              rangeStart.setMinutes(0, 0, 0);
            } else if (this.performanceRange === '7d') {
              rangeStart.setTime(this.local4hBucketStart(now).getTime() - 41 * 4 * 3600000);
            } else {
              rangeStart.setDate(rangeStart.getDate() - 29);
              rangeStart.setHours(0, 0, 0, 0);
            }
            return {
              start: rangeStart.toISOString().slice(0, 13),
              end: new Date(now.getTime() + 3600000).toISOString().slice(0, 13),
            };
          },

          performanceBucketGranularity() {
            if (this.performanceRange === 'today') return 'hour';
            if (this.performanceRange === '7d') return '4h';
            return 'day';
          },

          buildPerformanceBucketMap() {
            const bucketMap = new Map();
            const now = new Date();
            if (this.performanceRange === 'today') {
              const cur = new Date(now);
              cur.setMinutes(0, 0, 0);
              for (let i = 23; i >= 0; i--) {
                const d = new Date(cur.getTime() - i * 3600000);
                const h = d.getHours();
                bucketMap.set(this.localHourKey(d), pad2(h) + ':00 \\u2013 ' + pad2((h + 1) % 24) + ':00');
              }
            } else if (this.performanceRange === '7d') {
              return this.build4hBucketMap(42);
            } else {
              const days = 30;
              for (let i = days - 1; i >= 0; i--) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                d.setHours(0, 0, 0, 0);
                bucketMap.set(this.localDateKey(d), d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
              }
            }
            return bucketMap;
          },

          async fetchPerformanceOverview() {
            const range = this.performanceRangeParams();
            const params = new URLSearchParams({
              start: range.start,
              end: range.end,
              bucket: this.performanceBucketGranularity(),
              metric_scope: this.performanceMetricScope,
              timezone_offset_minutes: String(new Date().getTimezoneOffset()),
            });
            const resp = await fetch('/api/performance/overview?' + params.toString(), { headers: this.authHeaders() });
            if (resp.status === 401) {
              this.logout();
              return null;
            }
            if (!resp.ok) return null;
            const body = await resp.json();
            return body && typeof body === 'object' ? body : null;
          },

          async loadPerformanceTabData() {
            const expectedRange = this.performanceRange;
            const expectedScope = this.performanceMetricScope;
            this.performanceLoading = true;
            try {
              const overview = await this.fetchPerformanceOverview();
              if (this.tab !== 'performance' || this.performanceRange !== expectedRange || this.performanceMetricScope !== expectedScope) return;
              this.performanceSeries = Array.isArray(overview?.series) ? overview.series : [];
              this.performanceSummaryRows = Array.isArray(overview?.summaryRows) ? overview.summaryRows : [];
              this.performanceModelRows = Array.isArray(overview?.modelRows) ? overview.modelRows : [];
              const runtimeRows = Array.isArray(overview?.runtimeRows) ? overview.runtimeRows : [];
              this.performanceRuntimeRows = runtimeRows.filter(row => row.group !== 'unknown' || runtimeRows.length > 1);
              this.ensurePerformanceModelSelected();
              this.updatePerformanceSummary();
              await this.$nextTick();
              this.renderPerformanceChart();
            } catch (e) {
              console.error('loadPerformanceTabData:', e);
            } finally {
              this.performanceLoading = false;
            }
          },

          updatePerformanceSummary() {
            const row = this.performanceSummaryRows[0];
            this.performanceSummary = row
              ? { requests: row.requests, errors: row.errors, avgMs: row.avgMs, p50Ms: row.p50Ms, p95Ms: row.p95Ms, p99Ms: row.p99Ms }
              : { requests: 0, errors: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null };
          },

          renderPerformanceChart() {
            const canvas = document.getElementById('performanceChartByModel');
            if (!canvas || canvas.clientWidth === 0) return;
            if (_charts.performanceModel) {
              _charts.performanceModel.stop();
              _charts.performanceModel.destroy();
              _charts.performanceModel = null;
            }

            const sourceRows = this.performanceChartView === 'percentile' ? this.performanceSeries.filter(row => row.group === this.performanceModel) : this.performanceSeries;
            const bucketMap = this.buildPerformanceBucketMap();
            const bucketKeysArr = [...bucketMap.keys()];
            const labels = [...bucketMap.values()];
            const percentileMetrics = ['p50Ms', 'p95Ms', 'p99Ms'];
            const datasets =
              this.performanceChartView === 'percentile'
                ? percentileMetrics.map((metric, index) => {
                    const color = usageChartColor(index);
                    const valueByBucket = new Map(sourceRows.map(row => [row.bucket, row[metric]]));
                    return {
                      label: this.performancePercentileLabel(metric),
                      data: bucketKeysArr.map(bucket => valueByBucket.get(bucket) ?? null),
                      borderColor: color,
                      backgroundColor: color + '25',
                      borderWidth: 2,
                      pointRadius: 2,
                      pointHoverRadius: 5,
                      tension: 0.25,
                      fill: false,
                      spanGaps: true,
                    };
                  })
                : [...new Set(this.performanceSeries.map(row => row.group))].sort().map((group, index) => {
                    const color = usageChartColor(index);
                    const valueByKey = new Map(this.performanceSeries.map(row => [row.bucket + '\\0' + row.group, row[this.performancePercentile]]));
                    return {
                      label: group,
                      data: bucketKeysArr.map(bucket => valueByKey.get(bucket + '\\0' + group) ?? null),
                      borderColor: color,
                      backgroundColor: color + '25',
                      borderWidth: 2,
                      pointRadius: 2,
                      pointHoverRadius: 5,
                      tension: 0.25,
                      fill: false,
                      spanGaps: true,
                    };
                  });

            const self = this;
            _charts.performanceModel = new Chart(canvas, {
              type: 'line',
              data: { labels, datasets },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                  legend: {
                    position: 'bottom',
                    labels: { color: '#9e9e9e', font: { size: 11, family: "'DM Sans', sans-serif" }, boxWidth: 12, padding: 16, usePointStyle: true, pointStyle: 'circle' },
                  },
                  tooltip: {
                    backgroundColor: 'rgba(12,16,21,0.95)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    titleColor: '#e0e0e0',
                    bodyColor: '#b0bec5',
                    padding: 12,
                    filter: item => item.parsed.y !== null,
                    callbacks: { label: ctx => ctx.dataset.label + ': ' + formatDurationMs(ctx.parsed.y) },
                  },
                },
                scales: {
                  x: {
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: {
                      color: '#9e9e9e',
                      font: { size: 10, family: "'DM Sans', sans-serif" },
                      maxRotation: 45,
                      callback: chartXAxisTickCallback(bucketKeysArr, labels, self.performanceRange === '7d'),
                    },
                    border: { color: 'rgba(255,255,255,0.06)' },
                  },
                  y: {
                    type: 'logarithmic',
                    beginAtZero: false,
                    title: {
                      display: true,
                      text: self.performanceChartView === 'percentile' ? self.performanceModel + ' latency' : self.performancePercentileLabel() + ' latency',
                      color: '#9e9e9e',
                      font: { size: 10, family: "'DM Sans', sans-serif" },
                    },
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { color: '#9e9e9e', font: { size: 10, family: "'JetBrains Mono', monospace" }, callback: v => formatDurationMs(Number(v)) },
                    border: { color: 'rgba(255,255,255,0.06)' },
                  },
                },
              },
            });
            this.chartsReady = true;
          },

          ensurePerformanceModelSelected() {
            const models = this.performanceModelOptions();
            if (models.length === 0) {
              this.performanceModel = '';
              return;
            }
            if (!models.includes(this.performanceModel)) {
              this.performanceModel = models[0];
            }
          },

          async loadTokenUsage() {
            await this.loadUsageTabData();
          },

          buildBucketMap() {
            const bucketMap = new Map();
            const now = new Date();
            if (this.tokenRange === 'today') {
              const cur = new Date(now);
              cur.setMinutes(0, 0, 0);
              for (let i = 23; i >= 0; i--) {
                const d = new Date(cur.getTime() - i * 3600000);
                const h = d.getHours();
                bucketMap.set(this.localHourKey(d), pad2(h) + ':00 \\u2013 ' + pad2((h + 1) % 24) + ':00');
              }
            } else if (this.tokenRange === '7d') {
              return this.build4hBucketMap(42);
            } else {
              const days = 30;
              for (let i = days - 1; i >= 0; i--) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                d.setHours(0, 0, 0, 0);
                bucketMap.set(this.localDateKey(d), d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
              }
            }
            return bucketMap;
          },

          tokenBucketKeyFor(d) {
            if (this.tokenRange === 'today') return this.localHourKey(d);
            if (this.tokenRange === '7d') return this.local4hBucketKey(d);
            return this.localDateKey(d);
          },

          aggregateBuckets(records, dimension, metric = this.tokenChartMetric) {
            const bucketMap = this.buildBucketMap();
            const agg = new Map();
            const detail = new Map();
            for (const [key] of bucketMap) {
              agg.set(key, new Map());
              detail.set(key, new Map());
            }
            for (const r of records) {
              const utc = new Date(r.hour + ':00:00Z');
              const bucket = this.tokenBucketKeyFor(utc);
              if (!agg.has(bucket)) continue;
              const m = agg.get(bucket);
              const val = dimension === 'model' ? r.model : r[dimension];
              if (!isTokenChartPercentMetric(metric)) {
                m.set(val, (m.get(val) || 0) + tokenChartMetricRecordValue(r, metric));
              }
              const dm = detail.get(bucket);
              const prev = dm.get(val) || { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 };
              prev.requests += r.requests;
              prev.input += r.inputTokens;
              prev.output += r.outputTokens;
              prev.cacheRead += r.cacheReadTokens ?? 0;
              prev.cacheCreation += r.cacheCreationTokens ?? 0;
              prev.cost += r.cost ?? 0;
              dm.set(val, prev);
            }
            if (isTokenChartPercentMetric(metric)) {
              for (const [bucket, values] of detail) {
                const m = agg.get(bucket);
                for (const [val, item] of values) {
                  m.set(val, tokenChartMetricDetailValue(item, metric));
                }
              }
            }
            return { bucketMap, agg, detail };
          },

          aggregateSearchUsageBuckets(records) {
            const bucketMap = this.buildBucketMap();
            const agg = new Map();
            const detail = new Map();
            for (const [key] of bucketMap) {
              agg.set(key, new Map());
              detail.set(key, new Map());
            }
            for (const r of records) {
              const utc = new Date(r.hour + ':00:00Z');
              const bucket = this.tokenBucketKeyFor(utc);
              if (!agg.has(bucket)) continue;
              const m = agg.get(bucket);
              m.set(r.keyId, (m.get(r.keyId) || 0) + r.requests);
              const dm = detail.get(bucket);
              dm.set(r.keyId, (dm.get(r.keyId) || 0) + r.requests);
            }
            return { bucketMap, agg, detail };
          },

          hasTokenChartMetricData(detail, dimensionValue) {
            if (!isTokenChartPercentMetric(this.tokenChartMetric)) return null;
            for (const values of detail.values()) {
              const item = values.get(dimensionValue);
              if (item && tokenChartMetricDetailValue(item, this.tokenChartMetric) !== null) return true;
            }
            return false;
          },

          tokenChartBucketValue(agg, bucket, dimensionValue) {
            const value = agg.get(bucket)?.get(dimensionValue);
            if (value !== undefined) return value;
            return isTokenChartPercentMetric(this.tokenChartMetric) ? null : 0;
          },

          applyTokenChartMetricOptions(chart) {
            const metric = this.tokenChartMetric;
            const isPercentMetric = isTokenChartPercentMetric(metric);
            chart.options.scales.y.stacked = !isPercentMetric;
            chart.options.scales.y.title.text = tokenChartMetricLabel(metric);
            chart.options.scales.y.suggestedMax = isPercentMetric ? 100 : undefined;
            chart.options.scales.y.ticks.callback = v => formatTokenChartAxisValue(Number(v), metric);
            for (const ds of chart.data.datasets) {
              ds.fill = isPercentMetric ? false : 'stack';
              ds.spanGaps = isPercentMetric;
            }
          },

          updateSummary() {
            const filtered = this.tokenData.filter(r => !this.hiddenKeys.has(r.keyId) && !this.hiddenModels.has(r.model));
            let totalReqs = 0,
              totalIn = 0,
              totalOut = 0,
              totalCR = 0,
              totalCC = 0,
              totalCost = 0;
            for (const r of filtered) {
              totalReqs += r.requests;
              totalIn += r.inputTokens;
              totalOut += r.outputTokens;
              totalCR += r.cacheReadTokens ?? 0;
              totalCC += r.cacheCreationTokens ?? 0;
              totalCost += r.cost ?? 0;
            }
            this.tokenSummary = {
              requests: totalReqs,
              cost: totalCost,
              total: totalIn + totalOut,
              input: totalIn,
              output: totalOut,
              cacheRead: totalCR,
              cacheCreation: totalCC,
              prefill: prefillInputTokens(totalIn, totalCR),
            };
          },

          refreshChartsData() {
            const bucketMap = this.buildBucketMap();
            const bucketKeysArr = [...bucketMap.keys()];

            if (_charts.key) {
              const filtered = this.tokenData.filter(r => !this.hiddenModels.has(r.model));
              const { agg, detail } = this.aggregateBuckets(filtered, 'keyId');
              _detailMaps.key = detail;
              this.applyTokenChartMetricOptions(_charts.key);
              for (let i = 0; i < _charts.key.data.datasets.length; i++) {
                const ds = _charts.key.data.datasets[i];
                ds.data = bucketKeysArr.map(k => this.tokenChartBucketValue(agg, k, ds._keyId));
                const userHidden = this.hiddenKeys.has(ds._keyId);
                const hasData = this.hasTokenChartMetricData(detail, ds._keyId) ?? ds.data.some(v => v !== 0);
                _charts.key.setDatasetVisibility(i, !userHidden && hasData);
              }
              _charts.key.update('none');
            }

            if (_charts.model) {
              const filtered = this.tokenData.filter(r => !this.hiddenKeys.has(r.keyId));
              const { agg, detail } = this.aggregateBuckets(filtered, 'model');
              _detailMaps.model = detail;
              this.applyTokenChartMetricOptions(_charts.model);
              for (let i = 0; i < _charts.model.data.datasets.length; i++) {
                const ds = _charts.model.data.datasets[i];
                ds.data = bucketKeysArr.map(k => this.tokenChartBucketValue(agg, k, ds._model));
                const userHidden = this.hiddenModels.has(ds._model);
                const hasData = this.hasTokenChartMetricData(detail, ds._model) ?? ds.data.some(v => v !== 0);
                _charts.model.setDatasetVisibility(i, !userHidden && hasData);
              }
              _charts.model.update('none');
            }

            if (_charts.searchKey) {
              const filtered = this.searchUsageData.filter(r => r.provider === this.searchUsageActiveProvider);
              const { agg, detail } = this.aggregateSearchUsageBuckets(filtered);
              _detailMaps.searchKey = detail;
              for (let i = 0; i < _charts.searchKey.data.datasets.length; i++) {
                const ds = _charts.searchKey.data.datasets[i];
                ds.data = bucketKeysArr.map(k => agg.get(k)?.get(ds._keyId) ?? 0);
                const userHidden = this.hiddenKeys.has(ds._keyId);
                const hasData = ds.data.some(v => v !== 0);
                _charts.searchKey.setDatasetVisibility(i, !userHidden && hasData);
              }
              _charts.searchKey.update('none');
            }

            this.updateSummary();
          },

          renderTokenCharts() {
            const canvasKey = document.getElementById('tokenChartByKey');
            const canvasModel = document.getElementById('tokenChartByModel');
            const canvasSearchKey = document.getElementById('searchUsageChartByKey');
            if (!canvasKey || !canvasModel || canvasKey.clientWidth === 0) return;

            const data = this.tokenData;
            const self = this;

            const keyNameMap = _keyNameMap;
            keyNameMap.clear();
            const keyMetaMap = new Map();
            const allKeyIds = new Set();
            const allKeyIdsForOrder = new Set();
            const allSearchKeyIds = new Set();
            const allSearchKeyIdsForOrder = new Set();
            const allModels = new Set();
            for (const k of this.tokenKeyMetadata) {
              keyNameMap.set(k.id, k.name);
              keyMetaMap.set(k.id, { name: k.name, createdAt: k.createdAt });
              allKeyIdsForOrder.add(k.id);
            }
            for (const k of this.searchUsageKeyMetadata) {
              keyNameMap.set(k.id, k.name);
              keyMetaMap.set(k.id, { name: k.name, createdAt: k.createdAt });
              allSearchKeyIdsForOrder.add(k.id);
            }
            for (const r of data) {
              keyNameMap.set(r.keyId, r.keyName);
              keyMetaMap.set(r.keyId, { name: r.keyName, createdAt: r.keyCreatedAt ?? keyMetaMap.get(r.keyId)?.createdAt });
              allKeyIds.add(r.keyId);
              allKeyIdsForOrder.add(r.keyId);
              allModels.add(r.model);
            }
            const activeSearchUsageData = this.searchUsageData.filter(r => r.provider === this.searchUsageActiveProvider);
            for (const r of activeSearchUsageData) {
              keyNameMap.set(r.keyId, r.keyName);
              keyMetaMap.set(r.keyId, { name: r.keyName, createdAt: r.keyCreatedAt ?? keyMetaMap.get(r.keyId)?.createdAt });
              allSearchKeyIds.add(r.keyId);
              allSearchKeyIdsForOrder.add(r.keyId);
            }

            const bucketMap = this.buildBucketMap();
            const labels = [...bucketMap.values()];
            const bucketKeysArr = [...bucketMap.keys()];

            const { agg: keyAgg, detail: keyDetail } = this.aggregateBuckets(data, 'keyId');
            const { agg: modelAgg, detail: modelDetail } = this.aggregateBuckets(data, 'model');
            const { agg: searchKeyAgg, detail: searchKeyDetail } = this.aggregateSearchUsageBuckets(activeSearchUsageData);
            _detailMaps.key = keyDetail;
            _detailMaps.model = modelDetail;
            _detailMaps.searchKey = searchKeyDetail;

            const keyList = usageKeyChartEntries([...allKeyIds], keyMetaMap, [...allKeyIdsForOrder], this.tokenKeyColorOrder);
            const modelList = tokenModelChartEntries(
              [...allModels],
              this.allModels.map(m => m.id),
            );
            const searchKeyList = usageKeyChartEntries([...allSearchKeyIds], keyMetaMap, [...allSearchKeyIdsForOrder], this.searchUsageKeyColorOrder);

            const keyDatasets = keyList.map(({ keyId, colorSlot }) => {
              const c = usageChartColor(colorSlot);
              return {
                label: self.redactKeys ? keyId.slice(0, 8) : keyNameMap.get(keyId) || keyId.slice(0, 8),
                data: bucketKeysArr.map(k => self.tokenChartBucketValue(keyAgg, k, keyId)),
                borderColor: c,
                backgroundColor: c + '40',
                borderWidth: 2,
                pointRadius: 2,
                pointHoverRadius: 5,
                tension: 0.3,
                fill: 'stack',
                spanGaps: isTokenChartPercentMetric(self.tokenChartMetric),
                _keyId: keyId,
              };
            });

            const modelDatasets = modelList.map(({ model, colorSlot }) => {
              const c = usageChartColor(colorSlot);
              return {
                label: model,
                data: bucketKeysArr.map(k => self.tokenChartBucketValue(modelAgg, k, model)),
                borderColor: c,
                backgroundColor: c + '40',
                borderWidth: 2,
                pointRadius: 2,
                pointHoverRadius: 5,
                tension: 0.3,
                fill: 'stack',
                spanGaps: isTokenChartPercentMetric(self.tokenChartMetric),
                _model: model,
              };
            });

            const searchKeyDatasets = searchKeyList.map(({ keyId, colorSlot }) => {
              const c = usageChartColor(colorSlot);
              return {
                label: self.redactKeys ? keyId.slice(0, 8) : keyNameMap.get(keyId) || keyId.slice(0, 8),
                data: bucketKeysArr.map(k => searchKeyAgg.get(k)?.get(keyId) ?? 0),
                borderColor: c,
                backgroundColor: c + '40',
                borderWidth: 2,
                pointRadius: 2,
                pointHoverRadius: 5,
                tension: 0.3,
                fill: 'stack',
                spanGaps: false,
                _keyId: keyId,
              };
            });

            this.updateSummary();

            const makeOptions = (onClick, chartType) => {
              const isSearchChart = chartType === 'searchKey';
              return {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                  legend: {
                    position: 'bottom',
                    labels: {
                      color: '#9e9e9e',
                      font: { size: 11, family: "'DM Sans', sans-serif" },
                      boxWidth: 12,
                      padding: 16,
                      usePointStyle: true,
                      pointStyle: 'circle',
                    },
                    onClick,
                  },
                  tooltip: {
                    backgroundColor: 'rgba(12,16,21,0.95)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    titleColor: '#e0e0e0',
                    bodyColor: '#b0bec5',
                    padding: 12,
                    beforeBodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
                    bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
                    filter: item => item.parsed.y !== null && (isSearchChart ? item.parsed.y > 0 : isTokenChartPercentMetric(self.tokenChartMetric) || item.parsed.y > 0),
                    itemSort: (a, b) => b.parsed.y - a.parsed.y,
                    callbacks: {
                      beforeBody: items => {
                        if (isSearchChart) return [];
                        if (!items.length) return [];
                        return formatTooltipHeader(tooltipLabelWidth(items[0].chart));
                      },
                      label: ctx => {
                        const bucket = bucketKeysArr[ctx.dataIndex];
                        const dimKey = chartType === 'model' ? ctx.dataset._model : ctx.dataset._keyId;
                        const detailMap = _detailMaps[chartType];
                        const detail = detailMap?.get(bucket)?.get(dimKey);
                        if (isSearchChart) return ctx.dataset.label + ': ' + Math.round(detail ?? ctx.parsed.y).toLocaleString();
                        if (!detail) return ctx.dataset.label + ': ' + formatTokenChartAxisValue(ctx.parsed.y, self.tokenChartMetric);
                        return formatTooltipRow(String(ctx.dataset.label || ''), tooltipLabelWidth(ctx.chart), detail);
                      },
                    },
                  },
                },
                scales: {
                  x: {
                    stacked: true,
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: {
                      color: '#9e9e9e',
                      font: { size: 10, family: "'DM Sans', sans-serif" },
                      maxRotation: 45,
                      callback: chartXAxisTickCallback(bucketKeysArr, labels, self.tokenRange === '7d'),
                    },
                    border: { color: 'rgba(255,255,255,0.06)' },
                  },
                  y: {
                    stacked: isSearchChart || !isTokenChartPercentMetric(self.tokenChartMetric),
                    beginAtZero: true,
                    suggestedMax: !isSearchChart && isTokenChartPercentMetric(self.tokenChartMetric) ? 100 : undefined,
                    title: {
                      display: true,
                      text: isSearchChart ? 'Search Requests' : tokenChartMetricLabel(self.tokenChartMetric),
                      color: '#9e9e9e',
                      font: { size: 10, family: "'DM Sans', sans-serif" },
                    },
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: {
                      color: '#9e9e9e',
                      font: { size: 10, family: "'JetBrains Mono', monospace" },
                      callback: v => (isSearchChart ? Math.round(Number(v)).toLocaleString() : formatTokenChartAxisValue(Number(v), self.tokenChartMetric)),
                    },
                    border: { color: 'rgba(255,255,255,0.06)' },
                  },
                },
              };
            };

            destroyCharts();

            _charts.key = new Chart(canvasKey, {
              type: 'line',
              data: { labels, datasets: keyDatasets },
              options: makeOptions((_e, legendItem, legend) => {
                const ds = legend.chart.data.datasets[legendItem.datasetIndex];
                if (self.hiddenKeys.has(ds._keyId)) self.hiddenKeys.delete(ds._keyId);
                else self.hiddenKeys.add(ds._keyId);
                self.refreshChartsData();
              }, 'key'),
            });

            _charts.model = new Chart(canvasModel, {
              type: 'line',
              data: { labels, datasets: modelDatasets },
              options: makeOptions((_e, legendItem, legend) => {
                const ds = legend.chart.data.datasets[legendItem.datasetIndex];
                if (self.hiddenModels.has(ds._model)) self.hiddenModels.delete(ds._model);
                else self.hiddenModels.add(ds._model);
                self.refreshChartsData();
              }, 'model'),
            });

            if (canvasSearchKey && this.searchUsageActiveProvider !== 'disabled') {
              _charts.searchKey = new Chart(canvasSearchKey, {
                type: 'line',
                data: { labels, datasets: searchKeyDatasets },
                options: makeOptions((_e, legendItem, legend) => {
                  const ds = legend.chart.data.datasets[legendItem.datasetIndex];
                  if (self.hiddenKeys.has(ds._keyId)) self.hiddenKeys.delete(ds._keyId);
                  else self.hiddenKeys.add(ds._keyId);
                  self.refreshChartsData();
                }, 'searchKey'),
              });
            }

            this.chartsReady = true;
            this.refreshChartsData();
          },

          toggleRedactKeys() {
            this.redactKeys = !this.redactKeys;
            if (_charts.key) {
              for (const ds of _charts.key.data.datasets) {
                ds.label = this.redactKeys ? ds._keyId.slice(0, 8) : _keyNameMap.get(ds._keyId) || ds._keyId.slice(0, 8);
              }
              _charts.key.update('none');
            }
            if (_charts.searchKey) {
              for (const ds of _charts.searchKey.data.datasets) {
                ds.label = this.redactKeys ? ds._keyId.slice(0, 8) : _keyNameMap.get(ds._keyId) || ds._keyId.slice(0, 8);
              }
              _charts.searchKey.update('none');
            }
          },

          switchTokenRange(range) {
            this.tokenRange = range;
            destroyCharts();
            this.chartsReady = false;
            this.loadUsageTabData();
          },

          switchTokenChartMetric(metric) {
            if (!TOKEN_CHART_METRICS[metric] || this.tokenChartMetric === metric) return;
            this.tokenChartMetric = metric;
            this.refreshChartsData();
          },

          switchPerformanceRange(range) {
            if (this.performanceRange === range) return;
            this.performanceRange = range;
            destroyCharts();
            this.chartsReady = false;
            this.loadPerformanceTabData();
          },

          switchPerformanceMetricScope(scope) {
            if (this.performanceMetricScope === scope) return;
            this.performanceMetricScope = scope;
            destroyCharts();
            this.chartsReady = false;
            this.loadPerformanceTabData();
          },

          switchPerformanceChartView(view) {
            if (this.performanceChartView === view) return;
            this.performanceChartView = view;
            if (view === 'percentile') this.ensurePerformanceModelSelected();
            this.renderPerformanceChart();
          },

          switchPerformancePercentile(percentile) {
            if (this.performancePercentile === percentile) return;
            this.performancePercentile = percentile;
            this.renderPerformanceChart();
          },

          async exportData() {
            this.exportLoading = true;
            try {
              const resp = await fetch('/api/export' + (this.exportIncludePerformance ? '?include_performance=1' : ''), { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (!resp.ok) {
                alert('Export failed: ' + (await resp.json()).error);
                return;
              }
              const data = await resp.json();
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'floway-export-' + new Date().toISOString().slice(0, 10) + '.json';
              a.click();
              URL.revokeObjectURL(url);
            } catch (e) {
              console.error('exportData:', e);
              alert('Export failed');
            } finally {
              this.exportLoading = false;
            }
          },

          handleImportFile(event) {
            const file = event.target.files[0];
            if (!file) return;
            this.importFile = file;
            this.importPreview = { ready: false, exportedAt: null, apiKeys: 0, upstreams: 0, usage: 0, searchUsage: 0, performance: 0 };
            this.importData = null;
            this.importVersion = null;

            const reader = new FileReader();
            reader.onload = e => {
              try {
                const json = JSON.parse(e.target.result);
                if (!json.data) {
                  alert('Invalid export file: missing data field');
                  this.importFile = null;
                  return;
                }
                if (json.version !== 2) {
                  alert('Invalid export file: unsupported export version');
                  this.importFile = null;
                  return;
                }
                this.importData = json.data;
                this.importVersion = json.version;
                this.importPreview = {
                  ready: true,
                  exportedAt: json.exportedAt || null,
                  apiKeys: Array.isArray(json.data.apiKeys) ? json.data.apiKeys.length : 0,
                  upstreams: Array.isArray(json.data.upstreams) ? json.data.upstreams.length : 0,
                  usage: Array.isArray(json.data.usage) ? json.data.usage.length : 0,
                  searchUsage: Array.isArray(json.data.searchUsage) ? json.data.searchUsage.length : 0,
                  performance: Array.isArray(json.data.performance) ? json.data.performance.length : 0,
                };
              } catch {
                alert('Invalid JSON file');
                this.importFile = null;
              }
            };
            reader.readAsText(file);
          },

          async doImport() {
            if (!this.importData) return;
            if (this.importMode === 'replace') {
              if (!confirm('This will DELETE ALL existing data and replace it with the imported file. Are you sure?')) return;
            }
            this.importLoading = true;
            try {
              const resp = await fetch('/api/import', {
                method: 'POST',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ version: this.importVersion, mode: this.importMode, data: this.importData }),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              const result = await resp.json();
              if (resp.ok) {
                alert(
                  'Import complete: ' +
                    result.imported.apiKeys +
                    ' keys, ' +
                    result.imported.upstreams +
                    ' upstreams, ' +
                    result.imported.usage +
                    ' usage records, ' +
                    result.imported.searchUsage +
                    ' search usage records, ' +
                    result.imported.performance +
                    ' performance records',
                );
                this.importFile = null;
                this.importData = null;
                this.importVersion = null;
                this.importPreview = { ready: false, exportedAt: null, apiKeys: 0, upstreams: 0, usage: 0, searchUsage: 0, performance: 0 };
              } else {
                alert('Import failed: ' + (result.error || 'Unknown error'));
              }
            } catch (e) {
              console.error('doImport:', e);
              alert('Import failed');
            } finally {
              this.importLoading = false;
            }
          },

          // ---- Models tab ----

          async loadAllModels() {
            await this.ensureModelsLoaded();
          },

          selectChatModel(id) {
            this.chatModelId = id;
            if (this._chatAbort) {
              this._chatAbort.abort();
              this._chatAbort = null;
              this.chatSending = false;
            }
          },

          clearChat() {
            if (this._chatAbort) {
              this._chatAbort.abort();
              this._chatAbort = null;
            }
            this.chatMessages = [];
            this.chatSending = false;
            this.chatStreamText = '';
          },

          buildChatApiMessages() {
            return this.chatMessages.map(m => {
              if (m.role === 'assistant') return { role: 'assistant', content: m.text };
              if (m.imageUrl) {
                return {
                  role: 'user',
                  content: [
                    { type: 'image_url', image_url: { url: m.imageUrl } },
                    { type: 'text', text: m.text },
                  ],
                };
              }
              return { role: 'user', content: m.text };
            });
          },

          scrollChat() {
            this.$nextTick(() => {
              const el = this.$refs.chatScroll;
              if (el) el.scrollTop = el.scrollHeight;
            });
          },

          async sendChatMessage() {
            const text = this.chatInput.trim();
            const img = this.chatImageUrl.trim();
            if (!text && !img) return;
            if (!this.chatModelId) return;

            this.chatMessages.push({ role: 'user', text: text || '(image)', imageUrl: img || null });
            this.chatInput = '';
            this.chatImageUrl = '';
            this.chatShowImage = false;
            this.chatSending = true;
            this.chatStreamText = '';

            const controller = new AbortController();
            this._chatAbort = controller;

            try {
              const resp = await fetch('/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': this.authKey, 'x-models-playground': '1' },
                body: JSON.stringify({
                  model: this.chatModelId,
                  messages: this.buildChatApiMessages(),
                  stream: true,
                }),
                signal: controller.signal,
              });

              if (!resp.ok) {
                const errText = await resp.text();
                this.chatMessages.push({ role: 'assistant', text: '[Error ' + resp.status + '] ' + errText });
                this.chatSending = false;
                this._chatAbort = null;
                this.scrollChat();
                return;
              }

              const reader = resp.body.getReader();
              const decoder = new TextDecoder();
              let buf = '';
              let assistantText = '';
              let assistantIndex = -1;

              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\\n');
                buf = lines.pop();
                for (const line of lines) {
                  if (!line.startsWith('data: ')) continue;
                  const payload = line.slice(6);
                  if (payload === '[DONE]') continue;
                  const chunk = JSON.parse(payload);
                  if (chunk.error) {
                    throw new Error(chunk.error.message || JSON.stringify(chunk.error));
                  }
                  const delta = chunk.choices?.[0]?.delta?.content;
                  if (delta) {
                    if (assistantIndex === -1) {
                      assistantIndex = this.chatMessages.length;
                      this.chatMessages.push({ role: 'assistant', text: '' });
                    }
                    assistantText += delta;
                    this.chatMessages[assistantIndex].text = assistantText;
                  }
                }
                this.scrollChat();
              }

              if (!assistantText) {
                this.chatMessages.push({ role: 'assistant', text: '(empty response)' });
              }
            } catch (e) {
              if (e.name !== 'AbortError') {
                this.chatMessages.push({ role: 'assistant', text: '[Error] ' + e.message });
              }
            } finally {
              this.chatSending = false;
              this._chatAbort = null;
              this.scrollChat();
            }
          },

          logout() {
            localStorage.removeItem('authKey');
            localStorage.removeItem('isAdmin');
            localStorage.removeItem('login_key_id');
            localStorage.removeItem('login_key_name');
            localStorage.removeItem('login_key_hint');
            window.location.href = '/';
          },
        };
      }
    </script>
  `;
}
