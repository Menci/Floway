import {
  DeleteRegular,
  EditRegular,
  KeyRegular,
  PersonKey24Regular,
} from '@fluentui/react-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { redirect, useOutletContext } from 'react-router';
import { z } from 'zod';

import type { DashboardOutletContext } from './dashboard';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import type { ControlPlaneModel, ControlPlaneUser, UpstreamOption } from '../api/types';
import { getSessionToken } from '../auth/session';
import type { Route } from './+types/dashboard-admin-users';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { DialogShell } from '../components/ui/dialog-shell';
import { Input } from '../components/ui/fluent-form-controls';
import { ResourceListActions, ResourceListEmptyState, ResourceListPanel } from '../components/ui/resource-list';
import { ScrollArea } from '../components/ui/scroll-area';
import { SettingsCard, SettingsSwitch } from '../components/ui/settings-card';
import { TableActions, TableActionsHeader } from '../components/ui/table-actions';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { UpstreamAccessControl } from '../components/upstreams/upstream-access-control';
import { fluentComponents } from '../fluent';
import { localeForLanguage } from '../i18n';
import { useAuthStore } from '../stores/auth-store';

const {
  Badge,
  Button,
  DialogActions,
  DialogTitle,
  Field,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableCellLayout,
  TableHeader,
  TableHeaderCell,
  TableRow,
} = fluentComponents;

interface UsersPageData {
  users: ControlPlaneUser[];
  upstreams: UpstreamOption[];
  models: ControlPlaneModel[];
  error: string | null;
  modelsLoaded: boolean;
  usersLoaded: boolean;
  upstreamsLoaded: boolean;
}

interface UserFormValues {
  username: string;
  password: string;
  isAdmin: boolean;
  upstreamOverride: boolean;
  upstreamIds: string[];
}

interface PasswordFormValues {
  password: string;
  confirmation: string;
}

export async function clientLoader(): Promise<UsersPageData> {
  if (!getSessionToken()) throw redirect('/');

  const user = await useAuthStore.getState().initialize();
  if (!user?.isAdmin) {
    throw redirect('/dashboard/services/api-keys');
  }

  return await loadUsersPageData();
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Users | Floway' }];
}

