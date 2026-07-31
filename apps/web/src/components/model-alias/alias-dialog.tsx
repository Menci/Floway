import { AddRegular, Eye24Regular, Info24Regular } from '@fluentui/react-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useState } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { computeAnnouncedMetadata } from './announced-metadata';
import { aliasBody, aliasDefaults, blankTarget, metadataForKind, type AliasFormValues } from './form-data';
import { MetadataEditor } from './metadata-editor';
import { AliasTargetRow } from './target-row';
import { computeAliasWarnings, realModelIdsOfKind } from './warnings';
import { callApi } from '../../api/auth';
import { api } from '../../api/client';
import type { ControlPlaneModel, ModelAlias, ModelKind } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { ChoiceGroup } from '../ui/choice-group';
import { DialogShell } from '../ui/dialog-shell';
import { Dropdown, Input } from '../ui/fluent-form-controls';
import { SettingsCard, SettingsExpander, SettingsSwitch } from '../ui/settings-card';
import { MODEL_KINDS } from '@floway-dev/protocols/common';

const { Button, DialogActions, DialogTitle, Field, MessageBar, MessageBarBody, Option, Text } = fluentComponents;

export function AliasDialog({ aliases, models, onOpenChange, open, onSaved, record }: {
  aliases: readonly ModelAlias[];
  models: readonly ControlPlaneModel[] | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onSaved: () => Promise<void>;
  record: ModelAlias | null;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const schema = useMemo(() => z.object({
    name: z.string().trim().min(1, 'dashboard.modelAliases.validation.nameRequired'),
    displayName: z.string(),
    kind: z.enum(MODEL_KINDS),
    selection: z.enum(['first-available', 'random']),
    visible: z.boolean(),
    targets: z.array(z.object({ target_model_id: z.string().trim().min(1, 'dashboard.modelAliases.validation.targetRequired'), rules: z.any().refine(value => value !== undefined) })).min(1),
    manualMetadata: z.boolean(),
    announcedMetadata: z.any().refine(value => value !== undefined),
  }).superRefine((values, ctx) => {
    if (aliases.some(alias => alias.name === values.name.trim() && alias.name !== record?.name)) ctx.addIssue({ code: 'custom', message: 'dashboard.modelAliases.validation.duplicate', path: ['name'] });
    values.targets.forEach((target, index) => {
      const reasoning = target.rules.reasoning;
      if (reasoning?.budget_tokens !== undefined && (!Number.isInteger(reasoning.budget_tokens) || reasoning.budget_tokens < 0)) ctx.addIssue({ code: 'custom', message: 'dashboard.modelAliases.validation.budget', path: ['targets', index, 'target_model_id'] });
      if (reasoning?.adaptive === true && reasoning?.budget_tokens !== undefined) ctx.addIssue({ code: 'custom', message: 'dashboard.modelAliases.validation.adaptiveBudget', path: ['targets', index, 'target_model_id'] });
    });
    for (const value of Object.values(values.announcedMetadata.limits ?? {})) if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) ctx.addIssue({ code: 'custom', message: 'dashboard.modelAliases.validation.metadataNumber', path: ['announcedMetadata'] });
    const budget = values.announcedMetadata.chat?.reasoning?.budget_tokens;
    for (const value of [budget?.min, budget?.max]) if (value !== undefined && (!Number.isInteger(value) || value < 0)) ctx.addIssue({ code: 'custom', message: 'dashboard.modelAliases.validation.metadataNumber', path: ['announcedMetadata'] });
    if (values.manualMetadata && budget?.min !== undefined && budget?.max !== undefined && budget.max < budget.min) ctx.addIssue({ code: 'custom', message: 'dashboard.modelAliases.validation.metadataRange', path: ['announcedMetadata'] });
  }), [aliases, record?.name]);
  const { control, formState: { errors }, handleSubmit, setValue } = useForm<AliasFormValues>({ resolver: zodResolver(schema), defaultValues: aliasDefaults(record) });
  // Every field has a default and useFieldArray preserves complete target rows;
  // RHF still exposes useWatch as DeepPartial, so narrow at this form boundary.
  const values = useWatch({ control }) as AliasFormValues;
  const targets = values.targets;
  const kind = values.kind;
  const { append, fields, move, remove, replace } = useFieldArray({ control, name: 'targets' });
  const automaticMetadata = useMemo(() => computeAnnouncedMetadata(targets, kind, models), [kind, models, targets]);
  const targetIds = useMemo(() => realModelIdsOfKind(models, kind), [kind, models]);
  const aliasWarnings = computeAliasWarnings({ name: values.name.trim(), targets }, models);

  const changeKind = (next: ModelKind) => {
    setValue('kind', next, { shouldValidate: true });
    replace(targets.map(target => ({ ...target, rules: {} })));
    if (next === 'image') {
      setValue('manualMetadata', false);
      setValue('announcedMetadata', {});
    } else {
      setValue('announcedMetadata', metadataForKind(next, values.announcedMetadata));
    }
  };
  const setManual = (enabled: boolean) => {
    setValue('manualMetadata', enabled);
    setValue('announcedMetadata', enabled ? structuredClone(automaticMetadata) : {});
  };
  const save = async (form: AliasFormValues) => {
    setSaving(true); setServerError(null);
    const body = aliasBody(form, record);
    const result = record
      ? await callApi(() => api.api.aliases[':name'].$put({ param: { name: record.name }, json: body }))
      : await callApi(() => api.api.aliases.$post({ json: body }));
    if (result.error) { setSaving(false); setServerError(result.error.message); return; }
    onOpenChange(false); await onSaved();
  };

  return <DialogShell
    maxWidth="720px"
    open={open}
    onOpenChange={(_, data) => !saving && onOpenChange(data.open)}
    onSubmit={() => void handleSubmit(save)()}
    title={<DialogTitle>{record ? t('dashboard.modelAliases.dialog.editTitle', { name: record.name }) : t('dashboard.modelAliases.dialog.createTitle')}</DialogTitle>}
    actions={<DialogActions><Button disabled={saving} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button><Button appearance="primary" disabled={saving} type="submit">{saving ? t('dashboard.modelAliases.actions.saving') : t('dashboard.modelAliases.actions.save')}</Button></DialogActions>}
  >
    {serverError && <MessageBar intent="error"><MessageBarBody>{serverError}</MessageBarBody></MessageBar>}
    <div className="grid grid-cols-2 gap-3 max-[620px]:grid-cols-1">
      <Controller control={control} name="name" render={({ field }) => <Field required label={t('dashboard.modelAliases.form.name')} validationMessage={errors.name?.message ? t(errors.name.message) : undefined} validationState={errors.name ? 'error' : undefined}><Input {...field} className="font-mono" disabled={saving} placeholder={t('dashboard.modelAliases.form.namePlaceholder')} /></Field>} />
      <Controller control={control} name="displayName" render={({ field }) => <Field label={t('dashboard.modelAliases.form.displayName')}><Input {...field} disabled={saving} placeholder={values.name || t('dashboard.modelAliases.form.displayPlaceholder')} /></Field>} />
      <Controller control={control} name="kind" render={({ field }) => <Field label={t('dashboard.modelAliases.form.kind')}><Dropdown disabled={saving} selectedOptions={[field.value]} value={t(`dashboard.modelAliases.kind.${field.value}`)} onOptionSelect={(_, data) => data.optionValue !== undefined && changeKind(data.optionValue as ModelKind)}>{MODEL_KINDS.map(modelKind => <Option key={modelKind} value={modelKind}>{t(`dashboard.modelAliases.kind.${modelKind}`)}</Option>)}</Dropdown></Field>} />
      <Field label={t('dashboard.modelAliases.form.selection')}><ChoiceGroup ariaLabel={t('dashboard.modelAliases.form.selection')} value={values.selection} onChange={value => setValue('selection', value as AliasFormValues['selection'])} items={[{ value: 'first-available', label: t('dashboard.modelAliases.selection.first') }, { value: 'random', label: t('dashboard.modelAliases.selection.random') }]} /></Field>
    </div>
    <section className="grid gap-2" role="group" aria-labelledby="alias-targets-heading">
      <div className="flex items-center justify-between gap-3"><div className="min-w-0"><Text id="alias-targets-heading" size={400} weight="semibold">{t('dashboard.modelAliases.target.heading')}</Text><Text block size={200} className="text-fui-fg2">{t('dashboard.modelAliases.target.description')}</Text></div><Button className="!whitespace-nowrap flex-none" icon={<AddRegular />} onClick={() => append(blankTarget())}>{t('dashboard.modelAliases.actions.addTarget')}</Button></div>
      {fields.map((field, index) => <AliasTargetRow key={field.id} disabled={saving} index={index} isFirst={index === 0} isLast={index === fields.length - 1} isSole={fields.length === 1} kind={kind} models={models} target={targets[index] ?? field} targetIds={targetIds} onChange={target => setValue(`targets.${index}`, target, { shouldDirty: true, shouldValidate: true })} onMove={direction => move(index, index + direction)} onRemove={() => remove(index)} />)}
      {errors.targets?.message && <Text role="alert" className="text-fui-fg2">{t(errors.targets.message)}</Text>}
    </section>
    {kind !== 'image' && <SettingsExpander
      action={<SettingsSwitch checked={values.manualMetadata} disabled={saving} label={t('dashboard.modelAliases.metadata.manual')} onChange={setManual} />}
      description={t('dashboard.modelAliases.metadata.description')}
      expandLabel={t('dashboard.modelAliases.metadata.heading')}
      icon={<Info24Regular />}
      header={t('dashboard.modelAliases.metadata.heading')}
      toggledOn={values.manualMetadata}
    >
      <MetadataEditor disabled={saving || !values.manualMetadata} kind={kind} value={values.manualMetadata ? values.announcedMetadata : automaticMetadata} onChange={value => setValue('announcedMetadata', value, { shouldValidate: true })} />
    </SettingsExpander>}
    {aliasWarnings.length > 0 && <MessageBar intent="warning"><MessageBarBody><ul className="m-0 pl-5">{aliasWarnings.map(warning => <li key={warning.type}>{t(`dashboard.modelAliases.warnings.${warning.key}`, warning.values)}</li>)}</ul></MessageBarBody></MessageBar>}
    <SettingsCard
      action={<SettingsSwitch checked={values.visible} disabled={saving} label={t('dashboard.modelAliases.form.visible')} onChange={checked => setValue('visible', checked)} />}
      header={t('dashboard.modelAliases.form.visible')}
      icon={<Eye24Regular />}
    />
  </DialogShell>;
}
