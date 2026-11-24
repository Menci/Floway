import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { createSqlJsDatabase, migrationSqlByFilename } from '../repo/test-sqlite.ts';

type Fixture = {
  filename: string;
  provider: 'azure' | 'custom';
  config: Record<string, unknown>;
  field: 'deployments' | 'supportedEndpoints' | 'models';
  expected: unknown[];
  hue?: number;
};

// These are stored operator settings, not JSON-function examples: a quoted
// rebuilt array makes the provider unable to read its models after an upgrade.
// Seed each historical shape immediately before its owning migration so later
// rewrites cannot conceal the first migration that loses the array or objects.
const fixtures: Fixture[] = [
  {
    filename: '0014_azure_deployment_limits_flatten.sql',
    provider: 'azure',
    config: { deployments: [{ deployment: 'a', capabilities: { limits: { max_output_tokens: 512 } } }] },
    field: 'deployments',
    expected: [{ deployment: 'a', limits: { max_output_tokens: 512 } }],
  },
  {
    filename: '0016_custom_drop_embeddings_endpoint.sql',
    provider: 'custom',
    config: { supportedEndpoints: ['/responses', '/embeddings', '/v1/embeddings'] },
    field: 'supportedEndpoints',
    expected: ['/responses'],
  },
  {
    filename: '0016_custom_drop_embeddings_endpoint.sql',
    provider: 'custom',
    config: { supportedEndpoints: ['/embeddings', '/v1/embeddings'] },
    field: 'supportedEndpoints',
    expected: [],
  },
  {
    filename: '0018_consolidate_deepseek_flag.sql',
    provider: 'azure',
    config: {
      deployments: [
        { deployment: 'a', flagOverrides: { enabled: true, values: { 'deepseek-reasoning-dialect': true } } },
        { deployment: 'b', flagOverrides: { enabled: true, values: { 'deepseek-reasoning-dialect': false } } },
        { deployment: 'untouched' },
      ],
    },
    field: 'deployments',
    expected: [
      { deployment: 'a', flagOverrides: { enabled: true, values: { 'vendor-deepseek': true } } },
      { deployment: 'b', flagOverrides: { enabled: true, values: {} } },
      { deployment: 'untouched' },
    ],
  },
  {
    filename: '0021_unified_model_list.sql',
    provider: 'azure',
    config: { deployments: [{ deployment: 'a', limits: { max_output_tokens: 512 } }] },
    field: 'models',
    expected: [{ upstreamModelId: 'a', limits: { max_output_tokens: 512 } }],
  },
  {
    filename: '0024_structured_model_endpoints.sql',
    provider: 'azure',
    config: { models: [{ upstreamModelId: 'a', supportedEndpoints: ['/responses', '/v1/messages'] }] },
    field: 'models',
    expected: [{ upstreamModelId: 'a', endpoints: { responses: {}, messages: {} } }],
  },
  {
    filename: '0025_drop_messages_count_tokens.sql',
    provider: 'azure',
    config: {
      models: [
        { upstreamModelId: 'a', endpoints: { messages: { countTokens: true } } },
        { upstreamModelId: 'untouched', endpoints: { responses: {} } },
      ],
    },
    field: 'models',
    expected: [
      { upstreamModelId: 'a', endpoints: { messages: {} } },
      { upstreamModelId: 'untouched', endpoints: { responses: {} } },
    ],
  },
  {
    filename: '0049_flatten_model_flag_overrides.sql',
    provider: 'custom',
    config: {
      models: [
        { upstreamModelId: 'a', flagOverrides: { enabled: true, values: { 'vendor-qwen': false } } },
        { upstreamModelId: 'b', flagOverrides: { enabled: false, values: { 'vendor-qwen': true } } },
        { upstreamModelId: 'untouched' },
      ],
    },
    field: 'models',
    expected: [
      { upstreamModelId: 'a', flagOverrides: { 'vendor-qwen': false } },
      { upstreamModelId: 'b' },
      { upstreamModelId: 'untouched' },
    ],
  },
  {
    filename: '0054_model_pricing.sql',
    provider: 'custom',
    config: {
      models: [
        { upstreamModelId: 'a', cost: { input: 1, output: 2 } },
        { upstreamModelId: 'untouched', limits: { max_output_tokens: 512 } },
      ],
    },
    field: 'models',
    expected: [
      {
        upstreamModelId: 'a', pricing: {
          entries: [{
            rates: {
              input: 1, input_cache_read: 1, input_cache_write: 1, input_cache_write_1h: 1,
              input_image: 1, output: 2, output_image: 2,
            },
          }],
        },
      },
      { upstreamModelId: 'untouched', limits: { max_output_tokens: 512 } },
    ],
  },
  {
    filename: '0062_usage_billing_metrics.sql',
    provider: 'custom',
    config: {
      models: [
        { upstreamModelId: 'a', pricing: { entries: [{ selector: { serviceTier: 'priority' }, rates: { input: 2, input_cache_read: 0.25, output: 5 } }] } },
        { upstreamModelId: 'untouched', limits: { max_output_tokens: 512 } },
      ],
    },
    field: 'models',
    expected: [
      {
        upstreamModelId: 'a', pricing: {
          entries: [{
            selector: { serviceTier: 'priority' }, rates: {
              input_tokens: '0.000002', input_cache_read_tokens: '0.00000025', output_tokens: '0.000005',
            },
          }],
        },
      },
      { upstreamModelId: 'untouched', limits: { max_output_tokens: 512 } },
    ],
  },
  {
    filename: '0070_drop_retry_cyber_policy_flag.sql',
    provider: 'custom',
    config: {
      models: [
        { upstreamModelId: 'a', flagOverrides: { 'retry-cyber-policy': true, 'vendor-qwen': false } },
        { upstreamModelId: 'untouched' },
      ],
    },
    field: 'models',
    expected: [
      { upstreamModelId: 'a', flagOverrides: { 'vendor-qwen': false } },
      { upstreamModelId: 'untouched' },
    ],
  },
  {
    filename: '0073_rewrite_role_flags.sql',
    provider: 'custom',
    config: {
      models: [
        {
          upstreamModelId: 'a', flagOverrides: {
            'demote-interleaved-system-to-user': true,
            'demote-developer-to-system': false,
            'promote-system-to-developer': true,
          },
        },
        { upstreamModelId: 'untouched' },
      ],
    },
    field: 'models',
    expected: [
      {
        upstreamModelId: 'a', flagOverrides: {
          'rewrite-mid-conv-system-to-user': true,
          'rewrite-developer-to-system': false,
          'rewrite-system-to-developer': true,
        },
      },
      { upstreamModelId: 'untouched' },
    ],
  },
  {
    filename: '0083_canonical_protocol_names.sql',
    provider: 'custom',
    hue: 210,
    config: {
      models: [
        { upstreamModelId: 'a', endpoints: { responses: {} }, flagOverrides: { 'responses-compact-shim': false } },
        { upstreamModelId: 'untouched' },
      ],
    },
    field: 'models',
    expected: [
      { upstreamModelId: 'a', endpoints: { openaiResponses: {} }, flagOverrides: { 'openai-responses-compact-shim': false } },
      { upstreamModelId: 'untouched' },
    ],
  },
];

