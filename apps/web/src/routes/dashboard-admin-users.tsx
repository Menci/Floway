import {
  DeleteRegular,
  EditRegular,
  KeyRegular,
  PersonKey24Regular,
} from '@fluentui/react-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { redirect } from 'react-router';
import { z } from 'zod';

import { useDashboardOutletContext } from './dashboard';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import type { ControlPlaneModel, ControlPlaneUser, UpstreamOption } from '../api/types';
import { requireAdmin } from '../auth/require-admin';
import { getSessionToken } from '../auth/session';
import type { Route } from './+types/dashboard-admin-users';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { DialogShell } from '../components/ui/dialog-shell';
import { EmptyStateLine } from '../components/ui/empty-state';
import { Input } from '../components/ui/fluent-form-controls';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { ResourceListActions, ResourceListEmptyState, ResourceListPanel } from '../components/ui/resource-list';
import { ScrollArea } from '../components/ui/scroll-area';
import { SettingsCard, SettingsSwitch } from '../components/ui/settings-card';
import { StatusBadge } from '../components/ui/status-badge';
import { TableActions, TableActionsHeader } from '../components/ui/table-actions';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { useRefresh } from '../components/ui/use-refresh';
import { UpstreamAccessControl } from '../components/upstreams/upstream-access-control';
import { refineUpstreamAccess } from '../components/upstreams/upstream-access-validation';
import { fluentComponents } from '../fluent';
import { shortDate } from '../lib/format-time';
import { useLocale } from '../lib/use-locale';
import { useAuthStore } from '../stores/auth-store';

const {
  Button,
  DialogActions,
  DialogTitle,
  Field,
  MessageBar,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableCellLayout,
  TableHeader,
  TableHeaderCell,
  TableRow,
} = fluentComponents;

// `null` is a fetch that failed, not an empty deployment: a list showing zero
// users on a gateway that certainly has at least one is a page inventing an
// answer.
interface UsersPageData {
  users: ControlPlaneUser[] | null;
  upstreams: UpstreamOption[] | null;
  models: ControlPlaneModel[] | null;
  error: string | null;
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

const loadPageData = async (
  current: Pick<UsersPageData, 'users' | 'upstreams' | 'models'>,
  signal?: AbortSignal,
): Promise<UsersPageData> => {
  const [usersResult, upstreamsResult, modelsResult] = await Promise.all([
    callApi(() => api.api.users.$get(undefined, { init: { signal } })),
    callApi(() => api.api['upstream-options'].$get(undefined, { init: { signal } })),
    callApi(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } }, { init: { signal } })),
  ]);
  return {
    users: usersResult.data ?? current.users,
    upstreams: upstreamsResult.data ?? current.upstreams,
    models: modelsResult.data?.data ?? current.models,
    error: usersResult.error?.message ?? upstreamsResult.error?.message ?? modelsResult.error?.message ?? null,
  };
};

const unloadedPageData: Pick<UsersPageData, 'users' | 'upstreams' | 'models'> = { users: null, upstreams: null, models: null };

export async function clientLoader(): Promise<UsersPageData> {
  if (!getSessionToken()) throw redirect('/');

  if (!(await requireAdmin())) throw redirect('/dashboard/services/api-keys');
  return await loadPageData(unloadedPageData);
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Users | Floway' }];
}

