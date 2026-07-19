// The Agent Setup persistence contract. The package owns this domain surface;
// a host application supplies a concrete implementation (an in-memory map, a
// SQL table, anything) and injects it into the route factories. Nothing here
// names a database, a table, or a query — a lease is just a record keyed by its
// token, and the multi-row lifecycle is expressed purely in terms of records.
//
// Times are Unix milliseconds.

export interface AgentSetupRecord {
  // The lease token. Primary identity: it is embedded in the public
  // setup-script URL and is globally unique across users. A user may own many
  // concurrent records, one per dashboard page that acquired a lease.
  token: string;
  userId: number;
  configurationJson: string;
  // Optimistic-concurrency counter for configuration edits. A freshly inserted
  // record starts at 1; a successful configuration write bumps it. Lease
  // renewal never touches it, so a heartbeat cannot invalidate an in-flight
  // dashboard edit.
  configurationRevision: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

// Outcome of a conditional write against one token.
// - `missing`: no record with that (userId, token) exists — it expired and was
//   swept, or it never existed. Terminal for the caller's page.
// - `revision-conflict`: the record exists but the caller edited against a
//   stale revision; the live record rides along so the caller can rebase.
export type AgentSetupMutation =
  | { status: 'ok'; record: AgentSetupRecord }
  | { status: 'missing' }
  | { status: 'revision-conflict'; record: AgentSetupRecord };

// Renewal only extends expiry; it can never conflict on a revision, so its
// outcome is the ok/missing subset of AgentSetupMutation.
export type AgentSetupRenewal =
  | { status: 'ok'; record: AgentSetupRecord }
  | { status: 'missing' };

// Thrown by `insertForUser` when the generated token already exists. A 256-bit
// token makes this a practical impossibility; the typed error only lets the
// route retry with a fresh token instead of surfacing a storage-specific
// uniqueness message, keeping the retry loop free of any storage knowledge.
export class AgentSetupTokenCollisionError extends Error {
  constructor() {
    super('Agent Setup token collided with an existing lease');
    this.name = 'AgentSetupTokenCollisionError';
  }
}

export interface AgentSetupRepository {
  // Public serve path: resolve a single lease by its token.
  findByToken(token: string): Promise<AgentSetupRecord | null>;

  // Restore-on-reopen: the user's most recently touched record, regardless of
  // expiry. Deterministic ordering (updated_at, then created_at, then token,
  // all descending) so a restore is reproducible under equal timestamps.
  latestByUserId(userId: number): Promise<AgentSetupRecord | null>;

  // POST: insert a brand-new record at revision 1. Never supersedes or deletes
  // any unexpired sibling; a host may sweep the same user's already-expired
  // records as part of the insert, but must never touch the new record.
  // Throws AgentSetupTokenCollisionError if the token already exists.
  insertForUser(input: {
    userId: number;
    token: string;
    configurationJson: string;
    now: number;
    expiresAt: number;
  }): Promise<AgentSetupRecord>;

  // PUT: write configuration to exactly the (userId, token) record under
  // optimistic concurrency. On a revision match it bumps the revision and
  // updates the configuration, expiry, and updated_at; the token never
  // changes. An already-expired record is still writable while it exists.
  updateConfiguration(input: {
    userId: number;
    token: string;
    expectedRevision: number;
    configurationJson: string;
    now: number;
    expiresAt: number;
  }): Promise<AgentSetupMutation>;

  // Heartbeat: extend only the expiry of the (userId, token) record. It must
  // not touch updated_at or the revision, so a heartbeat never reorders the
  // restore selection nor collides with an in-flight edit. An expired-but-still-
  // present record may be renewed; a swept one returns `missing`.
  renewLease(input: {
    userId: number;
    token: string;
    expiresAt: number;
  }): Promise<AgentSetupRenewal>;
}
