import { aggregatePerformanceForDisplay, aggregatePerformanceSlice } from './performance-overview-oracle.ts';
import { partitionTelemetryOverviewRecords } from './telemetry-overview-oracle.ts';
import {
  accessScopeDepth,
  accessScopeKey,
  accessScopeOrderGroup,
  AccessRecordConflictError,
  sameModelOrderBoundary,
  type AccessPrincipal,
  type AccessRecord,
  type AccessRecordInput,
  validateAccessRecordInput,
} from '../../src/access-control/types.ts';
import { buildKeyToUserMap } from '../../src/control-plane/shared/key-to-user.ts';
import { normalizeDisabledPublicModelIds } from '../../src/repo/disabled-public-models.ts';
import { normalizeFlagOverrides } from '../../src/repo/flag-overrides.ts';
import { groupNameKey } from '../../src/repo/group-names.ts';
import { AUTOMATIC_REFRESH_INTERVAL_MS, storedModelErrorMessage } from '../../src/repo/models-cache-contract.ts';
import { modelsRefreshRetryAt } from '../../src/repo/models-refresh-backoff.ts';
import {
  assertSameStoredOpenAIResponsesItem,
  cloneStoredOpenAIResponsesItem,
  cloneStoredOpenAIResponsesSnapshot,
  compareOpenAIResponsesItemsByFreshness,
  scopedOpenAIResponsesKey,
} from '../../src/repo/openai-responses-clone.ts';
import { quantizeOpenAIResponsesRefreshedAt, OPENAI_RESPONSES_REFRESH_GRANULARITY_MS, openaiResponsesStateCutoff } from '../../src/repo/openai-responses-retention.ts';
import { normalizeProxyFallbackList } from '../../src/repo/proxy-fallback-list.ts';
import { SEED_ADMIN_USER_ID } from '../../src/repo/seed-admin.ts';
import { generateSessionToken } from '../../src/repo/session-tokens.ts';
import { overviewBucketId } from '../../src/repo/telemetry-bucket-sql.ts';
import type {
  ApiKey,
  ApiKeyRepo,
  ApiKeyUpdate,
  AccessRecordsRepo,
  ExpirationDomain,
  ExpirationSweepCompletion,
  ExpirationSweepClaim,
  ExpirationSweepsRepo,
  AgentSetupMutation,
  AgentSetupRecord,
  AgentSetupRenewal,
  AgentSetupRepository,
  BackoffRow,
  CatalogModelEntry,
  CatalogUpstreamRow,
  DueModelsRefreshCandidate,
  Group,
  GroupWithMembers,
  GroupsRepo,
  ModelsRefreshFailureInput,
  ModelsRefreshSuccessInput,
  ModelAliasesRepo,
  ModelAliasRecord,
  PerformanceDimensions,
  PerformanceRepo,
  PerformanceTelemetryRecord,
  PerformanceSample,
  PerformanceBucketRow,
  PerformanceMetric,
  PerformanceOverviewQueryOptions,
  PerformanceOverviewResult,
  PerformanceSliceQuery,
  ProxyBackoffRepo,
  ProxyRecord,
  ProxyRepo,
  Repo,
  ResolvedUpstreamModelMatch,
  OpenAIResponsesItemsRepo,
  OpenAIResponsesSnapshotsRepo,
  ScheduledMaintenanceRepo,
  SiteSettings,
  SiteSettingsRepo,
  SpilledFilesRepo,
  WebSearchConfigRepo,
  WebSearchUsageRecord,
  WebSearchUsageRepo,
  Session,
  SessionsRepo,
  StoredOpenAIResponsesItem,
  StoredOpenAIResponsesSnapshot,
  StoredUpstreamMeta,
  StoredUpstreamRecord,
  UpstreamModelEntry,
  UpstreamModelsCacheAction,
  UpstreamModelsCacheState,
  UpstreamModelsRepo,
  UpstreamModelsWritePayload,
  UpstreamRepo,
  UsageRecord,
  UsageOverviewAxis,
  UsageOverviewQueryOptions,
  UsageOverviewRecord,
  UsageOverviewResult,
  UsageRepo,
  User,
  UserDirectory,
  GroupMembership,
  UserPreferencesRepo,
  UsersRepo,
} from '../../src/repo/types.ts';
import { serializeStoredState } from '../../src/repo/upstream-json.ts';
import { usageMetricRows } from '../../src/repo/usage-metrics.ts';
import { bucketForTtftMs, bucketForTpotUs } from '../../src/shared/performance-histogram.ts';
import { assertWebSearchProviderName, type WebSearchConfig } from '../../src/shared/web-search-providers.ts';
import { AgentSetupTokenCollisionError } from '@floway-dev/agent-setup';
import { addDecimalStrings, canonicalPricingSelectorKey, canonicalizePricingSelector, defaultUserPreferences, multiplyDecimalStrings, parseUserPreferences, tokenUsageUnattributedUserId, usageUpstreamDimensionValue, type BillingMetric, type DecimalString, type ModelKind, type PricingSelector, type UserPreferences } from '@floway-dev/protocols/common';
import { normalizeUpstreamMetricIdentity, upstreamMetricIdentityKey, UpstreamGoneError, type ProviderModel, type UpstreamModelConfig, type UpstreamModelSource, type UpstreamRecord } from '@floway-dev/provider';

const SEED_ADMIN_USER: User = {
  id: SEED_ADMIN_USER_ID,
  username: 'admin',
  passwordHash: null,
  isAdmin: true,
  createdAt: new Date(0).toISOString(),
  deletedAt: null,
};

// Mirror the SQL `username TEXT COLLATE NOCASE` collation: usernames match
// case-insensitively for both lookup and uniqueness. `USERNAME_PATTERN`
// restricts usernames to ASCII, so a plain `toLowerCase()` fold is exactly
// SQLite's NOCASE.
const usernamesMatch = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

class MemoryUsersRepo implements UsersRepo {
  constructor(private groups: GroupsRepo) {}
  private users: User[] = [{ ...SEED_ADMIN_USER }];

  snapshot(): User[] {
    return this.users.filter(u => u.deletedAt === null).map(u => ({ ...u }));
  }

  list(): Promise<User[]> {
    return Promise.resolve(this.snapshot());
  }

  listIncludingDeleted(): Promise<User[]> {
    return Promise.resolve(this.users.map(u => ({ ...u })));
  }

  getById(id: number): Promise<User | null> {
    const u = this.users.find(u => u.id === id && u.deletedAt === null);
    return Promise.resolve(u ? { ...u } : null);
  }

  findByUsername(username: string): Promise<User | null> {
    const u = this.users.find(u => usernamesMatch(u.username, username) && u.deletedAt === null);
    return Promise.resolve(u ? { ...u } : null);
  }

  createNewUser(template: Omit<User, 'id'>): Promise<User> {
    const collision = this.users.find(u => usernamesMatch(u.username, template.username) && u.deletedAt === null);
    if (collision) throw new Error(`username taken: ${template.username}`);
    const id = this.users.reduce((max, u) => Math.max(max, u.id), 0) + 1;
    const user: User = { ...template, id };
    this.users.push(user);
    return Promise.resolve({ ...user });
  }

  async save(user: User, groupIds?: readonly number[]): Promise<void> {
    // Match SQL's partial unique index `WHERE deleted_at IS NULL`: a clash is
    // only meaningful when the new row is also active. A soft-deleted import
    // can carry a username already in use by an active row without colliding.
    const collision = this.users.find(u => usernamesMatch(u.username, user.username) && u.deletedAt === null && u.id !== user.id);
    if (collision && user.deletedAt === null) throw new Error(`username taken: ${user.username}`);
    const i = this.users.findIndex(u => u.id === user.id);
    if (i >= 0) this.users[i] = { ...user };
    else this.users.push({ ...user });
    if (groupIds !== undefined) await this.groups.replaceUserGroups(user.id, groupIds);
  }

  async softDelete(id: number): Promise<boolean> {
    const i = this.users.findIndex(u => u.id === id && u.deletedAt === null);
    if (i < 0) return false;
    this.users[i] = { ...this.users[i], deletedAt: new Date().toISOString() };
    return true;
  }

  deleteAll(): Promise<void> {
    this.users = [];
    return Promise.resolve();
  }
}

class MemoryUserPreferencesRepo implements UserPreferencesRepo {
  private readonly preferences = new Map<number, UserPreferences>();

  get(userId: number): Promise<UserPreferences> {
    const stored = this.preferences.get(userId);
    return Promise.resolve(stored === undefined ? { ...defaultUserPreferences } : parseUserPreferences(stored));
  }

  save(userId: number, preferences: UserPreferences): Promise<void> {
    this.preferences.set(userId, parseUserPreferences(preferences));
    return Promise.resolve();
  }

  listAll(): Promise<Array<{ userId: number; preferences: UserPreferences }>> {
    return Promise.resolve([...this.preferences].map(([userId, preferences]) => ({ userId, preferences: parseUserPreferences(preferences) })));
  }

  deleteAll(): Promise<void> {
    this.preferences.clear();
    return Promise.resolve();
  }
}

class MemoryGroupsRepo implements GroupsRepo {
  private groups: Group[] = [];
  private members = new Map<number, Map<number, string>>();

  snapshot(): Group[] {
    return this.groups.filter(group => group.deletedAt === null).map(group => ({ ...group }));
  }

  snapshotMemberships(): GroupMembership[] {
    const active = new Set(this.groups.filter(group => group.deletedAt === null).map(group => group.id));
    return [...this.members].filter(([groupId]) => active.has(groupId))
      .flatMap(([groupId, members]) => [...members].map(([userId, createdAt]) => ({ groupId, userId, createdAt })))
      .toSorted((a, b) => a.groupId - b.groupId || a.userId - b.userId);
  }

  list(): Promise<Group[]> {
    return Promise.resolve(this.snapshot());
  }

  listIncludingDeleted(): Promise<Group[]> {
    return Promise.resolve(this.groups.map(group => ({ ...group })));
  }

  getById(id: number): Promise<Group | null> {
    const group = this.groups.find(candidate => candidate.id === id && candidate.deletedAt === null);
    return Promise.resolve(group ? { ...group } : null);
  }

  findByName(name: string): Promise<Group | null> {
    const group = this.groups.find(candidate => groupNameKey(candidate.name) === groupNameKey(name) && candidate.deletedAt === null);
    return Promise.resolve(group ? { ...group } : null);
  }

  async create(name: string, hue: number): Promise<Group> {
    if (this.groups.some(group => groupNameKey(group.name) === groupNameKey(name) && group.deletedAt === null)) {
      throw new Error(`group name taken: ${name}`);
    }
    const group: Group = {
      id: this.groups.reduce((maximum, candidate) => Math.max(maximum, candidate.id), 0) + 1,
      name,
      hue,
      createdAt: new Date().toISOString(),
      deletedAt: null,
    };
    this.groups.push(group);
    return { ...group };
  }

  async save(group: Group): Promise<void> {
    const collision = this.groups.find(candidate => groupNameKey(candidate.name) === groupNameKey(group.name) && candidate.deletedAt === null && candidate.id !== group.id);
    if (collision && group.deletedAt === null) throw new Error(`group name taken: ${group.name}`);
    const index = this.groups.findIndex(candidate => candidate.id === group.id);
    if (index < 0) this.groups.push({ ...group });
    else this.groups[index] = { ...group };
  }

  async restore(groups: readonly GroupWithMembers[]): Promise<void> {
    const records = new Map(this.groups.map(group => [group.id, group]));
    for (const { memberIds: _memberIds, ...group } of groups) records.set(group.id, group);
    const names = new Set<string>();
    for (const group of records.values()) {
      if (group.deletedAt !== null) continue;
      const key = groupNameKey(group.name);
      if (names.has(key)) throw new Error(`group name taken: ${group.name}`);
      names.add(key);
    }
    this.groups = [...records.values()];
    for (const group of groups) this.replaceMemberSnapshot(group.id, group.memberIds);
  }

