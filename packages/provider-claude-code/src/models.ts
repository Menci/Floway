// The Claude Code OAuth bearer accepts the standard Anthropic /v1/models
// endpoint. We refresh the catalog from there on every dispatcher poll so
// the gateway surfaces exactly the models Anthropic exposes to the
// subscription's tier — sonnet / opus 4.5, opus 4.6+, fable-5, etc. —
// without a per-release code bump.
//
// Two id shapes coexist on the wire today. Pre-4.6 models (4.5 / 4.1)
// return with a `-YYYYMMDD` date suffix; their public alias is the
// de-dated form (`claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`).
// 4.6+ and `claude-fable-5` return with the alias already (no date),
// so the alias derivation is the identity. The catalog id we publish is
// always the alias; the original /v1/models id rides on
// `providerData.upstreamModelId` so the wire fetch in `fetch.ts` and the
// pricing table key by the per-revision id.

import { CLAUDE_CODE_HEADERS_SONNET_OPUS } from './headers.ts';
import { pricingForClaudeCodeModelKey } from './pricing.ts';
import type { ClaudeCodeProviderData } from './types.ts';
import type { Fetcher, UpstreamModel, UpstreamChatModelConfig } from '@floway-dev/provider';

const ANTHROPIC_MODELS_ENDPOINT = 'https://api.anthropic.com/v1/models?limit=100';

// `/v1/models` returns more fields than we consume; the parser keeps the
// ones the catalog needs and ignores the rest so a benign upstream
// addition does not fail the refresh. Unknown shapes still throw because
// dropping a required field is the kind of contract change we want to
// notice loudly.
export interface ClaudeCodeApiModel {
  id: string;
  display_name: string;
  max_input_tokens: number;
  capabilities?: {
    image_input?: { supported: boolean };
    thinking?: {
      types?: {
        enabled?: { supported: boolean };
        adaptive?: { supported: boolean };
      };
    };
    // `supported` is the top-level boolean; other keys are named level
    // sub-objects `{ supported: boolean }`. The union type captures both.
    effort?: {
      supported: boolean;
      [level: string]: { supported: boolean } | boolean;
    };
  };
}

