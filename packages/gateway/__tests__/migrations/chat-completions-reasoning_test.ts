import { expect, test } from 'vitest';

import { compatibilityDefaultsForKind, resolveProviderModelEndpoints } from '../../src/data-plane/providers/registry.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import { createSqlJsDatabase, migrationSqlByFilename, wrapSqlJsDatabase } from '../repo/test-sqlite.ts';
import type { ChatCompletionsReasoningFormat, ChatCompletionsReasoningOverrides } from '@floway-dev/protocols/openai-chat-completions';
import { modelsField, type FlagOverrides, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const MIGRATION = '0086_compatibility.sql';
const CANONICAL: ChatCompletionsReasoningFormat = { text: 'reasoning-text', data: 'reasoning-opaque' };
const DEEPSEEK: ChatCompletionsReasoningFormat = { text: 'reasoning-content', data: 'passthrough' };

const model = (flagOverrides?: FlagOverrides, reasoning?: ChatCompletionsReasoningOverrides): UpstreamModelConfig => ({
  upstreamModelId: 'chat-model',
  display_name: 'Configured model',
  kind: 'chat',
  endpoints: { openaiChatCompletions: {} },
  ...(reasoning === undefined ? {} : { compatibility: { openaiChatCompletions: { reasoning } } }),
  ...(flagOverrides === undefined ? {} : { flagOverrides }),
});

const migrate = async (
  kind: 'custom' | 'azure' | 'ollama',
  flagOverrides: FlagOverrides,
  models: UpstreamModelConfig[],
): Promise<UpstreamRecord> => {
  const config = kind === 'custom'
    ? { baseUrl: 'https://example.com', authStyle: 'none', ingressHeadersRules: [], endpoints: { openaiChatCompletions: {} }, modelsFetch: { enabled: false }, models }
    : kind === 'azure'
      ? { endpoint: 'https://resource.openai.azure.com/openai/v1', apiKey: 'test-key', models }
      : { baseUrl: 'https://ollama.example.com', cloudUsage: false, models };
  const db = await createSqlJsDatabase();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === MIGRATION) {
        db.run(`INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, flag_overrides, hue)
          VALUES ('up_legacy', ?, 'Legacy', '', '', ?, ?, 210)`, [kind, JSON.stringify(config), JSON.stringify(flagOverrides)]);
      }
      db.run(sql);
    }
    const record = await new SqlRepo(wrapSqlJsDatabase(db)).upstreams.getById('up_legacy');
    if (record === null) throw new Error('Migrated upstream missing');
    expect(record.config).toEqual({ ...config, models: (record.config as { models: UpstreamModelConfig[] }).models });
    expect(record.flagOverrides).toEqual(flagOverrides);
    return record;
  } finally {
    db.close();
  }
};

const migratedModels = (record: UpstreamRecord): UpstreamModelConfig[] =>
  modelsField((record.config as { models: unknown }).models, record.kind);

const resolvedFormat = (record: UpstreamRecord, config: Pick<UpstreamModelConfig, 'endpoints' | 'compatibility'> = { endpoints: { openaiChatCompletions: {} } }): ChatCompletionsReasoningOverrides | undefined =>
  resolveProviderModelEndpoints(record, { ...stubProviderModel(), ...config }).endpoints.openaiChatCompletions?.reasoning;

for (const kind of ['custom', 'azure', 'ollama'] as const) {
  test.each([true, false])(`${kind}: explicit upstream DeepSeek decision migrates independently from provider defaults (on=%s)`, async on => {
    const models = [model()];
    const record = await migrate(kind, { 'vendor-deepseek': on, 'vendor-kimi': true }, models);
    const expected = on ? DEEPSEEK : CANONICAL;
    expect(record.compatibility).toEqual({ openaiChatCompletions: { reasoning: expected } });
    expect(migratedModels(record)).toEqual(models);
    expect(resolvedFormat(record)).toEqual(expected);
  });

  test.each([true, false])(`${kind}: explicit model decision overrides the opposite upstream decision (on=%s)`, async on => {
    const legacy = model({ 'vendor-deepseek': on, 'vendor-qwen': false });
    const record = await migrate(kind, { 'vendor-deepseek': !on }, [legacy]);
    const [migrated] = migratedModels(record);
    const expected = on ? DEEPSEEK : CANONICAL;
    expect(migrated).toEqual({ ...legacy, compatibility: { openaiChatCompletions: { reasoning: expected } } });
    expect(resolvedFormat(record, migrated)).toEqual(expected);
  });

  test(`${kind}: absent DeepSeek decisions inherit provider defaults without Qwen or Kimi selecting a format`, async () => {
    const models = [model({ 'vendor-qwen': true, 'vendor-kimi': false })];
    const record = await migrate(kind, { 'vendor-qwen': false, 'vendor-kimi': true }, models);
    expect(record.compatibility).toEqual({});
    expect(migratedModels(record)).toEqual(models);
    expect(resolvedFormat(record, models[0])).toEqual(compatibilityDefaultsForKind(kind).openaiChatCompletions.reasoning);
  });
}

test.each([
  { format: { text: 'reasoning' } as const, expected: { text: 'reasoning', data: 'passthrough' } },
  { format: { data: 'litellm-thinking-blocks' } as const, expected: { text: 'reasoning-content', data: 'litellm-thinking-blocks' } },
  { format: { text: 'reasoning', data: 'openrouter-reasoning-details' } as const, expected: { text: 'reasoning', data: 'openrouter-reasoning-details' } },
])('migration retains explicit reasoning channels ($format)', async ({ format, expected }) => {
  const record = await migrate('custom', {}, [model({ 'vendor-deepseek': true }, format)]);
  expect(migratedModels(record)[0].compatibility?.openaiChatCompletions?.reasoning).toEqual(expected);
});

test('migration keeps non-Chat-Completions models and empty model lists intact', async () => {
  const models: UpstreamModelConfig[] = [{ upstreamModelId: 'messages', kind: 'chat', endpoints: { anthropicMessages: {} }, flagOverrides: { 'vendor-deepseek': true } }];
  expect(migratedModels(await migrate('custom', { 'vendor-deepseek': false }, models))).toEqual(models);
  expect(migratedModels(await migrate('custom', { 'vendor-deepseek': true }, []))).toEqual([]);
});
