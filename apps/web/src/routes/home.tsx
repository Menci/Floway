import { redirect } from 'react-router';

import type { Route } from './+types/home';
import { login as loginWithPassword } from '../api/auth';
import { getSessionToken } from '../auth/session';
import { LoginForm, type LoginActionData } from '../components/login-form';
import { SCROLLPORT_FILL_CLASS } from '../components/ui/layout';
import { ScrollArea } from '../components/ui/scroll-area';
import { useAuthStore } from '../stores/auth-store';

export async function clientLoader() {
  if (getSessionToken()) throw redirect('/dashboard/playground');
  return null;
}

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
      credentials: result.error.status === 401,
    };
  }

  useAuthStore.getState().primeFromLogin(result.data);
  throw redirect('/dashboard/playground');
}

export default function Home() {
  return (
    <ScrollArea axes="vertical" className="h-[100dvh]" contentClassName="h-full" noTabIndex>
      <main className={`grid ${SCROLLPORT_FILL_CLASS} place-items-center p-6 max-[520px]:p-4`}>
        <LoginForm />
      </main>
    </ScrollArea>
  );
}
