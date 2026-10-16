import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { ScopeExpression, type ScopeExpressionData } from './scope-expression';
import { api, callApi } from '../../api/client';
import type { AccessRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { DialogShell } from '../ui/dialog-shell';
import { Dropdown, Input, Textarea } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import type { AccessPrincipal, AccessScope, AccessValues, UpstreamEditLevel } from '@floway-dev/gateway/browser';

const { Button, DialogActions, DialogTitle, Field, Option, Tab, TabList } = fluentComponents;

const modelPatternSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), value: z.string().min(1) }),
  z.object({ kind: z.literal('regex'), value: z.string().min(1) }).superRefine((value, context) => {
    try { new RegExp(value.value); } catch (cause) { context.addIssue({ code: 'custom', message: cause instanceof Error ? cause.message : String(cause) }); }
  }),
]);
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upstreams') }),
  z.object({ kind: z.literal('upstream'), upstreamId: z.string().min(1) }),
  z.object({ kind: z.literal('upstreamModel'), upstreamId: z.string().min(1), model: modelPatternSchema }),
  z.object({ kind: z.literal('users') }),
  z.object({ kind: z.literal('user'), userId: z.number().int().positive() }),
  z.object({ kind: z.literal('group'), groupId: z.number().int().positive() }),
]);

type Permission = keyof AccessValues;
interface FormValues { principal: string; sortOrder: number }