  softDelete(id: number): Promise<boolean> {
    const index = this.groups.findIndex(group => group.id === id && group.deletedAt === null);
    if (index < 0) return Promise.resolve(false);
    this.groups[index] = { ...this.groups[index], deletedAt: new Date().toISOString() };
    this.members.delete(id);
    return Promise.resolve(true);
  }

  listMemberIds(groupId: number): Promise<number[]> {
    return Promise.resolve([...(this.members.get(groupId)?.keys() ?? [])].toSorted((a, b) => a - b));
  }

  async listMemberships(): Promise<Map<number, number[]>> {
    return new Map([...this.members].map(([id, members]) => [id, [...members.keys()].toSorted((a, b) => a - b)]));
  }

  async setMember(groupId: number, userId: number, included: boolean): Promise<void> {
    const members = new Map(this.members.get(groupId));
    if (included) {
      if (!members.has(userId)) members.set(userId, new Date().toISOString());
    } else members.delete(userId);
    this.members.set(groupId, members);
  }

  async replaceUserGroups(userId: number, groupIds: readonly number[]): Promise<void> {
    for (const group of this.groups) await this.setMember(group.id, userId, groupIds.includes(group.id));
  }

  listIdsByUserId(userId: number): Promise<number[]> {
    const active = new Set(this.groups.filter(group => group.deletedAt === null).map(group => group.id));
    return Promise.resolve([...this.members.entries()]
      .filter(([groupId, userIds]) => active.has(groupId) && userIds.has(userId))
      .map(([groupId]) => groupId)
      .toSorted((a, b) => a - b));
  }

  async listIdsByUserIds(userIds: readonly number[]): Promise<Map<number, number[]>> {
    const active = new Set(this.groups.filter(group => group.deletedAt === null).map(group => group.id));
    return new Map(userIds.map(userId => [userId, [...this.members.entries()]
      .filter(([groupId, members]) => active.has(groupId) && members.has(userId))
      .map(([groupId]) => groupId)
      .toSorted((a, b) => a - b)]));
  }

  replaceMembers(groupId: number, userIds: readonly number[]): Promise<void> {
    this.replaceMemberSnapshot(groupId, userIds);
    return Promise.resolve();
  }

  private replaceMemberSnapshot(groupId: number, userIds: readonly number[]): void {
    const previous = new Map(this.members.get(groupId));
    const now = new Date().toISOString();
    this.members.set(groupId, new Map(userIds.map(userId => [userId, previous.get(userId) ?? now])));
  }

  deleteMembershipsByUserId(userId: number): Promise<number> {
    let changes = 0;
    for (const members of this.members.values()) {
      if (members.delete(userId)) changes++;
    }
    return Promise.resolve(changes);
  }

  deleteAll(): Promise<void> {
    this.groups = [];
    this.members.clear();
    return Promise.resolve();
  }
}

const principalKey = (principal: AccessPrincipal): string => `${principal.kind}:${principal.id}`;

class MemoryAccessRecordsRepo implements AccessRecordsRepo {
  private nextId = 1;
  private records: AccessRecord[] = [];

  list(): Promise<AccessRecord[]> {
    return Promise.resolve(this.records.map(record => structuredClone(record)));
  }

  getById(id: number): Promise<AccessRecord | null> {
    const record = this.records.find(candidate => candidate.id === id);
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  listByPrincipal(principal: AccessPrincipal): Promise<AccessRecord[]> {
    return this.listByPrincipals([principal]);
  }

  listByPrincipals(principals: readonly AccessPrincipal[]): Promise<AccessRecord[]> {
    const keys = new Set(principals.map(principalKey));
    return Promise.resolve(this.records
      .filter(record => keys.has(principalKey(record.principal)))
      .map(record => structuredClone(record)));
  }

  async save(input: AccessRecordInput): Promise<AccessRecord> {
    validateAccessRecordInput(input);
    const now = new Date().toISOString();
    const scopeKey = accessScopeKey(input.scope);
    const index = this.records.findIndex(record => principalKey(record.principal) === principalKey(input.principal) && accessScopeKey(record.scope) === scopeKey);
    const duplicateOrder = this.records.find((record, recordIndex) =>
      input.scope.kind === 'upstreamModel' && recordIndex !== index
      && principalKey(record.principal) === principalKey(input.principal)
      && accessScopeDepth(record.scope) === accessScopeDepth(input.scope)
      && accessScopeOrderGroup(record.scope) === accessScopeOrderGroup(input.scope)
      && record.sortOrder === input.sortOrder);
    if (duplicateOrder) throw new AccessRecordConflictError(`Access record sortOrder ${input.sortOrder} is already used at this scope level`);
    const record: AccessRecord = index < 0
      ? { id: this.nextId++, ...structuredClone(input), createdAt: now, updatedAt: now }
      : { ...this.records[index], ...structuredClone(input), updatedAt: now };
    if (index < 0) this.records.push(record);
    else this.records[index] = record;
    return structuredClone(record);
  }

  async replace(id: number, input: AccessRecordInput): Promise<AccessRecord | null> {
    validateAccessRecordInput(input);
    const index = this.records.findIndex(record => record.id === id);
    if (index < 0) return null;
    const sortOrder = sameModelOrderBoundary(this.records[index]!, input) ? this.records[index]!.sortOrder : input.sortOrder;
    const duplicateScope = this.records.find((record, recordIndex) =>
      recordIndex !== index
      && principalKey(record.principal) === principalKey(input.principal)
      && accessScopeKey(record.scope) === accessScopeKey(input.scope));
    if (duplicateScope) throw new AccessRecordConflictError('Access record already exists for this principal and scope');
    const duplicateOrder = this.records.find((record, recordIndex) =>
      input.scope.kind === 'upstreamModel' && recordIndex !== index
      && principalKey(record.principal) === principalKey(input.principal)
      && accessScopeDepth(record.scope) === accessScopeDepth(input.scope)
      && accessScopeOrderGroup(record.scope) === accessScopeOrderGroup(input.scope)
      && record.sortOrder === sortOrder);
    if (duplicateOrder) throw new AccessRecordConflictError(`Access record sortOrder ${sortOrder} is already used at this scope level`);
    const next = { ...this.records[index], ...structuredClone(input), sortOrder, updatedAt: new Date().toISOString() };
    this.records[index] = next;
    return structuredClone(next);
  }

  reorderModel(upstreamId: string, expectedIds: readonly number[], ids: readonly number[]): Promise<AccessRecord[] | null> {
    const segment = this.records.filter(record => record.scope.kind === 'upstreamModel' && record.scope.upstreamId === upstreamId)
      .toSorted((left, right) => left.sortOrder - right.sortOrder || left.id - right.id);
    if (JSON.stringify(segment.map(record => record.id)) !== JSON.stringify(expectedIds)) return Promise.resolve(null);
    const now = new Date().toISOString();
    const ranks = new Map(ids.map((id, rank) => [id, rank]));
    const updated = segment.map(record => ({ ...record, sortOrder: ranks.get(record.id)!, updatedAt: now }));
    const byId = new Map(updated.map(record => [record.id, record]));
    this.records = this.records.map(record => byId.get(record.id) ?? record);
    return Promise.resolve(structuredClone(updated));
  }

  delete(id: number): Promise<boolean> {
    const length = this.records.length;
    this.records = this.records.filter(record => record.id !== id);
    return Promise.resolve(this.records.length < length);
  }

  deleteByPrincipal(principal: AccessPrincipal): Promise<number> {
    const length = this.records.length;
    const key = principalKey(principal);
    this.records = this.records.filter(record => principalKey(record.principal) !== key);
    return Promise.resolve(length - this.records.length);
  }

  deleteAll(): Promise<void> {
    this.records = [];
    this.nextId = 1;
    return Promise.resolve();
  }
}

class MemorySessionsRepo implements SessionsRepo {
  private sessions: Session[] = [];

  getByIdAndTouch(id: string): Promise<Session | null> {
    const i = this.sessions.findIndex(s => s.id === id);
    if (i < 0) return Promise.resolve(null);
    const now = new Date().toISOString();
    this.sessions[i] = { ...this.sessions[i], lastSeenAt: now };
    return Promise.resolve({ ...this.sessions[i] });
  }

  create(userId: number): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = { id: generateSessionToken(), userId, createdAt: now, lastSeenAt: now };
    this.sessions.push(session);
    return Promise.resolve({ ...session });
  }

  deleteById(id: string): Promise<boolean> {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter(s => s.id !== id);
    return Promise.resolve(this.sessions.length < before);
  }

  deleteByUserId(userId: number): Promise<number> {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter(s => s.userId !== userId);
    return Promise.resolve(before - this.sessions.length);
  }

  deleteByUserIdExcept(userId: number, exceptId: string): Promise<number> {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter(s => s.userId !== userId || s.id === exceptId);
    return Promise.resolve(before - this.sessions.length);
  }

  deleteAll(): Promise<void> {
    this.sessions = [];
    return Promise.resolve();
  }
}

class MemoryApiKeyRepo implements ApiKeyRepo {
  private keys: ApiKey[] = [];

  constructor(private readonly expirationSweeps: ExpirationSweepsRepo) {}

  private schedulePolicyChanges(previous: ApiKey, next: ApiKey): Promise<void> {
    const schedules: Promise<void>[] = [];
    if (previous.openaiResponsesRetentionSeconds !== next.openaiResponsesRetentionSeconds || previous.deletedAt !== next.deletedAt) {
      schedules.push(this.expirationSweeps.schedule('responses', next.id, 0));
    }
    if (previous.dumpRetentionSeconds !== next.dumpRetentionSeconds || previous.deletedAt !== next.deletedAt) {
      schedules.push(this.expirationSweeps.schedule('dumps', next.id, 0));
    }
    return Promise.all(schedules).then(() => undefined);
  }

  list(): Promise<ApiKey[]> {
    return Promise.resolve(this.keys.filter(k => k.deletedAt === null).map(k => ({ ...k })));
  }

  listIncludingDeleted(): Promise<ApiKey[]> {
    return Promise.resolve(this.keys.map(k => ({ ...k })));
  }

  listByUserId(userId: number): Promise<ApiKey[]> {
    return Promise.resolve(this.keys.filter(k => k.userId === userId && k.deletedAt === null).map(k => ({ ...k })));
  }

  listByUserIdIncludingDeleted(userId: number): Promise<ApiKey[]> {
    return Promise.resolve(this.keys.filter(k => k.userId === userId).map(k => ({ ...k })));
  }

  findByRawKey(rawKey: string): Promise<ApiKey | null> {
    const k = this.keys.find(k => k.key === rawKey && k.deletedAt === null);
    return Promise.resolve(k ? { ...k } : null);
  }

  getById(id: string): Promise<ApiKey | null> {
    const k = this.keys.find(k => k.id === id && k.deletedAt === null);
    return Promise.resolve(k ? { ...k } : null);
  }

  async save(key: ApiKey): Promise<void> {
    const i = this.keys.findIndex(k => k.id === key.id);
    if (i >= 0) {
      const previous = this.keys[i];
      this.keys[i] = { ...key };
      try {
        await this.schedulePolicyChanges(previous, key);
      } catch (error) {
        this.keys[i] = previous;
        throw error;
      }
    } else this.keys.push({ ...key });
  }

  async update(id: string, patch: ApiKeyUpdate): Promise<ApiKey | null> {
    const i = this.keys.findIndex(key => key.id === id && key.deletedAt === null);
    if (i < 0) return null;
    const previous = this.keys[i];
    const next = { ...previous, ...patch };
    this.keys[i] = next;
    try {
      await this.schedulePolicyChanges(previous, next);
    } catch (error) {
      this.keys[i] = previous;
      throw error;
    }
    return { ...next };
  }

  setLastUsedAt(id: string, lastUsedAt: string): Promise<void> {
    const key = this.keys.find(key => key.id === id && key.deletedAt === null);
    if (key) key.lastUsedAt = lastUsedAt;
    return Promise.resolve();
  }

