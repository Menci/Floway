import { EditorSection } from './section';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Dropdown } from '../ui/fluent-form-controls';
import { TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { CHAT_COMPLETIONS_REASONING_TEXT_STANDARDS, CHAT_COMPLETIONS_REASONING_DATA_STANDARDS, type ChatCompletionsReasoningFormat, type ChatCompletionsReasoningOverrides } from '@floway-dev/protocols/openai-chat-completions';

const { Field, Option, Text } = fluentComponents;

export function ReasoningFormatEditor({ defaults, inherited, value, onChange, readOnly = false, providerOwned = false }: {
  defaults: ChatCompletionsReasoningFormat;
  inherited?: ChatCompletionsReasoningOverrides;
  value: ChatCompletionsReasoningOverrides;
  onChange: (value: ChatCompletionsReasoningOverrides) => void;
  readOnly?: boolean;
  providerOwned?: boolean;
}) {
  const { t } = useTranslation();
  const effective = { ...defaults, ...inherited };
  const renderChannel = (channel: 'text' | 'data', standards: readonly string[]) => {
    const selected = value[channel] ?? 'inherit';
    const source = inherited?.[channel] === undefined ? t('dashboard.upstreamEditor.reasoningFormat.flowayDefault') : t('dashboard.upstreamEditor.reasoningFormat.upstreamDefault');
    const inheritLabel = t('dashboard.upstreamEditor.reasoningFormat.inherit', { value: effective[channel], source });
    return <Field label={t(`dashboard.upstreamEditor.reasoningFormat.${channel}`)}>
      <Dropdown readOnly={readOnly} selectedOptions={[selected]} value={selected === 'inherit' ? inheritLabel : selected} onOptionSelect={(_, data) => {
        if (data.optionValue === undefined) return;
        const next = { ...value };
        if (data.optionValue === 'inherit') delete next[channel];
        else Object.assign(next, { [channel]: data.optionValue });
        onChange(next);
      }}>
        <Option value="inherit">{inheritLabel}</Option>
        {standards.map(standard => <Option key={standard} value={standard}>{standard}</Option>)}
      </Dropdown>
    </Field>;
  };
  return <EditorSection level={3} title={t('dashboard.upstreamEditor.reasoningFormat.title')} info={t('dashboard.upstreamEditor.reasoningFormat.hint')}>
    <div className={TWO_COLUMN_FORM_CLASS}>{renderChannel('text', CHAT_COMPLETIONS_REASONING_TEXT_STANDARDS)}{renderChannel('data', CHAT_COMPLETIONS_REASONING_DATA_STANDARDS)}</div>
    {providerOwned && <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.reasoningFormat.providerDecision')}</Text>}
  </EditorSection>;
}
