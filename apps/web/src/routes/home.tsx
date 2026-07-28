import { redirect } from 'react-router';

import type { Route } from './+types/home';
import { login as loginWithPassword } from '../api/client';
import { setSessionToken, getSessionToken } from '../auth/session';
import { LoginForm, type LoginActionData } from '../components/login-form';
import { ScrollArea } from '../components/ui/scroll-area';
import { useAuthStore } from '../stores/auth-store';

export async function clientLoader() {
  if (getSessionToken()) throw redirect('/dashboard/playground');
  return null;
}

clientLoader.hydrate = true as const;

export async function clientAction({
  request,
}: Route.ClientActionArgs): Promise<LoginActionData | Response> {
  const formData = await request.formData();
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  const result = await loginWithPassword({ username, password });
  if (result.error) {
    return {
      ok: false,
      values: { username },
      error: result.error.message || 'auth.login.genericError',
    };
  }

  setSessionToken(result.data.token);
  useAuthStore.getState().primeFromLogin(result.data);
  throw redirect('/dashboard/playground');
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: 'Sign in | Floway' },
    { name: 'description', content: 'Sign in to the Floway control plane.' },
  ];
}

export default function Home() {
  return (
    <ScrollArea axes="vertical" className="h-[100dvh]" contentClassName="min-h-full">
      <main className="grid min-h-full place-items-center p-6 max-[520px]:p-4">
        <LoginForm />
      </main>
    </ScrollArea>
  );
}
