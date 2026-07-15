import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loginSpy, replaceSpy, setAuthSpy } = vi.hoisted(() => ({
  loginSpy: vi.fn(),
  replaceSpy: vi.fn(),
  setAuthSpy: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: replaceSpy }),
}));

vi.mock('../api/client.ts', () => ({
  useApi: () => ({ auth: { login: { $post: loginSpy } } }),
  callApi: async <T>(fn: () => Promise<Response>) => {
    const response = await fn();
    return { data: await response.json() as T };
  },
}));

vi.mock('../stores/auth.ts', () => ({
  useAuthStore: () => ({ setAuth: setAuthSpy }),
}));

const { default: LoginPage } = await import('./login.vue');

const loginResult = {
  token: 'session-token',
  user: {
    id: 1,
    username: 'admin',
    isAdmin: true,
    canViewGlobalTelemetry: true,
    upstreamIds: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('definePage', vi.fn());
  loginSpy.mockResolvedValue(Response.json(loginResult));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('login page', () => {
  it('submits empty credentials for zero-config local development', async () => {
    const wrapper = mount(LoginPage);

    expect(wrapper.text()).toContain('In local development without an ADMIN_KEY, leave the password blank too');

    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(loginSpy).toHaveBeenCalledExactlyOnceWith({ json: { username: '', password: '' } });
    expect(setAuthSpy).toHaveBeenCalledExactlyOnceWith(loginResult);
    expect(replaceSpy).toHaveBeenCalledExactlyOnceWith('/dashboard/settings');
  });

  it('still requires a password for a named account', async () => {
    const wrapper = mount(LoginPage);

    await wrapper.get('#username').setValue('alice');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('Enter a password to continue.');
    expect(loginSpy).not.toHaveBeenCalled();
    expect(setAuthSpy).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});
