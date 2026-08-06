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
