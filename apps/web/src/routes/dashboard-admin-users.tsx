import {
  ArrowClockwiseRegular,
  DeleteRegular,
  EditRegular,
  KeyRegular,
  PersonAddRegular,
} from '@fluentui/react-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useId, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { redirect, useOutletContext } from 'react-router';
import { z } from 'zod';

import type { DashboardOutletContext } from './dashboard';
import { authFetch, callApi } from '../api/auth';
import { api, getCurrentSession } from '../api/client';
import type { ControlPlaneUser, UpstreamOption } from '../api/types';
import { getSessionToken } from '../auth/session';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DialogShell } from '../components/ui/dialog-shell';
import { Input } from '../components/ui/fluent-form-controls';
import { Panel } from '../components/ui/panel';
import { fluentComponents } from '../fluent';
import { localeForLanguage } from '../i18n';
import { useAuthStore } from '../stores/auth-store';
import type { Route } from './+types/dashboard-admin-users';

const {
  Badge,
  Button,
  Checkbox,
  DialogActions,
  DialogTitle,
  Field,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableCellLayout,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Tooltip,
  makeStyles,
} = fluentComponents;

interface UsersPageData {
  users: ControlPlaneUser[];
  upstreams: UpstreamOption[];
  error: string | null;
  usersLoaded: boolean;
  upstreamsLoaded: boolean;
}

interface UserFormValues {
  username: string;
  password: string;
  isAdmin: boolean;
  canViewGlobalTelemetry: boolean;
  upstreamOverride: boolean;
  upstreamIds: string[];
}

interface PasswordFormValues {
  password: string;
  confirmation: string;
}

const useStyles = makeStyles({
  dangerButton: { color: 'var(--colorPaletteRedForeground1)' },
  validationMessage: { color: 'var(--colorPaletteRedForeground1)' },
});

