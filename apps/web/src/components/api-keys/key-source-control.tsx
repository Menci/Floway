import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import type { KeySource } from './key-source';
import { fluentComponents } from '../../fluent';
import { Input } from '../ui/fluent-form-controls';
import { SegmentedControl } from '../ui/segmented-control';

const { Text, makeStyles } = fluentComponents;
const useStyles = makeStyles({ fieldError: { color: 'var(--colorPaletteRedForeground1)' } });

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
  const styles = useStyles();
  const label = t('dashboard.apiKeys.form.customKey');
  const errorId = useId();

  return (
    <div
      aria-describedby={error ? errorId : undefined}
      aria-label={label}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 min-w-0 max-[620px]:grid-cols-1"
      role="group"
    >
      <SegmentedControl
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
          className={`col-start-2 max-[620px]:col-start-1 ${styles.fieldError}`}
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