  async softDelete(id: string): Promise<boolean> {
    const i = this.keys.findIndex(k => k.id === id && k.deletedAt === null);
    if (i < 0) return false;
    const previous = this.keys[i];
    const next = { ...previous, deletedAt: new Date().toISOString(), openaiResponsesRetentionSeconds: 0 };
    this.keys[i] = next;
    try {
      await this.schedulePolicyChanges(previous, next);
    } catch (error) {
      this.keys[i] = previous;
      throw error;
    }
    return true;
  }

  async softDeleteByUserId(userId: number): Promise<number> {
    const now = new Date().toISOString();
    const updates: Array<{ index: number; previous: ApiKey; next: ApiKey }> = [];
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[i];
      if (k.userId === userId && k.deletedAt === null) {
        const next = { ...k, deletedAt: now, openaiResponsesRetentionSeconds: 0 };
        updates.push({ index: i, previous: k, next });
      }
    }
    for (const update of updates) this.keys[update.index] = update.next;
    try {
      await Promise.all(updates.map(update => this.schedulePolicyChanges(update.previous, update.next)));
    } catch (error) {
      for (const update of updates) this.keys[update.index] = update.previous;
      throw error;
    }
    return updates.length;
  }

  async deleteAll(): Promise<void> {
    const previous = this.keys;
    this.keys = [];
    try {
      await Promise.all(previous.flatMap(key => [
        this.expirationSweeps.schedule('responses', key.id, 0),
        this.expirationSweeps.schedule('dumps', key.id, 0),
      ]));
    } catch (error) {
      this.keys = previous;
      throw error;
    }
  }
}

interface UsageBucketIdentity {
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  hour: string;
  pricingSelector: PricingSelector;
}

interface UsageBucketState extends UsageBucketIdentity {
  metrics: Map<BillingMetric, { metric: BillingMetric; quantity: DecimalString; unitPrice: DecimalString | null }>;
  requests: number;
}

const memoryUsageUserIdForKey = (keyId: string, keyToUser: ReadonlyMap<string, number>): number =>
  keyToUser.get(keyId) ?? tokenUsageUnattributedUserId;

const accumulateMemoryOverview = (aggregate: UsageOverviewRecord, record: UsageRecord) => {
  aggregate.requests += record.requests;
  for (const row of record.metrics) {
    const metric = aggregate.metrics.find(candidate => candidate.metric === row.metric);
    if (metric) metric.quantity = addDecimalStrings(metric.quantity, row.quantity);
    else aggregate.metrics.push({ metric: row.metric, quantity: row.quantity });
    if (row.unitPrice !== null) {
      aggregate.cost = addDecimalStrings(
        aggregate.cost ?? '0',
        multiplyDecimalStrings(row.quantity, row.unitPrice),
      );
    }
  }
};

const memoryOverviewGroup = (
  record: UsageRecord,
  axis: UsageOverviewAxis,
  keyToUser: ReadonlyMap<string, number>,
): string => {
  if (axis === 'none') return 'all';
  if (axis === 'userId') return String(memoryUsageUserIdForKey(record.keyId, keyToUser));
  if (axis === 'upstream') return usageUpstreamDimensionValue(record.upstream);
  return record[axis];
};

const aggregateMemoryOverview = (
  records: readonly UsageRecord[],
  keyToUser: ReadonlyMap<string, number>,
  visibleKeyIds: ReadonlySet<string>,
): Map<UsageOverviewAxis, UsageOverviewRecord[]> => {
  const axes: UsageOverviewAxis[] = ['none', 'keyId', 'userId', 'model', 'upstream'];
  const result = new Map<UsageOverviewAxis, UsageOverviewRecord[]>();
  for (const axis of axes) {
    const aggregates = new Map<string, UsageOverviewRecord>();
    for (const record of records) {
      if (axis === 'keyId' && !visibleKeyIds.has(record.keyId)) continue;
      const group = memoryOverviewGroup(record, axis, keyToUser);
      let aggregate = aggregates.get(group);
      if (!aggregate) {
        aggregate = { group, requests: 0, metrics: [], cost: null };
        aggregates.set(group, aggregate);
      }
      accumulateMemoryOverview(aggregate, record);
    }
    result.set(axis, [...aggregates.values()].sort((left, right) => left.group.localeCompare(right.group)));
  }
  return result;
};

class MemoryUsageRepo implements UsageRepo {
  private store = new Map<string, UsageBucketState>();

  constructor(private readonly apiKeys: ApiKeyRepo) {}

  private key(r: UsageBucketIdentity): string {
    return [r.keyId, r.model, r.upstream ?? '', r.modelKey, r.hour, canonicalPricingSelectorKey(r.pricingSelector)].join('\0');
  }

  private toRecord(state: UsageBucketState): UsageRecord {
    return { keyId: state.keyId, model: state.model, upstream: state.upstream ?? null, modelKey: state.modelKey, hour: state.hour, pricingSelector: state.pricingSelector, requests: state.requests, metrics: [...state.metrics.values()].map(row => ({ ...row })) };
  }

  private bucket(record: UsageRecord): UsageBucketState {
    const pricingSelector = canonicalizePricingSelector(record.pricingSelector);
    const k = this.key({ ...record, pricingSelector });
    let state = this.store.get(k);
    if (!state) {
      state = { keyId: record.keyId, model: record.model, upstream: record.upstream ?? null, modelKey: record.modelKey, hour: record.hour, pricingSelector, metrics: new Map(), requests: 0 };
      this.store.set(k, state);
    }
    return state;
  }

  record(record: UsageRecord): Promise<void> {
    const state = this.bucket(record);
    state.requests += record.requests;
    for (const row of usageMetricRows(record)) {
      const current = state.metrics.get(row.metric);
      state.metrics.set(row.metric, current
        ? { ...current, quantity: addDecimalStrings(current.quantity, row.quantity) }
        : { ...row });
    }
    return Promise.resolve();
  }

  query(opts: { keyIds?: readonly string[]; start: string; end: string }): Promise<UsageRecord[]> {
    const keyIds = opts.keyIds === undefined ? undefined : new Set(opts.keyIds);
    return Promise.resolve(
      [...this.store.values()]
        .filter(r => {
          if (keyIds !== undefined && !keyIds.has(r.keyId)) return false;
          return r.hour >= opts.start && r.hour < opts.end;
        })
        .map(r => this.toRecord(r))
        .sort((a, b) => a.hour.localeCompare(b.hour)),
    );
  }

  async queryOverview(opts: UsageOverviewQueryOptions): Promise<UsageOverviewResult[]> {
    const keyToUser = buildKeyToUserMap(await this.apiKeys.listIncludingDeleted());
    const records = [...this.store.values()]
      .filter(record => record.hour >= opts.start && record.hour < opts.end)
      .map(record => this.toRecord(record));
    const scoped = opts.ownedKeysOnly
      ? records.filter(record => keyToUser.get(record.keyId) === opts.actorUserId)
      : records;
    const visibleUserIds = new Set(opts.visibleUserIds);
    const visibleUpstreams = new Set(opts.visibleUpstreams);
    const authorized = scoped.filter(record => opts.isAdmin
      || visibleUserIds.has(memoryUsageUserIdForKey(record.keyId, keyToUser))
      || (record.upstream !== null && visibleUpstreams.has(record.upstream)));
    const visibleKeyIds = new Set([...keyToUser]
      .filter(([, userId]) => userId === opts.actorUserId)
      .map(([keyId]) => keyId));
    const hourlyBuckets = new Set(opts.hourlyBuckets);
    const buckets = Map.groupBy(authorized, ({ hour }) => {
      const bucket = overviewBucketId(opts.bucket, hour);
      return hourlyBuckets.has(bucket) ? hour : bucket;
    });
    return [...buckets.values()].map(bucketRecords => {
      const partitioned = partitionTelemetryOverviewRecords(bucketRecords, {
        keyId: {
          value: record => record.keyId,
          includeFacet: record => visibleKeyIds.has(record.keyId),
        },
        userId: {
          value: record => String(memoryUsageUserIdForKey(record.keyId, keyToUser)),
          includeFacet: () => true,
        },
        model: { value: record => record.model },
        upstream: { value: record => usageUpstreamDimensionValue(record.upstream) },
      }, {
        keyId: new Set(opts.filters.keyIds),
        userId: new Set(opts.filters.userIds.map(String)),
        model: new Set(opts.filters.models),
        upstream: new Set(opts.filters.upstreams),
      });
      const aggregates = aggregateMemoryOverview(partitioned.filtered, keyToUser, visibleKeyIds);
      const hours = bucketRecords.map(record => record.hour).sort();
      return {
        firstHour: hours[0]!,
        lastHour: hours.at(-1)!,
        axes: {
          none: aggregates.get('none')!,
          keyId: aggregates.get('keyId')!,
          userId: aggregates.get('userId')!,
          model: aggregates.get('model')!,
          upstream: aggregates.get('upstream')!,
        },
        dimensionValues: {
          keyIds: partitioned.dimensionValues.keyId,
          userIds: partitioned.dimensionValues.userId.map(Number).sort((left, right) => left - right),
          models: partitioned.dimensionValues.model,
          upstreams: partitioned.dimensionValues.upstream,
        },
      };
    }).sort((left, right) => left.firstHour.localeCompare(right.firstHour));
  }

  listAll(): Promise<UsageRecord[]> {
    return Promise.resolve([...this.store.values()].map(r => this.toRecord(r)).sort((a, b) => a.hour.localeCompare(b.hour)));
  }