export async function clientLoader(): Promise<UsersPageData> {
  if (!getSessionToken()) throw redirect('/');

  const session = await getCurrentSession();
  if (session.error || !session.data.user.isAdmin) {
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
  const setAuthUser = useAuthStore(state => state.setUser);
  const [data, setData] = useState<UsersPageData>(loaderData);
  const [pageError, setPageError] = useState<string | null>(loaderData.error);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ControlPlaneUser | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<ControlPlaneUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ControlPlaneUser | null>(null);
  const [deleting, setDeleting] = useState(false);

  const reload = async () => {
    setLoading(true);
    const next = await loadUsersPageData();
    setLoading(false);
    setData(current => ({
      users: next.usersLoaded ? next.users : current.users,
      upstreams: next.upstreamsLoaded ? next.upstreams : current.upstreams,
      error: next.error,
      usersLoaded: next.usersLoaded,
      upstreamsLoaded: next.upstreamsLoaded,
    }));
    setPageError(next.error);
  };

  const afterSaved = async (savedId?: number) => {
    await reload();
    if (savedId !== actor.id) return;

    const session = await getCurrentSession();
    if (session.data) setAuthUser(session.data.user);
    else if (session.error) setPageError(session.error.message);
  };

  const deleteUser = async (target: ControlPlaneUser) => {
    setDeleting(true);
    setPageError(null);
    const result = await callApi<{ ok: true }>(() =>
      api.api.users[':id'].$delete({ param: { id: String(target.id) } }));
    setDeleting(false);
    if (result.error) {
      setPageError(result.error.message);
      return;
    }
    setDeleteTarget(null);
    await reload();
  };

  return (
    <div className="grid gap-[18px] min-w-0">
      <header className="flex items-start gap-[18px] justify-between min-w-0 max-[900px]:flex-col max-[900px]:items-stretch">
        <div className="grid gap-1 min-w-0">
          <Text size={200} weight="semibold" className="text-fui-fg2 leading-[1.2]">
            {t('dashboard.groups.admin')}
          </Text>
          <Text as="h1" size={700} weight="semibold" className="!m-0">
            {t('dashboard.nav.users')}
          </Text>
          <Text size={300} className="text-fui-fg2 leading-[1.45] max-w-[760px]">
            {t('dashboard.pages.users')}
          </Text>
        </div>
        <div className="flex items-center gap-2 flex-none">
          <Tooltip content={t('dashboard.users.actions.refresh')} relationship="label">
            <Button
              appearance="subtle"
              aria-label={t('dashboard.users.actions.refresh')}
              disabled={loading || deleting}
              icon={loading ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />}
              onClick={() => void reload()}
            />
          </Tooltip>
          <Button
            appearance="primary"
            icon={<PersonAddRegular />}
            onClick={() => setCreateOpen(true)}
          >
            {t('dashboard.users.actions.create')}
          </Button>
        </div>
      </header>

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

      <Panel className="min-w-0 !p-[10px_18px_18px]">
        <UsersTable
          actorId={actor.id}
          onDelete={setDeleteTarget}
          onEdit={setEditTarget}
          onResetPassword={setPasswordTarget}
          users={data.users}
        />
      </Panel>

      <UserDialog
        key={'create'}
        actorId={actor.id}
        mode="create"
        onOpenChange={setCreateOpen}
        onSaved={() => afterSaved()}
        open={createOpen}
        upstreams={data.upstreams}
        user={null}
      />
      <UserDialog
        key={editTarget?.id ?? 'closed'}
        actorId={actor.id}
        mode="edit"
        onOpenChange={open => { if (!open) setEditTarget(null); }}
        onSaved={afterSaved}
        open={editTarget !== null}
        upstreams={data.upstreams}
        user={editTarget}
      />
      <PasswordDialog key={passwordTarget?.id ?? 'closed'}
        onOpenChange={open => { if (!open) setPasswordTarget(null); }}
        onSaved={reload}
        open={passwordTarget !== null}
        user={passwordTarget}
      />
      <ConfirmDialog
        actionLabel={deleting
          ? t('dashboard.users.actions.deleting')
          : t('dashboard.users.actions.delete')}
        message={t('dashboard.users.delete.message', {
          username: deleteTarget?.username ?? '',
        })}
        onConfirm={() => {
          if (deleteTarget && !deleting) void deleteUser(deleteTarget);
        }}
        onOpenChange={open => { if (!open && !deleting) setDeleteTarget(null); }}
        open={deleteTarget !== null}
        title={t('dashboard.users.delete.title')}
      />
    </div>
  );
}

function UsersTable({
  actorId,
  onDelete,
  onEdit,
  onResetPassword,
  users,
}: {
  actorId: number;
  onDelete: (user: ControlPlaneUser) => void;
  onEdit: (user: ControlPlaneUser) => void;
  onResetPassword: (user: ControlPlaneUser) => void;
  users: ControlPlaneUser[];
}) {
  const { i18n, t } = useTranslation();
  const s = useStyles();
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(localeForLanguage(i18n.resolvedLanguage), {
      dateStyle: 'medium',
    }),
    [i18n.resolvedLanguage],
  );

  if (users.length === 0) {
    return <p className="text-fui-fg2 text-center py-8 m-0">{t('dashboard.users.empty')}</p>;
  }

  return (
    <div className="min-w-0 overflow-x-auto">
      <Table aria-label={t('dashboard.users.table.label')} className="min-w-[850px]">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t('dashboard.users.table.username')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.role')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.telemetry')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.upstreams')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.created')}</TableHeaderCell>
            <TableHeaderCell className="!text-right">
              {t('dashboard.users.table.actions')}
            </TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map(user => {
            const protectedUser = user.id === 1 || user.id === actorId;
            return (
              <TableRow key={user.id}>
                <TableCell>
                  <TableCellLayout>
                    <span className="font-fui-semibold truncate">{user.username}</span>
                  </TableCellLayout>
                </TableCell>
                <TableCell>
                  <Badge appearance="tint" color={user.isAdmin ? 'brand' : 'informative'}>
                    {t(`dashboard.users.role.${user.isAdmin ? 'admin' : 'operator'}`)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge appearance="tint" color={user.isAdmin || user.canViewGlobalTelemetry ? 'success' : 'subtle'}>
                    {t(`dashboard.users.state.${user.isAdmin || user.canViewGlobalTelemetry ? 'enabled' : 'scoped'}`)}
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
                  <div className="flex items-center justify-end gap-1">
                    <IconButton
                      icon={<EditRegular />}
                      label={t('dashboard.users.actions.edit')}
                      onClick={() => onEdit(user)}
                    />
                    <IconButton
                      icon={<KeyRegular />}
                      label={t('dashboard.users.actions.resetPassword')}
                      onClick={() => onResetPassword(user)}
                    />
                    <IconButton
                      className={s.dangerButton}
                      disabled={protectedUser}
                      icon={<DeleteRegular />}
                      label={t('dashboard.users.actions.delete')}
                      onClick={() => onDelete(user)}
                    />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function UserDialog({
  actorId,
  mode,
  onOpenChange,
  onSaved,
  open,
  upstreams,
  user,
}: {
  actorId: number;
  mode: 'create' | 'edit';
  onOpenChange: (open: boolean) => void;
  onSaved: (userId?: number) => Promise<void>;
  open: boolean;
  upstreams: UpstreamOption[];
  user: ControlPlaneUser | null;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schema = useMemo(
    () => z.object({
      username: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/, 'dashboard.users.validation.username'),
      password: z.string().max(1024, 'dashboard.users.validation.passwordMax'),
      isAdmin: z.boolean(),
      canViewGlobalTelemetry: z.boolean(),
      upstreamOverride: z.boolean(),
      upstreamIds: z.array(z.string()),
    }).superRefine((value, ctx) => {
      if (mode === 'create' && !value.password) {
        ctx.addIssue({ code: 'custom', message: 'dashboard.users.validation.passwordRequired', path: ['password'] });
      }
      if (value.upstreamOverride && value.upstreamIds.length === 0) {
        ctx.addIssue({ code: 'custom', message: 'dashboard.users.validation.upstreamRequired', path: ['upstreamIds'] });
      }
    }),
    [mode],
  );
  const { control, handleSubmit, setValue, watch, formState: { errors } } =
    useForm<UserFormValues>({
      resolver: zodResolver(schema),
      defaultValues: userFormDefaults(user),
    });

  const values = watch();
  const adminLocked = mode === 'edit' && !!user && (user.id === 1 || user.id === actorId);

  const save = async (form: UserFormValues) => {
    setSaving(true);
    setError(null);
    const upstreamIds = form.upstreamOverride ? form.upstreamIds : null;
    const body = mode === 'create'
      ? {
          username: form.username.trim(),
          password: form.password,
          isAdmin: form.isAdmin,
          canViewGlobalTelemetry: form.canViewGlobalTelemetry,
          upstreamIds,
        }
      : {
          username: form.username.trim(),
          ...(!adminLocked ? { isAdmin: form.isAdmin } : {}),
          canViewGlobalTelemetry: form.canViewGlobalTelemetry,
          upstreamIds,
        };
    const result = await callApi<ControlPlaneUser | { user: ControlPlaneUser }>(() =>
      authFetch(mode === 'create' ? '/api/users' : `/api/users/${user!.id}`, {
        method: mode === 'create' ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
    setSaving(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    onOpenChange(false);
    await onSaved(user?.id);
  };

  return (
    <DialogShell
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
      onOpenChange={(_, data) => onOpenChange(data.open)}
      onSubmit={() => void handleSubmit(save)()}
      open={open}
      title={<DialogTitle>{mode === 'create'
        ? t('dashboard.users.dialog.createTitle')
        : t('dashboard.users.dialog.editTitle', { username: user?.username ?? '' })}</DialogTitle>}
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
      <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
        <PermissionToggle
          checked={values.isAdmin}
          description={adminLocked
            ? t(user?.id === 1 ? 'dashboard.users.form.userOneLocked' : 'dashboard.users.form.selfLocked')
            : t('dashboard.users.form.administratorDescription')}
          disabled={saving || adminLocked}
          label={t('dashboard.users.form.administrator')}
          onChange={checked => setValue('isAdmin', checked, { shouldValidate: true })}
        />
        <PermissionToggle
          checked={values.isAdmin || values.canViewGlobalTelemetry}
          description={values.isAdmin
            ? t('dashboard.users.form.telemetryAdmin')
            : t('dashboard.users.form.telemetryDescription')}
          disabled={saving || values.isAdmin}
          label={t('dashboard.users.form.telemetry')}
          onChange={checked => setValue('canViewGlobalTelemetry', checked, { shouldValidate: true })}
        />
      </div>
      <UpstreamAccessPicker
        disabled={saving}
        error={errors.upstreamIds?.message ? t(errors.upstreamIds.message) : null}
        ids={values.upstreamIds}
        onChange={next => {
          setValue('upstreamOverride', next.override, { shouldValidate: true });
          setValue('upstreamIds', next.ids, { shouldValidate: true });
        }}
        override={values.upstreamOverride}
        upstreams={upstreams}
      />
      {mode === 'create' && (
        <MessageBar intent="info"><MessageBarBody>{t('dashboard.users.createdDefaultKey')}</MessageBarBody></MessageBar>
      )}
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
    </DialogShell>
  );
}

function PermissionToggle({ checked, description, disabled, label, onChange }: {
  checked: boolean;
  description: string;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border border-solid border-fui-stroke1 rounded-lg p-3 bg-fui-bg2 min-w-0">
      <div className="grid gap-1 min-w-0">
        <Text weight="semibold">{label}</Text>
        <Text size={200} className="text-fui-fg2 leading-[1.4]">{description}</Text>
      </div>
      <Switch
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(_, data) => onChange(!!data.checked)}
      />
    </div>
  );
}

function UpstreamAccessPicker({ disabled, error, ids, onChange, override, upstreams }: {
  disabled: boolean;
  error: string | null;
  ids: string[];
  onChange: (value: { override: boolean; ids: string[] }) => void;
  override: boolean;
  upstreams: UpstreamOption[];
}) {
  const { t } = useTranslation();
  const idPrefix = useId();
  const styles = useStyles();
  return (
    <div className="grid gap-[10px] min-w-0">
      <div className="flex items-start justify-between gap-3 border border-solid border-fui-stroke1 rounded-lg p-3 bg-fui-bg2">
        <div className="grid gap-1 min-w-0">
          <Text weight="semibold">{t('dashboard.users.upstreams.override')}</Text>
          <Text size={200} className="text-fui-fg2 leading-[1.4]">{t('dashboard.users.upstreams.description')}</Text>
        </div>
        <Switch
          aria-label={t('dashboard.users.upstreams.override')}
          checked={override}
          disabled={disabled}
          onChange={(_, next) => onChange({ override: !!next.checked, ids })}
        />
      </div>
      {override && (
        <div
          aria-describedby={error ? `${idPrefix}-error` : undefined}
          aria-invalid={error ? true : undefined}
          aria-labelledby={`${idPrefix}-label`}
          className="grid gap-1.5"
          role="group"
        >
          <Text id={`${idPrefix}-label`} weight="semibold">
            {t('dashboard.users.upstreams.select')}
          </Text>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 border border-solid border-fui-stroke1 rounded-lg p-3 max-[560px]:grid-cols-1">
            {upstreams.map((upstream, index) => (
              <Checkbox
                checked={ids.includes(upstream.id)}
                disabled={disabled}
                id={`${idPrefix}-upstream-${index}`}
                key={upstream.id}
                label={upstream.name}
                name={`available-upstream-${upstream.id}`}
                onChange={(_, data) => onChange({
                  override: true,
                  ids: data.checked
                    ? [...new Set([...ids, upstream.id])]
                    : ids.filter(id => id !== upstream.id),
                })}
              />
            ))}
          </div>
          {error && (
            <Text className={styles.validationMessage} id={`${idPrefix}-error`} role="alert" size={200}>
              {error}
            </Text>
          )}
        </div>
      )}
    </div>
  );
}

function PasswordDialog({ onOpenChange, onSaved, open, user }: {
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
  open: boolean;
  user: ControlPlaneUser | null;
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
    if (!user) return;
    setSaving(true);
    setError(null);
    const result = await callApi<ControlPlaneUser>(() =>
      authFetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: values.password }),
      }));
    setSaving(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    onOpenChange(false);
    await onSaved();
  };

  return (
    <DialogShell
      actions={<DialogActions>
        <Button disabled={saving} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
        <Button appearance="primary" disabled={saving} type="submit">
          {saving ? t('dashboard.users.actions.saving') : t('dashboard.users.actions.save')}
        </Button>
      </DialogActions>}
      onOpenChange={(_, data) => onOpenChange(data.open)}
      onSubmit={() => void handleSubmit(save)()}
      open={open}
      title={<DialogTitle>{t('dashboard.users.dialog.passwordTitle', { username: user?.username ?? '' })}</DialogTitle>}
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

function IconButton({ className, disabled, icon, label, onClick }: {
  className?: string;
  disabled?: boolean;
  icon: React.ReactElement;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip content={label} relationship="label">
      <Button
        appearance="subtle"
        aria-label={label}
        className={className}
        disabled={disabled}
        icon={icon}
        onClick={onClick}
      />
    </Tooltip>
  );
}

function userFormDefaults(user: ControlPlaneUser | null): UserFormValues {
  return {
    username: user?.username ?? '',
    password: '',
    isAdmin: user?.isAdmin ?? false,
    canViewGlobalTelemetry: user?.canViewGlobalTelemetry ?? false,
    upstreamOverride: user?.upstreamIds !== null && user?.upstreamIds !== undefined,
    upstreamIds: user?.upstreamIds ?? [],
  };
}

async function loadUsersPageData(): Promise<UsersPageData> {
  const [usersResult, upstreamsResult] = await Promise.all([
    callApi<ControlPlaneUser[]>(() => api.api.users.$get()),
    callApi<UpstreamOption[]>(() => api.api['upstream-options'].$get()),
  ]);
  return {
    users: usersResult.data ?? [],
    upstreams: upstreamsResult.data ?? [],
    error: usersResult.error?.message ?? upstreamsResult.error?.message ?? null,
    usersLoaded: !!usersResult.data,
    upstreamsLoaded: !!upstreamsResult.data,
  };
}
