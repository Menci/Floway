import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Trans, useTranslation } from 'react-i18next';
import { useFetcher } from 'react-router';
import { z } from 'zod';

import { fluentComponents } from '../fluent';
import { FlowayLogo } from './logo';
import { Input } from './ui/fluent-form-controls';
import { OutcomeMessageBar } from './ui/outcome-message-bar';
import { Panel } from './ui/panel';

const {
  Button,
  Field,
} = fluentComponents;

// The form's resolver, and the subject of
// `__tests__/components/login-form_test.ts`, which is what the export is for.
export const loginSchema = z.object({
  username: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{0,64}$/, 'validation.usernamePattern'),
  password: z
    .string()
    .max(1024, 'validation.passwordMax'),
}).superRefine((value, context) => {
  if (value.username.trim() && !value.password) {
    context.addIssue({ code: 'custom', message: 'validation.passwordRequired', path: ['password'] });
  }
});

export type LoginFormValues = z.infer<typeof loginSchema>;

export interface LoginActionData {
  ok: false;
  values: Pick<LoginFormValues, 'username'>;
  error: string;
  /** Whether the gateway rejected the credentials rather than failing to answer. */
  credentials: boolean;
}

export function LoginForm() {
  const { t } = useTranslation();
  const fetcher = useFetcher<LoginActionData>();
  const isSubmitting = fetcher.state !== 'idle';
  // The fetcher keeps its last response for as long as it lives, so a bar read
  // straight off it has no state a dismiss could clear. The rejection is taken
  // into state as each response arrives — during render rather than in an
  // effect, so the bar and the response it reports are painted together.
  const [serverError, setServerError] = useState<string | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [reportedResponse, setReportedResponse] = useState(fetcher.data);
  if (reportedResponse !== fetcher.data) {
    setReportedResponse(fetcher.data);
    const failure = fetcher.data?.ok === false ? fetcher.data : null;
    setServerError(failure && !failure.credentials ? failure.error : null);
    setCredentialError(failure?.credentials === true ? failure.error : null);
  }

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      username: '',
      password: '',
    },
  });

  useEffect(() => {
    if (fetcher.data?.ok === false) {
      setError('password', { type: 'server', message: fetcher.data.error });
    }
  }, [fetcher.data, setError]);

  const onSubmit = (values: LoginFormValues) => {
    // See the note at the submit button: it stays focusable while in flight,
    // which leaves the form's own submission path open.
    if (isSubmitting) return;
    void fetcher.submit(
      {
        username: values.username.trim(),
        password: values.password,
      },
      { method: 'post' },
    );
  };

  const passwordError = errors.password?.message;
  const usernameError = errors.username?.message;

  return (
    <Panel className="w-[min(440px,100%)]">
      {/* The mark alone, at the size the dashboard wears it. A heading under it
          would name the page the mark has already named. */}
      <header className="grid justify-items-center">
        <FlowayLogo />
      </header>

      {/* 12px from the mark to the first field. The form's first Field carries
          12px of its own above its label, so the gap states none and lets that
          be the whole of it -- stating 12 here would read as 24 on screen. */}
      <form
        className="mx-auto grid w-full max-w-full gap-5"
        onSubmit={event => void handleSubmit(onSubmit)(event)}
      >
        <Controller
          control={control}
          name="username"
          render={({ field }) => (
            <Field
              label={t('auth.login.username')}
              validationMessage={usernameError ? t(usernameError) : undefined}
              validationState={usernameError ? 'error' : undefined}
            >
              <Input
                {...field}
                aria-label={t('auth.login.username')}
                autoComplete="username"
                autoFocus
                className="!min-h-[36px]"
                disabled={isSubmitting}
                placeholder={t('auth.login.usernamePlaceholder')}
              />
            </Field>
          )}
        />

        <Controller
          control={control}
          name="password"
          render={({ field }) => (
            <Field
              label={t('auth.login.password')}
              validationMessage={(passwordError ?? credentialError) === undefined || (passwordError ?? credentialError) === null
                ? undefined
                : t((passwordError ?? credentialError)!)}
              validationState={passwordError ?? credentialError ? 'error' : undefined}
            >
              <Input
                {...field}
                aria-label={t('auth.login.password')}
                autoComplete="current-password"
                className="!min-h-[36px]"
                disabled={isSubmitting}
                placeholder={t('auth.login.passwordPlaceholder')}
                type="password"
              />
            </Field>
          )}
        />

        <Button
          appearance="primary"
          className="mt-3.5 !min-h-[34px] w-full text-fui-base300"
          disabledFocusable={isSubmitting}
          type="submit"
        >
          {t('auth.login.submit')}
        </Button>

        {/* A step quieter than the form it explains, and with the leading that
            step is set with rather than the one it inherited from a larger. */}
        <p className="m-0 text-center text-fui-base200 leading-[var(--lineHeightBase300)] text-fui-fg2">
          <Trans
            i18nKey="auth.adminKeyHint"
            components={{
              adminKey: (
                <code />
              ),
            }}
          />
        </p>
      </form>

      {serverError && (
        <OutcomeMessageBar className="mt-[18px]" onDismiss={() => setServerError(null)}>
          {t(serverError)}
        </OutcomeMessageBar>
      )}
    </Panel>
  );
}
