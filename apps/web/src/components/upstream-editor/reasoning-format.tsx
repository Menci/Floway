import { EditorSection } from './section';
import { fluentComponents } from '../../fluent';
import { Trans, useTranslation, type TFunction } from '../../i18n/translation';
import { Dropdown } from '../ui/fluent-form-controls';
import { TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { CHAT_COMPLETIONS_REASONING_TEXT_STANDARDS, CHAT_COMPLETIONS_REASONING_DATA_STANDARDS, type ChatCompletionsReasoningFormat, type ChatCompletionsReasoningOverrides } from '@floway-dev/protocols/openai-chat-completions';

const { Field, Option, Text } = fluentComponents;

const STANDARD_LABELS = {
  reasoning: { field: 'reasoning' },
  'reasoning-content': { field: 'reasoning_content' },
  'reasoning-text': { field: 'reasoning_text' },
  'reasoning-opaque': { field: 'reasoning_opaque' },
  'openrouter-reasoning-details': { vendor: 'OpenRouter', field: 'reasoning_details' },
  'litellm-thinking-blocks': { vendor: 'LiteLLM', field: 'thinking_blocks' },
};

type Standard = ChatCompletionsReasoningFormat['text' | 'data'];

const standardText = (standard: Standard, t: TFunction): string => {
  if (standard === 'passthrough') return t('dashboard.upstreamEditor.reasoningFormat.passthrough');
  const label = STANDARD_LABELS[standard];
  return 'vendor' in label ? `${label.vendor} ${label.field}` : label.field;
};

function StandardLabel({ standard }: { standard: Standard }) {
  const { t } = useTranslation();
  if (standard === 'passthrough') return <>{t('dashboard.upstreamEditor.reasoningFormat.passthrough')}</>;
  const label = STANDARD_LABELS[standard];
  return <>{'vendor' in label && <>{label.vendor} </>}<span className="font-mono">{label.field}</span></>;
}

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
  const selectedFormat = { ...effective, ...value };
  const clientResponseKey = selectedFormat.text === 'passthrough'
    ? selectedFormat.data === 'passthrough' ? 'clientResponsePassthrough' : 'clientResponseData'
    : selectedFormat.data === 'passthrough' ? 'clientResponseText' : 'clientResponseBoth';
  const renderChannel = (channel: 'text' | 'data', standards: readonly Standard[]) => {
    const selected = value[channel] ?? 'inherit';
    const source = inherited?.[channel] === undefined ? t('dashboard.upstreamEditor.reasoningFormat.flowayDefault') : t('dashboard.upstreamEditor.reasoningFormat.upstreamDefault');
    const inheritLabel = t('dashboard.upstreamEditor.reasoningFormat.inherit', { value: standardText(effective[channel], t), source });
    const inheritedContent = <Trans components={{ format: <StandardLabel standard={effective[channel]} /> }} i18nKey="dashboard.upstreamEditor.reasoningFormat.inheritRich" values={{ source }} />;
    return <Field className="min-w-0" label={t(`dashboard.upstreamEditor.reasoningFormat.${channel}`)}>
      <Dropdown readOnly={readOnly} selectedOptions={[selected]} value={selected === 'inherit' ? inheritLabel : standardText(selected, t)} button={{ children: <span className="truncate">{selected === 'inherit' ? inheritedContent : <StandardLabel standard={selected} />}</span> }} onOptionSelect={(_, data) => {
        if (data.optionValue === undefined) return;
        const next = { ...value };
        if (data.optionValue === 'inherit') delete next[channel];
        else Object.assign(next, { [channel]: data.optionValue });
        onChange(next);
      }}>
        <Option text={inheritLabel} value="inherit">{inheritedContent}</Option>
        {standards.map(standard => <Option key={standard} text={standardText(standard, t)} value={standard}><StandardLabel standard={standard} /></Option>)}
      </Dropdown>
    </Field>;
  };
  return <EditorSection level={3} title={t('dashboard.upstreamEditor.reasoningFormat.title')} info={t('dashboard.upstreamEditor.reasoningFormat.hint')}>
    <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>{renderChannel('text', CHAT_COMPLETIONS_REASONING_TEXT_STANDARDS)}{renderChannel('data', CHAT_COMPLETIONS_REASONING_DATA_STANDARDS)}</div>
    <Text size={200} className="text-fui-fg2 mono-size-xs">
      <Trans i18nKey={`dashboard.upstreamEditor.reasoningFormat.${clientResponseKey}`} components={{
        text: <StandardLabel standard={selectedFormat.text} />,
        data: <StandardLabel standard={selectedFormat.data} />,
        reasoning: <span className="font-mono" />,
        opaque: <span className="font-mono" />,
      }} />
    </Text>
    {providerOwned && <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.reasoningFormat.providerDecision')}</Text>}
  </EditorSection>;
}
