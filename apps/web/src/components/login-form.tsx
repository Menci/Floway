import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useFetcher, useNavigate } from 'react-router';
import { z } from 'zod';

import { listOAuth2Providers, registerOAuth2User, resolveOAuth2Result, type OAuth2ProvidersResponse, type OAuth2ResultResponse } from '../api/auth';
import { fluentComponents } from '../fluent';
import { FlowayLogo } from './logo';
import { Trans, useTranslation } from '../i18n/translation';
import { useAuthStore } from '../stores/auth-store';
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

type PendingOAuth2Registration = Extract<OAuth2ResultResponse, { status: 'registration_required' }>;

const oauth2Fragment = (): URLSearchParams | null => {
  if (typeof window === 'undefined' || !window.location.hash.startsWith('#')) return null;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  return fragment.has('oauth2_result') || fragment.has('oauth2_error') ? fragment : null;
};

export function LoginForm() {
  const { t } = useTranslation();
  const fetcher = useFetcher<LoginActionData>();
  const navigate = useNavigate();
  const isSubmitting = fetcher.state !== 'idle';
  // The fetcher keeps its last response for as long as it lives, so a bar read
  // straight off it has no state a dismiss could clear. Each response is taken
  // into state during render rather than in an effect, so the bar and the
  // response it reports are painted together.
  const [serverError, setServerError] = useState<string | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [oauth2Providers, setOAuth2Providers] = useState<OAuth2ProvidersResponse['providers']>([]);
  const [oauth2Busy, setOAuth2Busy] = useState<string | null>(null);
  const [oauth2Error, setOAuth2Error] = useState<string | null>(null);
  const [pendingRegistration, setPendingRegistration] = useState<PendingOAuth2Registration | null>(null);
  const [registrationUsername, setRegistrationUsername] = useState('');
  const [registrationUsernameError, setRegistrationUsernameError] = useState<string | null>(null);
  const callbackFragment = useRef<URLSearchParams | null | undefined>(undefined);
  const callbackRequest = useRef<ReturnType<typeof resolveOAuth2Result> | null>(null);
  const [reportedResponse, setReportedResponse] = useState(fetcher.data);
  if (reportedResponse !== fetcher.data) {
    setReportedResponse(fetcher.data);
    const failure = fetcher.data?.ok === false ? fetcher.data : null;
    setServerError(failure && !failure.credentials ? failure.error : null);
    setCredentialError(failure?.credentials === true ? failure.error : null);
  }

  useEffect(() => {
    let active = true;
    void listOAuth2Providers().then(result => {
      if (!active) return;
      if (result.data) setOAuth2Providers(result.data.providers);
      else setOAuth2Error('auth.oauth2.providerLoadError');
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (callbackFragment.current === undefined) {
      callbackFragment.current = oauth2Fragment();
      if (callbackFragment.current) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      }
    }
    const fragment = callbackFragment.current;
    if (!fragment) return;
    const providerError = fragment.get('oauth2_error');
    if (providerError) {
      setOAuth2Error(providerError);
      return;
    }
    const resultToken = fragment.get('oauth2_result');
    if (!resultToken) return;

    let active = true;
    setOAuth2Busy('callback');
    callbackRequest.current ??= resolveOAuth2Result(resultToken);
    void callbackRequest.current.then(result => {
      if (!active) return;
      setOAuth2Busy(null);
      if (result.error) {
        setOAuth2Error('auth.oauth2.resultError');
        return;
      }
      if (result.data.status === 'authenticated') {
        useAuthStore.getState().primeFromLogin({ token: result.data.token, user: result.data.user });
        void navigate('/dashboard/playground', { replace: true });
        return;
      }
      setPendingRegistration(result.data);
      setRegistrationUsername(result.data.suggestedUsername);
    });
    return () => {
      active = false;
    };
  }, [navigate]);

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

  const startOAuth2 = (providerId: string) => {
    if (oauth2Busy) return;
    setOAuth2Error(null);
    setOAuth2Busy(providerId);
    window.location.assign(`/auth/oauth2/${encodeURIComponent(providerId)}/start`);
  };

  const submitRegistration = async () => {
    if (!pendingRegistration || oauth2Busy) return;
    const username = registrationUsername.trim();
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username)) {
      setRegistrationUsernameError('validation.usernamePattern');
      return;
    }
    setRegistrationUsernameError(null);
    setOAuth2Error(null);
    setOAuth2Busy('registration');
    const result = await registerOAuth2User({
      registrationToken: pendingRegistration.registrationToken,
      username,
    });
    setOAuth2Busy(null);
    if (result.error) {
      const errorCode = (result.error.raw as { code?: unknown } | undefined)?.code;
      setRegistrationUsernameError(errorCode === 'username_taken'
        ? 'auth.oauth2.registration.usernameTaken'
        : null);
      if (errorCode !== 'username_taken') setOAuth2Error('auth.oauth2.registration.error');
      return;
    }
    useAuthStore.getState().primeFromLogin(result.data);
    void navigate('/dashboard/playground', { replace: true });
  };

  const cancelRegistration = () => {
    setPendingRegistration(null);
    setRegistrationUsername('');
    setRegistrationUsernameError(null);
    setOAuth2Error(null);
  };

  return (
    <Panel className="w-[min(440px,100%)]">
      <header className="grid justify-items-center">
        <FlowayLogo />
      </header>

      {pendingRegistration ? (
        <form
          className="mx-auto grid w-full max-w-full gap-5"
          onSubmit={event => {
            event.preventDefault();
            void submitRegistration();
          }}
        >
          <div className="grid gap-1 text-center">
            <h1 className="m-0 text-fui-base500 font-fui-semibold">{t('auth.oauth2.registration.title')}</h1>
            <p className="m-0 text-fui-fg2 leading-[var(--lineHeightBase300)]">
              {t('auth.oauth2.registration.description', {
                provider: pendingRegistration.providerDisplayName,
                login: pendingRegistration.providerLogin,
              })}
            </p>
          </div>
          <Field
            label={t('auth.oauth2.registration.username')}
            validationMessage={registrationUsernameError ? t(registrationUsernameError) : undefined}
            validationState={registrationUsernameError ? 'error' : undefined}
          >
            <Input
              autoComplete="username"
              autoFocus
              disabled={oauth2Busy !== null}
              onChange={event => setRegistrationUsername(event.target.value)}
              value={registrationUsername}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Button
              className={CONTROL_ROW_CLASS}
              disabledFocusable={oauth2Busy !== null}
              onClick={cancelRegistration}
              type="button"
            >
              {t('common.cancel')}
            </Button>
            <Button
              appearance="primary"
              className={CONTROL_ROW_CLASS}
              disabledFocusable={oauth2Busy !== null}
              type="submit"
            >
              {oauth2Busy === 'registration'
                ? t('auth.oauth2.registration.creating')
                : t('auth.oauth2.registration.create')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="grid gap-5">
          {oauth2Providers.length > 0 && (
            <div className="grid gap-3">
              {oauth2Providers.map(provider => (
                <Button
                  appearance="primary"
                  className={`w-full ${CONTROL_ROW_CLASS}`}
                  disabledFocusable={oauth2Busy !== null}
                  key={provider.id}
                  onClick={() => startOAuth2(provider.id)}
                  type="button"
                >
                  {oauth2Busy === provider.id
                    ? t('auth.oauth2.connecting')
                    : t('auth.oauth2.continueWith', { provider: provider.displayName })}
                </Button>
              ))}
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-fui-base200 text-fui-fg3" role="separator">
                <span className="border-t border-fui-divider" />
                <span>{t('auth.oauth2.passwordDivider')}</span>
                <span className="border-t border-fui-divider" />
              </div>
            </div>
          )}

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
                    autoFocus={oauth2Providers.length === 0}
                    disabled={isSubmitting || oauth2Busy !== null}
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
                    disabled={isSubmitting || oauth2Busy !== null}
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
              disabledFocusable={isSubmitting || oauth2Busy !== null}
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
        </div>
      )}

      {serverError && (
        <OutcomeMessageBar className="mt-[18px]" onDismiss={() => setServerError(null)}>
          {t(serverError)}
        </OutcomeMessageBar>
      )}
      {oauth2Error && (
        <OutcomeMessageBar className="mt-[18px]" onDismiss={() => setOAuth2Error(null)}>
          {oauth2Error.startsWith('auth.') ? t(oauth2Error) : oauth2Error}
        </OutcomeMessageBar>
      )}
    </Panel>
  );
}
