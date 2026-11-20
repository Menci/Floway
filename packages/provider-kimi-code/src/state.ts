import { readKimiCodeUsage } from './usage.ts';
import { object, number, string } from './validation.ts';

// Mirrors the profile payload the vendor's own client parses, so a field the
// service starts returning is carried without a schema change here. Every field
// beyond `userId` degrades independently: the vendor documents `user_id`,
// `nickname`, `status`, `region`, `user_level`, `user_level_name`, `domain` and
// `domain_name` as always serialized (possibly as zero values) and the rest as
// optional, so a profile that omits an optional field is still a usable account.
// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/oauth/src/managed-userinfo.ts#L1-L26
export interface KimiCodeAccountPhone {
  countryCode: string;
  number: string;
}

export interface KimiCodeAccount {
  userId: string;
  globalId: string | null;
  nickname: string;
  status: string;
  region: string;
  userLevel: number;
  userLevelName: string;
  domain: number;
  domainName: string;
  goodsVersion: number | null;
  username: string | null;
  email: string | null;
  bio: string | null;
  avatar: string | null;
  phone: KimiCodeAccountPhone | null;
  createdTime: string | null;
  lastLoginTime: string | null;
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

const optionalString = (value: unknown, path: string): string | null =>
  value === undefined || value === null ? null : string(value, path, true);

const optionalNumber = (value: unknown, path: string): number | null =>
  value === undefined || value === null ? null : number(value, path);

const readPhone = (value: unknown): KimiCodeAccountPhone | null => {
  if (value === undefined || value === null) return null;
  const body = object(value, 'Kimi Code account.phone');
  const countryCode = optionalString(body.country_code, 'Kimi Code account.phone.country_code') ?? '';
  const number_ = optionalString(body.number, 'Kimi Code account.phone.number') ?? '';
  return countryCode === '' && number_ === '' ? null : { countryCode, number: number_ };
};

// Reads the vendor's snake_case profile payload directly. Display fields keep
// the vendor's own empty-string possibility rather than becoming null, because
// an empty nickname is the account's answer, not an absent field.
// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/oauth/src/managed-userinfo.ts#L100-L128
export const readKimiCodeAccount = (value: unknown): KimiCodeAccount => {
  const body = object(value, 'Kimi Code /me');
  return {
    userId: string(body.user_id, 'Kimi Code /me.user_id'),
    globalId: optionalString(body.global_id, 'Kimi Code /me.global_id'),
    nickname: optionalString(body.nickname, 'Kimi Code /me.nickname') ?? '',
    status: optionalString(body.status, 'Kimi Code /me.status') ?? '',
    region: optionalString(body.region, 'Kimi Code /me.region') ?? '',
    userLevel: optionalNumber(body.user_level, 'Kimi Code /me.user_level') ?? 0,
    userLevelName: optionalString(body.user_level_name, 'Kimi Code /me.user_level_name') ?? '',
    domain: optionalNumber(body.domain, 'Kimi Code /me.domain') ?? 0,
    domainName: optionalString(body.domain_name, 'Kimi Code /me.domain_name') ?? '',
    goodsVersion: optionalNumber(body.goods_version, 'Kimi Code /me.goods_version'),
    username: optionalString(body.username, 'Kimi Code /me.username'),
    email: optionalString(body.email, 'Kimi Code /me.email'),
    bio: optionalString(body.bio, 'Kimi Code /me.bio'),
    avatar: optionalString(body.avatar, 'Kimi Code /me.avatar'),
    phone: readPhone(body.phone),
    createdTime: optionalString(body.created_time, 'Kimi Code /me.created_time'),
    lastLoginTime: optionalString(body.last_login_time, 'Kimi Code /me.last_login_time'),
  };
};

// The persisted account is the camelCase shape above, so it is validated
// against its own field names rather than through the wire reader.
const readPersistedAccount = (value: unknown): KimiCodeAccount => {
  const body = object(value, 'Kimi Code account');
  const text = (key: keyof KimiCodeAccount, required = false): string => string(body[key], `Kimi Code account.${key}`, !required);
  return {
    userId: text('userId', true),
    globalId: optionalString(body.globalId, 'Kimi Code account.globalId'),
    nickname: text('nickname'),
    status: text('status'),
    region: text('region'),
    userLevel: number(body.userLevel, 'Kimi Code account.userLevel'),
    userLevelName: text('userLevelName'),
    domain: number(body.domain, 'Kimi Code account.domain'),
    domainName: text('domainName'),
    goodsVersion: optionalNumber(body.goodsVersion, 'Kimi Code account.goodsVersion'),
    username: optionalString(body.username, 'Kimi Code account.username'),
    email: optionalString(body.email, 'Kimi Code account.email'),
    bio: optionalString(body.bio, 'Kimi Code account.bio'),
    avatar: optionalString(body.avatar, 'Kimi Code account.avatar'),
    phone: readPersistedPhone(body.phone),
    createdTime: optionalString(body.createdTime, 'Kimi Code account.createdTime'),
    lastLoginTime: optionalString(body.lastLoginTime, 'Kimi Code account.lastLoginTime'),
  };
};

const readPersistedPhone = (value: unknown): KimiCodeAccountPhone | null => {
  if (value === null) return null;
  const body = object(value, 'Kimi Code account.phone');
  return {
    countryCode: string(body.countryCode, 'Kimi Code account.phone.countryCode', true),
    number: string(body.number, 'Kimi Code account.phone.number', true),
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
    accountProbe: readProbe(body.accountProbe, readPersistedAccount),
  };
};
