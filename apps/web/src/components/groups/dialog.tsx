import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { GroupIdentity } from './identity';
import { api, callApi } from '../../api/client';
import type { ControlPlaneGroup } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { HUE_RAIL_GRADIENT, pickDistinctHue } from '../../lib/hue';
import { DialogShell } from '../ui/dialog-shell';
import { Input } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { useDiscardGuard } from '../ui/use-discard-guard';

const { Button, ColorSlider, DialogActions, DialogTitle, Field } = fluentComponents;
interface GroupForm { name: string; hue: number }

export function GroupDialog({ group, groups, onOpenChange, onSaved, open }: {
  group?: ControlPlaneGroup;
  groups: ControlPlaneGroup[];
  onOpenChange: (open: boolean) => void;
  onSaved: (id: number) => Promise<void>;
  open: boolean;
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { control, handleSubmit, formState: { errors } } = useForm<GroupForm>({
    resolver: zodResolver(z.object({ name: z.string().trim().min(1).max(64), hue: z.number().int().min(0).max(359) })),
    defaultValues: { name: group?.name ?? '', hue: group?.hue ?? pickDistinctHue(groups.map(candidate => candidate.hue)) },
  });
  const values = useWatch({ control }) as GroupForm;
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { discardConfirmation, requestClose } = useDiscardGuard({ onClose: close, values });

  const save = async (form: GroupForm) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    const name = form.name.trim();
    const handle = toasts.start(t(`dashboard.groupsManagement.toast.${group ? 'edit' : 'create'}.pending`, { name }));
    const body = { name, hue: form.hue };
    const result = group
      ? await callApi(() => api.api.groups[':id'].$patch({ param: { id: String(group.id) }, json: body }))
      : await callApi(() => api.api.groups.$post({ json: body }));
    setSaving(false);
    if (result.error) {
      handle.settle();
      setError(result.error.message);
      return;
    }
    handle.succeed(t(`dashboard.groupsManagement.toast.${group ? 'edit' : 'create'}.success`, { name }));
    onOpenChange(false);
    await onSaved(result.data.id);
  };

  return <>{discardConfirmation}<DialogShell
    actions={<DialogActions>
      <Button disabled={saving} onClick={requestClose}>{t('common.cancel')}</Button>
      <Button appearance="primary" disabledFocusable={saving} type="submit">{t(group ? 'dashboard.groupsManagement.actions.save' : 'dashboard.groupsManagement.actions.create')}</Button>
    </DialogActions>}
    onOpenChange={(_, event) => !event.open && !saving && requestClose()}
    onSubmit={() => void handleSubmit(save)()}
    open={open}
    title={<DialogTitle>{t(group ? 'dashboard.groupsManagement.dialog.editTitle' : 'dashboard.groupsManagement.dialog.createTitle', { name: group?.name ?? '' })}</DialogTitle>}
  >
    <Controller control={control} name="name" render={({ field }) => <Field label={t('dashboard.groupsManagement.fields.name')} validationState={errors.name ? 'error' : undefined} validationMessage={errors.name ? t('dashboard.groupsManagement.invalidName') : undefined}><Input {...field} autoComplete="off" disabled={saving} maxLength={64} spellCheck={false} /></Field>} />
    <Controller control={control} name="hue" render={({ field }) => <Field label={t('dashboard.groupsManagement.fields.hue')}>
      <ColorSlider
        aria-label={t('dashboard.groupsManagement.fields.hue')}
        channel="hue"
        className="!w-full"
        color={{ h: field.value, s: 1, v: 1 }}
        disabled={saving}
        onChange={(_, data) => field.onChange(Math.round(data.color.h) % 360)}
        rail={{ style: { backgroundImage: HUE_RAIL_GRADIENT } }}
      />
      <div className="inline-flex min-w-0 mt-2"><GroupIdentity group={{ name: values.name.trim() || t('dashboard.groupsManagement.dialog.createTitle'), hue: values.hue }} /></div>
    </Field>} />
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
  </DialogShell></>;
}
