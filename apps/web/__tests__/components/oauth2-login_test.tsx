import { fireEvent, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flowayTokenStorageKey } from '../../src/auth/session';
import { LoginForm } from '../../src/components/login-form';
import { useAuthStore } from '../../src/stores/auth-store';
import { renderInApp } from '../render';
import { settle } from '../settle';

const user = { id: 2, username: 'alice', isAdmin: false, upstreamIds: null };

const renderLogin = () => {
  const router = createMemoryRouter([
    { path: '/', element: <LoginForm /> },
    { path: '/dashboard/playground', element: <div>Dashboard</div> },
  ]);
  return {
    router,
    ...renderInApp(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    ),
  };
};

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  useAuthStore.getState().clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OAuth2 login', () => {
  it('renders configured providers without exposing their configuration', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input), 'http://localhost').pathname).toBe('/auth/oauth2/providers');
      return Response.json({ providers: [{ id: 'custom', displayName: 'Example ID' }] });
    }));

    renderLogin();
    await settle();

    expect(screen.getByRole('button', { name: 'Continue with Example ID' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('clientSecret');
  });

  it('turns a callback handoff into a self-service account and dashboard session', async () => {
    window.history.replaceState(null, '', '/#oauth2_result=abcdefghijklmnopqrstuvwxyzABCDEFGH_12345678');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/auth/oauth2/providers') {
        return Response.json({ providers: [{ id: 'custom', displayName: 'Example ID' }] });
      }
      if (path === '/auth/oauth2/result') {
        return Response.json({
          status: 'registration_required',
          registrationToken: 'abcdefghijklmnopqrstuvwxyzABCDEFGH_12345678',
          providerId: 'custom',
          providerDisplayName: 'Example ID',
          providerLogin: 'alice@example.com',
          suggestedUsername: 'alice-example.com',
        });
      }
      if (path === '/auth/oauth2/register') {
        const body = JSON.parse(String(init?.body)) as { registrationToken: string; username: string };
        expect(body).toEqual({
          registrationToken: 'abcdefghijklmnopqrstuvwxyzABCDEFGH_12345678',
          username: 'alice',
        });
        return Response.json({ token: 'session-from-oauth2', user }, { status: 201 });
      }
      throw new Error(`unexpected request to ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { router } = renderLogin();
    await settle();

    expect(window.location.hash).toBe('');
    expect(screen.getByText('Create your Floway account')).toBeTruthy();
    expect(screen.getByDisplayValue('alice-example.com')).toBeTruthy();
    const username = screen.getByRole('textbox', { name: 'Username' });
    fireEvent.change(username, { target: { value: 'alice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await settle();

    expect(router.state.location.pathname).toBe('/dashboard/playground');
    expect(window.localStorage.getItem(flowayTokenStorageKey)).toBe('session-from-oauth2');
    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input), 'http://localhost').pathname === '/auth/oauth2/register')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input), 'http://localhost').pathname === '/auth/oauth2/result')).toHaveLength(1);
  });
});
