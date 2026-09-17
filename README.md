# service-core

Shared cross-cutting infrastructure for the [atc-web](https://github.com/alitalipcalikoglu?tab=repositories) services: config parsing, a SQLite base class, audit-event forwarding, API-key auth, W3C trace-context handling, an outbound SSRF guard/signer/HTTP transport, graceful process shutdown, and small Fastify helpers. No domain logic, no service orchestration, no app factory — every service still owns its own `Fastify(...)` instance, schema, and business rules.

## Why this exists

Every atc-web service is its own independent repository (`atc-web/<name>/`, copy the folder, `npm ci`, run). That independence is deliberate, but it meant roughly 450 lines of identical or near-identical infrastructure code were copied into each one — a change to the audit-retry policy needed a commit in 11 repositories. This package extracts exactly the parts that really are identical or safely parameterizable, and leaves everything with real per-service behavior (differing key formats, differing shutdown order, differing signing schemes) where it was. See each source repository's `docs/READINESS.md` for what that service specifically adopted.

## Install

Not published to any registry — installed straight from GitHub, pinned to a tag:

```
npm install github:alitalipcalikoglu/service-core#v1.0.0
```

A service's `package.json` then has `"@atc-web/service-core": "github:alitalipcalikoglu/service-core#v1.0.0"`, and `npm ci` resolves and clones that exact tagged commit — no private registry, no simultaneous-upgrade requirement across services. See [VERSIONING.md](VERSIONING.md).

## Modules

Each is a separate `exports` subpath so a service only pulls in what it uses:

| Import | Contents |
|---|---|
| `@atc-web/service-core/config` | `EnvReader`, `ConfigError`, `parseApiKeys`, `parseAudit`, `parseTarget` |
| `@atc-web/service-core/db` | `Database` (subclass with your own `static MIGRATIONS`), `StatementCache` |
| `@atc-web/service-core/audit` | `AuditClient` (buffered, batched, fail-safe forwarding to the audit service) |
| `@atc-web/service-core/auth` | `ApiKeyAuth` (bearer key auth; decoration shape and role rules are options) |
| `@atc-web/service-core/context` | `TraceContext` (W3C `traceparent` parse/generate, trust-boundary aware) |
| `@atc-web/service-core/http` | `HttpCaller`, `CallError`, `NetGuard`, `NetGuardError`, `Signer` |
| `@atc-web/service-core/lifecycle` | `Lifecycle.install(...)` — signal handling, ordered shutdown steps, force-exit |
| `@atc-web/service-core/fastify` | `jsonParser`, `createErrorHandler`, `registerProbes`, `metricsText` |

Every module's own JSDoc explains the exact contract and which per-service behavior stays local (e.g. `ApiKeyAuth`'s `decorate` option, `Lifecycle`'s caller-supplied `steps` order, `createErrorHandler`'s `extra` hook).

## What deliberately stayed local

Not everything that looks similar across services moved here — see `stack/docs/ARCHITECTURE_AUDIT.md`'s Stage 2 section for the full accounting:

- **notify's outbound webhook signing** (`channels/webhook.js`) was not migrated to this package's `Signer`/`HttpCaller`. Its signature verification uses `Buffer.prototype.equals` instead of a timing-safe comparison — a known, already-tracked defect (see `ARCHITECTURE_AUDIT.md`) scheduled for its own fix in a later stage. Adopting core's (correct) `Signer` here would have silently changed that behavior as a side effect of an "extraction" stage, which is exactly the kind of unintended change this package's adoption process is designed to avoid.
- **`crypto/password.js`, `crypto/opaque-token.js`** (auth ↔ console), **`rate-limiter.js`** (gateway ↔ console) and **`maintenance.js`** (auth/console/flags/shortlink/media/audit) are duplicated but were not pulled into this package — each is domain-adjacent enough (password hashing policy, a specific rate-limit algorithm, per-service maintenance windows) that centralizing it risked exactly the "giant framework" this package is meant not to become. They remain candidates for a future, separately-scoped extraction.

## License

MIT, see [LICENSE](LICENSE).
