import { DeleteRegular } from '@fluentui/react-icons';
import { useId } from 'react';
import { Controller, type FieldError, useFieldArray, useFormContext, useFormState, useWatch } from 'react-hook-form';

import type { UpstreamEditorValues } from './data';
import { EditorSection } from './section';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Combobox, Input } from '../ui/fluent-form-controls';
import { TooltipIconButton } from '../ui/tooltip-icon-button';

const { Field, Option, Text } = fluentComponents;

const PASSTHROUGH_OPTION = 'passthrough';
const EMPTY_OPTION = 'empty';
const VALIDATION_MESSAGE_STYLE = {
  fontSize: 'var(--fontSizeBase200)',
  lineHeight: 'var(--lineHeightBase200)',
} as const;

type CustomValues = Omit<UpstreamEditorValues, 'config'> & {
  config: Extract<UpstreamRecord, { kind: 'custom' }>['config'];
};

export function CustomIngressHeaderRules({ readOnly = false }: { readOnly?: boolean | undefined } = {}) {
  const { t } = useTranslation();
  const { control } = useFormContext<CustomValues>();
  const { append, fields, remove } = useFieldArray({ control, name: 'config.ingressHeadersRules' });

  return <EditorSection
    hint={t('upstreams.editor.headers.description')}
    level={3}
    title={t('upstreams.editor.headers.title')}
  >
    <div className="grid gap-2">
      <div aria-hidden="true" className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] gap-2 px-1">
        <Text size={200} weight="semibold">{t('upstreams.editor.headers.key')}</Text>
        <Text size={200} weight="semibold">{t('upstreams.editor.headers.value')}</Text>
        <span />
      </div>
      {fields.map((field, index) => <IngressHeaderRuleRow
        appendBlank={() => append({ key: '', value: null }, { shouldFocus: false })}
        index={index}
        isBlankRow={index === fields.length - 1}
        key={field.id}
        onRemove={() => remove(index)}
        readOnly={readOnly}
      />)}
    </div>
  </EditorSection>;
}

function IngressHeaderRuleRow({
  appendBlank,
  index,
  isBlankRow,
  onRemove,
  readOnly,
}: {
  appendBlank: () => void;
  index: number;
  isBlankRow: boolean;
  onRemove: () => void;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const { control, trigger } = useFormContext<CustomValues>();
  const labelId = useId();
  const rowNumber = index + 1;
  const keyName = `config.ingressHeadersRules.${index}.key` as const;
  const valueName = `config.ingressHeadersRules.${index}.value` as const;
  const headerName = useWatch({ control, name: keyName });
  const { errors } = useFormState({ control, name: [keyName, valueName] });
  const ruleErrors = (errors.config as { ingressHeadersRules?: Array<{ key?: FieldError; value?: FieldError }> } | undefined)
    ?.ingressHeadersRules?.[index];
  const valueDisabled = headerName.trim() === '';
  const keyValidationMessage = ruleErrors?.key?.message
    ? { children: t(ruleErrors.key.message), style: VALIDATION_MESSAGE_STYLE }
    : undefined;
  const valueValidationMessage = ruleErrors?.value?.message
    ? { children: t(ruleErrors.value.message), style: VALIDATION_MESSAGE_STYLE }
    : undefined;

  return <div aria-labelledby={labelId} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] items-start gap-2" role="group">
    <span className="sr-only" id={labelId}>{t('upstreams.editor.headers.row', { number: rowNumber })}</span>
    <Controller
      control={control}
      name={keyName}
      render={({ field }) => <Field
        className="min-w-0"
        validationMessage={keyValidationMessage}
        validationState={ruleErrors?.key ? 'error' : 'none'}
      >
        <Input
          aria-label={t('upstreams.editor.headers.keyForRow', { number: rowNumber })}
          autoComplete="off"
          className="font-mono"
          name={field.name}
          onBlur={() => {
            const key = field.value.trim().toLowerCase();
            field.onChange(key);
            field.onBlur();
            if (key === '' && !isBlankRow) onRemove();
            void trigger('config.ingressHeadersRules');
          }}
          onChange={(_, data) => {
            field.onChange(data.value);
            if (isBlankRow && data.value.trim() !== '') appendBlank();
          }}
          placeholder="x-client-request-id"
          readOnly={readOnly}
          ref={field.ref}
          spellCheck={false}
          value={field.value}
        />
      </Field>}
    />
    <Controller
      control={control}
      name={valueName}
      render={({ field }) => {
        const custom = field.value !== null && field.value !== '';
        const placeholder = valueDisabled
          ? undefined
          : field.value === null
            ? t('upstreams.editor.headers.passthrough')
            : field.value === ''
              ? t('upstreams.editor.headers.empty')
              : undefined;
        return <Field
          className="min-w-0"
          validationMessage={valueValidationMessage}
          validationState={ruleErrors?.value ? 'error' : 'none'}
        >
          <Combobox
            aria-label={t('upstreams.editor.headers.valueForRow', { number: rowNumber })}
            autoComplete="off"
            className={custom ? 'font-mono' : undefined}
            disabled={valueDisabled}
            freeform
            onBlur={field.onBlur}
            onChange={event => field.onChange(event.target.value)}
            onOptionSelect={(_, data) => {
              if (data.optionValue === PASSTHROUGH_OPTION) field.onChange(null);
              if (data.optionValue === EMPTY_OPTION) field.onChange('');
            }}
            {...(placeholder === undefined ? {} : { placeholder })}
            readOnly={readOnly}
            ref={field.ref}
            selectedOptions={field.value === null ? [PASSTHROUGH_OPTION] : field.value === '' ? [EMPTY_OPTION] : []}
            spellCheck={false}
            value={field.value ?? ''}
          >
            <Option value={PASSTHROUGH_OPTION}>{t('upstreams.editor.headers.passthrough')}</Option>
            <Option value={EMPTY_OPTION}>{t('upstreams.editor.headers.empty')}</Option>
          </Combobox>
        </Field>;
      }}
    />
    {!readOnly && <TooltipIconButton
      danger
      disabled={isBlankRow}
      icon={<DeleteRegular />}
      label={t('upstreams.editor.headers.remove', { number: rowNumber })}
      onClick={onRemove}
    />}
  </div>;
}
