import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useFetcher } from 'react-router';
import { z } from 'zod';

import { fluentComponents } from '../fluent';
import { FlowayLogo } from './logo';
import { Trans, useTranslation } from '../i18n/translation';
import { Input } from './ui/fluent-form-controls';
import { CONTROL_ROW_CLASS } from './ui/layout';
import { OutcomeMessageBar } from './ui/outcome-message-bar';
import { Panel } from './ui/panel';

const {
  Button,
  Field,
} = fluentComponents;

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
  // straight off it has no state a dismiss could clear. Each response is taken
  // into state during render rather than in an effect, so the bar and the
  // response it reports are painted together.
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
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      username: '',
      password: '',
    },
  });

  const onSubmit = (values: LoginFormValues) => {
    // The submit button stays focusable while in flight (disabledFocusable),
    // so the form's own submission path stays open.
    if (isSubmitting) return;
    void fetcher.submit(
      {
        username: values.username.trim(),
        password: values.password,
      },
      { method: 'post' },
    );
  };

  const usernameError = errors.username?.message;
  const passwordMessage = errors.password?.message ?? credentialError ?? null;

  return (
    <Panel className="w-[min(440px,100%)]">
      <header className="grid justify-items-center">
        <FlowayLogo />
      </header>

      {/* The first Field carries 12px of its own above its label, so no gap is
          stated from the mark to it -- stating 12 here would read as 24. */}
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
                autoComplete="username"
                autoFocus
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
              validationMessage={passwordMessage === null ? undefined : t(passwordMessage)}
              validationState={passwordMessage === null ? undefined : 'error'}
            >
              <Input
                {...field}
                autoComplete="current-password"
                disabled={isSubmitting}
                placeholder={t('auth.login.passwordPlaceholder')}
                type="password"
              />
            </Field>
          )}
        />

        {/* Full width so the submit sits flush under the fields above it. */}
        <Button
          appearance="primary"
          className={`mt-3.5 w-full ${CONTROL_ROW_CLASS}`}
          disabledFocusable={isSubmitting}
          type="submit"
        >
          {t('auth.login.submit')}
        </Button>

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
