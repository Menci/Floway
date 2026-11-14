import { DataUsage24Regular, LocalLanguage24Regular, LockClosed24Regular } from '@fluentui/react-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useFetcher } from 'react-router';
import { z } from 'zod';

import { setLanguage } from '../i18n';
import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-settings';
import { requireDashboardSession } from './guards';
import { changeOwnPassword, updateOwnPreferences } from '../api/auth';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { DialogShell } from '../components/ui/dialog-shell';
import { Dropdown, Input } from '../components/ui/fluent-form-controls';
import { SETTINGS_PAGE_CLASS, SETTINGS_SECTION_HEADER_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { SectionHeader } from '../components/ui/section-header';
import { SettingsCard } from '../components/ui/settings-card';
import { fluentComponents } from '../fluent';
import { browserLanguage, normalizeLanguage, supportedLanguages } from '../i18n/languages';
import { useUserPreferences } from '../lib/use-preferences';
import { useAuthStore } from '../stores/auth-store';
import { QUOTA_DISPLAYS, type QuotaDisplay, type SupportedLanguage, type UserPreferences } from '@floway-dev/protocols/browser';

const {
  Button,
  DialogActions,
  DialogTitle,
  Field,
  Option,
  Text,
} = fluentComponents;

export async function clientLoader() {
  requireDashboardSession();
  return null;
}

const passwordSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, 'dashboard.settings.validation.currentPasswordRequired')
      .max(1024, 'validation.passwordMax'),
    newPassword: z
      .string()
      .min(1, 'dashboard.settings.validation.newPasswordRequired')
      .max(1024, 'validation.passwordMax'),
    confirmPassword: z.string(),
  })
  .refine(values => values.newPassword === values.confirmPassword, {
    message: 'dashboard.settings.validation.passwordMismatch',
    path: ['confirmPassword'],
  });

type PasswordFormValues = z.infer<typeof passwordSchema>;

type SettingsActionData =
  | { ok: true }
  | { ok: false; error: string };

const submittedField = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string') throw new TypeError(`Password form submitted without ${name}`);
  return value;
};

export async function clientAction({
  request,
}: Route.ClientActionArgs): Promise<SettingsActionData> {
  const formData = await request.formData();
  const result = await changeOwnPassword({
    currentPassword: submittedField(formData, 'currentPassword'),
    newPassword: submittedField(formData, 'newPassword'),
  });

  if (result.error) return { ok: false, error: result.error.message };
  return { ok: true };
}

export default function DashboardSettings() {
  const { t } = useTranslation();
  const [passwordOpen, setPasswordOpen] = useState(false);

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader description={t('dashboard.settings.description')} title={t('dashboard.nav.settings')} />

      <div className={SETTINGS_PAGE_CLASS}>
        <div className={SETTINGS_SECTION_HEADER_CLASS}><SectionHeader level={4} title={t('dashboard.settings.appearance')} /></div>
        <PreferencesSection />

        <div className={SETTINGS_SECTION_HEADER_CLASS}><SectionHeader level={4} title={t('dashboard.settings.security')} /></div>
        <SettingsCard
          description={t('dashboard.settings.password.description')}
          header={t('dashboard.settings.password.title')}
          icon={<LockClosed24Regular />}
          onClick={() => setPasswordOpen(true)}
        />
      </div>

      <PasswordDialog onOpenChange={setPasswordOpen} open={passwordOpen} />
    </section>
  );
}

const languageNames: Record<SupportedLanguage, string> = {
  'en': 'English',
  'zh-Hans': '简体中文',
};

