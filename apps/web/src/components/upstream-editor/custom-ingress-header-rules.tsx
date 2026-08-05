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

type CustomValues = Omit<UpstreamEditorValues, 'config'> & {
  config: Extract<UpstreamRecord, { kind: 'custom' }>['config'];
};

export function CustomIngressHeaderRules() {
  const { t } = useTranslation();
  const { control } = useFormContext<CustomValues>();
  const { append, fields, remove } = useFieldArray({ control, name: 'config.ingressHeadersRules' });

  return <EditorSection
    hint={t('dashboard.upstreamEditor.headers.description')}
    level={3}
    title={t('dashboard.upstreamEditor.headers.title')}
  >
    <div className="grid gap-2">
      <div aria-hidden="true" className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] gap-2 px-1">
        <Text size={200} weight="semibold">{t('dashboard.upstreamEditor.headers.key')}</Text>
        <Text size={200} weight="semibold">{t('dashboard.upstreamEditor.headers.value')}</Text>
        <span />
      </div>
      {fields.map((field, index) => <IngressHeaderRuleRow
        appendBlank={() => append({ key: '', value: null }, { shouldFocus: false })}
        index={index}
        isBlankRow={index === fields.length - 1}
        key={field.id}
        onRemove={() => remove(index)}
      />)}
    </div>
  </EditorSection>;
}

function IngressHeaderRuleRow({
  appendBlank,
  index,
  isBlankRow,
  onRemove,
}: {
  appendBlank: () => void;
  index: number;
  isBlankRow: boolean;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const { control } = useFormContext<CustomValues>();
  const labelId = useId();
  const rowNumber = index + 1;
  const keyName = `config.ingressHeadersRules.${index}.key` as const;
  const valueName = `config.ingressHeadersRules.${index}.value` as const;
  const headerName = useWatch({ control, name: keyName });
  const { errors } = useFormState({ control, name: [keyName, valueName] });
  const ruleErrors = (errors.config as { ingressHeadersRules?: Array<{ key?: FieldError; value?: FieldError }> } | undefined)
    ?.ingressHeadersRules?.[index];
  const valueDisabled = headerName.trim() === '';

  return <div aria-labelledby={labelId} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] items-start gap-2" role="group">
    <span className="sr-only" id={labelId}>{t('dashboard.upstreamEditor.headers.row', { number: rowNumber })}</span>
    <Controller
      control={control}
      name={keyName}
      render={({ field }) => <Field
        className="min-w-0"
        validationMessage={ruleErrors?.key?.message ? t(ruleErrors.key.message) : undefined}
        validationState={ruleErrors?.key ? 'error' : undefined}
      >
        <Input
          aria-label={t('dashboard.upstreamEditor.headers.keyForRow', { number: rowNumber })}
          autoComplete="off"
          className="font-mono"
          name={field.name}
          onBlur={() => {
            const key = field.value.trim().toLowerCase();
            field.onChange(key);
            field.onBlur();
            if (key === '' && !isBlankRow) onRemove();
          }}
          onChange={(_, data) => {
            field.onChange(data.value);
            if (isBlankRow && data.value.trim() !== '') appendBlank();
          }}
          placeholder="x-client-request-id"
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
        const placeholder = field.value === null
          ? t('dashboard.upstreamEditor.headers.passthrough')
          : field.value === ''
            ? t('dashboard.upstreamEditor.headers.empty')
            : undefined;
        return <Field
          className="min-w-0"
          validationMessage={ruleErrors?.value?.message ? t(ruleErrors.value.message) : undefined}
          validationState={ruleErrors?.value ? 'error' : undefined}
        >
          <Combobox
            aria-label={t('dashboard.upstreamEditor.headers.valueForRow', { number: rowNumber })}
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
            placeholder={valueDisabled ? undefined : placeholder}
            ref={field.ref}
            selectedOptions={field.value === null ? [PASSTHROUGH_OPTION] : field.value === '' ? [EMPTY_OPTION] : []}
            spellCheck={false}
            value={field.value ?? ''}
          >
            <Option value={PASSTHROUGH_OPTION}>{t('dashboard.upstreamEditor.headers.passthrough')}</Option>
            <Option value={EMPTY_OPTION}>{t('dashboard.upstreamEditor.headers.empty')}</Option>
          </Combobox>
        </Field>;
      }}
    />
    <TooltipIconButton
      danger
      disabled={isBlankRow}
      icon={<DeleteRegular />}
      label={t('dashboard.upstreamEditor.headers.remove', { number: rowNumber })}
      onClick={onRemove}
    />
  </div>;
}
