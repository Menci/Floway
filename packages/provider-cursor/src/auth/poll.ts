/**
 * Cursor PKCE poll-based OAuth login.
 *
 * Unlike Codex/Claude (callback-paste), Cursor CLI login is poll-based:
 *   1. generate an opaque uuid + PKCE verifier/challenge
 *   2. open cursor.com/loginDeepControl?challenge=&uuid=&mode=login&redirectTarget=cli
 *   3. poll api2.cursor.sh/auth/poll?uuid=&verifier= until it returns tokens
 *
 * Workers-clean: crypto.getRandomValues / crypto.subtle / crypto.randomUUID,
 * bytesToBase64Url from checksum.ts instead of Buffer.
 */

import { bytesToBase64Url } from '../checksum.ts';
import { TEXT_ENCODER } from '../proto/encoding.ts';
import type { Fetcher } from '@floway-dev/provider';

const CURSOR_LOGIN_URL = 'https://cursor.com/loginDeepControl';
const CURSOR_POLL_URL = 'https://api2.cursor.sh/auth/poll';

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY = 1000;
const POLL_MAX_DELAY = 10_000;
const POLL_BACKOFF_MULTIPLIER = 1.2;
const POLL_MAX_CONSECUTIVE_ERRORS = 10;

export interface CursorAuthParams {
  verifier: string;
  challenge: string;
  uuid: string;
  loginUrl: string;
}

export interface CursorPollTokens {
  accessToken: string;
  refreshToken: string;
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(96);
  crypto.getRandomValues(verifierBytes);
  const verifier = bytesToBase64Url(verifierBytes);

  const data = TEXT_ENCODER.encode(verifier);
  const hashBuffer = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)));
  const challenge = bytesToBase64Url(hashBuffer);

  return { verifier, challenge };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate the PKCE pair + uuid + login URL. The operator opens loginUrl in a
 * browser; the gateway polls with the returned verifier+uuid.
 */
export async function generateCursorAuthParams(): Promise<CursorAuthParams> {
  const { verifier, challenge } = await generatePKCE();
  const uuid = crypto.randomUUID();

  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: 'login',
    redirectTarget: 'cli',
  });

  const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;
  return { verifier, challenge, uuid, loginUrl };
}

/**
 * Poll the Cursor auth endpoint until the operator completes login. 404 means
 * "not ready yet" (backoff and continue); 200 returns the tokens. Other errors
 * are counted against a consecutive-error cap so a transient network storm
 * doesn't abort a legitimate pending login.
 */
export async function pollCursorAuth(uuid: string, verifier: string, fetcher: Fetcher): Promise<CursorPollTokens> {
  let delay = POLL_BASE_DELAY;
  let consecutiveErrors = 0;
  let lastError: string | undefined;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(delay);

    try {
      const response = await fetcher(`${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`, {});

      if (response.status === 404) {
        consecutiveErrors = 0;
        delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY);
        continue;
      }

      if (response.ok) {
        const data = (await response.json()) as { accessToken?: string; refreshToken?: string };
        if (typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string') {
          throw new Error('Poll response missing accessToken/refreshToken');
        }
        return { accessToken: data.accessToken, refreshToken: data.refreshToken };
      }

      const errorBody = await response.text().catch(() => '');
      throw new Error(`Poll failed: ${response.status}${errorBody ? ` - ${errorBody}` : ''}`);
    } catch (err) {
      consecutiveErrors++;
      lastError = err instanceof Error ? err.message : String(err);
      if (consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) {
        throw new Error(`Too many consecutive errors during Cursor auth polling (last: ${lastError})`);
      }
      delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY);
    }
  }

  throw new Error('Cursor authentication polling timeout');
}
