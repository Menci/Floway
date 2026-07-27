import { useTranslation } from 'react-i18next';

import { fluentComponents } from '../../fluent';
import { Input, Select } from '../ui/fluent-form-controls';
import type { RerankProtocol, RerankTarget } from '@floway-dev/protocols/common';
import { DEFAULT_RERANK_PATHS } from '@floway-dev/protocols/rerank';

const { Field } = fluentComponents;

// Rerank upstreams disagree on both the request dialect and the path, and the
// pairing is per model rather than per provider, so both live on the target.
const PROTOCOL_LABELS: Record<RerankProtocol, string> = {
  'cohere-v1': 'Cohere v1',
  'cohere-v2': 'Cohere v2',
  'jina-v1': 'Jina v1',
  'voyage-v1': 'Voyage v1',
  'dashscope-compatible': 'DashScope compatible',
  'dashscope-native': 'DashScope native',
};

export const RerankTargetEditor = ({ disabled, onChange, value }: {
  disabled?: boolean;
  onChange: (target: RerankTarget) => void;
  value: RerankTarget;
}) => {
  const { t } = useTranslation();

  return <div className="grid gap-3 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-[560px]:grid-cols-1">
    <Field className="min-w-0" label={t('dashboard.upstreamEditor.models.rerankProtocol')}>
      <Select
        disabled={disabled}
        value={value.protocol}
        onChange={(_, data) => onChange({ ...value, protocol: data.value as RerankProtocol })}
      >
        {Object.entries(PROTOCOL_LABELS).map(([protocol, label]) => (
          <option key={protocol} value={protocol}>{label}</option>
        ))}
      </Select>
    </Field>

    <Field className="min-w-0" label={t('dashboard.upstreamEditor.models.rerankPath')} hint={t('dashboard.upstreamEditor.models.rerankPathHint')}>
      <Input
        className="!w-full font-mono"
        disabled={disabled}
        placeholder={DEFAULT_RERANK_PATHS[value.protocol]}
        value={value.path ?? ''}
        onChange={(_, data) => {
          const path = data.value.trim();
          // An empty override means "use the protocol default", which is the
          // absence of the field rather than an empty string.
          onChange(path === '' ? { protocol: value.protocol } : { ...value, path });
        }}
      />
    </Field>
  </div>;
};
