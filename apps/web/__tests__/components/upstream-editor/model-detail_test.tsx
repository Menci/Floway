import { fireEvent, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { kindPatchForModel, ModelDetail } from '../../../src/components/upstream-editor/model-detail';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';
import type { UpstreamModelConfig } from '@floway-dev/provider';

const config: UpstreamModelConfig = {
  upstreamModelId: 'mixed',
  kind: 'embedding',
  endpoints: { embeddings: {}, rerank: {} },
  rerankTarget: { protocol: 'cohere-v2' },
};

test('selecting the current kind keeps a mixed model contract untouched', () => {
  expect(kindPatchForModel(config, 'embedding')).toBeNull();
  const onChange = vi.fn();
  const record = upstreamRecord('up_custom', {
    kind: 'custom',
    config: {
      baseUrl: 'https://custom.example.com',
      authStyle: 'none',
      endpoints: {},
      ingressHeadersRules: [],
      modelsFetch: { enabled: false },
      models: [config],
    },
    state: null,
  });
  renderInApp(<ModelDetail
    onChange={onChange}
    onDelete={vi.fn()}
    onSourceChange={vi.fn()}
    readOnly={false}
    record={record}
    row={{ key: 'mixed', source: 'manual', config, manualIndex: 0, hasAuto: false }}
    section="details"
    upstreamFlags={{}}
  />);

  const kind = screen.getByRole('combobox', { name: i18n.t('dashboard.upstreamEditor.models.kind') });
  fireEvent.click(kind);
  fireEvent.click(screen.getByRole('option', { name: 'Embedding' }));
  expect(onChange).not.toHaveBeenCalled();
});

test('Ollama does not offer an image kind that its provider rejects', () => {
  const ollamaModel: UpstreamModelConfig = {
    upstreamModelId: 'chat',
    kind: 'chat',
    endpoints: { chatCompletions: {} },
  };
  const record = upstreamRecord('up_ollama', {
    kind: 'ollama',
    config: {
      baseUrl: 'https://ollama.example.com',
      models: [ollamaModel],
    },
    state: null,
  });
  renderInApp(<ModelDetail
    onChange={vi.fn()}
    onDelete={vi.fn()}
    onSourceChange={vi.fn()}
    readOnly={false}
    record={record}
    row={{ key: 'chat', source: 'manual', config: ollamaModel, manualIndex: 0, hasAuto: false }}
    section="details"
    upstreamFlags={{}}
  />);

  fireEvent.click(screen.getByRole('combobox', { name: i18n.t('dashboard.upstreamEditor.models.kind') }));
  expect(screen.queryByRole('option', { name: 'Image' })).toBeNull();
});
