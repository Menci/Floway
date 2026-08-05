import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Dropdown, Input } from '../ui/fluent-form-controls';
import { TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import type { RerankProtocol, RerankTarget } from '@floway-dev/protocols/common';
import { DEFAULT_RERANK_PATHS } from '@floway-dev/protocols/rerank';

const { Field, Option } = fluentComponents;

const PROTOCOL_LABELS: Record<RerankProtocol, string> = {
  'cohere-v1': 'Cohere v1',
  'cohere-v2': 'Cohere v2',
  'jina-v1': 'Jina v1',
  'voyage-v1': 'Voyage v1',
  'dashscope-compatible': 'DashScope compatible',
  'dashscope-native': 'DashScope native',
};

export function RerankTargetEditor({ onChange, readOnly, value }: {
  readOnly: boolean;
  onChange: (target: RerankTarget) => void;
  value: RerankTarget;
}) {
  const { t } = useTranslation();

  return <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>
    <Field className="min-w-0" label={t('dashboard.upstreamEditor.models.rerankProtocol')}>
      <Dropdown
        readOnly={readOnly}
        selectedOptions={[value.protocol]}
        value={PROTOCOL_LABELS[value.protocol]}
        onOptionSelect={(_, data) => data.optionValue !== undefined && onChange({ ...value, protocol: data.optionValue as RerankProtocol })}
      >
        {Object.entries(PROTOCOL_LABELS).map(([protocol, label]) => (
          <Option key={protocol} value={protocol}>{label}</Option>
        ))}
      </Dropdown>
    </Field>

    <Field className="min-w-0" label={t('dashboard.upstreamEditor.models.rerankPath')} hint={t('dashboard.upstreamEditor.models.rerankPathHint')}>
      <Input
        className="!w-full font-mono"
        readOnly={readOnly}
        placeholder={DEFAULT_RERANK_PATHS[value.protocol]}
        value={value.path ?? ''}
        onChange={(_, data) => {
          const path = data.value.trim();
          // "Use the protocol default" is the absence of the field rather
          // than an empty string.
          onChange(path === '' ? { protocol: value.protocol } : { ...value, path });
        }}
      />
    </Field>
  </div>;
}
