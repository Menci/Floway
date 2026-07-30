import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Trans, useTranslation } from 'react-i18next';
import { useFetcher } from 'react-router';
import { z } from 'zod';

import { fluentComponents } from '../fluent';
import { FlowayLogo } from './logo';
import { Input } from './ui/fluent-form-controls';
import { Panel } from './ui/panel';

const {
  Button,
  Field,
  MessageBar,
  MessageBarBody,
  Spinner,
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
}

export function LoginForm() {
  const { t } = useTranslation();
  const fetcher = useFetcher<LoginActionData>();
  const isSubmitting = fetcher.state !== 'idle';

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
  const serverError =
    fetcher.data?.ok === false ? fetcher.data.error : undefined;

  return (
    <Panel
      className="w-[min(440px,100%)] !rounded-xl !p-7 max-[520px]:!p-5"
    >
      <header className="mb-9 grid justify-items-center gap-6 text-center">
        <FlowayLogo />
        <h1 className="m-0 text-fui-base600 font-fui-semibold leading-[1.15] tracking-normal">
          {t('auth.login.title')}
        </h1>
      </header>

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
              validationMessage={passwordError ? t(passwordError) : undefined}
              validationState={passwordError ? 'error' : undefined}
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
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? (
            <span className="inline-flex items-center gap-2">
              <Spinner size="tiny" />
              {t('auth.login.submitting')}
            </span>
          ) : (
            t('auth.login.submit')
          )}
        </Button>

        <p className="m-0 text-center text-fui-base300 leading-[1.45] text-fui-fg2">
          <Trans
            i18nKey="auth.adminKeyHint"
            components={{
              adminKey: (
                <code className="rounded border border-solid border-fui-stroke1 bg-fui-bg2 px-1.5 py-px font-mono text-fui-base200 text-fui-fg2" />
              ),
            }}
          />
        </p>
      </form>

      {serverError && (
        <MessageBar intent="error" className="mt-[18px]">
          <MessageBarBody>{t(serverError)}</MessageBarBody>
        </MessageBar>
      )}
    </Panel>
  );
}
