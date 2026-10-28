/**
 * Who may call what.
 *
 * Every request is mapped to exactly one scope from its method and path.
 * Anything that is not in the table below gets `null`, and `null` means 403.
 * A new endpoint is closed until somebody adds a line here on purpose.
 */

export const SCOPES = [
  'catalog:read',
  'clients:read',
  'clients:write',
  'appointments:read',
  'appointments:write',
  'invoices:read',
  'clinical:read',
] as const;

export type Scope = (typeof SCOPES)[number];

/**
 * Scopes an API key can be granted at all. `clinical:read` is missing on
 * purpose: clinical data is for people signed in to the app, never for keys
 * or the assistants that hold them.
 */
export const KEY_SCOPES: readonly Scope[] = SCOPES.filter((scope) => scope !== 'clinical:read');

export type Role = 'owner' | 'therapist' | 'receptionist';

/** The ceiling for each role. A key never sees more than its owner does in the app. */
export const ROLE_SCOPES: Record<Role, readonly Scope[]> = {
  owner: SCOPES,
  therapist: ['catalog:read', 'clients:read', 'appointments:read', 'appointments:write', 'clinical:read'],
  receptionist: [
    'catalog:read',
    'clients:read',
    'clients:write',
    'appointments:read',
    'appointments:write',
    'invoices:read',
  ],
};

/**
 * Path segments that API keys can never reach, whatever scopes they hold.
 * Checked before scopes, so a mistake in the scope table cannot open them.
 */
export const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
  'records',
  'notes',
  'photos',
  'attachments',
  'consents',
  'surveys',
]);

/**
 * True when any segment of the path names sensitive data.
 *
 * The check is deliberately paranoid: it decodes percent-encoding (so
 * `%72ecords` and `a%2Frecords` count), ignores case and file extensions
 * (`Records.json`), and treats a path it cannot decode as forbidden.
 */
export function hasForbiddenSegment(path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true;
  }

  return decoded
    .toLowerCase()
    .split(/[/\\]/)
    .some((segment) => {
      const base = segment.split(/[.;]/)[0] ?? '';
      return FORBIDDEN_SEGMENTS.has(base);
    });
}

const ID = '[A-Za-z0-9_-]+';

/* [method, path pattern, scope]. Patterns match the raw path, end to end. */
const ROUTES: readonly (readonly [string, RegExp, Scope])[] = [
  ['GET', /^\/v1\/clinics$/, 'catalog:read'],
  ['GET', /^\/v1\/services$/, 'catalog:read'],
  ['GET', /^\/v1\/team$/, 'catalog:read'],
  ['GET', /^\/v1\/clients$/, 'clients:read'],
  ['POST', /^\/v1\/clients$/, 'clients:write'],
  ['GET', new RegExp(`^/v1/clients/${ID}$`), 'clients:read'],
  ['GET', /^\/v1\/availability$/, 'appointments:read'],
  ['GET', /^\/v1\/appointments$/, 'appointments:read'],
  ['POST', /^\/v1\/appointments$/, 'appointments:write'],
  ['POST', new RegExp(`^/v1/appointments/${ID}/cancel$`), 'appointments:write'],
  ['GET', /^\/v1\/invoices$/, 'invoices:read'],
  ['GET', new RegExp(`^/v1/clients/${ID}/(records|notes|photos|attachments|consents|surveys)$`), 'clinical:read'],
];

/** The scope a request needs, or `null` when the route is not open to anyone. */
export function scopeForRequest(method: string, path: string): Scope | null {
  const upper = method.toUpperCase();
  for (const [routeMethod, pattern, scope] of ROUTES) {
    if (routeMethod === upper && pattern.test(path)) return scope;
  }
  return null;
}
