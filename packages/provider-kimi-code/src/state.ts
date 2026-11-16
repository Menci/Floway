import { readKimiCodeUsage } from './usage.ts';
import { object, number, string } from './validation.ts';

export interface KimiCodeAccount {
  userId: string;
  nickname: string;
  planName: string;
}

export interface KimiCodeObservation<T> {
  fetchedAt: number;
  data: T;
}

export interface KimiCodeProbeEntry<T> {
  attemptedAt: number;
  observation: KimiCodeObservation<T> | null;
  error: string | null;
}

export interface KimiCodeUpstreamState {
  usageProbe: KimiCodeProbeEntry<unknown> | null;
  accountProbe: KimiCodeProbeEntry<KimiCodeAccount> | null;
}

export const readKimiCodeAccount = (value: unknown): KimiCodeAccount => {
  const body = object(value, 'Kimi Code account');
  return {
    userId: string(body.userId, 'Kimi Code account.userId'),
    nickname: string(body.nickname, 'Kimi Code account.nickname', true),
    planName: string(body.planName, 'Kimi Code account.planName', true),
  };
};

const readProbe = <T>(value: unknown, readData: (value: unknown) => T): KimiCodeProbeEntry<T> | null => {
  if (value === null) return null;
  const body = object(value, 'Kimi Code probe');
  const observation = body.observation === null ? null : object(body.observation, 'Kimi Code observation');
  if (body.error !== null && typeof body.error !== 'string') throw new TypeError('Kimi Code probe.error must be a string or null');
  return {
    attemptedAt: number(body.attemptedAt, 'Kimi Code probe.attemptedAt'),
    observation: observation === null ? null : { fetchedAt: number(observation.fetchedAt, 'Kimi Code observation.fetchedAt'), data: readData(observation.data) },
    error: body.error,
  };
};

export const readKimiCodeUpstreamState = (value: unknown): KimiCodeUpstreamState => {
  if (value === null) return { usageProbe: null, accountProbe: null };
  const body = object(value, 'Kimi Code state');
  for (const key of Object.keys(body)) if (key !== 'usageProbe' && key !== 'accountProbe') throw new TypeError(`Kimi Code state has unexpected key ${key}`);
  return {
    usageProbe: readProbe(body.usageProbe, data => {
      readKimiCodeUsage(data);
      return data;
    }),
    accountProbe: readProbe(body.accountProbe, readKimiCodeAccount),
  };
};
