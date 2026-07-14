import { mount } from '@vue/test-utils';
import { expect, test } from 'vitest';
import { defineComponent } from 'vue';

import CliSnippet from './CliSnippet.vue';
import type { ControlPlaneModel } from '../../api/types.ts';

const CodeStub = defineComponent({
  name: 'Code',
  props: {
    code: { type: String, required: true },
  },
  template: '<pre>{{ code }}</pre>',
});

const codexModel: ControlPlaneModel = {
  id: 'gpt-5.4',
  object: 'model',
  type: 'model',
  display_name: 'GPT-5.4',
  limits: {},
  kind: 'chat',
  endpoints: { responses: {} },
  upstreams: [],
};

const sectionLines = (config: string, section: string): string[] => {
  const lines = config.split('\n');
  const start = lines.indexOf(`[${section}]`);
  if (start < 0) throw new Error(`Missing [${section}] in generated Codex config`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('['));
  return lines.slice(start + 1, next < 0 ? undefined : next);
};

test('Codex snippet requires OpenAI auth and disables Agent Identity', () => {
  const wrapper = mount(CliSnippet, {
    props: { apiKey: 'floway-key', models: [codexModel] },
    global: { stubs: { Code: CodeStub } },
  });
  const config = wrapper.findAll('pre').map(block => block.text()).find(code => code.includes('[model_providers.floway]'));
  if (config === undefined) throw new Error('Codex config block was not rendered');
  expect(sectionLines(config, 'model_providers.floway')).toContain('requires_openai_auth = true');
  expect(sectionLines(config, 'features')).toEqual(expect.arrayContaining([
    'apps = false',
    'use_agent_identity = false',
  ]));
});
