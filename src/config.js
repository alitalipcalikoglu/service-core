/**
 * Shared configuration primitives: a typed reader over `process.env`, the `ConfigError` every
 * service exits the process on, and the two env-var shapes duplicated across every service —
 * `id:secret[:role[:scope]]` API keys and the `AUDIT_URL`/`AUDIT_API_KEY` pair. Nothing here knows
 * about any one service's specific env var names beyond what is passed in.
 */

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Typed accessors over a raw environment map. Every service builds one over `process.env`. */
export class EnvReader {
  /** @param {NodeJS.ProcessEnv} env */
  constructor(env) {
    this.env = env;
  }

  /** @param {string} name */
  optional(name) {
    return this.env[name]?.trim() ?? '';
  }

  /** @param {string} name */
  required(name) {
    const v = this.optional(name);
    if (v === '') throw new ConfigError(`${name} is required`);
    return v;
  }

  /**
   * @param {string} name
   * @param {number} fallback
   * @param {{ min?: number, max?: number }} [range]
   */
  integer(name, fallback, range = {}) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
    const n = Number(raw);
    if (range.min !== undefined && n < range.min) throw new ConfigError(`${name} must be >= ${range.min}`);
    if (range.max !== undefined && n > range.max) throw new ConfigError(`${name} must be <= ${range.max}`);
    return n;
  }

  /**
   * @param {string} name
   * @param {boolean} fallback
   */
  boolean(name, fallback) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new ConfigError(`${name} must be true or false, got "${raw}"`);
  }

  /**
   * Comma-separated list, trimmed, empty entries dropped. Covers every service's `csv`/`list`
   * helper: default fallback is the empty string (an unset var yields `[]`), same as every service
   * that calls this with no fallback argument today.
   * @param {string} name
   * @param {string} [fallback]
   */
  list(name, fallback = '') {
    const raw = this.env[name] === undefined ? fallback : this.env[name];
    return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  }
}

/**
 * Parse `id:secret[:role[:scopeList]]` entries, comma separated. Two current shapes are supported
 * by the same function depending on whether `roles` is passed:
 * - `roles` given (ratelimit/geo/flags/search/scheduler/shortlink/webhook-out/audit today): role is
 *   the 3rd field, defaults to `readwrite`; a 4th field is a `+`-separated scope list validated
 *   against `scopePattern` when given (`null` scope means "every scope").
 * - `roles` omitted (auth/media/notify today): plain `id:secret`, no role or scope concept at all —
 *   every returned entry has `role: undefined, scopes: null`.
 * @param {string} raw
 * @param {string} envName Used only in error messages.
 * @param {{ roles?: readonly string[], scopePattern?: RegExp, minSecretLength?: number }} [opts]
 * @returns {{ id: string, secret: string, role: string|undefined, scopes: string[]|null }[]}
 */
export function parseApiKeys(raw, envName, { roles, scopePattern, minSecretLength = 32 } = {}) {
  const maxParts = roles ? 4 : 2;
  const keys = raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const parts = entry.split(':');
    if (parts.length < 2 || parts.length > maxParts) {
      throw new ConfigError(roles
        ? `${envName} entry "${entry.slice(0, 8)}…" must be id:secret[:role[:scopes]]`
        : `${envName} entry "${entry.slice(0, 8)}…" must be id:secret`);
    }
    const [id, secret, role, scopeList] = parts;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ConfigError(`${envName} id "${id}" must match [A-Za-z0-9_-]{1,64}`);
    if (secret.length < minSecretLength) throw new ConfigError(`${envName} secret for "${id}" must be at least ${minSecretLength} characters`);
    if (!roles) return { id, secret, role: undefined, scopes: null };
    const effectiveRole = role || 'readwrite';
    if (!roles.includes(effectiveRole)) throw new ConfigError(`${envName} role for "${id}" must be one of ${roles.join(', ')}`);
    let scopes = null;
    if (scopeList) {
      scopes = scopeList.split('+').map((s) => s.trim()).filter(Boolean);
      if (scopePattern) for (const s of scopes) if (!scopePattern.test(s)) throw new ConfigError(`${envName} key "${id}" names an invalid scope "${s}"`);
    }
    return { id, secret, role: effectiveRole, scopes };
  });
  if (keys.length === 0) throw new ConfigError(`${envName} must contain at least one key`);
  if (new Set(keys.map((k) => k.id)).size !== keys.length) throw new ConfigError(`${envName} ids must be unique`);
  if (new Set(keys.map((k) => k.secret)).size !== keys.length) throw new ConfigError(`${envName} secrets must be unique`);
  return keys;
}

/**
 * `AUDIT_URL` + `AUDIT_API_KEY`: both or neither. Empty return means audit events are not
 * forwarded. The pair of env var names is fixed across every service (never renamed per service).
 * @param {EnvReader} r
 * @returns {{ url: string, apiKey: string }|null}
 */
export function parseAudit(r) {
  const url = r.optional('AUDIT_URL').replace(/\/+$/, '');
  const apiKey = r.optional('AUDIT_API_KEY');
  if (!url && !apiKey) return null;
  if (!url || !apiKey) throw new ConfigError('AUDIT_URL and AUDIT_API_KEY must be set together');
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new ConfigError('AUDIT_URL must be an absolute http(s) URL');
  if (apiKey.length < 32) throw new ConfigError('AUDIT_API_KEY must be at least 32 characters');
  return { url, apiKey };
}

/**
 * `TARGET_ALLOW_HTTP` / `TARGET_ALLOW_PRIVATE` / `TARGET_ALLOWED_HOSTS`: the outbound-SSRF-guard
 * config shape shared by scheduler and webhook-out (and adopted by any service that calls
 * caller-supplied URLs). Fixed env var names, same as {@link parseAudit}.
 * @param {EnvReader} r
 * @returns {{ allowHttp: boolean, allowPrivate: boolean, allowedHosts: string[] }}
 */
export function parseTarget(r) {
  const allowPrivate = r.boolean('TARGET_ALLOW_PRIVATE', false);
  const allowedHosts = r.list('TARGET_ALLOWED_HOSTS').map((h) => h.toLowerCase());
  if (allowPrivate && allowedHosts.length === 0) throw new ConfigError('TARGET_ALLOWED_HOSTS is required when TARGET_ALLOW_PRIVATE is true');
  return { allowHttp: r.boolean('TARGET_ALLOW_HTTP', false), allowPrivate, allowedHosts };
}