export function AccessRecordDialog({ data, fixedPrincipal, onOpenChange, onSaved, open, record, suggestedSortOrder = 0 }: {
  data: ScopeExpressionData;
  fixedPrincipal?: AccessPrincipal;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
  open: boolean;
  record?: AccessRecord;
  suggestedSortOrder?: number;
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [scope, setScope] = useState<AccessScope | null>(record?.scope ?? { kind: 'upstreams' });
  const [scopeMode, setScopeMode] = useState<'visual' | 'json'>('visual');
  const [scopeJson, setScopeJson] = useState(() => JSON.stringify(record?.scope ?? { kind: 'upstreams' }, null, 2));
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [values, setValues] = useState<AccessValues>(record?.values ?? {});
  const [inherited, setInherited] = useState<AccessValues>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { control, handleSubmit } = useForm<FormValues>({
    resolver: zodResolver(z.object({ principal: z.string().min(1), sortOrder: z.number().int().nonnegative() })),
    defaultValues: {
      principal: principalValue(fixedPrincipal ?? record?.principal ?? { kind: 'user', id: data.users[0]?.id ?? 0 }),
      sortOrder: record?.sortOrder ?? suggestedSortOrder,
    },
  });

  const concreteTarget = scopeToTarget(scope);
  const selectedPrincipal = useWatch({ control, name: 'principal' });
  const principal = fixedPrincipal ?? parsePrincipal(selectedPrincipal);
  useEffect(() => {
    if (!open || concreteTarget === null || principal?.kind !== 'user') return;
    const controller = new AbortController();
    void callApi(() => api.api['access-resolve'].$post({
      json: {
        userId: principal.id,
        target: concreteTarget,
        ...(record ? { excludeRecordId: record.id } : {}),
      },
    }, { init: { signal: controller.signal } })).then(result => {
      if (!controller.signal.aborted && result.data) setInherited(result.data.values as AccessValues);
    });
    return () => controller.abort();
  }, [concreteTarget, open, principal, record]);

  const permissions = useMemo(() => permissionsForScope(scope), [scope]);
  const visibleInherited = concreteTarget !== null && principal?.kind === 'user' ? inherited : {};
  const changeScope = (next: AccessScope | null) => {
    setScope(next);
    const nextPermissions = permissionsForScope(next);
    setValues(current => Object.fromEntries(Object.entries(current).filter(([permission]) => nextPermissions.includes(permission as Permission))) as AccessValues);
  };

  const parseJsonScope = (): AccessScope | null => {
    try {
      const parsed = scopeSchema.parse(JSON.parse(scopeJson));
      changeScope(parsed);
      setScopeError(null);
      return parsed;
    } catch (cause) {
      setScopeError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  };
  const selectMode = (mode: 'visual' | 'json') => {
    if (mode === 'visual' && scopeMode === 'json' && parseJsonScope() === null) return;
    if (mode === 'json' && scope !== null) setScopeJson(JSON.stringify(scope, null, 2));
    setScopeMode(mode);
  };

  const save = async (form: FormValues) => {
    if (saving) return;
    const finalScope = scopeMode === 'json' ? parseJsonScope() : scope;
    if (finalScope === null) return;
    if (Object.keys(values).length === 0) {
      setError(t('dashboard.accessControl.validation.emptyRecord'));
      return;
    }
    const finalPrincipal = fixedPrincipal ?? parsePrincipal(form.principal);
    if (finalPrincipal === null) return;
    setSaving(true);
    setError(null);
    const payload = { principal: finalPrincipal, scope: finalScope, sortOrder: form.sortOrder, values };
    const handle = toasts.start(t(`dashboard.accessControl.toast.${record ? 'edit' : 'create'}.pending`));
    const result = record
      ? await callApi(() => api.api['access-records'][':id'].$put({ param: { id: String(record.id) }, json: payload }))
      : await callApi(() => api.api['access-records'].$post({ json: payload }));
    setSaving(false);
    if (result.error) {
      handle.settle();
      setError(result.error.message);
      return;
    }
    handle.succeed(t(`dashboard.accessControl.toast.${record ? 'edit' : 'create'}.success`));
    onOpenChange(false);
    await onSaved();
  };

  return <DialogShell
    actions={<DialogActions>
      <Button disabled={saving} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
      <Button appearance="primary" disabledFocusable={saving} type="submit">{t('dashboard.accessControl.actions.save')}</Button>
    </DialogActions>}
    onOpenChange={(_, event) => !event.open && !saving && onOpenChange(false)}
    onSubmit={() => void handleSubmit(save)()}
    open={open}
    title={<DialogTitle>{t(record ? 'dashboard.accessControl.dialog.editTitle' : 'dashboard.accessControl.dialog.createTitle')}</DialogTitle>}
    width="editor"
  >
    {!fixedPrincipal && <Controller control={control} name="principal" render={({ field }) => <Field label={t('dashboard.accessControl.fields.principal')}>
      <Dropdown onOptionSelect={(_, option) => option.optionValue && field.onChange(option.optionValue)} selectedOptions={[field.value]} value={principalLabel(parsePrincipal(field.value), data)}>
        {data.users.map(user => <Option key={`user:${user.id}`} value={`user:${user.id}`}>{t('dashboard.accessControl.principal.user', { name: user.username })}</Option>)}
        {data.groups.map(group => <Option key={`group:${group.id}`} value={`group:${group.id}`}>{t('dashboard.accessControl.principal.group', { name: group.name })}</Option>)}
      </Dropdown>
    </Field>} />}

    <Field label={t('dashboard.accessControl.fields.scope')} validationMessage={scopeError ?? undefined} validationState={scopeError ? 'error' : undefined}>
      <TabList onTabSelect={(_, tab) => selectMode(tab.value === 'json' ? 'json' : 'visual')} selectedValue={scopeMode} size="small">
        <Tab value="visual">{t('dashboard.accessControl.scope.visual')}</Tab>
        <Tab value="json">{t('dashboard.accessControl.scope.json')}</Tab>
      </TabList>
      {scopeMode === 'visual'
        ? <ScopeExpression data={data} onChange={next => { changeScope(next); if (next) setScopeJson(JSON.stringify(next, null, 2)); }} value={scope} />
        : <Textarea aria-label={t('dashboard.accessControl.scope.json')} autoComplete="off" className="font-mono min-h-36" name="scopeJson" onChange={event => setScopeJson(event.target.value)} spellCheck={false} value={scopeJson} />}
    </Field>

    <Controller control={control} name="sortOrder" render={({ field }) => <Field label={t('dashboard.accessControl.fields.order')}>
      <Input autoComplete="off" min={0} name={field.name} onChange={event => field.onChange(event.target.valueAsNumber)} step={1} type="number" value={String(field.value)} />
    </Field>} />

    {permissions.map(permission => <PermissionField
      inherited={visibleInherited[permission]}
      key={permission}
      onChange={value => setValues(current => {
        if (value !== undefined) return { ...current, [permission]: value };
        const next = { ...current };
        delete next[permission];
        return next;
      })}
      permission={permission}
      value={values[permission]}
    />)}
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
  </DialogShell>;
}

function PermissionField({ inherited, onChange, permission, value }: {
  inherited: boolean | UpstreamEditLevel | undefined;
  onChange: (value: boolean | UpstreamEditLevel | undefined) => void;
  permission: Permission;
  value: boolean | UpstreamEditLevel | undefined;
}) {
  const { t } = useTranslation();
  const selected = value === undefined ? 'inherit' : typeof value === 'boolean' ? value ? 'on' : 'off' : value;
  const inheritedLabel = inherited === true || inherited === 'models' || inherited === 'full'
    ? t('dashboard.accessControl.states.inheritOn')
    : t('dashboard.accessControl.states.inheritOff');
  const options = permission === 'Upstream.Edit'
    ? [['inherit', inheritedLabel], ['off', t('dashboard.accessControl.states.off')], ['models', t('dashboard.accessControl.states.models')], ['full', t('dashboard.accessControl.states.full')]] as const
    : [['inherit', inheritedLabel], ['off', t('dashboard.accessControl.states.off')], ['on', t('dashboard.accessControl.states.on')]] as const;
  return <Field label={t(`dashboard.accessControl.permissions.${permission}`)}>
    <Dropdown onOptionSelect={(_, option) => {
      if (!option.optionValue) return;
      onChange(option.optionValue === 'inherit' ? undefined : option.optionValue === 'on' ? true : option.optionValue === 'off' && permission !== 'Upstream.Edit' ? false : option.optionValue as UpstreamEditLevel);
    }} selectedOptions={[selected]} value={options.find(([key]) => key === selected)?.[1] ?? selected}>
      {options.map(([key, label]) => <Option key={key} value={key}>{label}</Option>)}
    </Dropdown>
  </Field>;
}

const permissionsForScope = (scope: AccessScope | null): Permission[] => scope?.kind === 'upstreams' || scope?.kind === 'upstream'
  ? ['Model.Use', 'Upstream.Audit', 'Upstream.Edit']
  : scope?.kind === 'upstreamModel' ? ['Model.Use'] : scope ? ['User.Audit'] : [];
const scopeToTarget = (scope: AccessScope | null) => scope?.kind === 'upstream'
  ? { kind: 'upstream' as const, upstreamId: scope.upstreamId }
  : scope?.kind === 'upstreamModel' && scope.model.kind === 'exact'
    ? { kind: 'upstreamModel' as const, upstreamId: scope.upstreamId, modelId: scope.model.value }
    : scope?.kind === 'user' ? { kind: 'user' as const, userId: scope.userId } : null;
const principalValue = (principal: AccessPrincipal) => `${principal.kind}:${principal.id}`;
const parsePrincipal = (value: string): AccessPrincipal | null => {
  const [kind, rawId] = value.split(':');
  const id = Number(rawId);
  return (kind === 'user' || kind === 'group') && Number.isInteger(id) && id > 0 ? { kind, id } : null;
};
const principalLabel = (principal: AccessPrincipal | null, data: ScopeExpressionData) => principal?.kind === 'user'
  ? data.users.find(user => user.id === principal.id)?.username ?? String(principal.id)
  : principal?.kind === 'group' ? data.groups.find(group => group.id === principal.id)?.name ?? String(principal.id) : '';