export default function DashboardAdminUsers({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user: actor } = useDashboardOutletContext();
  const refreshAuth = useAuthStore(state => state.refresh);
  const toasts = useOutcomeToasts();
  const [data, setData] = useState<UsersPageData>(loaderData);
  const [pageError, setPageError] = useState<string | null>(loaderData.error);
  const editorDialog = useDialogInvocation<{ kind: 'create' } | { kind: 'edit'; user: ControlPlaneUser }>();
  const passwordDialog = useDialogInvocation<ControlPlaneUser>();
  const deleteDialog = useDialogInvocation<ControlPlaneUser>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reload = useCallback(async (signal: AbortSignal) => {
    const next = await loadPageData(data, signal);
    if (signal.aborted) return;
    setData(next);
    setPageError(next.error);
  }, [data]);
  const { refresh, refreshing } = useRefresh(reload);

  const afterSaved = async (savedId?: number) => {
    await refresh();
    if (savedId !== actor.id) return;

    const refreshed = await refreshAuth();
    if (!refreshed) {
      const error = useAuthStore.getState().error;
      if (error) setPageError(error);
    }
  };

  const deleteUser = async (target: ControlPlaneUser) => {
    setDeleting(true);
    setDeleteError(null);
    const handle = toasts.start(t('dashboard.users.toast.delete.pending', { username: target.username }));
    const result = await callApi(() =>
      api.api.users[':id'].$delete({ param: { id: String(target.id) } }));
    setDeleting(false);
    if (result.error) {
      handle.settle();
      setDeleteError(result.error.message);
      return;
    }
    deleteDialog.close();
    handle.succeed(t('dashboard.users.toast.delete.success', { username: target.username }));
    await refresh();
  };

  const { models, upstreams, users } = data;
  const loaded = users !== null && models !== null && upstreams !== null;

  return (
    <div className="dashboard-page">
      <DashboardPageHeader
        actions={<ResourceListActions
          createLabel={t('dashboard.users.actions.create')}
          disabled={deleting || !loaded}
          onCreate={() => editorDialog.open({ kind: 'create' })}
          onRefresh={() => void refresh()}
          refreshLabel={t('dashboard.users.actions.refresh')}
          refreshing={refreshing}
        />}
        description={t('dashboard.pages.users')}
        title={t('dashboard.nav.users')}
      />

      {pageError && (
        <OutcomeMessageBar
          action={<Button appearance="transparent" disabled={refreshing} onClick={() => void refresh()}>
            {t('dashboard.users.actions.retry')}
          </Button>}
          onDismiss={() => setPageError(null)}
        >
          {pageError}
        </OutcomeMessageBar>
      )}

      {!loaded ? <Panel><EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine></Panel> : <>
        <ResourceListPanel>
          <UsersTable
            actorId={actor.id}
            disabled={refreshing || deleting}
            onDelete={deleteDialog.open}
            onEdit={user => editorDialog.open({ kind: 'edit', user })}
            onResetPassword={passwordDialog.open}
            users={users}
          />
        </ResourceListPanel>

        {editorDialog.invocation?.value.kind === 'create' && <UserDialog
          open={editorDialog.isOpen}
          actorId={actor.id}
          key={editorDialog.invocation.key}
          mode="create"
          models={models}
          onOpenChange={open => { if (!open) editorDialog.close(); }}
          onSaved={() => afterSaved()}
          upstreams={upstreams}
        />}
        {editorDialog.invocation?.value.kind === 'edit' && <UserDialog
          open={editorDialog.isOpen}
          actorId={actor.id}
          key={editorDialog.invocation.key}
          mode="edit"
          models={models}
          onOpenChange={open => { if (!open) editorDialog.close(); }}
          onSaved={afterSaved}
          upstreams={upstreams}
          user={editorDialog.invocation.value.user}
        />}
        {passwordDialog.invocation && <PasswordDialog
          open={passwordDialog.isOpen}
          key={passwordDialog.invocation.key}
          onOpenChange={open => { if (!open) passwordDialog.close(); }}
          onSaved={refresh}
          user={passwordDialog.invocation.value}
        />}
        {deleteDialog.invocation && <ConfirmDialog
          open={deleteDialog.isOpen}
          actionLabel={deleting
            ? t('dashboard.users.actions.deleting')
            : t('dashboard.users.actions.delete')}
          busy={deleting}
          error={deleteError}
          key={deleteDialog.invocation.key}
          message={t('dashboard.users.delete.message', {
            username: deleteDialog.invocation.value.username,
          })}
          onConfirm={() => {
            if (!deleting) void deleteUser(deleteDialog.invocation!.value);
          }}
          onDismissError={() => setDeleteError(null)}
          onOpenChange={open => { if (!deleting && !open) deleteDialog.close(); }}
          title={t('dashboard.users.delete.title')}
        />}
      </>}
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
  const { t } = useTranslation();
  const locale = useLocale();

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
                  <StatusBadge color={user.isAdmin ? 'brand' : 'informative'}>
                    {t(`dashboard.users.role.${user.isAdmin ? 'admin' : 'operator'}`)}
                  </StatusBadge>
                </TableCell>
                <TableCell>
                  {user.upstreamIds === null
                    ? t('dashboard.users.upstreams.all')
                    : t('dashboard.users.upstreams.count', { count: user.upstreamIds.length })}
                </TableCell>
                <TableCell>
                  <span title={new Date(user.createdAt).toLocaleString()}>
                    {shortDate(user.createdAt, locale)}
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
  const toasts = useOutcomeToasts();
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
      refineUpstreamAccess(value, ctx);
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
    try {
      const username = form.username.trim();
      const upstreamIds = form.upstreamOverride ? form.upstreamIds : null;
      const handle = toasts.start(t(`dashboard.users.toast.${mode}.pending`, { username }));
      const result = props.mode === 'create'
        ? await callApi(() => api.api.users.$post({
            json: {
              username,
              password: form.password,
              isAdmin: form.isAdmin,
              upstreamIds,
            },
          }))
        : await callApi(() => api.api.users[':id'].$patch({
            param: { id: String(props.user.id) }, json: {
              username,
              ...(!adminLocked ? { isAdmin: form.isAdmin } : {}),
              upstreamIds,
            },
          }));
      if (result.error) {
        handle.settle();
        setError(result.error.message);
        return;
      }
      onOpenChange(false);
      handle.succeed(t(`dashboard.users.toast.${mode}.success`, { username }));
      await onSaved(props.mode === 'edit' ? props.user.id : undefined);
    } finally {
      setSaving(false);
    }
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
      {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
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
  const toasts = useOutcomeToasts();
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
    try {
      const handle = toasts.start(t('dashboard.users.toast.password.pending', { username: user.username }));
      const result = await callApi(() => api.api.users[':id'].$patch({
        param: { id: String(user.id) },
        json: { password: values.password },
      }));
      if (result.error) {
        handle.settle();
        setError(result.error.message);
        return;
      }
      onOpenChange(false);
      handle.succeed(t('dashboard.users.toast.password.success', { username: user.username }));
      await onSaved();
    } finally {
      setSaving(false);
    }
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
      {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    </DialogShell>
  );
}

const userFormDefaults = (user: ControlPlaneUser | null): UserFormValues => {
  return {
    username: user?.username ?? '',
    password: '',
    isAdmin: user?.isAdmin ?? false,
    upstreamOverride: user?.upstreamIds !== null && user?.upstreamIds !== undefined,
    upstreamIds: user?.upstreamIds ?? [],
  };
};
