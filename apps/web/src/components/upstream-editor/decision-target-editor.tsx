import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Dropdown, Input } from '../ui/fluent-form-controls';
import { TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { type DecisionProtocol, type DecisionTarget, DEFAULT_DECISION_PATHS } from '@floway-dev/protocols/browser';

const { Field, Option } = fluentComponents;

const PROTOCOL_LABELS: Record<DecisionProtocol, string> = {
  'systemone': 'System One',
  'openai-decisions': 'OpenAI Decisions',
};

export function DecisionTargetEditor({ onChange, readOnly, value }: {
  readOnly: boolean;
  onChange: (target: DecisionTarget) => void;
  value: DecisionTarget;
}) {
  const { t } = useTranslation();
  return <div className="grid gap-3">
    <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>
      <Field className="min-w-0" label={t('dashboard.upstreamEditor.models.decisionProtocol')}>
        <Dropdown
          readOnly={readOnly}
          selectedOptions={[value.protocol]}
          value={PROTOCOL_LABELS[value.protocol]}
          onOptionSelect={(_, data) => data.optionValue !== undefined && onChange({ ...value, protocol: data.optionValue as DecisionProtocol })}
        >
          {Object.entries(PROTOCOL_LABELS).map(([protocol, label]) => (
            <Option key={protocol} value={protocol}>{label}</Option>
          ))}
        </Dropdown>
      </Field>

      <Field className="min-w-0" label={t('dashboard.upstreamEditor.models.decisionPath')} hint={t('dashboard.upstreamEditor.models.decisionPathHint')}>
        <Input
          className="!w-full font-mono"
          readOnly={readOnly}
          placeholder={DEFAULT_DECISION_PATHS[value.protocol]}
          value={value.path ?? ''}
          onChange={(_, data) => {
            const path = data.value.trim();
            // "Use the protocol default" is the absence of the field; the other
            // target fields keep their value when it is cleared.
            const { path: _path, ...rest } = value;
            onChange(path === '' ? rest : { ...rest, path });
          }}
        />
      </Field>
    </div>
  </div>;
}
