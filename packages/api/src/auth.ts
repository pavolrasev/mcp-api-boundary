import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { KEY_SCOPES, ROLE_SCOPES, type Scope } from './scopes.js';
import type { ApiKey, Member, Store } from './store.js';

/**
 * Who is calling.
 *
 * `session` is a person signed in to the app. `api_key` is anything else:
 * an integration, a script, an MCP server acting for an assistant. The two
 * are told apart because only sessions may ever see clinical data.
 */
export interface Principal {
  kind: 'session' | 'api_key';
  member: Member;
  scopes: ReadonlySet<Scope>;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * The scopes a key really has: what it was granted, capped by what its
 * owner's role allows today. Demote the owner and the key shrinks with them.
 */
export function effectiveKeyScopes(key: ApiKey, member: Member): Set<Scope> {
  const ceiling = new Set(ROLE_SCOPES[member.role]);
  return new Set(key.scopes.filter((scope) => ceiling.has(scope) && KEY_SCOPES.includes(scope)));
}

/**
 * Creates a key for a member and returns the secret. The store keeps only
 * its hash, so the secret cannot be shown again or read from a backup.
 */
export function issueApiKey(
  store: Store,
  memberId: string,
  scopes: Scope[],
  options: { label?: string; secret?: string } = {},
): { id: string; secret: string } {
  const member = store.members.find((item) => item.id === memberId);
  if (!member) throw new Error(`Unknown member ${memberId}.`);

  const notGrantable = scopes.filter((scope) => !KEY_SCOPES.includes(scope));
  if (notGrantable.length > 0) {
    throw new Error(`API keys cannot be granted: ${notGrantable.join(', ')}.`);
  }

  const secret = options.secret ?? `cbk_${randomBytes(24).toString('base64url')}`;
  const id = `key_${randomUUID().slice(0, 8)}`;
  store.apiKeys.push({
    id,
    memberId,
    label: options.label ?? 'API key',
    hash: hashSecret(secret),
    scopes: [...scopes],
    revoked: false,
  });
  return { id, secret };
}

/** Starts an app session for a member. Only used by tests and the demo seed. */
export function issueSession(store: Store, memberId: string): string {
  const secret = `sess_${randomBytes(24).toString('base64url')}`;
  store.sessions.push({ memberId, hash: hashSecret(secret) });
  return secret;
}

/**
 * Resolves a bearer secret to a principal, or `null` for anything that should
 * get a 401: unknown, revoked, or owned by someone who is no longer active.
 */
export function authenticate(store: Store, secret: string): Principal | null {
  const hash = hashSecret(secret);
  const activeMember = (memberId: string) =>
    store.members.find((member) => member.id === memberId && member.status === 'active');

  const key = store.apiKeys.find((item) => item.hash === hash && !item.revoked);
  if (key) {
    const member = activeMember(key.memberId);
    if (!member) return null;
    return { kind: 'api_key', member, scopes: effectiveKeyScopes(key, member) };
  }

  const session = store.sessions.find((item) => item.hash === hash);
  if (session) {
    const member = activeMember(session.memberId);
    if (!member) return null;
    return { kind: 'session', member, scopes: new Set(ROLE_SCOPES[member.role]) };
  }

  return null;
}
