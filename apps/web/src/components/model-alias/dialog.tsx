import { AddRegular, Eye24Regular, Info24Regular } from '@fluentui/react-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useMemo, useState } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { computeAnnouncedMetadata } from './announced-metadata';
import { aliasBody, aliasDefaults, blankTarget, kindAnnouncesMetadata, metadataForKind, type AliasFormValues } from './form-data';
import { MetadataEditor } from './metadata-editor';
import { AliasTargetRow } from './target-row';
import { announcedMetadataIssues, targetIssue, ANNOUNCED_METADATA_FIELDS } from './validation';
import { computeAliasWarnings, modelAliasWarningText, realModelIdsOfKind } from './warnings';
import { api, callApi } from '../../api/client';
import type { ControlPlaneModel } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { issuesFromErrors } from '../../lib/form-issues';
import { indexCatalog } from '../models/catalog-index';
import { ChoiceGroup } from '../ui/choice-group';
import { useDangerTextClass } from '../ui/danger';
import { DialogShell } from '../ui/dialog-shell';
import { Dropdown, Input } from '../ui/fluent-form-controls';
import { TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { SectionHeader } from '../ui/section-header';
import { SettingsCard, SettingsExpander, SettingsSwitch } from '../ui/settings-card';
import { useDiscardGuard } from '../ui/use-discard-guard';
import { MODEL_KINDS, type ModelAlias, type ModelKind } from '@floway-dev/protocols/common';

const { Button, DialogActions, DialogTitle, Field, Option, Text } = fluentComponents;

export function AliasDialog({ aliases, models, onOpenChange, open, onSaved, record }: {
  aliases: readonly ModelAlias[];
  models: readonly ControlPlaneModel[] | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onSaved: () => Promise<void>;
  record: ModelAlias | null;
}) {
  const { t } = useTranslation();
  const dangerText = useDangerTextClass();
  const toasts = useOutcomeToasts();
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const schema = useMemo(() => z.object({
    name: z.string().trim().min(1, 'dashboard.modelAliases.validation.nameRequired'),
    displayName: z.string(),
    kind: z.enum(MODEL_KINDS),
    selection: z.enum(['first-available', 'random']),
    visible: z.boolean(),
    targets: z.array(z.object({ target_model_id: z.string(), rules: z.any().refine(value => value !== undefined) })).min(1),
    manualMetadata: z.boolean(),
    announcedMetadata: z.any().refine(value => value !== undefined),
  }).superRefine((values, ctx) => {
    if (aliases.some(alias => alias.name === values.name.trim() && alias.name !== record?.name)) ctx.addIssue({ code: 'custom', message: 'dashboard.modelAliases.validation.duplicate', path: ['name'] });
    values.targets.forEach((target, index) => {
      const issue = targetIssue(target);
      if (issue) ctx.addIssue({ code: 'custom', message: issue, path: ['targets', index, 'target_model_id'] });
    });
    for (const [field, message] of Object.entries(announcedMetadataIssues(values.announcedMetadata))) {
      ctx.addIssue({ code: 'custom', message, path: ['announcedMetadata', field] });
    }
  }), [aliases, record?.name]);
  const { control, formState: { errors }, handleSubmit, setValue } = useForm<AliasFormValues>({ resolver: zodResolver(schema), defaultValues: aliasDefaults(record) });
  // useWatch is typed DeepPartial, but every field has a default and useFieldArray keeps target rows whole.
  const values = useWatch({ control }) as AliasFormValues;
  const targets = values.targets;
  const kind = values.kind;
  const { append, fields, move, remove, replace } = useFieldArray({ control, name: 'targets' });
  const catalog = useMemo(() => indexCatalog(models), [models]);
  const automaticMetadata = useMemo(() => computeAnnouncedMetadata(targets, kind, catalog), [catalog, kind, targets]);
  const targetIds = useMemo(() => realModelIdsOfKind(models, kind), [kind, models]);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { discardConfirmation, requestClose } = useDiscardGuard({ onClose: close, values });
  const aliasWarnings = computeAliasWarnings({ name: values.name.trim(), targets }, models === null ? null : catalog);

  const changeKind = (next: ModelKind) => {
    setValue('kind', next, { shouldValidate: true });
    replace(targets.map(target => ({ ...target, rules: {} })));
    if (!kindAnnouncesMetadata(next)) setValue('manualMetadata', false);
    setValue('announcedMetadata', metadataForKind(next, values.announcedMetadata));
  };
  const setManual = (enabled: boolean) => {
    setValue('manualMetadata', enabled);
    setValue('announcedMetadata', enabled ? structuredClone(automaticMetadata) : {});
  };
  const save = async (form: AliasFormValues) => {
    // disabledFocusable keeps the submit button usable while saving, so this guard is what makes a second press inert.
    if (saving) return;
    setSaving(true); setServerError(null);
    try {
      const name = form.name.trim();
      const body = aliasBody(form);
      const handle = toasts.start(t('dashboard.modelAliases.toast.save.pending', { name }));
      const result = record
        ? await callApi(() => api.api.aliases[':id'].$put({ param: { id: record.id }, json: body }))
        : await callApi(() => api.api.aliases.$post({ json: body }));
      if (result.error) { handle.settle(); setServerError(result.error.message); return; }
      onOpenChange(false);
      handle.succeed(t('dashboard.modelAliases.toast.save.success', { name }));
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return <>{discardConfirmation}<DialogShell
    width="editor"
    open={open}
    onOpenChange={(_, data) => { if (!data.open && !saving) requestClose(); }}
    onSubmit={() => void handleSubmit(save)()}
    title={<DialogTitle>{record ? t('dashboard.modelAliases.dialog.editTitle', { name: record.name }) : t('dashboard.modelAliases.dialog.createTitle')}</DialogTitle>}
    actions={<DialogActions><Button disabled={saving} onClick={requestClose}>{t('common.cancel')}</Button><Button appearance="primary" disabledFocusable={saving} type="submit">{t('dashboard.modelAliases.actions.save')}</Button></DialogActions>}
  >
    <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>
      <Controller control={control} name="name" render={({ field }) => <Field label={t('dashboard.modelAliases.form.name')} validationMessage={errors.name?.message ? t(errors.name.message) : undefined} validationState={errors.name ? 'error' : undefined}><Input {...field} className="font-mono" disabled={saving} placeholder={t('dashboard.modelAliases.form.namePlaceholder')} /></Field>} />
      <Controller control={control} name="displayName" render={({ field }) => <Field label={t('dashboard.modelAliases.form.displayName')}><Input {...field} disabled={saving} placeholder={values.name || t('dashboard.modelAliases.form.displayPlaceholder')} /></Field>} />
      <Controller control={control} name="kind" render={({ field }) => <Field label={t('dashboard.modelAliases.form.kind')}><Dropdown disabled={saving} selectedOptions={[field.value]} value={t(`dashboard.modelAliases.kind.${field.value}`)} onOptionSelect={(_, data) => data.optionValue !== undefined && changeKind(data.optionValue as ModelKind)}>{MODEL_KINDS.map(modelKind => <Option key={modelKind} value={modelKind}>{t(`dashboard.modelAliases.kind.${modelKind}`)}</Option>)}</Dropdown></Field>} />
      <Field label={t('dashboard.modelAliases.form.selection')}><ChoiceGroup ariaLabel={t('dashboard.modelAliases.form.selection')} value={values.selection} onChange={value => setValue('selection', value as AliasFormValues['selection'])} items={[{ value: 'first-available', label: t('dashboard.modelAliases.selection.first') }, { value: 'random', label: t('dashboard.modelAliases.selection.random') }]} /></Field>
    </div>
    <section className="grid gap-2" role="group" aria-labelledby="alias-targets-heading">
      <SectionHeader
        description={t('dashboard.modelAliases.target.description')}
        level={3}
        title={t('dashboard.modelAliases.target.heading')}
        titleId="alias-targets-heading"
        actions={<Button className="!whitespace-nowrap" disabled={saving} icon={<AddRegular />} onClick={() => append(blankTarget())}>{t('dashboard.modelAliases.actions.addTarget')}</Button>}
      />
      {fields.map((field, index) => <AliasTargetRow key={field.id} disabled={saving} error={errors.targets?.[index]?.target_model_id?.message ? t(errors.targets[index].target_model_id.message) : undefined} index={index} isFirst={index === 0} isLast={index === fields.length - 1} isSole={fields.length === 1} catalog={catalog} kind={kind} target={targets[index] ?? field} targetIds={targetIds} onChange={target => setValue(`targets.${index}`, target, { shouldDirty: true, shouldValidate: true })} onMove={direction => move(index, index + direction)} onRemove={() => remove(index)} />)}
      {errors.targets?.message && <Text className={dangerText} role="alert" size={200}>{t(errors.targets.message)}</Text>}
    </section>
    {kindAnnouncesMetadata(kind) && <SettingsExpander
      action={<SettingsSwitch checked={values.manualMetadata} disabled={saving} label={t('dashboard.modelAliases.metadata.manual')} onChange={setManual} />}
      description={t('dashboard.modelAliases.metadata.description')}
      icon={<Info24Regular />}
      header={t('dashboard.modelAliases.metadata.heading')}
      revealOn={errors.announcedMetadata !== undefined}
      toggledOn={values.manualMetadata}
    >
      <MetadataEditor disabled={saving} issues={issuesFromErrors(errors.announcedMetadata, ANNOUNCED_METADATA_FIELDS)} kind={kind} readOnly={!values.manualMetadata} value={values.manualMetadata ? values.announcedMetadata : automaticMetadata} onChange={value => setValue('announcedMetadata', value, { shouldValidate: true })} />
    </SettingsExpander>}
    {aliasWarnings.length > 0 && <OutcomeMessageBar intent="warning">{aliasWarnings.map(warning => <Text key={warning.type}>{modelAliasWarningText(warning, t)}</Text>)}</OutcomeMessageBar>}
    <SettingsCard
      action={<SettingsSwitch checked={values.visible} disabled={saving} label={t('dashboard.modelAliases.form.visible')} onChange={checked => setValue('visible', checked)} />}
      description={t('dashboard.modelAliases.form.visibleHint')}
      header={t('dashboard.modelAliases.form.visible')}
      icon={<Eye24Regular />}
    />
    {serverError && <OutcomeMessageBar onDismiss={() => setServerError(null)}>{serverError}</OutcomeMessageBar>}
  </DialogShell></>;
}