for (const fixture of fixtures) {
  test.each(['node:sqlite', 'sql.js'] as const)(`${fixture.filename} preserves operator ${fixture.field} (${fixture.expected.length} entries) on %s`, async backend => {
    const db = backend === 'node:sqlite' ? new DatabaseSync(':memory:') : await createSqlJsDatabase();
    try {
      for (const [filename, sql] of migrationSqlByFilename) {
        if (filename >= fixture.filename) break;
        db.exec(sql);
      }
      const sql = migrationSqlByFilename.find(([filename]) => filename === fixture.filename)?.[1];
      if (sql === undefined) throw new Error(`Missing migration ${fixture.filename}`);
      const insert = `
        INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, flag_overrides${fixture.hue === undefined ? '' : ', hue'})
        VALUES ('array-fixture', ?, 'Floway migration fixture', '', '', ?, '{}'${fixture.hue === undefined ? '' : ', ?'})
      `;
      const config = JSON.stringify({ ...fixture.config, operatorSetting: 'keep-me' });
      const values = [fixture.provider, config, ...(fixture.hue === undefined ? [] : [fixture.hue])];
      if (db instanceof DatabaseSync) db.prepare(insert).run(...values);
      else db.run(insert, values);

      db.exec(sql);

      const select = "SELECT config_json FROM upstreams WHERE id = 'array-fixture'";
      const stored = db instanceof DatabaseSync
        ? db.prepare(select).get()?.config_json
        : db.exec(select)[0]?.values[0]?.[0];
      if (typeof stored !== 'string') throw new Error('Missing migrated operator configuration');
      const migrated = JSON.parse(stored) as Record<string, unknown>;
      expect(migrated[fixture.field]).toEqual(fixture.expected);
      expect(migrated.operatorSetting).toBe('keep-me');
    } finally {
      db.close();
    }
  });
}