export const fetchClaudeCodeModelsList = async (
  accessToken: string,
  fetcher: Fetcher,
): Promise<ClaudeCodeApiModel[]> => {
  const headers: Record<string, string> = {
    ...CLAUDE_CODE_HEADERS_SONNET_OPUS,
    authorization: `Bearer ${accessToken}`,
  };
  const response = await fetcher(ANTHROPIC_MODELS_ENDPOINT, { method: 'GET', headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Claude Code /v1/models fetch failed: ${response.status} ${body.slice(0, 200)}`);
  }
  const parsed = await response.json() as { data?: unknown };
  if (!Array.isArray(parsed.data)) throw new Error('Claude Code /v1/models response missing data array');
  return parsed.data.map(assertApiModel);
};

const assertApiModel = (value: unknown): ClaudeCodeApiModel => {
  if (typeof value !== 'object' || value === null) throw new TypeError('Claude Code /v1/models entry is not an object');
  const { id, display_name, max_input_tokens, capabilities } = value as Record<string, unknown>;
  if (typeof id !== 'string') throw new TypeError(`Claude Code /v1/models entry missing id: ${JSON.stringify(value).slice(0, 200)}`);
  if (typeof display_name !== 'string') throw new TypeError(`Claude Code /v1/models entry ${id} missing display_name`);
  if (typeof max_input_tokens !== 'number') throw new TypeError(`Claude Code /v1/models entry ${id} missing max_input_tokens`);
  return {
    id,
    display_name,
    max_input_tokens,
    ...(capabilities !== undefined ? { capabilities: parseCapabilities(capabilities) } : {}),
  };
};

// Parses the `capabilities` block from the Anthropic /v1/models response.
// Unknown sub-fields are silently skipped — Anthropic adds capabilities
// forward-compatibly, and we'd rather miss a future field than fail the catalog refresh.
const parseCapabilities = (raw: unknown): ClaudeCodeApiModel['capabilities'] => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const cap = raw as Record<string, unknown>;
  const out: NonNullable<ClaudeCodeApiModel['capabilities']> = {};

  if (typeof cap.image_input === 'object' && cap.image_input !== null) {
    const ii = cap.image_input as Record<string, unknown>;
    if (typeof ii.supported === 'boolean') out.image_input = { supported: ii.supported };
  }

  if (typeof cap.thinking === 'object' && cap.thinking !== null) {
    const th = cap.thinking as Record<string, unknown>;
    const thinking: NonNullable<ClaudeCodeApiModel['capabilities']>['thinking'] = {};
    if (typeof th.types === 'object' && th.types !== null) {
      const types = th.types as Record<string, unknown>;
      const parsedTypes: NonNullable<typeof thinking.types> = {};
      if (typeof types.enabled === 'object' && types.enabled !== null) {
        const en = types.enabled as Record<string, unknown>;
        if (typeof en.supported === 'boolean') parsedTypes.enabled = { supported: en.supported };
      }
      if (typeof types.adaptive === 'object' && types.adaptive !== null) {
        const ad = types.adaptive as Record<string, unknown>;
        if (typeof ad.supported === 'boolean') parsedTypes.adaptive = { supported: ad.supported };
      }
      if (parsedTypes.enabled !== undefined || parsedTypes.adaptive !== undefined) thinking.types = parsedTypes;
    }
    if (thinking.types !== undefined) out.thinking = thinking;
  }

  // `effort.supported` is required to interpret the block; skip otherwise.
  if (typeof cap.effort === 'object' && cap.effort !== null) {
    const eff = cap.effort as Record<string, unknown>;
    if (typeof eff.supported === 'boolean') {
      const effort: NonNullable<ClaudeCodeApiModel['capabilities']>['effort'] = { supported: eff.supported };
      for (const [level, levelVal] of Object.entries(eff)) {
        if (level === 'supported') continue;
        if (typeof levelVal === 'object' && levelVal !== null) {
          const lv = levelVal as Record<string, unknown>;
          if (typeof lv.supported === 'boolean') effort[level] = { supported: lv.supported };
        }
      }
      out.effort = effort;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
};

// Pre-4.6 models return as `claude-<family>-<digits>-<digits>-YYYYMMDD`;
// the public alias is the de-dated form. Newer ids (`claude-opus-4-7`,
// `claude-fable-5`) have no date suffix and pass through unchanged. The
// pattern is intentionally generic over the family slug — anchoring to
// `claude-(haiku|opus|sonnet)` would silently drop a future family the
// upstream exposes before we hard-code its name.
export const aliasFromApiId = (apiId: string): string => apiId.replace(/-\d{8}$/, '');

// Derives the `chat` metadata from a model's capabilities block.
// Returns undefined when no relevant capability is present so the
// caller can omit the key entirely and keep the UpstreamModel lean.
export const chatFromCapabilities = (
  capabilities: ClaudeCodeApiModel['capabilities'],
): UpstreamChatModelConfig | undefined => {
  if (capabilities === undefined) return undefined;

  const chat: UpstreamChatModelConfig = {};

  if (capabilities.image_input?.supported === true) {
    chat.modalities = { input: ['text', 'image'], output: ['text'] };
  }

  const reasoning: NonNullable<UpstreamChatModelConfig['reasoning']> = {};

  const eff = capabilities.effort;
  if (eff?.supported === true) {
    const supportedLevels = Object.entries(eff)
      .filter(([key, val]) => key !== 'supported' && typeof val === 'object' && val !== null && (val as { supported: boolean }).supported === true)
      .map(([key]) => key);
    if (supportedLevels.length > 0) {
      const defaultLevel = supportedLevels.includes('medium') ? 'medium' : supportedLevels[0]!;
      reasoning.effort = { supported: supportedLevels, default: defaultLevel };
    }
  }

  if (capabilities.thinking?.types?.enabled?.supported === true) {
    reasoning.budget_tokens = {};
  }

  if (capabilities.thinking?.types?.adaptive?.supported === true) {
    reasoning.adaptive = true;
  }

  if (reasoning.effort !== undefined || reasoning.budget_tokens !== undefined || reasoning.adaptive !== undefined) {
    chat.reasoning = reasoning;
  }

  return (chat.modalities !== undefined || chat.reasoning !== undefined) ? chat : undefined;
};

export const buildClaudeCodeCatalog = (
  apiModels: readonly ClaudeCodeApiModel[],
  enabledFlags: ReadonlySet<string>,
): UpstreamModel[] => apiModels.map(api => {
  const alias = aliasFromApiId(api.id);
  const cost = pricingForClaudeCodeModelKey(api.id);
  const providerData: ClaudeCodeProviderData = { upstreamModelId: api.id };
  const chat = chatFromCapabilities(api.capabilities);
  return {
    id: alias,
    display_name: api.display_name,
    owned_by: 'anthropic',
    kind: 'chat',
    endpoints: { messages: {} },
    enabledFlags,
    limits: { max_context_window_tokens: api.max_input_tokens },
    providerData,
    ...(cost ? { cost } : {}),
    ...(chat ? { chat } : {}),
  };
});
