import { expect, test } from 'vitest';

import { config, record } from './fixtures.ts';
import { assertKimiCodeUpstreamRecord, kimiCodeStateSurvivesConfigChange, parseKimiCodeUpstreamConfig } from '../src/config.ts';

test('Kimi Code config chooses a coding region and requires a credential', () => {
  expect(parseKimiCodeUpstreamConfig(config)).toEqual(config);
  expect(parseKimiCodeUpstreamConfig({ ...config, region: 'overseas' }).region).toBe('overseas');
  for (const invalid of [null, {}, { ...config, region: 'elsewhere' }, { ...config, apiKey: '' }, { ...config, apiKey: 123 }]) expect(() => parseKimiCodeUpstreamConfig(invalid)).toThrow();
  expect(assertKimiCodeUpstreamRecord(record()).config).toEqual(config);
  expect(() => assertKimiCodeUpstreamRecord(record({ kind: 'custom' }))).toThrow('Expected kimi-code');
});

test('Kimi Code state follows the credential through regional configuration changes', () => {
  expect(kimiCodeStateSurvivesConfigChange(config, { ...config, region: 'overseas' })).toBe(true);
  expect(kimiCodeStateSurvivesConfigChange({ ...config, region: 'overseas' }, config)).toBe(true);
  const replacement = { ...config, apiKey: 'sk-kimi-fake-replacement-key' };
  expect(kimiCodeStateSurvivesConfigChange(config, replacement)).toBe(false);
  expect(kimiCodeStateSurvivesConfigChange(replacement, config)).toBe(false);
});
