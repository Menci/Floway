import type { ModelLimitKey } from './limits';
import { limitKeysForKind } from './limits';
import { fluentComponents } from '../../fluent';
import type { TFunction } from '../../i18n/translation';
import type { PublicModelLimits, ModelKind } from '@floway-dev/protocols/browser';

const { Field, Input } = fluentComponents;

// The three limits the gateway surfaces, in the order every editor states
// them. Labels are shared because both the upstream editor and the alias
// metadata editor name the same quantity.
const LIMIT_LABELS: Readonly<Record<ModelLimitKey, string>> = {
  max_context_window_tokens: 'dashboard.models.limits.context',
  max_prompt_tokens: 'dashboard.models.limits.prompt',
  max_output_tokens: 'dashboard.models.limits.output',
};

const LIMIT_PLACEHOLDERS: Readonly<Record<ModelLimitKey, string>> = {
  max_context_window_tokens: 'e.g. 1050000',
  max_prompt_tokens: 'e.g. 922000',
  max_output_tokens: 'e.g. 128000',
};

// Stateless by design: each editor owns how it stores a limit (an upstream row
// patches its config, an alias patches its announced metadata), so this states
// only which fields the kind has and hands back the raw string.
export function ModelLimitsFields({
  columnGapClass,
  limits,
  onChange,
  readOnly,
  t,
  kind,
  errorFor,
}: {
  columnGapClass: string;
  limits: PublicModelLimits | undefined;
  onChange: (key: ModelLimitKey, raw: string) => void;
  readOnly: boolean;
  t: TFunction;
  kind: ModelKind;
  errorFor?: (key: ModelLimitKey) => string | undefined;
}) {
  const keys = limitKeysForKind(kind);
  if (keys.length === 0) return null;
  return <div className={`grid gap-4 max-[760px]:grid-cols-1 ${columnGapClass} ${keys.length === 3 ? 'grid-cols-3' : 'grid-cols-1'}`}>
    {keys.map(key => {
      const error = errorFor?.(key);
      return <Field
        key={key}
        className="min-w-0"
        label={t(LIMIT_LABELS[key])}
        {...(error === undefined ? {} : { validationMessage: error, validationState: 'error' as const })}
      >
        <Input
          className="!w-full"
          min={0}
          placeholder={LIMIT_PLACEHOLDERS[key]}
          readOnly={readOnly}
          type="number"
          value={limits?.[key] === undefined ? '' : String(limits[key])}
          onChange={(_, data) => onChange(key, data.value)}
        />
      </Field>;
    })}
  </div>;
}
