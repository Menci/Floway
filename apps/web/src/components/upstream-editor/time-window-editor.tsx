import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Checkbox, Input, Textarea } from '../ui/fluent-form-controls';
import { TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import type { PricingTimeWindowCoordinate } from '@floway-dev/protocols/browser';

const { Field } = fluentComponents;
const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

export function TimeWindowEditor({ value, onChange, readOnly }: {
  value: PricingTimeWindowCoordinate | undefined;
  onChange: (value: PricingTimeWindowCoordinate | undefined) => void;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const key = 'dashboard.upstreamEditor.models.timeWindow.';
  return <div className="col-span-full grid min-w-0 gap-3">
    <Checkbox
      label={t(`${key}enabled`)}
      checked={value !== undefined}
      readOnly={readOnly}
      onChange={(_, data) => onChange(data.checked ? { timeZone: 'UTC', weekdays: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '24:00' } : undefined)}
    />
    {value && <>
      <Field label={t(`${key}timeZone`)} hint={t(`${key}hint`)}>
        <Input value={value.timeZone} readOnly={readOnly} onChange={(_, data) => onChange({ ...value, timeZone: data.value })} />
      </Field>
      <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>
        <Field label={t(`${key}start`)}>
          <Input value={value.start} readOnly={readOnly} onChange={(_, data) => onChange({ ...value, start: data.value })} />
        </Field>
        <Field label={t(`${key}end`)}>
          <Input value={value.end} readOnly={readOnly} onChange={(_, data) => onChange({ ...value, end: data.value })} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t(`${key}weekdays`)}>
        {weekdays.map((day, index) => <Checkbox
          key={day}
          label={t(`${key}${day}`)}
          checked={value.weekdays.includes(index + 1)}
          readOnly={readOnly}
          onChange={(_, data) => onChange({ ...value, weekdays: data.checked ? [...value.weekdays, index + 1].toSorted((a, b) => a - b) : value.weekdays.filter(day => day !== index + 1) })}
        />)}
      </div>
      <Field label={t(`${key}excludedDates`)} hint={t(`${key}excludedDatesHint`)}>
        <Textarea
          value={value.excludedDates?.join('\n') ?? ''}
          readOnly={readOnly}
          onChange={(_, data) => onChange({ ...value, excludedDates: data.value === '' ? [] : data.value.split('\n').map(date => date.trim()) })}
        />
      </Field>
    </>}
  </div>;
}