export default function DashboardAdminUsers({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user: actor } = useOutletContext<DashboardOutletContext>();
  const refreshAuth = useAuthStore(state => state.refresh);
  const [data, setData] = useState<UsersPageData>(loaderData);
  const [pageError, setPageError] = useState<string | null>(loaderData.error);
  const [loading, setLoading] = useState(false);
  const editorDialog = useDialogInvocation<{ kind: 'create' } | { kind: 'edit'; user: ControlPlaneUser }>();
  const passwordDialog = useDialogInvocation<ControlPlaneUser>();
  const deleteDialog = useDialogInvocation<ControlPlaneUser>();
  const [deleting, setDeleting] = useState(false);

  const reload = async () => {
    setLoading(true);
    const next = await loadUsersPageData();
    setLoading(false);
    setData(current => ({
      models: next.modelsLoaded ? next.models : current.models,
      users: next.usersLoaded ? next.users : current.users,
      upstreams: next.upstreamsLoaded ? next.upstreams : current.upstreams,
      error: next.error,
      modelsLoaded: next.modelsLoaded,
      usersLoaded: next.usersLoaded,
      upstreamsLoaded: next.upstreamsLoaded,
    }));
    setPageError(next.error);
  };

  const afterSaved = async (savedId?: number) => {
    await reload();
    if (savedId !== actor.id) return;

    const refreshed = await refreshAuth();
    if (!refreshed) {
      const error = useAuthStore.getState().error;
      if (error) setPageError(error);
    }
  };

  const deleteUser = async (target: ControlPlaneUser) => {
    setDeleting(true);
    setPageError(null);
    const result = await callApi(() =>
      api.api.users[':id'].$delete({ param: { id: String(target.id) } }));
    setDeleting(false);
    if (result.error) {
      setPageError(result.error.message);
      return;
    }
    deleteDialog.close();
    await reload();
  };

  return (
    <div className="dashboard-page">
      <DashboardPageHeader
        actions={<ResourceListActions
          createLabel={t('dashboard.users.actions.create')}
          disabled={deleting}
          onCreate={() => editorDialog.open({ kind: 'create' })}
          onRefresh={() => void reload()}
          refreshLabel={t('dashboard.users.actions.refresh')}
          refreshing={loading}
        />}
        description={t('dashboard.pages.users')}
        eyebrow={t('dashboard.groups.admin')}
        title={t('dashboard.nav.users')}
      />

      {pageError && (
        <MessageBar intent="error">
          <MessageBarBody>{pageError}</MessageBarBody>
          <MessageBarActions>
            <Button appearance="transparent" disabled={loading} onClick={() => void reload()}>
              {t('dashboard.users.actions.retry')}
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      <ResourceListPanel>
        <UsersTable
          actorId={actor.id}
          disabled={loading || deleting}
          onDelete={deleteDialog.open}
          onEdit={user => editorDialog.open({ kind: 'edit', user })}
          onResetPassword={passwordDialog.open}
          users={data.users}
        />
      </ResourceListPanel>

      {editorDialog.invocation?.value.kind === 'create' && <UserDialog
        open={editorDialog.isOpen}
        actorId={actor.id}
        key={editorDialog.invocation.key}
        mode="create"
        models={data.models}
        onOpenChange={open => { if (!open) editorDialog.close(); }}
        onSaved={() => afterSaved()}
        upstreams={data.upstreams}
      />}
      {editorDialog.invocation?.value.kind === 'edit' && <UserDialog
        open={editorDialog.isOpen}
        actorId={actor.id}
        key={editorDialog.invocation.key}
        mode="edit"
        models={data.models}
        onOpenChange={open => { if (!open) editorDialog.close(); }}
        onSaved={afterSaved}
        upstreams={data.upstreams}
        user={editorDialog.invocation.value.user}
      />}
      {passwordDialog.invocation && <PasswordDialog
        open={passwordDialog.isOpen}
        key={passwordDialog.invocation.key}
        onOpenChange={open => { if (!open) passwordDialog.close(); }}
        onSaved={reload}
        user={passwordDialog.invocation.value}
      />}
      {deleteDialog.invocation && <ConfirmDialog
        open={deleteDialog.isOpen}
        actionLabel={deleting
          ? t('dashboard.users.actions.deleting')
          : t('dashboard.users.actions.delete')}
        busy={deleting}
        key={deleteDialog.invocation.key}
        message={t('dashboard.users.delete.message', {
          username: deleteDialog.invocation.value.username,
        })}
        onConfirm={() => {
          if (!deleting) void deleteUser(deleteDialog.invocation!.value);
        }}
        onOpenChange={open => { if (!deleting && !open) deleteDialog.close(); }}
        title={t('dashboard.users.delete.title')}
      />}
    </div>
  );
}

function UsersTable({
  actorId,
  disabled,
  onDelete,
  onEdit,
  onResetPassword,
  users,
}: {
  actorId: number;
  disabled: boolean;
  onDelete: (user: ControlPlaneUser) => void;
  onEdit: (user: ControlPlaneUser) => void;
  onResetPassword: (user: ControlPlaneUser) => void;
  users: ControlPlaneUser[];
}) {
  const { i18n, t } = useTranslation();
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(localeForLanguage(i18n.resolvedLanguage), {
      dateStyle: 'medium',
    }),
    [i18n.resolvedLanguage],
  );

  if (users.length === 0) {
    return <ResourceListEmptyState>{t('dashboard.users.empty')}</ResourceListEmptyState>;
  }

  return (
    <ScrollArea axes="horizontal" className="min-w-0">
      <Table aria-label={t('dashboard.users.table.label')} className="min-w-[720px]">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t('dashboard.users.table.username')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.role')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.upstreams')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.created')}</TableHeaderCell>
            <TableActionsHeader className="!w-[116px]">
              {t('dashboard.users.table.actions')}
            </TableActionsHeader>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map(user => {
            const protectedUser = user.id === 1 || user.id === actorId;
            return (
              <TableRow key={user.id}>
                <TableCell>
                  <TableCellLayout>
                    <span className="truncate">{user.username}</span>
                  </TableCellLayout>
                </TableCell>
                <TableCell>
                  <Badge appearance="tint" color={user.isAdmin ? 'brand' : 'informative'}>
                    {t(`dashboard.users.role.${user.isAdmin ? 'admin' : 'operator'}`)}
                  </Badge>
                </TableCell>
                <TableCell>
                  {user.upstreamIds === null
                    ? t('dashboard.users.upstreams.all')
                    : t('dashboard.users.upstreams.count', { count: user.upstreamIds.length })}
                </TableCell>
                <TableCell>
                  <span title={new Date(user.createdAt).toLocaleString()}>
                    {dateFormatter.format(new Date(user.createdAt))}
                  </span>
                </TableCell>
                <TableCell>
                  <TableActions>
                    <TooltipIconButton
                      disabled={disabled}
                      icon={<EditRegular />}
                      label={t('dashboard.users.actions.edit')}
                      onClick={() => onEdit(user)}
                    />
                    <TooltipIconButton
                      disabled={disabled}
                      icon={<KeyRegular />}
                      label={t('dashboard.users.actions.resetPassword')}
                      onClick={() => onResetPassword(user)}
                    />
                    <TooltipIconButton
                      danger
                      disabled={disabled || protectedUser}
                      icon={<DeleteRegular />}
                      label={t('dashboard.users.actions.delete')}
                      onClick={() => onDelete(user)}
                    />
                  </TableActions>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

interface UserDialogCommonProps {
  actorId: number;
  models: ControlPlaneModel[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onSaved: (userId?: number) => Promise<void>;
  upstreams: UpstreamOption[];
}

type UserDialogProps = UserDialogCommonProps & (
  | { mode: 'create'; user?: never }
  | { mode: 'edit'; user: ControlPlaneUser }
);

function UserDialog(props: UserDialogProps) {
  const { actorId, mode, models, onOpenChange, onSaved, upstreams } = props;
  const { t } = useTranslation();
  const user = props.mode === 'edit' ? props.user : null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schema = useMemo(
    () => z.object({
      username: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/, 'dashboard.users.validation.username'),
      password: z.string().max(1024, 'dashboard.users.validation.passwordMax'),
      isAdmin: z.boolean(),
      upstreamOverride: z.boolean(),
      upstreamIds: z.array(z.string()),
    }).superRefine((value, ctx) => {
      if (mode === 'create' && !value.password) {
        ctx.addIssue({ code: 'custom', message: 'dashboard.users.validation.passwordRequired', path: ['password'] });
      }
      if (value.upstreamOverride && value.upstreamIds.length === 0) {
        ctx.addIssue({ code: 'custom', message: 'dashboard.upstreamAccess.validation', path: ['upstreamIds'] });
      }
    }),
    [mode],
  );
  const { control, handleSubmit, setValue, formState: { errors } } =
    useForm<UserFormValues>({
      resolver: zodResolver(schema),
      defaultValues: userFormDefaults(user),
    });
  const values = useWatch({ control }) as UserFormValues;
  const adminLocked = props.mode === 'edit' && (props.user.id === 1 || props.user.id === actorId);

  const save = async (form: UserFormValues) => {
    setSaving(true);
    setError(null);
    const upstreamIds = form.upstreamOverride ? form.upstreamIds : null;
    const result = props.mode === 'create'
      ? await callApi(() => api.api.users.$post({
          json: {
            username: form.username.trim(),
            password: form.password,
            isAdmin: form.isAdmin,
            upstreamIds,
          },
        }))
      : await callApi(() => api.api.users[':id'].$patch({
          param: { id: String(props.user.id) }, json: {
            username: form.username.trim(),
            ...(!adminLocked ? { isAdmin: form.isAdmin } : {}),
            upstreamIds,
          },
        }));
    if (result.error) {
      setSaving(false);
      setError(result.error.message);
      return;
    }
    onOpenChange(false);
    await onSaved(props.mode === 'edit' ? props.user.id : undefined);
  };

  return (
    <DialogShell
      open={props.open}
      actions={
        <DialogActions>
          <Button disabled={saving} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button appearance="primary" disabled={saving} type="submit">
            {saving ? t('dashboard.users.actions.saving') : mode === 'create'
              ? t('dashboard.users.actions.create')
              : t('dashboard.users.actions.save')}
          </Button>
        </DialogActions>
      }
      onOpenChange={(_, data) => !saving && onOpenChange(data.open)}
      onSubmit={() => void handleSubmit(save)()}
      title={<DialogTitle>{props.mode === 'create'
        ? t('dashboard.users.dialog.createTitle')
        : t('dashboard.users.dialog.editTitle', { username: props.user.username })}</DialogTitle>}
    >
      <Controller
        control={control}
        name="username"
        render={({ field }) => (
          <Field
            hint={t('dashboard.users.form.usernameHint')}
            label={t('dashboard.users.form.username')}
            validationMessage={errors.username?.message ? t(errors.username.message) : undefined}
            validationState={errors.username ? 'error' : undefined}
          >
            <Input {...field} autoComplete="off" disabled={saving} />
          </Field>
        )}
      />
      {mode === 'create' && (
        <Controller
          control={control}
          name="password"
          render={({ field }) => (
            <Field
              label={t('dashboard.users.form.password')}
              validationMessage={errors.password?.message ? t(errors.password.message) : undefined}
              validationState={errors.password ? 'error' : undefined}
            >
              <Input {...field} autoComplete="new-password" disabled={saving} type="password" />
            </Field>
          )}
        />
      )}
      <SettingsCard
        action={<SettingsSwitch
          checked={values.isAdmin}
          disabled={saving || adminLocked}
          label={t('dashboard.users.form.administrator')}
          onChange={checked => setValue('isAdmin', checked, { shouldValidate: true })}
        />}
        description={adminLocked
          ? t(props.mode === 'edit' && props.user.id === 1 ? 'dashboard.users.form.userOneLocked' : 'dashboard.users.form.selfLocked')
          : t('dashboard.users.form.administratorDescription')}
        header={t('dashboard.users.form.administrator')}
        icon={<PersonKey24Regular />}
      />
      <UpstreamAccessControl
        available={upstreams}
        disabled={saving}
        error={errors.upstreamIds?.message ? t(errors.upstreamIds.message) : null}
        ids={values.upstreamIds}
        models={models}
        onChange={next => {
          setValue('upstreamOverride', next.override, { shouldValidate: true });
          setValue('upstreamIds', next.ids, { shouldValidate: true });
        }}
        override={values.upstreamOverride}
      />
      {mode === 'create' && (
        <MessageBar intent="info"><MessageBarBody>{t('dashboard.users.createdDefaultKey')}</MessageBarBody></MessageBar>
      )}
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
    </DialogShell>
  );
}

function PasswordDialog({ onOpenChange, open, onSaved, user }: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onSaved: () => Promise<void>;
  user: ControlPlaneUser;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schema = useMemo(() => z.object({
    password: z.string().min(1, 'dashboard.users.validation.passwordRequired').max(1024, 'dashboard.users.validation.passwordMax'),
    confirmation: z.string(),
  }).refine(value => value.password === value.confirmation, {
    message: 'dashboard.users.validation.passwordMismatch',
    path: ['confirmation'],
  }), []);
  const { control, handleSubmit, formState: { errors } } = useForm<PasswordFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirmation: '' },
  });
  const save = async (values: PasswordFormValues) => {
    setSaving(true);
    setError(null);
    const result = await callApi(() => api.api.users[':id'].$patch({
      param: { id: String(user.id) },
      json: { password: values.password },
    }));
    if (result.error) {
      setSaving(false);
      setError(result.error.message);
      return;
    }
    onOpenChange(false);
    await onSaved();
  };

  return (
    <DialogShell
      open={open}
      actions={<DialogActions>
        <Button disabled={saving} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
        <Button appearance="primary" disabled={saving} type="submit">
          {saving ? t('dashboard.users.actions.saving') : t('dashboard.users.actions.save')}
        </Button>
      </DialogActions>}
      onOpenChange={(_, data) => !saving && onOpenChange(data.open)}
      onSubmit={() => void handleSubmit(save)()}
      title={<DialogTitle>{t('dashboard.users.dialog.passwordTitle', { username: user.username })}</DialogTitle>}
    >
      <Controller control={control} name="password" render={({ field }) => (
        <Field
          label={t('dashboard.users.form.newPassword')}
          validationMessage={errors.password?.message ? t(errors.password.message) : undefined}
          validationState={errors.password ? 'error' : undefined}
        >
          <Input {...field} autoComplete="new-password" disabled={saving} type="password" />
        </Field>
      )} />
      <Controller control={control} name="confirmation" render={({ field }) => (
        <Field
          label={t('dashboard.users.form.confirmPassword')}
          validationMessage={errors.confirmation?.message ? t(errors.confirmation.message) : undefined}
          validationState={errors.confirmation ? 'error' : undefined}
        >
          <Input {...field} autoComplete="new-password" disabled={saving} type="password" />
        </Field>
      )} />
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
    </DialogShell>
  );
}

function userFormDefaults(user: ControlPlaneUser | null): UserFormValues {
  return {
    username: user?.username ?? '',
    password: '',
    isAdmin: user?.isAdmin ?? false,
    upstreamOverride: user?.upstreamIds !== null && user?.upstreamIds !== undefined,
    upstreamIds: user?.upstreamIds ?? [],
  };
}

async function loadUsersPageData(): Promise<UsersPageData> {
  const [usersResult, upstreamsResult, modelsResult] = await Promise.all([
    callApi(() => api.api.users.$get()),
    callApi(() => api.api['upstream-options'].$get()),
    callApi(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } })),
  ]);
  return {
    users: usersResult.data ?? [],
    upstreams: upstreamsResult.data ?? [],
    models: modelsResult.data?.data ?? [],
    error: usersResult.error?.message ?? upstreamsResult.error?.message ?? modelsResult.error?.message ?? null,
    modelsLoaded: !!modelsResult.data,
    usersLoaded: !!usersResult.data,
    upstreamsLoaded: !!upstreamsResult.data,
  };
}
