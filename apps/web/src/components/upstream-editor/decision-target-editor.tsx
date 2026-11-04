import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Dropdown, Input } from '../ui/fluent-form-controls';
import { TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { type DecisionProtocol, type DecisionQuestionType, type DecisionTarget, DEFAULT_DECISION_PATHS, DECISION_QUESTION_TYPES } from '@floway-dev/protocols/browser';

const { Checkbox, Field, Option } = fluentComponents;

const PROTOCOL_LABELS: Record<DecisionProtocol, string> = {
  'systemone': 'System One',
  'openai-decisions': 'OpenAI Decisions',
};

const QUESTION_TYPE_LABELS: Record<DecisionQuestionType, string> = {
  noul: 'Noul (yes/no)',
  choice: 'Choice',
  score: 'Score',
};

export function DecisionTargetEditor({ onChange, readOnly, value }: {
  readOnly: boolean;
  onChange: (target: DecisionTarget) => void;
  value: DecisionTarget;
}) {
  const { t } = useTranslation();
  // An undefined questionTypes means every primitive; the checkboxes show the
  // effective set and collapse back to undefined when every type is on, so a
  // row that accepts everything stores no narrowing at all.
  const selected = value.questionTypes ?? DECISION_QUESTION_TYPES;
  const setQuestionTypes = (next: DecisionQuestionType[]) => {
    const kept = DECISION_QUESTION_TYPES.filter(type => next.includes(type));
    const { questionTypes: _ignored, ...rest } = value;
    onChange(kept.length === DECISION_QUESTION_TYPES.length ? rest : { ...rest, questionTypes: kept });
  };

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

    <Field className="min-w-0" hint={t('dashboard.upstreamEditor.models.decisionQuestionTypesHint')} label={t('dashboard.upstreamEditor.models.decisionQuestionTypes')}>
      <div className="flex flex-wrap gap-4">
        {DECISION_QUESTION_TYPES.map(type => (
          <Checkbox
            key={type}
            checked={selected.includes(type)}
            disabled={readOnly}
            label={QUESTION_TYPE_LABELS[type]}
            onChange={(_, data) => {
              const next = data.checked ? [...selected, type] : selected.filter(candidate => candidate !== type);
              // A target that answers no primitive would reject every request;
              // the last enabled box stays on.
              if (next.length > 0) setQuestionTypes(next);
            }}
          />
        ))}
      </div>
    </Field>
  </div>;
}