// SettingsCard rows carry the choice; the save is one action for the group, as
// WinUI's SettingsPage does, and its outcome is reported through the toast that
// every other save on this dashboard uses.
function PreferencesSection() {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const saved = useUserPreferences();
  const replacePreferences = useAuthStore(state => state.replacePreferences);
  const [draft, setDraft] = useState<UserPreferences>(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = draft.quotaDisplay !== saved.quotaDisplay || draft.language !== saved.language;

  const save = async () => {
    // Nothing to send, so the button answers a press without a request rather
    // than standing disabled: a disabled primary action at the foot of a
    // settings group reads as a broken control, not as "nothing changed".
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    const result = await updateOwnPreferences(draft);
    setSaving(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    const next = result.data.preferences;
    replacePreferences(next);
    setDraft(next);
    if (next.language !== null) await setLanguage(next.language);
    else await setLanguage(browserLanguage());
    toasts.succeed(t('dashboard.settings.preferences.saved'));
  };

  const quotaLabels: Record<QuotaDisplay, string> = {
    remaining: t('dashboard.settings.preferences.quotaDisplay.remaining'),
    used: t('dashboard.settings.preferences.quotaDisplay.used'),
  };
  const languageLabel = draft.language === null ? t('dashboard.settings.preferences.language.browser') : languageNames[draft.language];

  return <>
    <div className="grid gap-1">
      <SettingsCard
        action={<Dropdown
          aria-label={t('dashboard.settings.preferences.quotaDisplay.title')}
          onOptionSelect={(_, data) => {
            // `Dropdown` still opens its list for an option it reports as
            // undefined, so the guard is what keeps an unknown selection from
            // reaching the draft as `null`.
            if (data.optionValue === undefined) return;
            setDraft(current => ({ ...current, quotaDisplay: data.optionValue as QuotaDisplay }));
          }}
          selectedOptions={[draft.quotaDisplay]}
          value={quotaLabels[draft.quotaDisplay]}
        >
          {QUOTA_DISPLAYS.map(value => <Option key={value} text={quotaLabels[value]} value={value}>{quotaLabels[value]}</Option>)}
        </Dropdown>}
        description={t('dashboard.settings.preferences.quotaDisplay.description')}
        header={t('dashboard.settings.preferences.quotaDisplay.title')}
        icon={<DataUsage24Regular />}
      />

      <SettingsCard
        action={<Dropdown
          aria-label={t('common.language')}
          onOptionSelect={(_, data) => {
            if (data.optionValue === undefined) return;
            setDraft(current => ({
              ...current,
              language: data.optionValue === 'browser' ? null : normalizeLanguage(data.optionValue),
            }));
          }}
          selectedOptions={[draft.language ?? 'browser']}
          value={languageLabel}
        >
          <Option text={t('dashboard.settings.preferences.language.browser')} value="browser">{t('dashboard.settings.preferences.language.browser')}</Option>
          {supportedLanguages.map(language => <Option key={language} text={languageNames[language]} value={language}>{languageNames[language]}</Option>)}
        </Dropdown>}
        description={t('dashboard.settings.preferences.language.description')}
        header={t('common.language')}
        icon={<LocalLanguage24Regular />}
      />
    </div>

    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}

    <div className="flex justify-start mt-3">
      <Button appearance="primary" disabledFocusable={saving} onClick={() => void save()}>
        {t('dashboard.settings.preferences.save')}
      </Button>
    </div>
  </>;
}

function PasswordDialog({ onOpenChange, open }: { onOpenChange: (open: boolean) => void; open: boolean }) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const fetcher = useFetcher<SettingsActionData>();
  const [dismissed, setDismissed] = useState<SettingsActionData | null>(null);
  const saving = fetcher.state !== 'idle';
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
  });

  // A dismissal names the result it dismissed rather than clearing a copy, so the
  // next submission's failure appears on its own account. The gateway's message
  // is prose, not a message key: `t` would read its first colon as a namespace
  // separator and hand back the tail.
  const error = fetcher.data && !fetcher.data.ok && fetcher.data !== dismissed
    ? fetcher.data.error
    : null;

  useEffect(() => {
    if (!fetcher.data?.ok) return;
    reset();
    toasts.succeed(t('dashboard.settings.passwordUpdated'));
    onOpenChange(false);
  }, [fetcher.data, onOpenChange, reset, t, toasts]);

  const submit = (values: PasswordFormValues) => {
    // `disabledFocusable` leaves the native disabled attribute off, so a second
    // Enter still submits; refusing here is what makes the button inert.
    if (saving) return;
    void fetcher.submit(values, { method: 'post' });
  };

  return <DialogShell
    actions={<DialogActions>
      <Button disabled={saving} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
      <Button appearance="primary" disabledFocusable={saving} type="submit">{t('dashboard.settings.password.submit')}</Button>
    </DialogActions>}
    onOpenChange={(_, data) => { if (!data.open && !saving) onOpenChange(false); }}
    onSubmit={() => void handleSubmit(submit)()}
    open={open}
    surfaceClassName="!w-[min(430px,calc(100vw-48px))]"
    title={<DialogTitle>{t('dashboard.settings.password.title')}</DialogTitle>}
  >
    <Controller
      control={control}
      name="currentPassword"
      render={({ field }) => (
        <Field
          label={t('dashboard.settings.currentPassword')}
          validationMessage={errors.currentPassword?.message ? t(errors.currentPassword.message) : undefined}
          validationState={errors.currentPassword ? 'error' : undefined}
        >
          <Input {...field} autoComplete="current-password" disabled={saving} type="password" />
        </Field>
      )}
    />

    <Controller
      control={control}
      name="newPassword"
      render={({ field }) => (
        <Field
          label={t('dashboard.settings.newPassword')}
          validationMessage={errors.newPassword?.message ? t(errors.newPassword.message) : undefined}
          validationState={errors.newPassword ? 'error' : undefined}
        >
          <Input {...field} autoComplete="new-password" disabled={saving} type="password" />
        </Field>
      )}
    />

    <Controller
      control={control}
      name="confirmPassword"
      render={({ field }) => (
        <Field
          label={t('dashboard.settings.confirmPassword')}
          validationMessage={errors.confirmPassword?.message ? t(errors.confirmPassword.message) : undefined}
          validationState={errors.confirmPassword ? 'error' : undefined}
        >
          <Input {...field} autoComplete="new-password" disabled={saving} type="password" />
        </Field>
      )}
    />

    <Text size={200} className="text-fui-fg2">{t('dashboard.settings.otherDevices')}</Text>

    {error && <OutcomeMessageBar onDismiss={() => setDismissed(fetcher.data ?? null)}>{error}</OutcomeMessageBar>}
  </DialogShell>;
}