  set(record: UsageRecord): Promise<void> {
    const pricingSelector = canonicalizePricingSelector(record.pricingSelector);
    const k = this.key({ ...record, pricingSelector });
    const state: UsageBucketState = {
      keyId: record.keyId,
      model: record.model,
      upstream: record.upstream ?? null,
      modelKey: record.modelKey,
      hour: record.hour,
      pricingSelector,
      metrics: new Map(),
      requests: record.requests,
    };
    for (const row of usageMetricRows(record)) {
      state.metrics.set(row.metric, { ...row });
    }
    this.store.set(k, state);
    return Promise.resolve();
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

class MemoryWebSearchUsageRepo implements WebSearchUsageRepo {
  private store = new Map<string, WebSearchUsageRecord>();

  private key(r: { provider: WebSearchUsageRecord['provider']; keyId: string; action: WebSearchUsageRecord['action']; hour: string }): string {
    return `${r.provider}\0${r.keyId}\0${r.action}\0${r.hour}`;
  }

  record(args: { provider: WebSearchUsageRecord['provider']; keyId: string; action: WebSearchUsageRecord['action']; hour: string; requests: number }): Promise<void> {
    return Promise.resolve().then(() => {
      const validProvider = assertWebSearchProviderName(args.provider);
      const k = this.key({ provider: validProvider, keyId: args.keyId, action: args.action, hour: args.hour });
      const existing = this.store.get(k);
      if (existing) {
        existing.requests += args.requests;
      } else {
        this.store.set(k, { provider: validProvider, keyId: args.keyId, action: args.action, hour: args.hour, requests: args.requests });
      }
    });
  }

  query(opts: { provider?: WebSearchUsageRecord['provider']; keyId?: string; action?: WebSearchUsageRecord['action']; start: string; end: string }): Promise<WebSearchUsageRecord[]> {
    return Promise.resolve().then(() => {
      const provider = opts.provider ? assertWebSearchProviderName(opts.provider) : undefined;
      return [...this.store.values()]
        .filter(r => !provider || r.provider === provider)
        .filter(r => !opts.keyId || r.keyId === opts.keyId)
        .filter(r => !opts.action || r.action === opts.action)
        .filter(r => r.hour >= opts.start && r.hour < opts.end)
        .map(r => ({ ...r }))
        .sort((a, b) => a.hour.localeCompare(b.hour));
    });
  }

  listAll(): Promise<WebSearchUsageRecord[]> {
    return Promise.resolve([...this.store.values()].map(r => ({ ...r })).sort((a, b) => a.hour.localeCompare(b.hour)));
  }

  set(record: WebSearchUsageRecord): Promise<void> {
    return Promise.resolve().then(() => {
      const provider = assertWebSearchProviderName(record.provider);
      const validRecord = { ...record, provider };
      this.store.set(this.key(validRecord), validRecord);
    });
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

type StoredPerformanceRow = Omit<PerformanceTelemetryRecord, 'buckets'> & { bucketMap: Map<string, PerformanceBucketRow> };

const comparePerformanceRow = (a: StoredPerformanceRow, b: StoredPerformanceRow): number =>
  a.hour.localeCompare(b.hour)
  || a.keyId.localeCompare(b.keyId)
  || a.model.localeCompare(b.model)
  || a.upstream.localeCompare(b.upstream)
  || a.operation.localeCompare(b.operation)
  || a.runtimeLocation.localeCompare(b.runtimeLocation);

const compareBucketRow = (a: PerformanceBucketRow, b: PerformanceBucketRow): number =>
  a.metric.localeCompare(b.metric) || a.lower - b.lower;

const freezePerformanceRow = ({ bucketMap, ...rest }: StoredPerformanceRow): PerformanceTelemetryRecord => ({
  ...rest,
  buckets: [...bucketMap.values()].map(b => ({ ...b })).sort(compareBucketRow),
});

class MemoryPerformanceRepo implements PerformanceRepo {
  private readonly summaries = new Map<string, StoredPerformanceRow>();

  constructor(private readonly apiKeys: ApiKeyRepo) {}

  async recordSample(sample: PerformanceSample): Promise<void> {
    const row = this.upsertRow(sample);
    row.requests += 1;
    if (sample.success) row.ttftSamplesOk += 1;
    else row.errorsWithOutput += 1;
    row.ttftMsSum += sample.ttftMs;
    this.incrementBucket(row, 'ttft_ms', bucketForTtftMs(sample.ttftMs));
    if (sample.tpotUs !== undefined) {
      row.tpotSamples += 1;
      row.tpotUsSum += sample.tpotUs;
      this.incrementBucket(row, 'tpot_us', bucketForTpotUs(sample.tpotUs));
    }
  }

  async recordZeroOutputError(dims: PerformanceDimensions): Promise<void> {
    const row = this.upsertRow(dims);
    row.requests += 1;
    row.errorsNoOutput += 1;
  }

  async recordNeutral(dims: PerformanceDimensions): Promise<void> {
    const row = this.upsertRow(dims);
    row.requests += 1;
    row.neutral += 1;
  }

  async queryOverview(opts: PerformanceOverviewQueryOptions): Promise<PerformanceOverviewResult> {
    const { authorized, keyToUser, visibleKeyIds } = await this.authorizedRows(opts, opts.groupBy === 'keyId');
    const partitioned = this.partitionOverview(authorized, opts.filters, keyToUser, visibleKeyIds);
    const { series, ...axes } = aggregatePerformanceForDisplay(partitioned.filtered, {
      series: { groupBy: opts.groupBy, bucketForHour: opts.bucketForHour },
      none: { groupBy: 'none', bucketForHour: () => 'all' },
      model: { groupBy: 'model', bucketForHour: () => 'all' },
      upstream: { groupBy: 'upstream', bucketForHour: () => 'all' },
      runtimeLocation: { groupBy: 'runtimeLocation', bucketForHour: () => 'all' },
      operation: { groupBy: 'operation', bucketForHour: () => 'all' },
      keyId: { groupBy: 'keyId', bucketForHour: () => 'all' },
      userId: { groupBy: 'userId', bucketForHour: () => 'all' },
    }, keyToUser, visibleKeyIds);
    return { series, axes, dimensionValues: partitioned.dimensionValues };
  }

  async querySlices(opts: PerformanceSliceQuery) {
    const { authorized, keyToUser, visibleKeyIds } = await this.authorizedRows(opts, opts.ownedKeysOnly);
    return [...Map.groupBy(authorized, record => {
      const bucket = overviewBucketId(opts.bucket, record.hour);
      return opts.hourlyBuckets.includes(bucket) ? record.hour : bucket;
    }).values()].flatMap(records => {
      const partitioned = this.partitionOverview(records, opts.filters, keyToUser, visibleKeyIds);
      const rows = aggregatePerformanceSlice(partitioned.filtered, opts.dimension, keyToUser, visibleKeyIds);
      const [total] = opts.includeTotals ? aggregatePerformanceSlice(partitioned.filtered, 'none', keyToUser, visibleKeyIds) : [];
      if (rows.length === 0 && total === undefined && !opts.includeFacets) return [];
      return [{
        firstHour: records[0]!.hour, lastHour: records.at(-1)!.hour, rows,
        ...(total === undefined ? {} : { total }),
        dimensionValues: opts.includeFacets ? partitioned.dimensionValues : {
          models: [], upstreams: [], operations: [], runtimeLocations: [], userIds: [], keyIds: [],
        },
      }];
    });
  }

  private async authorizedRows(opts: Pick<PerformanceOverviewQueryOptions, 'actorUserId' | 'start' | 'end' | 'isAdmin' | 'visibleUserIds' | 'visibleUpstreams'>, ownedKeysOnly: boolean) {
    const keyToUser = buildKeyToUserMap(await this.apiKeys.listIncludingDeleted());
    const visibleKeyIds = new Set([...keyToUser]
      .filter(([, userId]) => userId === opts.actorUserId)
      .map(([keyId]) => keyId));
    const records = [...this.summaries.values()]
      .filter(record => record.hour >= opts.start && record.hour < opts.end)
      .sort(comparePerformanceRow)
      .map(freezePerformanceRow);
    const scoped = ownedKeysOnly
      ? records.filter(record => visibleKeyIds.has(record.keyId))
      : records;
    const visibleUserIds = new Set(opts.visibleUserIds);
    const visibleUpstreams = new Set(opts.visibleUpstreams);
    const authorized = scoped.filter(record => opts.isAdmin
      || visibleUserIds.has(keyToUser.get(record.keyId) ?? tokenUsageUnattributedUserId)
      || visibleUpstreams.has(record.upstream));
    return { authorized, keyToUser, visibleKeyIds };
  }

  private partitionOverview(
    authorized: readonly PerformanceTelemetryRecord[],
    filters: PerformanceOverviewQueryOptions['filters'],
    keyToUser: ReadonlyMap<string, number>,
    visibleKeyIds: ReadonlySet<string>,
  ) {
    const partitioned = partitionTelemetryOverviewRecords(authorized, {
      model: { value: record => record.model },
      upstream: { value: record => record.upstream },
      operation: { value: record => record.operation },
      runtimeLocation: { value: record => record.runtimeLocation },
      userId: {
        value: record => keyToUser.get(record.keyId)?.toString() ?? null,
        includeFacet: () => true,
      },
      keyId: {
        value: record => record.keyId,
        includeFacet: record => visibleKeyIds.has(record.keyId),
      },
    }, {
      model: new Set(filters.models),
      upstream: new Set(filters.upstreams),
      operation: new Set(filters.operations),
      runtimeLocation: new Set(filters.runtimeLocations),
      userId: new Set(filters.userIds.map(String)),
      keyId: new Set(filters.keyIds),
    });
    return {
      filtered: partitioned.filtered,
      dimensionValues: {
        models: partitioned.dimensionValues.model,
        upstreams: partitioned.dimensionValues.upstream,
        operations: partitioned.dimensionValues.operation,
        runtimeLocations: partitioned.dimensionValues.runtimeLocation,
        userIds: partitioned.dimensionValues.userId.map(Number).sort((left, right) => left - right),
        keyIds: partitioned.dimensionValues.keyId,
      },
    };
  }

  async listAll(): Promise<PerformanceTelemetryRecord[]> {
    return [...this.summaries.values()].sort(comparePerformanceRow).map(freezePerformanceRow);
  }

  async set(record: PerformanceTelemetryRecord): Promise<void> {
    const key = this.rowKey(record);
    const { buckets, ...dims } = record;
    const bucketMap = new Map(buckets.map(b => [`${b.metric}\0${b.lower}`, { ...b }] as const));
    this.summaries.set(key, { ...dims, bucketMap });
  }

  async deleteAll(): Promise<void> {
    this.summaries.clear();
  }

  private rowKey(dims: PerformanceDimensions): string {
    return `${dims.hour}\0${dims.keyId}\0${dims.model}\0${dims.upstream}\0${dims.operation}\0${dims.runtimeLocation}`;
  }

  private upsertRow(dims: PerformanceDimensions): StoredPerformanceRow {
    const key = this.rowKey(dims);
    let row = this.summaries.get(key);
    if (!row) {
      row = {
        hour: dims.hour,
        keyId: dims.keyId,
        model: dims.model,
        upstream: dims.upstream,
        operation: dims.operation,
        runtimeLocation: dims.runtimeLocation,
        requests: 0,
        ttftSamplesOk: 0,
        errorsWithOutput: 0,
        errorsNoOutput: 0,
        neutral: 0,
        tpotSamples: 0,
        ttftMsSum: 0,
        tpotUsSum: 0,
        bucketMap: new Map(),
      };
      this.summaries.set(key, row);
    }
    return row;
  }

  private incrementBucket(row: StoredPerformanceRow, metric: PerformanceMetric, edges: { lower: number; upper: number | null }) {
    const key = `${metric}\0${edges.lower}`;
    const existing = row.bucketMap.get(key);
    if (existing) { existing.count += 1; return; }
    row.bucketMap.set(key, { metric, lower: edges.lower, upper: edges.upper, count: 1 });
  }
}

class MemorySiteSettingsRepo implements SiteSettingsRepo {
  private settings: SiteSettings = { siteName: null };

  get(): Promise<SiteSettings> {
    return Promise.resolve({ ...this.settings });
  }

  save(settings: SiteSettings): Promise<void> {
    this.settings = { ...settings };
    return Promise.resolve();
  }
}

class MemoryWebSearchConfigRepo implements WebSearchConfigRepo {
  private config: unknown | null = null;

  get(): Promise<unknown | null> {
    return Promise.resolve(this.config === null ? null : structuredClone(this.config));
  }

  save(config: WebSearchConfig): Promise<void> {
    this.config = structuredClone(config);
    return Promise.resolve();
  }
}

const toUpstreamMeta = (record: StoredUpstreamRecord): StoredUpstreamMeta => ({
  id: record.id,
  kind: record.kind,
  name: record.name,
  enabled: record.enabled,
  sortOrder: record.sortOrder,
  hue: record.hue,
});

const emptyModelsCacheState = (): UpstreamModelsCacheState => ({
  revision: null,
  fetchedAt: null,
  lastError: null,
});

const applyCacheAction = (
  current: UpstreamModelsCacheState,
  action: UpstreamModelsCacheAction,
): UpstreamModelsCacheState => {
  switch (action.kind) {
  case 'preserve':
    return structuredClone(current);
  case 'mark-stale':
    return { revision: null, fetchedAt: current.fetchedAt, lastError: null };
  case 'clear-cache':
    return emptyModelsCacheState();
  case 'set-fresh':
    return { revision: action.revision, fetchedAt: action.fetchedAt, lastError: null };
  }
};

const dedupeMemoryModels = (entries: readonly UpstreamModelEntry[]): UpstreamModelEntry[] => {
  const seen = new Set<string>();
  const out: UpstreamModelEntry[] = [];
  for (const entry of entries) {
    if (!entry.model.id) continue;
    const key = `${entry.model.id}\0${entry.model.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: entry.source, model: structuredClone(entry.model) });
  }
  out.sort((a, b) => a.model.kind.localeCompare(b.model.kind) || a.model.id.localeCompare(b.model.id));
  return out;
};

const memoryRequiresNetwork = (record: StoredUpstreamRecord): boolean => {
  if (record.kind === 'azure') return false;
  if (record.kind === 'custom') {
    const cfg = record.config as { modelsFetch?: { enabled?: unknown } } | null;
    return cfg?.modelsFetch?.enabled !== false;
  }
  return true;
};

class MemoryUpstreamStore {
  readonly upstreams = new Map<string, StoredUpstreamRecord>();
  readonly models = new Map<string, UpstreamModelEntry[]>();
  readonly manualModels = new Map<string, UpstreamModelConfig[]>();
}

class MemoryUpstreamRepo implements UpstreamRepo {
  constructor(
    private readonly shared: MemoryUpstreamStore,
    private readonly backoffs: MemoryProxyBackoffRows,
  ) {}

  has(id: string): boolean {
    return this.shared.upstreams.has(id);
  }

  private sorted(): StoredUpstreamRecord[] {
    return [...this.shared.upstreams.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  list(): Promise<StoredUpstreamRecord[]> {
    return Promise.resolve(this.sorted().map(cloneUpstreamRecord));
  }

  listIds(): Promise<string[]> {
    return Promise.resolve(this.sorted().map(record => record.id));
  }

  listMeta(): Promise<StoredUpstreamMeta[]> {
    return Promise.resolve(this.sorted().map(toUpstreamMeta));
  }

  getMetaByIds(ids: readonly string[]): Promise<StoredUpstreamMeta[]> {
    const wanted = new Set(ids);
    if (wanted.size === 0) return Promise.resolve([]);
    return Promise.resolve(this.sorted().filter(record => wanted.has(record.id)).map(toUpstreamMeta));
  }

  getById(id: string): Promise<StoredUpstreamRecord | null> {
    const found = this.shared.upstreams.get(id);
    return Promise.resolve(found ? cloneUpstreamRecord(found) : null);
  }

  listDueModelsRefresh(revision: number, nowMs: number): Promise<DueModelsRefreshCandidate[]> {
    const staleBefore = nowMs - AUTOMATIC_REFRESH_INTERVAL_MS;
    const due: DueModelsRefreshCandidate[] = [];
    for (const record of this.sorted()) {
      if (!record.enabled) continue;
      const requiresNetwork = memoryRequiresNetwork(record);
      const isDue = record.modelsCache.revision !== revision
        || record.modelsCache.fetchedAt === null
        || (requiresNetwork && record.modelsCache.fetchedAt <= staleBefore);
      if (!isDue) continue;
      if (record.modelsCache.lastError !== null && modelsRefreshRetryAt(record.modelsCache.lastError) > nowMs) continue;
      due.push({
        id: record.id,
        kind: record.kind,
        version: record.version,
        proxyFallbackList: normalizeProxyFallbackList(record.proxyFallbackList),
        requiresNetwork,
      });
    }
    return Promise.resolve(due);
  }

  async reorder(
    expectedIds: readonly string[],
    assignments: readonly { id: string; sortOrder: number }[],
  ): Promise<StoredUpstreamMeta[] | null> {
    const current = this.sorted();
    if (JSON.stringify(current.map(record => record.id)) !== JSON.stringify(expectedIds)) return null;
    const assignmentIds = assignments.map(assignment => assignment.id);
    if (new Set(assignmentIds).size !== assignmentIds.length || assignmentIds.some(id => !this.shared.upstreams.has(id))) return null;
    const now = new Date().toISOString();
    const updated = assignments.map(({ id, sortOrder }) => {
      const record = this.shared.upstreams.get(id)!;
      return cloneUpstreamRecord({ ...record, sortOrder, updatedAt: now, version: record.version + 1 });
    });
    for (const record of updated) this.shared.upstreams.set(record.id, record);
    return updated.map(toUpstreamMeta);
  }

  private applyChildWrites(
    upstreamId: string,
    manualModels: readonly UpstreamModelConfig[] | undefined,
    modelsWrite: UpstreamModelsWritePayload | undefined,
  ): void {
    if (manualModels !== undefined) {
      if (manualModels.length === 0) this.shared.manualModels.delete(upstreamId);
      else this.shared.manualModels.set(upstreamId, structuredClone([...manualModels]));
    }
    if (modelsWrite?.models !== undefined) {
      this.shared.models.set(upstreamId, dedupeMemoryModels(modelsWrite.models));
    }
  }

  insertAtEnd(input: {
    readonly upstream: UpstreamRecord;
    readonly manualModels?: readonly UpstreamModelConfig[];
    readonly modelsWrite?: UpstreamModelsWritePayload;
  }): Promise<StoredUpstreamRecord | null> {
    const sortOrder = Math.max(-1, ...[...this.shared.upstreams.values()].map(record => record.sortOrder)) + 1;
    return this.insert({ ...input, upstream: { ...input.upstream, sortOrder } });
  }

  insert(input: {
    readonly upstream: UpstreamRecord;
    readonly manualModels?: readonly UpstreamModelConfig[];
    readonly modelsWrite?: UpstreamModelsWritePayload;
  }): Promise<StoredUpstreamRecord | null> {
    const { upstream, manualModels, modelsWrite } = input;
    if (this.shared.upstreams.has(upstream.id)) return Promise.resolve(null);
    const cacheAction = modelsWrite?.cacheAction ?? { kind: 'preserve' as const };
    const stored = cloneUpstreamRecord({
      ...upstream,
      version: 1,
      modelsCache: applyCacheAction(emptyModelsCacheState(), cacheAction),
    });
    this.shared.upstreams.set(upstream.id, stored);
    this.applyChildWrites(upstream.id, manualModels, modelsWrite);
    return Promise.resolve(cloneUpstreamRecord(stored));
  }

  replace(input: {
    readonly previous: StoredUpstreamRecord;
    readonly upstream: UpstreamRecord;
    readonly replaceState?: boolean;
    readonly manualModels?: readonly UpstreamModelConfig[];
    readonly modelsWrite?: UpstreamModelsWritePayload;
  }): Promise<StoredUpstreamRecord | null> {
    const { previous, upstream, manualModels, modelsWrite } = input;
    const existing = this.shared.upstreams.get(upstream.id);
    if (existing === undefined || existing.version !== previous.version) return Promise.resolve(null);
    const replaceState = input.replaceState ?? serializeStoredState(previous.state) !== serializeStoredState(upstream.state);
    const next = cloneUpstreamRecord({
      ...upstream,
      createdAt: existing.createdAt,
      version: existing.version + 1,
      state: replaceState ? upstream.state : existing.state,
      modelsCache: applyCacheAction(existing.modelsCache, modelsWrite?.cacheAction ?? { kind: 'preserve' }),
    });
    this.shared.upstreams.set(upstream.id, next);
    this.applyChildWrites(upstream.id, manualModels, modelsWrite);
    return Promise.resolve(cloneUpstreamRecord(next));
  }

  delete(id: string): Promise<boolean> {
    const deleted = this.shared.upstreams.delete(id);
    if (deleted) {
      this.shared.models.delete(id);
      this.shared.manualModels.delete(id);
      this.backoffs.deleteWhere(row => row.upstreamId === id);
    }
    return Promise.resolve(deleted);
  }

  deleteAll(): Promise<void> {
    this.shared.upstreams.clear();
    this.shared.models.clear();
    this.shared.manualModels.clear();
    this.backoffs.clear();
    return Promise.resolve();
  }

  saveState(id: string, mutate: (current: unknown, version: number) => unknown): Promise<void> {
    const existing = this.shared.upstreams.get(id);
    if (!existing) throw new UpstreamGoneError(id);
    const next = mutate(existing.state, existing.version);
    const serialized = serializeStoredState(next);
    existing.state = serialized === null ? null : (JSON.parse(serialized) as unknown);
    return Promise.resolve();
  }

  publishModelsRefresh(input: ModelsRefreshSuccessInput): Promise<number | null> {
    const { id, version, revision, fetchedAt, models } = input;
    const existing = this.shared.upstreams.get(id);
    if (existing?.version !== version) return Promise.resolve(null);
    existing.version += 1;
    existing.modelsCache = { revision, fetchedAt, lastError: null };
    this.shared.models.set(id, dedupeMemoryModels(models));
    return Promise.resolve(existing.version);
  }

  recordModelsRefreshFailure(input: ModelsRefreshFailureInput): Promise<boolean> {
    const { id, version, error } = input;
    const existing = this.shared.upstreams.get(id);
    if (existing?.version !== version) return Promise.resolve(false);
    const previousCount = existing.modelsCache.lastError?.failureCount ?? 0;
    existing.modelsCache = {
      ...existing.modelsCache,
      lastError: {
        message: storedModelErrorMessage(error.message),
        at: error.at,
        failureCount: previousCount + 1,
      },
    };
    return Promise.resolve(true);
  }
}

class MemoryUpstreamModelsRepo implements UpstreamModelsRepo {
  constructor(private readonly shared: MemoryUpstreamStore) {}

  private sortedUpstreams(upstreamIds: readonly string[] | null): StoredUpstreamRecord[] {
    const all = [...this.shared.upstreams.values()]
      .filter(u => u.enabled)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (upstreamIds === null) return all;
    const rank = new Map(upstreamIds.map((id, index) => [id, index] as const));
    return all.filter(u => rank.has(u.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  }

  resolve(input: {
    readonly modelIds: readonly string[];
    readonly upstreamIds: readonly string[] | null;
  }): Promise<ResolvedUpstreamModelMatch[]> {
    const modelIds = [...new Set(input.modelIds.filter(id => id.length > 0))];
    if (modelIds.length === 0) return Promise.resolve([]);
    if (input.upstreamIds !== null && input.upstreamIds.length === 0) return Promise.resolve([]);

    const modelIdSet = new Set(modelIds);
    const orderedUpstreams = this.sortedUpstreams(input.upstreamIds);
    const matches: ResolvedUpstreamModelMatch[] = [];

    for (const upstream of orderedUpstreams) {
      const disabled = new Set(upstream.disabledPublicModelIds);
      const entries = this.shared.models.get(upstream.id) ?? [];
      const clonedUpstream = cloneUpstreamRecord(upstream);
      const allowsUnprefixed = upstream.modelPrefix === null || upstream.modelPrefix.addressable.includes('unprefixed');
      const allowsPrefixed = upstream.modelPrefix?.addressable.includes('prefixed') ?? false;

      if (allowsUnprefixed) {
        for (const entry of entries) {
          if (disabled.has(entry.model.id) || !modelIdSet.has(entry.model.id)) continue;
          matches.push({
            matchedInputId: entry.model.id,
            matchedForm: 'unprefixed',
            upstream: clonedUpstream,
            model: structuredClone(entry.model),
          });
        }
      }
      if (allowsPrefixed) {
        const prefix = upstream.modelPrefix!.prefix;
        for (const inputId of modelIds) {
          if (!inputId.startsWith(prefix)) continue;
          const rest = inputId.slice(prefix.length);
          if (rest.length === 0 || disabled.has(rest)) continue;
          for (const entry of entries) {
            if (entry.model.id !== rest) continue;
            matches.push({
              matchedInputId: inputId,
              matchedForm: 'prefixed',
              upstream: clonedUpstream,
              model: structuredClone(entry.model),
            });
          }
        }
      }
    }
    return Promise.resolve(matches);
  }

  listCatalog(upstreamIds: readonly string[] | null): Promise<{
    readonly upstreams: CatalogUpstreamRow[];
    readonly models: CatalogModelEntry[];
  }> {
    if (upstreamIds !== null && upstreamIds.length === 0) return Promise.resolve({ upstreams: [], models: [] });
    const orderedUpstreams = this.sortedUpstreams(upstreamIds);
    const upstreams: CatalogUpstreamRow[] = orderedUpstreams.map(u => ({
      id: u.id,
      kind: u.kind,
      name: u.name,
      hue: u.hue,
      sortOrder: u.sortOrder,
      modelPrefix: structuredClone(u.modelPrefix),
    }));
    const models: CatalogModelEntry[] = [];
    for (const u of orderedUpstreams) {
      const disabled = new Set(u.disabledPublicModelIds);
      for (const entry of this.shared.models.get(u.id) ?? []) {
        if (disabled.has(entry.model.id)) continue;
        models.push({ upstreamId: u.id, model: structuredClone(entry.model) });
      }
    }
    return Promise.resolve({ upstreams, models });
  }

  listAddressableIdsForUpstreams(upstreamIds: readonly string[]): Promise<{
    readonly upstreamId: string;
    readonly addressableId: string;
  }[]> {
    const wanted = new Set(upstreamIds);
    if (wanted.size === 0) return Promise.resolve([]);
    const out: { readonly upstreamId: string; readonly addressableId: string }[] = [];
    for (const u of this.shared.upstreams.values()) {
      if (!u.enabled || !wanted.has(u.id)) continue;
      const disabled = new Set(u.disabledPublicModelIds);
      const seenModelIds = new Set<string>();
      for (const entry of this.shared.models.get(u.id) ?? []) {
        if (disabled.has(entry.model.id) || seenModelIds.has(entry.model.id)) continue;
        seenModelIds.add(entry.model.id);
        if (u.modelPrefix === null) {
          out.push({ upstreamId: u.id, addressableId: entry.model.id });
          continue;
        }
        if (u.modelPrefix.addressable.includes('unprefixed')) {
          out.push({ upstreamId: u.id, addressableId: entry.model.id });
        }
        if (u.modelPrefix.addressable.includes('prefixed')) {
          out.push({ upstreamId: u.id, addressableId: `${u.modelPrefix.prefix}${entry.model.id}` });
        }
      }
    }
    return Promise.resolve(out);
  }

  countListedByUpstream(upstreamIds?: readonly string[]): Promise<Map<string, number | null>> {
    const wanted = upstreamIds === undefined ? null : new Set(upstreamIds);
    const counts = new Map<string, number | null>();
    for (const u of this.shared.upstreams.values()) {
      if (wanted !== null && !wanted.has(u.id)) continue;
      if (u.modelsCache.fetchedAt === null) {
        counts.set(u.id, null);
        continue;
      }
      const disabled = new Set(u.disabledPublicModelIds);
      const distinctActive = new Set(
        (this.shared.models.get(u.id) ?? [])
          .map(entry => entry.model.id)
          .filter(id => !disabled.has(id)),
      ).size;
      const mult = u.modelPrefix === null ? 1 : u.modelPrefix.listed.length;
      counts.set(u.id, distinctActive * mult);
    }
    return Promise.resolve(counts);
  }

  listByUpstream(
    upstreamId: string,
    options?: { readonly source?: UpstreamModelSource },
  ): Promise<UpstreamModelEntry[]> {
    const entries = this.shared.models.get(upstreamId) ?? [];
    const filtered = options?.source === undefined
      ? entries
      : entries.filter(entry => entry.source === options.source);
    return Promise.resolve(filtered.map(entry => ({ source: entry.source, model: structuredClone(entry.model) })));
  }

  getByKey(upstreamId: string, modelId: string, kind: ModelKind): Promise<ProviderModel | null> {
    const found = (this.shared.models.get(upstreamId) ?? []).find(
      entry => entry.model.id === modelId && entry.model.kind === kind,
    );
    return Promise.resolve(found ? structuredClone(found.model) : null);
  }

  listManualModels(upstreamId: string): Promise<UpstreamModelConfig[]> {
    return Promise.resolve(structuredClone(this.shared.manualModels.get(upstreamId) ?? []));
  }

  listManualModelsByUpstreams(upstreamIds: readonly string[]): Promise<Map<string, UpstreamModelConfig[]>> {
    const map = new Map<string, UpstreamModelConfig[]>();
    for (const id of new Set(upstreamIds)) {
      map.set(id, structuredClone(this.shared.manualModels.get(id) ?? []));
    }
    return Promise.resolve(map);
  }
}

const cloneUpstreamRecord = (upstream: StoredUpstreamRecord): StoredUpstreamRecord => ({
  ...upstream,
  config: structuredClone(upstream.config),
  state: upstream.state === null || upstream.state === undefined ? null : structuredClone(upstream.state),
  modelsCache: structuredClone(upstream.modelsCache),
  flagOverrides: normalizeFlagOverrides(upstream.flagOverrides),
  disabledPublicModelIds: normalizeDisabledPublicModelIds(upstream.disabledPublicModelIds),
  proxyFallbackList: normalizeProxyFallbackList(upstream.proxyFallbackList),
  modelPrefix: structuredClone(upstream.modelPrefix),
  hue: upstream.hue,
});

const openaiResponsesCleanupDueAt = async (
  apiKeys: ApiKeyRepo,
  apiKeyId: string,
  refreshedAt: number,
): Promise<number> => {
  const apiKey = (await apiKeys.listIncludingDeleted()).find(candidate => candidate.id === apiKeyId);
  if (apiKey === undefined) throw new Error(`API key not found for OpenAI Responses state: ${apiKeyId}`);
  return apiKey.deletedAt !== null || apiKey.openaiResponsesRetentionSeconds === 0
    ? 0
    : refreshedAt + apiKey.openaiResponsesRetentionSeconds * 1000 + OPENAI_RESPONSES_REFRESH_GRANULARITY_MS + 1;
};

class MemoryOpenAIResponsesItemsRepo implements OpenAIResponsesItemsRepo {
  private store = new Map<string, StoredOpenAIResponsesItem>();

  constructor(
    private readonly apiKeys: ApiKeyRepo,
    private readonly expirationSweeps: ExpirationSweepsRepo,
  ) {}

  lookupMany(apiKeyId: string, ids: readonly string[], earliestVisibleCutoff: number): Promise<StoredOpenAIResponsesItem[]> {
    const rows: StoredOpenAIResponsesItem[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = this.store.get(scopedOpenAIResponsesKey(apiKeyId, id));
      if (row !== undefined && row.refreshedAt >= earliestVisibleCutoff) rows.push(cloneStoredOpenAIResponsesItem(row));
    }
    return Promise.resolve(rows);
  }

  lookupManyByItemHash(apiKeyId: string, hashes: readonly string[], earliestVisibleCutoff: number): Promise<StoredOpenAIResponsesItem[]> {
    const wanted = new Set(hashes);
    if (wanted.size === 0) return Promise.resolve([]);
    const rows: StoredOpenAIResponsesItem[] = [];
    for (const row of this.store.values()) {
      if (row.apiKeyId === apiKeyId && row.refreshedAt >= earliestVisibleCutoff && wanted.has(row.itemHash)) {
        rows.push(cloneStoredOpenAIResponsesItem(row));
      }
    }
    return Promise.resolve(rows.toSorted(compareOpenAIResponsesItemsByFreshness));
  }

  async insertMany(items: readonly StoredOpenAIResponsesItem[], earliestVisibleCutoff: number): Promise<void> {
    const quantizedItems = items.map(item => ({
      ...item,
      refreshedAt: quantizeOpenAIResponsesRefreshedAt(item.refreshedAt),
    }));
    const pending = new Map<string, StoredOpenAIResponsesItem>();
    const dueByApiKey = new Map<string, number>();
    for (const item of quantizedItems) {
      const key = scopedOpenAIResponsesKey(item.apiKeyId, item.id);
      const existing = pending.get(key) ?? this.store.get(key);
      if (existing !== undefined && existing.refreshedAt >= earliestVisibleCutoff) {
        assertSameStoredOpenAIResponsesItem(item, existing);
      } else {
        pending.set(key, item);
      }
      const refreshedAt = Math.max(existing?.refreshedAt ?? item.refreshedAt, item.refreshedAt);
      const dueAt = await openaiResponsesCleanupDueAt(this.apiKeys, item.apiKeyId, refreshedAt);
      dueByApiKey.set(item.apiKeyId, Math.min(dueByApiKey.get(item.apiKeyId) ?? dueAt, dueAt));
    }
    const previous = new Map<string, StoredOpenAIResponsesItem | undefined>();
    for (const item of items) {
      const key = scopedOpenAIResponsesKey(item.apiKeyId, item.id);
      if (!previous.has(key)) previous.set(key, this.store.has(key) ? cloneStoredOpenAIResponsesItem(this.store.get(key)!) : undefined);
    }
    for (const [key, item] of pending) this.store.set(key, cloneStoredOpenAIResponsesItem(item));
    for (const item of quantizedItems) {
      const stored = this.store.get(scopedOpenAIResponsesKey(item.apiKeyId, item.id))!;
      if (stored.refreshedAt < item.refreshedAt) stored.refreshedAt = item.refreshedAt;
    }
    try {
      await Promise.all([...dueByApiKey].map(([apiKeyId, dueAt]) =>
        this.expirationSweeps.schedule('responses', apiKeyId, dueAt)));
    } catch (error) {
      for (const [key, item] of previous) {
        if (item === undefined) this.store.delete(key);
        else this.store.set(key, item);
      }
      throw error;
    }
  }

  async refreshMany(items: readonly StoredOpenAIResponsesItem[], refreshedAt: number, earliestVisibleCutoff: number): Promise<void> {
    const quantizedRefreshedAt = quantizeOpenAIResponsesRefreshedAt(refreshedAt);
    const existing = items.map(item => this.store.get(scopedOpenAIResponsesKey(item.apiKeyId, item.id)));
    const missingIndex = existing.findIndex(item =>
      item === undefined || item.refreshedAt < earliestVisibleCutoff);
    if (missingIndex !== -1) {
      throw new Error(`OpenAI Responses item disappeared before retention refresh: ${items[missingIndex].id}`);
    }
    const dueByApiKey = new Map<string, number>();
    for (let index = 0; index < existing.length; index += 1) {
      assertSameStoredOpenAIResponsesItem(items[index], existing[index]!);
      const nextRefreshedAt = Math.max(existing[index]!.refreshedAt, quantizedRefreshedAt);
      const dueAt = await openaiResponsesCleanupDueAt(this.apiKeys, items[index].apiKeyId, nextRefreshedAt);
      dueByApiKey.set(items[index].apiKeyId, Math.min(dueByApiKey.get(items[index].apiKeyId) ?? dueAt, dueAt));
    }
    const previous = new Map(existing.map(item => {
      const row = item!;
      return [scopedOpenAIResponsesKey(row.apiKeyId, row.id), cloneStoredOpenAIResponsesItem(row)] as const;
    }));
    for (const item of existing) {
      if (item!.refreshedAt < quantizedRefreshedAt) item!.refreshedAt = quantizedRefreshedAt;
    }
    try {
      await Promise.all([...dueByApiKey].map(([apiKeyId, dueAt]) =>
        this.expirationSweeps.schedule('responses', apiKeyId, dueAt)));
    } catch (error) {
      for (const [key, item] of previous) this.store.set(key, item);
      throw error;
    }
  }

  async deleteExpiredBatch(apiKeyId: string, now: number, limit: number): Promise<number> {
    let changes = 0;
    for (const [key, row] of this.store) {
      if (row.apiKeyId !== apiKeyId || changes >= limit) continue;
      const apiKey = await this.apiKeys.getById(row.apiKeyId);
      if (
        apiKey === null
        || apiKey.openaiResponsesRetentionSeconds === 0
        || row.refreshedAt < openaiResponsesStateCutoff(now, apiKey.openaiResponsesRetentionSeconds)
      ) {
        this.store.delete(key);
        changes += 1;
      }
    }
    return changes;
  }

  findOldestRefreshedAt(apiKeyId: string): Promise<number | null> {
    const rows = [...this.store.values()].filter(row => row.apiKeyId === apiKeyId);
    return Promise.resolve(rows.length === 0 ? null : Math.min(...rows.map(row => row.refreshedAt)));
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

class MemoryOpenAIResponsesSnapshotsRepo implements OpenAIResponsesSnapshotsRepo {
  private store = new Map<string, StoredOpenAIResponsesSnapshot>();

  constructor(
    private readonly apiKeys: ApiKeyRepo,
    private readonly expirationSweeps: ExpirationSweepsRepo,
  ) {}

  lookup(apiKeyId: string, id: string, earliestVisibleCutoff: number): Promise<StoredOpenAIResponsesSnapshot | null> {
    const snapshot = this.store.get(scopedOpenAIResponsesKey(apiKeyId, id));
    return Promise.resolve(snapshot !== undefined && snapshot.refreshedAt >= earliestVisibleCutoff ? cloneStoredOpenAIResponsesSnapshot(snapshot) : null);
  }

  async insert(snapshot: StoredOpenAIResponsesSnapshot): Promise<void> {
    const quantized = {
      ...snapshot,
      refreshedAt: quantizeOpenAIResponsesRefreshedAt(snapshot.refreshedAt),
    };
    const key = scopedOpenAIResponsesKey(quantized.apiKeyId, quantized.id);
    const existing = this.store.get(key);
    if (existing === undefined || quantized.refreshedAt > existing.refreshedAt) {
      this.store.set(key, cloneStoredOpenAIResponsesSnapshot(quantized));
      try {
        await this.expirationSweeps.schedule('responses', quantized.apiKeyId, await openaiResponsesCleanupDueAt(
          this.apiKeys,
          quantized.apiKeyId,
          quantized.refreshedAt,
        ));
      } catch (error) {
        if (existing === undefined) this.store.delete(key);
        else this.store.set(key, existing);
        throw error;
      }
    }
  }

  async deleteExpiredBatch(apiKeyId: string, now: number, limit: number): Promise<number> {
    let changes = 0;
    for (const [key, snapshot] of this.store) {
      if (snapshot.apiKeyId !== apiKeyId || changes >= limit) continue;
      const apiKey = await this.apiKeys.getById(snapshot.apiKeyId);
      if (
        apiKey === null
        || apiKey.openaiResponsesRetentionSeconds === 0
        || snapshot.refreshedAt < openaiResponsesStateCutoff(now, apiKey.openaiResponsesRetentionSeconds)
      ) {
        this.store.delete(key);
        changes += 1;
      }
    }
    return changes;
  }

  findOldestRefreshedAt(apiKeyId: string): Promise<number | null> {
    const rows = [...this.store.values()].filter(row => row.apiKeyId === apiKeyId);
    return Promise.resolve(rows.length === 0 ? null : Math.min(...rows.map(row => row.refreshedAt)));
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

class MemorySpilledFilesRepo implements SpilledFilesRepo {
  private readonly files = new Map<string, {
    collectAfter: number;
    claimToken: string | null;
    claimedAt: number | null;
  }>();

  claimCollectible(token: string, now: number, staleClaimedBefore: number, limit: number): Promise<string[]> {
    const keys = [...this.files]
      .filter(([, file]) =>
        file.collectAfter <= now && (file.claimToken === null || file.claimedAt! < staleClaimedBefore))
      .map(([fileKey]) => fileKey)
      .sort()
      .slice(0, limit);
    for (const key of keys) {
      const file = this.files.get(key)!;
      file.claimToken = token;
      file.claimedAt = now;
    }
    return Promise.resolve(keys);
  }

  acknowledge(token: string): Promise<number> {
    let changes = 0;
    for (const [key, file] of this.files) {
      if (file.claimToken !== token) continue;
      this.files.delete(key);
      changes += 1;
    }
    return Promise.resolve(changes);
  }

}

interface MemoryExpirationSweepRow extends ExpirationSweepClaim {
  dueAt: number;
  claimToken: string | null;
  claimedAt: number | null;
}

class MemoryScheduledMaintenanceRepo implements ScheduledMaintenanceRepo {
  private maintenanceClaim: { token: string; claimedAt: number } | null = null;

  tryClaim(token: string, now: number, staleClaimedBefore: number): Promise<boolean> {
    if (this.maintenanceClaim !== null && this.maintenanceClaim.claimedAt >= staleClaimedBefore) {
      return Promise.resolve(false);
    }
    this.maintenanceClaim = { token, claimedAt: now };
    return Promise.resolve(true);
  }

  renew(token: string, now: number): Promise<void> {
    if (this.maintenanceClaim?.token !== token) throw new Error('Scheduled maintenance lease was lost before renewal');
    this.maintenanceClaim.claimedAt = now;
    return Promise.resolve();
  }

  release(token: string): Promise<void> {
    if (this.maintenanceClaim?.token === token) this.maintenanceClaim = null;
    return Promise.resolve();
  }
}

class MemoryExpirationSweepsRepo implements ExpirationSweepsRepo {
  private readonly rows = new Map<string, MemoryExpirationSweepRow>();

  private key(domain: ExpirationDomain, keyId: string): string {
    return `${domain}\0${keyId}`;
  }

  backfillCleanupTracking(): Promise<void> {
    return Promise.resolve();
  }

  schedule(domain: ExpirationDomain, keyId: string, dueAt: number): Promise<void> {
    const key = this.key(domain, keyId);
    const existing = this.rows.get(key);
    this.rows.set(key, existing === undefined
      ? { domain, keyId, dueAt, revision: 0, claimToken: null, claimedAt: null }
      : { ...existing, dueAt: Math.min(existing.dueAt, dueAt), revision: existing.revision + 1 });
    return Promise.resolve();
  }

  claim(token: string, now: number, staleClaimedBefore: number): Promise<ExpirationSweepClaim | null> {
    const row = [...this.rows.values()]
      .filter(candidate => candidate.dueAt <= now && (candidate.claimToken === null || candidate.claimedAt! < staleClaimedBefore))
      .toSorted((a, b) => a.dueAt - b.dueAt || a.keyId.localeCompare(b.keyId) || a.domain.localeCompare(b.domain))[0];
    if (row === undefined) return Promise.resolve(null);
    row.claimToken = token;
    row.claimedAt = now;
    return Promise.resolve({ domain: row.domain, keyId: row.keyId, revision: row.revision });
  }

  complete(token: string, expectedRevision: number, completion: ExpirationSweepCompletion): Promise<void> {
    const row = [...this.rows.values()].find(candidate => candidate.claimToken === token);
    if (row === undefined) return Promise.resolve();
    const key = this.key(row.domain, row.keyId);
    if (row.revision === expectedRevision && completion.kind === 'drained' && completion.nextDueAt === null) {
      this.rows.delete(key);
      return Promise.resolve();
    }
    const nextDueAt = completion.kind === 'partial' ? completion.retryAt : completion.nextDueAt;
    if (nextDueAt !== null) {
      row.dueAt = row.revision === expectedRevision || completion.kind === 'partial'
        ? nextDueAt
        : Math.min(row.dueAt, nextDueAt);
    }
    row.claimToken = null;
    row.claimedAt = null;
    return Promise.resolve();
  }
}

class MemoryProxyRepo implements ProxyRepo {
  private store = new Map<string, ProxyRecord>();

  constructor(
    private readonly upstreams: UpstreamRepo,
    private readonly backoffs: MemoryProxyBackoffRows,
  ) {}

  has(id: string): boolean {
    return this.store.has(id);
  }

  list(): Promise<ProxyRecord[]> {
    return Promise.resolve(
      [...this.store.values()]
        .map(cloneProxyRecord)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
  }

  getById(id: string): Promise<ProxyRecord | null> {
    const found = this.store.get(id);
    return Promise.resolve(found ? cloneProxyRecord(found) : null);
  }

  insert(input: { id: string; name: string; url: string; dialTimeoutSeconds: number | null }): Promise<ProxyRecord> {
    const now = new Date().toISOString();
    const record: ProxyRecord = {
      id: input.id,
      name: input.name,
      url: input.url,
      createdAt: now,
      updatedAt: now,
      dialTimeoutSeconds: input.dialTimeoutSeconds,
    };
    this.store.set(record.id, record);
    return Promise.resolve(cloneProxyRecord(record));
  }

  patch(id: string, patch: { name?: string; url?: string; dialTimeoutSeconds?: number | null }): Promise<{ record: ProxyRecord; urlChanged: boolean } | null> {
    const existing = this.store.get(id);
    if (!existing) return Promise.resolve(null);

    const urlChanged = patch.url !== undefined && patch.url !== existing.url;
    // Distinguish "absent" from "explicit null" — `??` would collapse a
    // deliberate clear back to the existing value.
    const nextDialTimeout = Object.hasOwn(patch, 'dialTimeoutSeconds') ? patch.dialTimeoutSeconds! : existing.dialTimeoutSeconds;
    const updated: ProxyRecord = {
      ...existing,
      name: patch.name ?? existing.name,
      url: patch.url ?? existing.url,
      dialTimeoutSeconds: nextDialTimeout,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(id, updated);
    return Promise.resolve({ record: cloneProxyRecord(updated), urlChanged });
  }

  async delete(id: string): Promise<boolean> {
    // Mirror the SQL repo's atomic delete: refuse if any upstream's fallback
    // list still references the row, so an admin race adding the reference
    // between a prior findUpstreamsReferencing read and this delete is
    // rejected at the storage layer.
    const upstreams = await this.upstreams.list();
    if (upstreams.some(u => u.proxyFallbackList.some(e => e.id === id))) return false;
    const deleted = this.store.delete(id);
    if (deleted) this.backoffs.deleteWhere(row => row.proxyId === id);
    return deleted;
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    this.backoffs.clear();
    return Promise.resolve();
  }

  save(record: { id: string; name: string; url: string; dialTimeoutSeconds: number | null }): Promise<void> {
    // Upsert that mirrors the SQL ON CONFLICT path: preserve the existing
    // row's createdAt on collision so the import never overwrites the
    // local deployment's first-seen timestamp.
    const existing = this.store.get(record.id);
    const now = new Date().toISOString();
    const next: ProxyRecord = {
      id: record.id,
      name: record.name,
      url: record.url,
      dialTimeoutSeconds: record.dialTimeoutSeconds,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    this.store.set(record.id, next);
    return Promise.resolve();
  }

  async findUpstreamsReferencing(proxyId: string): Promise<string[]> {
    const upstreams = await this.upstreams.list();
    return upstreams.filter(u => u.proxyFallbackList.some(e => e.id === proxyId)).map(u => u.id);
  }
}

const cloneProxyRecord = (record: ProxyRecord): ProxyRecord => ({ ...record });

// Shared by the proxy and upstream repos so their deletes cascade the way the
// SQL foreign keys on proxy_upstream_backoffs do.
class MemoryProxyBackoffRows extends Map<string, BackoffRow> {
  deleteWhere(predicate: (row: BackoffRow) => boolean): void {
    for (const [key, row] of this) if (predicate(row)) this.delete(key);
  }
}

class MemoryProxyBackoffRepo implements ProxyBackoffRepo {
  constructor(
    private readonly rows: MemoryProxyBackoffRows,
    private readonly proxies: MemoryProxyRepo,
    private readonly upstreams: MemoryUpstreamRepo,
  ) {}

  private key(proxyId: string, upstreamId: string): string {
    return `${proxyId}\0${upstreamId}`;
  }

  recordDialFailure(proxyId: string, upstreamId: string, errorMessage: string): Promise<void> {
    if (!this.proxies.has(proxyId) || !this.upstreams.has(upstreamId)) {
      return Promise.reject(new Error('FOREIGN KEY constraint failed'));
    }
    const k = this.key(proxyId, upstreamId);
    const now = Math.floor(Date.now() / 1000);
    const existing = this.rows.get(k);
    if (!existing) {
      this.rows.set(k, {
        proxyId,
        upstreamId,
        failCount: 1,
        expiresAt: now + 60,
        lastError: errorMessage,
        lastErrorAt: now,
      });
      return Promise.resolve();
    }
    // Mirror the SQL UPSERT schedule (see SqlProxyBackoffRepo.recordDialFailure).
    // The exponent is clamped at 6 to stay within JS's 32-bit signed shift
    // semantics — `1 << 31` wraps to negative and would resolve `Math.min`
    // to a far-past expiresAt, effectively voiding the backoff.
    const previousFailCount = existing.failCount;
    this.rows.set(k, {
      proxyId,
      upstreamId,
      failCount: previousFailCount + 1,
      expiresAt: now + Math.min(60 * (1 << Math.min(previousFailCount, 6)), 3600),
      lastError: errorMessage,
      lastErrorAt: now,
    });
    return Promise.resolve();
  }

  recordDialSuccess(proxyId: string, upstreamId: string): Promise<void> {
    this.rows.delete(this.key(proxyId, upstreamId));
    return Promise.resolve();
  }

  listForUpstream(upstreamId: string): Promise<BackoffRow[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(r => r.upstreamId === upstreamId).map(cloneBackoffRow),
    );
  }

  listForProxy(proxyId: string): Promise<BackoffRow[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(r => r.proxyId === proxyId).map(cloneBackoffRow),
    );
  }

  listAll(): Promise<BackoffRow[]> {
    return Promise.resolve([...this.rows.values()].map(cloneBackoffRow));
  }

  resetForProxy(proxyId: string): Promise<void> {
    this.rows.deleteWhere(row => row.proxyId === proxyId);
    return Promise.resolve();
  }

  reset(proxyId: string, upstreamId: string): Promise<void> {
    this.rows.delete(this.key(proxyId, upstreamId));
    return Promise.resolve();
  }
}

const cloneBackoffRow = (row: BackoffRow): BackoffRow => ({ ...row });

const cloneModelAliasRecord = (record: ModelAliasRecord): ModelAliasRecord => ({
  ...record,
  targets: structuredClone(record.targets),
  announcedMetadata: record.announcedMetadata === null ? null : structuredClone(record.announcedMetadata),
});

class MemoryModelAliasesRepo implements ModelAliasesRepo {
  // Keyed by id, mirroring the table's primary key; the name uniqueness the
  // SQL backend enforces with a UNIQUE index is checked by scan here.
  private store = new Map<string, ModelAliasRecord>();

  private nameTaken(name: string, exceptId: string | null): boolean {
    return [...this.store.values()].some(record => record.name === name && record.id !== exceptId);
  }

  list(): Promise<ModelAliasRecord[]> {
    return Promise.resolve(
      [...this.store.values()]
        .map(cloneModelAliasRecord)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)),
    );
  }

  getById(id: string): Promise<ModelAliasRecord | null> {
    const found = this.store.get(id);
    return Promise.resolve(found ? cloneModelAliasRecord(found) : null);
  }

  getByName(name: string): Promise<ModelAliasRecord | null> {
    const found = [...this.store.values()].find(record => record.name === name);
    return Promise.resolve(found ? cloneModelAliasRecord(found) : null);
  }

  insert(record: ModelAliasRecord): Promise<void> {
    if (this.nameTaken(record.name, null)) throw new Error('UNIQUE constraint failed: model_aliases.name');
    this.store.set(record.id, cloneModelAliasRecord(record));
    return Promise.resolve();
  }

  update(record: ModelAliasRecord): Promise<void> {
    if (!this.store.has(record.id)) throw new Error(`alias ${record.id} not found`);
    if (this.nameTaken(record.name, record.id)) {
      throw new Error('UNIQUE constraint failed: model_aliases.name');
    }
    this.store.set(record.id, cloneModelAliasRecord(record));
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.store.delete(id));
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

const compareLatestAgentSetupRecord = (a: AgentSetupRecord, b: AgentSetupRecord): number =>
  b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.token < b.token ? 1 : -1);

class MemoryAgentSetupRepo implements AgentSetupRepository {
  // Keyed by token: a user may own many concurrent leases at once.
  private byToken = new Map<string, AgentSetupRecord>();

  findByToken(token: string): Promise<AgentSetupRecord | null> {
    const found = this.byToken.get(token);
    return Promise.resolve(found ? { ...found } : null);
  }

  latestByUserId(userId: number): Promise<AgentSetupRecord | null> {
    let latest: AgentSetupRecord | undefined;
    for (const record of this.byToken.values()) {
      if (record.userId !== userId) continue;
      if (latest === undefined || compareLatestAgentSetupRecord(record, latest) < 0) latest = record;
    }
    return Promise.resolve(latest ? { ...latest } : null);
  }

  insertForUser(input: {
    userId: number;
    token: string;
    configurationJson: string;
    now: number;
    expiresAt: number;
  }): Promise<AgentSetupRecord> {
    if (this.byToken.has(input.token)) throw new AgentSetupTokenCollisionError();
    const record: AgentSetupRecord = {
      userId: input.userId,
      token: input.token,
      configurationJson: input.configurationJson,
      configurationRevision: 1,
      expiresAt: input.expiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.byToken.set(record.token, record);
    // Mirror the AFTER INSERT trigger: sweep only this user's already-expired
    // rows, measured against the new row's created_at, never the new row.
    for (const [token, existing] of this.byToken) {
      if (existing.userId === input.userId && token !== record.token && existing.expiresAt <= input.now) this.byToken.delete(token);
    }
    return Promise.resolve({ ...record });
  }

  updateConfiguration(input: {
    userId: number;
    token: string;
    expectedRevision: number;
    configurationJson: string;
    now: number;
    expiresAt: number;
  }): Promise<AgentSetupMutation> {
    const existing = this.byToken.get(input.token);
    if (!existing || existing.userId !== input.userId) return Promise.resolve({ status: 'missing' });
    if (existing.configurationRevision !== input.expectedRevision) {
      return Promise.resolve({ status: 'revision-conflict', record: { ...existing } });
    }
    const record: AgentSetupRecord = {
      ...existing,
      configurationJson: input.configurationJson,
      configurationRevision: existing.configurationRevision + 1,
      expiresAt: input.expiresAt,
      updatedAt: input.now,
    };
    this.byToken.set(record.token, record);
    return Promise.resolve({ status: 'ok', record: { ...record } });
  }

  renewLease(input: {
    userId: number;
    token: string;
    expiresAt: number;
  }): Promise<AgentSetupRenewal> {
    const existing = this.byToken.get(input.token);
    if (!existing || existing.userId !== input.userId) return Promise.resolve({ status: 'missing' });
    // Expiry-only: updated_at and the revision stay put.
    const record: AgentSetupRecord = { ...existing, expiresAt: input.expiresAt };
    this.byToken.set(record.token, record);
    return Promise.resolve({ status: 'ok', record: { ...record } });
  }
}

export class InMemoryRepo implements Repo {
  private upstreamMetricRecords: import('../../src/repo/types.ts').UpstreamMetricRecord[] = [];
  upstreamMetrics: import('../../src/repo/types.ts').UpstreamMetricsRepo = {
    listAll: async () => this.upstreamMetricRecords.toSorted((a, b) => a.timestamp - b.timestamp || a.upstreamId.localeCompare(b.upstreamId) || upstreamMetricIdentityKey(a).localeCompare(upstreamMetricIdentityKey(b))),
    set: async record => {
      const identity = normalizeUpstreamMetricIdentity(record.name, record.labels);
      const identityKey = upstreamMetricIdentityKey(identity);
      this.upstreamMetricRecords = this.upstreamMetricRecords.filter(row => row.upstreamId !== record.upstreamId || upstreamMetricIdentityKey(row) !== identityKey || Math.floor(row.timestamp / 60_000) !== Math.floor(record.timestamp / 60_000));
      this.upstreamMetricRecords.push({ ...record, ...identity });
    },
    deleteAll: async () => { this.upstreamMetricRecords = []; },
    record: async record => {
      const identityKey = upstreamMetricIdentityKey(record);
      const bucket = Math.floor(record.timestamp / 60_000);
      const current = this.upstreamMetricRecords.find(row => row.upstreamId === record.upstreamId && upstreamMetricIdentityKey(row) === identityKey && Math.floor(row.timestamp / 60_000) === bucket);
      if (current !== undefined && current.timestamp > record.timestamp) return;
      await this.upstreamMetrics.set(record);
    },
    query: async (upstreamId, start, end, step) => {
      const latest = new Map<string, import('../../src/repo/types.ts').UpstreamMetricRecord>();
      for (const record of this.upstreamMetricRecords) {
        if (record.upstreamId !== upstreamId || record.timestamp < start || record.timestamp >= end) continue;
        const key = `${upstreamMetricIdentityKey(record)}\0${Math.floor((record.timestamp - start) / step)}`;
        if ((latest.get(key)?.timestamp ?? -Infinity) < record.timestamp) latest.set(key, record);
      }
      return [...latest.values()].toSorted((a, b) => a.timestamp - b.timestamp);
    },
  };
  apiKeys: ApiKeyRepo;
  users: MemoryUsersRepo;
  userPreferences: UserPreferencesRepo;
  groups: MemoryGroupsRepo;
  accessRecords: AccessRecordsRepo;
  sessions: SessionsRepo;
  usage: UsageRepo;
  webSearchUsage: WebSearchUsageRepo;
  performance: PerformanceRepo;
  siteSettings: SiteSettingsRepo;
  webSearchConfig: WebSearchConfigRepo;
  upstreams: UpstreamRepo;
  upstreamModels: UpstreamModelsRepo;
  proxies: ProxyRepo;
  proxyBackoffs: ProxyBackoffRepo;
  modelAliases: ModelAliasesRepo;
  openaiResponsesItems: OpenAIResponsesItemsRepo;
  openaiResponsesSnapshots: OpenAIResponsesSnapshotsRepo;
  spilledFiles: SpilledFilesRepo;
  expirationSweeps: ExpirationSweepsRepo;
  scheduledMaintenance: ScheduledMaintenanceRepo;
  agentSetup: AgentSetupRepository;

  readUserDirectory(): Promise<UserDirectory> {
    const users = this.users.snapshot();
    const userIds = new Set(users.map(user => user.id));
    const groups = this.groups.snapshot();
    const memberships = this.groups.snapshotMemberships().filter(member => userIds.has(member.userId));
    return Promise.resolve({ users, groups, memberships });
  }

  constructor() {
    this.groups = new MemoryGroupsRepo();
    this.users = new MemoryUsersRepo(this.groups);
    this.accessRecords = new MemoryAccessRecordsRepo();
    this.userPreferences = new MemoryUserPreferencesRepo();
    this.sessions = new MemorySessionsRepo();
    this.expirationSweeps = new MemoryExpirationSweepsRepo();
    this.scheduledMaintenance = new MemoryScheduledMaintenanceRepo();
    this.apiKeys = new MemoryApiKeyRepo(this.expirationSweeps);
    this.usage = new MemoryUsageRepo(this.apiKeys);
    this.webSearchUsage = new MemoryWebSearchUsageRepo();
    this.performance = new MemoryPerformanceRepo(this.apiKeys);
    this.siteSettings = new MemorySiteSettingsRepo();
    this.webSearchConfig = new MemoryWebSearchConfigRepo();
    const backoffRows = new MemoryProxyBackoffRows();
    const upstreamStore = new MemoryUpstreamStore();
    const upstreams = new MemoryUpstreamRepo(upstreamStore, backoffRows);
    const proxies = new MemoryProxyRepo(upstreams, backoffRows);
    this.upstreams = upstreams;
    this.upstreamModels = new MemoryUpstreamModelsRepo(upstreamStore);
    this.proxies = proxies;
    this.proxyBackoffs = new MemoryProxyBackoffRepo(backoffRows, proxies, upstreams);
    this.modelAliases = new MemoryModelAliasesRepo();
    this.openaiResponsesItems = new MemoryOpenAIResponsesItemsRepo(this.apiKeys, this.expirationSweeps);
    this.openaiResponsesSnapshots = new MemoryOpenAIResponsesSnapshotsRepo(this.apiKeys, this.expirationSweeps);
    this.spilledFiles = new MemorySpilledFilesRepo();
    this.agentSetup = new MemoryAgentSetupRepo();
  }
}
