import type { SlotRenderFunction } from '@fluentui/react-components';
import { zodResolver } from '@hookform/resolvers/zod';
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import type { ComponentProps } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { PermissionFields } from './permission-fields';
import { PrincipalPicker } from './principal';
import { parsePrincipal, principalKey } from './principals';
import { useAccessResolution } from './resolution';
import { scopeSchema } from './scope';
import { ScopeEditor, type ScopeExpressionData } from './scope-expression';
import { scopePermissions } from './values';
import { api, callApi } from '../../api/client';
import type { AccessRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { DialogShell } from '../ui/dialog-shell';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { useDiscardGuard } from '../ui/use-discard-guard';
import type { AccessPrincipal, AccessScope, AccessValues } from '@floway-dev/gateway/browser';

const { Button, DialogActions, DialogTitle, Field, Tab, TabList } = fluentComponents;
const JsonEditor = lazy(() => import('../ui/json-editor').then(module => ({ default: module.JsonEditor })));

type Permission = keyof AccessValues;
interface FormValues { principal: string }

export function AccessRecordDialog({ data, principalData, initialPrincipal, initialScope, onOpenChange, onSaved, open, record, suggestedSortOrder = 0 }: {
  data: ScopeExpressionData;
  principalData: ScopeExpressionData;
  initialPrincipal?: AccessPrincipal;
  initialScope?: AccessScope;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
  open: boolean;
  record?: AccessRecord;
  suggestedSortOrder?: number;
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [scope, setScope] = useState<AccessScope | null>(record?.scope ?? initialScope ?? null);
  const [scopeMode, setScopeMode] = useState<'visual' | 'json'>('visual');
  const [scopeJson, setScopeJson] = useState(() => JSON.stringify(record?.scope ?? initialScope ?? null, null, 2));
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [values, setValues] = useState<AccessValues>(record?.values ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultUser = principalData.users.find(user => !user.isAdmin) ?? principalData.users[0];
  const defaultPrincipal = record?.principal ?? initialPrincipal ?? (defaultUser ? { kind: 'user' as const, id: defaultUser.id } : principalData.groups[0] ? { kind: 'group' as const, id: principalData.groups[0].id } : null);
  const { control, handleSubmit } = useForm<FormValues>({
    resolver: zodResolver(z.object({ principal: z.string().min(1) })),
    defaultValues: {
      principal: defaultPrincipal === null ? '' : principalKey(defaultPrincipal),
    },
  });

  const formValues = useWatch({ control }) as FormValues;
  const selectedPrincipal = formValues.principal;
  const principal = useMemo(() => parsePrincipal(selectedPrincipal), [selectedPrincipal]);
  const { data: resolution, error: resolutionError } = useAccessResolution({ enabled: open, principal, scope, excludeRecordId: record?.id });
  const administratorBypass = principal?.kind === 'user' && data.users.some(user => user.id === principal.id && user.isAdmin);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { discardConfirmation, requestClose } = useDiscardGuard({
    onClose: close,
    values: { formValues, scope, scopeJson, values },
  });
  const permissions = useMemo(() => scopePermissions(scope), [scope]);
  const applyScope = (next: AccessScope | null) => {
    setScope(next);
    const nextPermissions = scopePermissions(next);
    setValues(current => Object.fromEntries(Object.entries(current).filter(([permission]) => nextPermissions.includes(permission as Permission))) as AccessValues);
  };
  const changeScope = (next: AccessScope | null) => {
    applyScope(next);
    setScopeJson(JSON.stringify(next, null, 2));
    setScopeError(null);
  };
  const changeScopeJson = (next: string) => {
    setScopeJson(next);
    const parsed = scopeSchema.nullable().safeParse(parseJson(next));
    if (!parsed.success) return;
    applyScope(parsed.data);
    setScopeError(null);
  };

  const parseJsonScope = (): { scope: AccessScope | null } | null => {
    try {
      const parsed = scopeSchema.nullable().parse(JSON.parse(scopeJson));
      changeScope(parsed);
      setScopeError(null);
      return { scope: parsed };
    } catch (cause) {
      setScopeError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  };
  const selectMode = (mode: 'visual' | 'json') => {
    if (mode === 'visual' && scopeMode === 'json' && parseJsonScope() === null) return;
    if (mode === 'json') setScopeJson(JSON.stringify(scope, null, 2));
    setScopeMode(mode);
  };

  const save = async (form: FormValues) => {
    if (saving) return;
    const parsed = scopeMode === 'json' ? parseJsonScope() : { scope };
    if (parsed === null) return;
    const finalScope = validateVisualScope(parsed.scope, setScopeError, t('dashboard.accessControl.validation.scopeRequired'));
    if (finalScope === null) return;
    const finalValues = Object.fromEntries(Object.entries(values).filter(([permission]) => scopePermissions(finalScope).includes(permission as Permission))) as AccessValues;
    if (Object.keys(finalValues).length === 0) {
      setError(t('dashboard.accessControl.validation.emptyRecord'));
      return;
    }
    const finalPrincipal = parsePrincipal(form.principal);
    if (finalPrincipal === null) return;
    setSaving(true);
    setError(null);
    const sameModelBoundary = record?.scope.kind === 'upstreamModel' && finalScope.kind === 'upstreamModel'
      && record.scope.upstreamId === finalScope.upstreamId && principalKey(record.principal) === principalKey(finalPrincipal);
    const sortOrder = record && (finalScope.kind !== 'upstreamModel' || sameModelBoundary) ? record.sortOrder : suggestedSortOrder;
    const payload = { principal: finalPrincipal, scope: finalScope, sortOrder, values: finalValues };
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

  const renderScopeHeader: SlotRenderFunction<ComponentProps<typeof fluentComponents.Label>> = (Component, labelProps) => <div className="floway-scope-editor-header" data-scope-editor-header="">
    <Component {...labelProps} style={{ ...labelProps.style, paddingBlock: 0, margin: 0 }}>{t('dashboard.accessControl.fields.scope')}</Component>
    <TabList aria-label={t('dashboard.accessControl.fields.scope')} onTabSelect={(_, tab) => selectMode(tab.value === 'json' ? 'json' : 'visual')} selectedValue={scopeMode} size="small">
      <Tab disabled={saving} value="visual">{t('dashboard.accessControl.scope.visual')}</Tab>
      <Tab disabled={saving} value="json">{t('dashboard.accessControl.scope.json')}</Tab>
    </TabList>
  </div>;

  return <>{discardConfirmation}<Suspense fallback={null}><DialogShell
    actions={<DialogActions>
      <Button disabled={saving} onClick={requestClose}>{t('common.cancel')}</Button>
      <Button appearance="primary" disabledFocusable={saving} type="submit">{t('dashboard.accessControl.actions.save')}</Button>
    </DialogActions>}
    onOpenChange={(_, event) => !event.open && !saving && requestClose()}
    onSubmit={() => void handleSubmit(save)()}
    open={open}
    title={<DialogTitle>{t(record ? 'dashboard.accessControl.dialog.editTitle' : 'dashboard.accessControl.dialog.createTitle')}</DialogTitle>}
    width="editor"
  >
    <Controller control={control} name="principal" render={({ field }) => <Field className="min-w-0" label={t('dashboard.accessControl.fields.principal')}>
      <PrincipalPicker data={principalData} disabled={saving} label={t('dashboard.accessControl.fields.principal')} onChange={principal => { if (principal !== null) field.onChange(principalKey(principal)); }} value={parsePrincipal(field.value)} />
    </Field>} />
    {administratorBypass && <OutcomeMessageBar intent="info">{t('dashboard.accessControl.administratorBypass')}</OutcomeMessageBar>}

    <Field className="min-w-0" label={{ children: renderScopeHeader }} validationMessage={scopeError ?? undefined} validationState={scopeError ? 'error' : undefined}>
      <div className="min-w-0" hidden={scopeMode !== 'visual'}><ScopeEditor className="!w-full" data={data} onChange={changeScope} readOnly={saving} value={scope} /></div>
      <JsonEditor active={scopeMode === 'json'} invalid={scopeError !== null} label={t('dashboard.accessControl.scope.json')} onChange={changeScopeJson} readOnly={saving} value={scopeJson} />
    </Field>

    {permissions.length > 0 && <PermissionFields
      disabled={saving}
      inherited={resolution?.values}
      onChange={(permission, value) => setValues(current => {
        if (value !== undefined) return { ...current, [permission]: value };
        const next = { ...current };
        delete next[permission];
        return next;
      })}
      permissions={permissions}
      values={values}
    />}
    {resolutionError && <OutcomeMessageBar>{resolutionError}</OutcomeMessageBar>}
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
  </DialogShell></Suspense></>;
}

const validateVisualScope = (scope: AccessScope | null, setError: (message: string) => void, requiredMessage: string): AccessScope | null => {
  if (scope === null) {
    setError(requiredMessage);
    return null;
  }
  const parsed = scopeSchema.safeParse(scope);
  if (parsed.success) return parsed.data;
  setError(parsed.error.message);
  return null;
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};
