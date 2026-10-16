import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { api, callApi } from '../../api/client';
import type { AccessRecord, ControlPlaneGroup, ControlPlaneUser } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { AccessRecordsSection } from '../access-control/records-section';
import type { ScopeExpressionData } from '../access-control/scope-expression';
import { DialogShell } from '../ui/dialog-shell';
import { Input } from '../ui/fluent-form-controls';
import { MultiselectCombobox } from '../ui/multiselect-combobox';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { useDiscardGuard } from '../ui/use-discard-guard';

const { Button, DialogActions, DialogTitle, Field } = fluentComponents;
interface GroupForm { name: string; memberIds: string[] }

export function GroupDialog({ accessData, accessRecords, group, onAccessChanged, onOpenChange, onSaved, open, users }: {
  accessData: ScopeExpressionData;
  accessRecords: AccessRecord[];
  group?: ControlPlaneGroup;
  onAccessChanged: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
  open: boolean;
  users: ControlPlaneUser[];
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { control, handleSubmit } = useForm<GroupForm>({
    resolver: zodResolver(z.object({ name: z.string().trim().min(1).max(64), memberIds: z.array(z.string()) })),
    defaultValues: { name: group?.name ?? '', memberIds: group?.memberIds.map(String) ?? [] },
  });
  const values = useWatch({ control }) as GroupForm;
  const memberIds = values.memberIds;
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { discardConfirmation, requestClose } = useDiscardGuard({ onClose: close, values });

  const save = async (form: GroupForm) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    const name = form.name.trim();
    const handle = toasts.start(t(`dashboard.groupsManagement.toast.${group ? 'edit' : 'create'}.pending`, { name }));
    const body = { name, memberIds: form.memberIds.map(Number) };
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
    await onSaved();
  };

  return <>{discardConfirmation}<DialogShell
    actions={<DialogActions>
      <Button disabled={saving} onClick={requestClose}>{t('common.cancel')}</Button>
      <Button appearance="primary" disabledFocusable={saving} type="submit">{t('dashboard.users.actions.save')}</Button>
    </DialogActions>}
    onOpenChange={(_, event) => !event.open && !saving && requestClose()}
    onSubmit={() => void handleSubmit(save)()}
    open={open}
    title={<DialogTitle>{t(group ? 'dashboard.groupsManagement.dialog.editTitle' : 'dashboard.groupsManagement.dialog.createTitle', { name: group?.name ?? '' })}</DialogTitle>}
    width="editor"
  >
    <Controller control={control} name="name" render={({ field }) => <Field label={t('dashboard.groupsManagement.fields.name')}><Input {...field} autoComplete="off" disabled={saving} spellCheck={false} /></Field>} />
    <Controller control={control} name="memberIds" render={({ field }) => <Field label={t('dashboard.groupsManagement.fields.members')}>
      <MultiselectCombobox
        closedLabel={t('dashboard.groupsManagement.members.count', { count: memberIds.length })}
        disabled={saving}
        onChange={field.onChange}
        options={users.map(user => ({ value: String(user.id), label: user.username }))}
        placeholder={t('dashboard.groupsManagement.fields.members')}
        value={field.value}
      />
    </Field>} />
    {group && <AccessRecordsSection
      data={accessData}
      onChanged={onAccessChanged}
      principal={{ kind: 'group', id: group.id }}
      records={accessRecords}
    />}
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
  </DialogShell></>;
}
