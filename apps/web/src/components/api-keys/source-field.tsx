import { useId } from 'react';

import type { KeySource } from './source';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { ChoiceGroup } from '../ui/choice-group';
import { useDangerTextClass } from '../ui/danger';
import { Input } from '../ui/fluent-form-controls';

const { Text } = fluentComponents;

export function KeySourceControl({
  customKey,
  disabled,
  error,
  onCustomKeyChange,
  onSourceChange,
  source,
}: {
  customKey: string;
  disabled: boolean;
  error?: string;
  onCustomKeyChange: (value: string) => void;
  onSourceChange: (value: KeySource) => void;
  source: KeySource;
}) {
  const { t } = useTranslation();
  const dangerText = useDangerTextClass();
  const label = t('dashboard.apiKeys.form.customKey');
  const errorId = useId();

  return (
    <div
      aria-describedby={error ? errorId : undefined}
      aria-label={label}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 min-w-0 max-[620px]:grid-cols-1"
      role="group"
    >
      <ChoiceGroup
        ariaLabel={label}
        items={[
          { value: 'generate', label: t('dashboard.apiKeys.source.generate'), disabled },
          { value: 'custom', label: t('dashboard.apiKeys.source.custom'), disabled },
        ]}
        onChange={value => onSourceChange(value as KeySource)}
        value={source}
      />
      <Input
        aria-invalid={Boolean(error)}
        aria-label={label}
        disabled={disabled || source !== 'custom'}
        onChange={(_, data) => onCustomKeyChange(data.value)}
        placeholder={t('dashboard.apiKeys.form.customKeyPlaceholder')}
        value={customKey}
      />
      {error && (
        <Text
          className={`col-start-2 max-[620px]:col-start-1 ${dangerText}`}
          id={errorId}
          role="alert"
          size={200}
        >
          {error}
        </Text>
      )}
    </div>
  );
}
