import { useId } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Switch } from '../ui/fluent-form-controls';
import type { ChatModelInfo } from '@floway-dev/protocols/browser';

const { Text } = fluentComponents;

export function ModelInputFields({ chat, onChange, disabled = false, readOnly }: {
  chat?: ChatModelInfo;
  onChange: (patch: Pick<ChatModelInfo, 'modalities' | 'image_detail_original'>) => void;
  disabled?: boolean;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const imageLabel = useId();
  const input = chat?.modalities?.input ?? ['text'] as const;
  const output = chat?.modalities?.output ?? ['text'] as const;
  const inputSwitch = (modality: typeof input[number], label: string) => {
    const checked = input.includes(modality);
    return <Switch checked={checked} disabled={disabled || (checked && input.length === 1)} readOnly={readOnly} label={label} onChange={(_, data) => {
      const next = data.checked ? [...input, modality] : input.filter(value => value !== modality);
      const textOnly = next.length === 1 && next[0] === 'text' && output.length === 1 && output[0] === 'text';
      onChange({
        modalities: textOnly ? undefined : { input: next, output },
        ...(modality === 'image' ? { image_detail_original: data.checked ? chat?.image_detail_original ?? false : undefined } : {}),
      });
    }} />;
  };
  return <>
    <div aria-labelledby={imageLabel} className="grid gap-3" role="group">
      <Text id={imageLabel} weight="semibold">{t('models.editor.imageInput')}</Text>
      <div className="flex flex-wrap gap-4">
        {inputSwitch('image', t('models.editor.imageInput'))}
        {input.includes('image') && <Switch checked={chat?.image_detail_original === true} disabled={disabled} readOnly={readOnly}
          label={t('models.editor.imageDetailOriginal')} onChange={(_, data) => onChange({ image_detail_original: data.checked })} />}
      </div>
    </div>
    <div className="flex flex-wrap gap-4">
      {inputSwitch('text', t('models.editor.textInput'))}
      {inputSwitch('audio', t('models.editor.audioInput'))}
    </div>
  </>;
}
