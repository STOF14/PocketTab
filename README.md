# PocketTab

PocketTab is a household expense tracking app for families. It supports multiple households, role-based permissions, requests, payments, settlements, recurring flows, notifications, chat, attachments, and operational tooling (health checks and backups).

## Table of Contents

1. [What PocketTab Is](#what-pockettab-is)
2. [Core Capabilities](#core-capabilities)
3. [Architecture](#architecture)
4. [Authentication and Authorization Model](#authentication-and-authorization-model)
5. [Quick Start](#quick-start)
6. [Environment Variables](#environment-variables)
7. [Project Structure](#project-structure)
8. [Data Model Overview](#data-model-overview)
9. [API Reference](#api-reference)
10. [Frontend Runtime Behavior](#frontend-runtime-behavior)
11. [Operations Runbook](#operations-runbook)
12. [Deployment Guide](#deployment-guide)
13. [Testing Guide](#testing-guide)
14. [Security Model](#security-model)
15. [Known Gaps and Non-Goals](#known-gaps-and-non-goals)
16. [Troubleshooting](#troubleshooting)

## What PocketTab Is

PocketTab is designed for shared household finance coordination:

- Who owes who, and why
- Request/accept/reject money requests
- Send and confirm/dispute payments
- Keep communication attached to the request/payment context
- Enforce household boundaries and role permissions

UI style is intentionally minimalist/brutalist and the backend is an API-first Node.js + Express service backed by SQLite.

## Core Capabilities

- Multi-household tenancy with strict household-scoped data access
- Household-first login flow:
  - Household login ID in temporary format `PT-{FRUIT}`
  - 6-digit household code
  - Member selection
  - Member PIN
- Role-aware controls:
  - `admin`
  - `parent`
  - `child` (public-facing member role maps to child in storage)
- Session management:
  - JWT access tokens
  - Session table with revocation and activity metadata
  - Session revocation endpoints
- Optional Google sign-in:
  - OAuth 2.0 authorization code flow
  - Automatic session cookie issuance
  - Redirects directly into dashboard when successful
- Request lifecycle:
  - pending, accepted, rejected, partially settled, settled
  - child request approval path
- Payment lifecycle:
  - sent, confirmed, disputed
  - optional payment-to-request linking
- Recurring requests and scheduled generation endpoint
- Allowances with approval thresholds
- Settlement suggestions for netting household balances
- Notification system and stale-item reminders
- Contextual messaging and file attachments on requests/payments
- Reports (summary, trends, CSV, lightweight PDF-like output)
- Production-minded operations:
  - health endpoint
  - backup, restore, backup verification scripts
  - smoke-test script

## Architecture

### Backend

- Runtime: Node.js
- Framework: Express 5
- DB: SQLite via `better-sqlite3`
- Auth/session: JWT + session persistence
- Password/PIN hashing: `bcryptjs`
- Rate limiting: `express-rate-limit` with SQLite-backed store

### Frontend

- Vanilla HTML/CSS/JS
- Served by the same Express app (same-origin API requests)
- Uses `localStorage` for token and current user cache

### Request Processing

- Middleware enforces JSON content type on API POST/PATCH requests
- Security headers and structured request logging are enabled
- Global and auth route-specific rate limits are applied (except in tests or when disabled)

## Authentication and Authorization Model

### Household-First Login (Current Primary UX)

1. User enters household login ID and household code.
2. `POST /api/auth/household/access` validates household credentials.
3. Backend returns a short-lived household access token and member list.
4. User selects member profile and enters 4-digit PIN.
5. `POST /api/auth/login` validates PIN and issues a full session token.

If a household forgets login details, PocketTab now supports a secure recovery reset:

1. On the login screen, choose "Forgot Household ID Or Code?"
2. Enter an admin/parent member name and PIN
3. `POST /api/auth/household/recover-reset` rotates household login credentials and returns fresh values
4. Continue sign-in using the new household ID/code

### Compatibility Behavior

`POST /api/auth/login` still accepts direct `userId + pin` without `householdAccessToken` for compatibility with existing clients/tests.

### Optional Google Sign-In

When configured, users can choose Google sign-in from the login screen:

1. Browser starts `GET /api/auth/google/start`.
2. Google redirects back to `GET /api/auth/google/callback`.
3. Backend verifies ID token and establishes a PocketTab session cookie.
4. User is redirected to `/` and enters the dashboard directly.

Google users are linked by `google_sub` (primary) and `google_email` (fallback). If no matching account exists, PocketTab provisions a new admin user and household.

### Role Rules (High-level)

- `admin`: full household admin operations, invite generation, household code rotation, member role changes
- `parent`: elevated member management for child flows (such as PIN reset assistance)
- `child`: regular member operations with restricted admin/parent actions

### Credential Reset Flows

- Self-service username update: `PATCH /api/users/me/name`
- Self-service PIN change: `PATCH /api/users/pin`
- Admin/parent member credential reset: `PATCH /api/users/:id/credentials-reset`
- Existing admin PIN-only reset flow remains available: `POST /api/users/:id/pin-reset`

## Quick Start

### Prerequisites

- Node.js 18+ (or newer LTS)
- npm

### Install and run

```bash
npm install
npm start
```

New users URL (landing): <http://localhost:3000/new>

Existing users URL (direct app/auth): <http://localhost:3000/app>

### Run tests

```bash
npm test
```

### Useful scripts

```bash
npm run backup:db
npm run verify:backups
npm run restore:db -- /absolute/path/to/backup.db
npm run smoke:staging
npm run monitor:health
```

## Environment Variables

### Runtime and security

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Set to `production` for strict production behavior |
| `PORT` | `3000` | Server listen port |
| `JWT_SECRET` | required in production | JWT signing secret |
| `PIN_PEPPER` | required in production | Server-side pepper appended to PIN before hashing |
| `PIN_BCRYPT_ROUNDS` | `12` (minimum 12) | bcrypt cost factor for PIN hashing |
| `SESSION_TTL_DAYS` | `7` (clamped 1-30) | Session/JWT lifetime in days |
| `SESSION_COOKIE_NAME` | `pt_session` | Name of httpOnly session cookie |
| `HOUSEHOLD_ACCESS_TTL_MINUTES` | `10` (clamped 1-30) | Temporary household-access token lifetime |
| `ALLOW_LEGACY_LOGIN_WITHOUT_HOUSEHOLD_ACCESS` | `false` in production, `true` otherwise | Allow direct PIN login without household access token |
| `GOOGLE_CLIENT_ID` | unset | Enables Google OAuth when set with secret |
| `GOOGLE_CLIENT_SECRET` | unset | Google OAuth client secret |
| `GOOGLE_OAUTH_REDIRECT_URI` | unset | Optional explicit callback URI; default is `{request-origin}/api/auth/google/callback` |
| `PIN_MAX_ATTEMPTS` | `5` | Failed login attempts before lock |
| `PIN_LOCK_MINUTES` | `15` | Lockout duration |

### Database path and durability

| Variable | Default | Description |
| --- | --- | --- |
| `DB_PATH` | dev: `./pockettab.db`, production: required unless Render `/var/data` fallback applies | SQLite file path |
| `ALLOW_EPHEMERAL_RENDER_DB_FALLBACK` | `false` | Emergency-only Render fallback to ephemeral local DB |

### API behavior and limits

| Variable | Default | Description |
| --- | --- | --- |
| `JSON_BODY_LIMIT` | production `1mb`, otherwise `10mb` | Max JSON body size |
| `SLOW_REQUEST_MS` | `1000` | Slow request log threshold |
| `TRUST_PROXY` | production `1`, otherwise `false` | Express proxy trust config |
| `DISABLE_RATE_LIMIT` | `false` (test commonly sets true) | Disable API rate limiting |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window |
| `GLOBAL_RATE_LIMIT_MAX` | production `300`, otherwise `100` | Global request cap per window |
| `AUTH_RATE_LIMIT_MAX` | production `30`, otherwise `10` | Auth request cap per window |
| `HOUSEHOLD_ACCESS_RATE_LIMIT_MAX` | production `20`, otherwise `10` | Household access request cap per window |
| `MAX_ATTACHMENT_BYTES` | `5242880` (5 MiB) | Max upload size for multipart attachment file payloads |
| `ALLOWED_ATTACHMENT_MIME_TYPES` | `application/pdf,application/octet-stream,image/jpeg,image/png,image/webp,text/plain` | Comma-separated MIME allowlist for attachment uploads |

### Administrative safety switches

| Variable | Default | Description |
| --- | --- | --- |
| `ALLOW_DATA_RESET` | `false` | Enables `DELETE /api/users/reset-all` |
| `DATA_RESET_SECRET` | unset | Required secret for `DELETE /api/users/reset-all` |
| `ALLOW_DATA_RESET_HTTP` | `false` | In production, must be `true` to allow reset endpoint over HTTP |

### Backup and restore tooling

| Variable | Default | Description |
| --- | --- | --- |
| `DB_BACKUP_DIR` | `./backups` | Backup output directory |
| `DB_BACKUP_KEEP` | `14` | Number of backups to retain |
| `DB_BACKUP_MIN_COUNT` | `1` | Minimum expected backup files |
| `DB_BACKUP_MAX_AGE_HOURS` | `30` | Max age of latest backup |
| `DB_BACKUP_FILE` | unset | Specific backup file for verify-restore script |

### Monitoring and smoke scripts

| Variable | Default | Description |
| --- | --- | --- |
| `HEALTH_URL` | required by monitor script | Full health endpoint URL |
| `HEALTH_TIMEOUT_MS` | `5000` | Health check request timeout |
| `SMOKE_BASE_URL` | required by smoke script | Base URL for smoke tests |
| `SMOKE_TEST_PIN` | `1234` | PIN used by smoke script-created users |
| `SMOKE_TIMEOUT_MS` | `10000` | Smoke API timeout |

## Project Structure

```text
.
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── scripts/
│   ├── backup-db.js
│   ├── check-backups.js
│   ├── monitor-health.js
│   ├── restore-db.js
│   ├── smoke-check.js
│   └── verify-backup-restore.js
├── server/
│   ├── app.js
│   ├── config.js
│   ├── db-path.js
│   ├── db.js
│   ├── index.js
│   ├── middleware/
│   ├── routes/
│   └── services/
├── test/
│   └── api.test.js
├── backups/
├── uploads/
│   └── attachments/
├── package.json
└── README.md
```

## Data Model Overview

Primary tables include:

- `households`
- `household_invites`
- `users`
- `requests`
- `payments`
- `messages`
- `sessions`
- `notifications`
- `recurring_requests`
- `allowances`
- `attachments`
- `pin_reset_requests`
- `rate_limit_attempts`

Important notes:

- Monetary values are persisted in integer cents (`*_cents`) for correctness.
- Household login credentials are stored as:
  - `households.login_id`
  - `households.login_code_hash`
- PIN and household codes are not stored in plaintext.
- Display names are unique per household (case-insensitive).

## API Reference

All API routes are mounted under `/api`.

### Health

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/health` | No | Service and DB liveness |

### Auth and household

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/auth/users` | No | User listing scoped by `inviteCode` |
| POST | `/api/auth/household/access` | No | Validate household ID/code and return members + temporary access token |
| GET | `/api/auth/invites/:code` | No | Validate invite code and preview household |
| POST | `/api/auth/register` | No | Register user (join by invite or create household) |
| POST | `/api/auth/login` | No | Login with `userId + pin` (production requires `householdAccessToken` unless explicitly overridden) |
| GET | `/api/auth/google/status` | No | Returns whether Google OAuth is enabled |
| GET | `/api/auth/google/start` | No | Start Google OAuth sign-in flow |
| GET | `/api/auth/google/link/start` | Yes | Start Google OAuth account-link flow for signed-in user |
| GET | `/api/auth/google/callback` | No | Complete Google OAuth sign-in flow and issue session |
| GET | `/api/auth/google/link/status` | Yes | Returns Google-link state for current user |
| POST | `/api/auth/logout` | Yes | Revoke current session |
| GET | `/api/auth/household` | Yes | Current household details |
| GET | `/api/auth/household/members` | Yes | Members in current household |
| POST | `/api/auth/household/invites` | Yes (admin) | Create invite code |
| POST | `/api/auth/household/login-code/rotate` | Yes (admin) | Rotate household login code |
| PATCH | `/api/auth/household/members/:userId/role` | Yes (admin) | Set household role (`admin` or `member`) |

### Users, roles, PIN, sessions

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/users/me` | Yes | Current profile |
| GET | `/api/users/members` | Yes (parent/admin) | Household member list |
| PATCH | `/api/users/:id/role` | Yes (admin) | Set stored role (`admin`, `parent`, `child`) |
| PATCH | `/api/users/pin` | Yes | Change own PIN |
| POST | `/api/users/pin-recovery-request` | Yes | Request recovery help |
| POST | `/api/users/:id/pin-reset` | Yes (parent/admin) | Reset another member PIN |
| GET | `/api/users/sessions` | Yes | List sessions for self (or `userId` when admin) |
| DELETE | `/api/users/sessions/:id` | Yes | Revoke session |
| DELETE | `/api/users/reset-all` | Yes (admin) | Household data reset (requires env switch + reset secret) |

### Requests and payments

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/requests` | Yes | List requests with filters, search, paging |
| POST | `/api/requests` | Yes | Create request |
| PATCH | `/api/requests/:id` | Yes | Accept/reject request |
| POST | `/api/requests/:id/approve-child` | Yes (parent/admin) | Approve child request |
| POST | `/api/requests/:id/reject-child` | Yes (parent/admin) | Reject child request |
| GET | `/api/payments` | Yes | List payments with filters, search, paging |
| POST | `/api/payments` | Yes | Create payment (optional `requestId`) |
| PATCH | `/api/payments/:id` | Yes | Confirm/dispute payment |

### Messaging and attachments

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/messages` | Yes | List thread messages by `refType` and `refId` |
| POST | `/api/messages` | Yes | Post message |
| GET | `/api/attachments` | Yes | List attachments by `refType` and `refId` |
| POST | `/api/attachments` | Yes | Upload multipart attachment (`refType`, `refId`, `file`) |
| GET | `/api/attachments/:id/download` | Yes | Download attachment |
| DELETE | `/api/attachments/:id` | Yes | Delete attachment |

Attachment uploads use `multipart/form-data` and must include the binary file in form field `file`.

### Notifications

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/notifications` | Yes | List notifications |
| PATCH | `/api/notifications/:id/read` | Yes | Mark one as read |
| PATCH | `/api/notifications/read-all` | Yes | Mark all as read |
| POST | `/api/notifications/reminders/run` | Yes (parent/admin) | Generate reminder notifications |

### Recurring, allowances, settlements, reports

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/recurring` | Yes | List recurring rules |
| POST | `/api/recurring` | Yes (parent/admin) | Create recurring rule |
| PATCH | `/api/recurring/:id` | Yes (parent/admin) | Update recurring rule |
| POST | `/api/recurring/run` | Yes (parent/admin) | Execute recurring generation |
| GET | `/api/allowances` | Yes | List allowances |
| POST | `/api/allowances` | Yes (parent/admin) | Create allowance |
| PATCH | `/api/allowances/:id` | Yes (parent/admin) | Update allowance |
| GET | `/api/settlements/net` | Yes | Net balances and transfer suggestions |
| GET | `/api/reports/summary` | Yes | Summary report |
| GET | `/api/reports/trends` | Yes | Trend report |
| GET | `/api/reports/export.csv` | Yes | CSV export |
| GET | `/api/reports/export.pdf` | Yes | Lightweight PDF-like export |

Recurring generation is executed only by `POST /api/recurring/run`.

## Frontend Runtime Behavior

The frontend reads optional runtime config from `window.POCKETTAB_CONFIG`.

Supported keys:

- `requestTimeoutMs` (default 10000)
- `maxSafeRetries` (default 2, GET requests only)
- `retryBaseDelayMs` (default 300)

Other behavior:

- Session authentication uses an httpOnly same-site cookie (default name `pt_session`)
- API calls are made to same-origin `/api/*`
- Route-based entry points:
  - `/new` (or `/welcome`) for the landing page/new users
  - `/app` for existing users (goes directly to auth/app shell, no landing page)

## Operations Runbook

### Health monitoring

- Endpoint: `GET /api/health`
- Monitor script:

```bash
HEALTH_URL=https://your-domain/api/health npm run monitor:health
```

### Database backup

Create backup now:

```bash
npm run backup:db
```

Daily backup (retention 30):

```bash
npm run backup:db:daily
```

Verify backups:

```bash
npm run verify:backups
```

### Restore database

```bash
npm run restore:db -- /absolute/path/to/backup.db
```

### Verify backup restore integrity

```bash
node scripts/verify-backup-restore.js
# optionally pin file
DB_BACKUP_FILE=/absolute/path/to/backup.db node scripts/verify-backup-restore.js
```

### Example cron entries

```bash
15 2 * * * cd /path/to/PocketTab && npm run backup:db:daily >> /var/log/pockettab-backup.log 2>&1
25 2 * * * cd /path/to/PocketTab && npm run verify:backups >> /var/log/pockettab-backup-verify.log 2>&1 || logger -t pockettab-backup "backup verification failed"
```

## Deployment Guide

### Baseline production requirements

- `NODE_ENV=production`
- strong `JWT_SECRET`
- strong `PIN_PEPPER`
- durable `DB_PATH`
- `TRUST_PROXY=1` behind reverse proxy/load balancer

### Render-specific notes

- If persistent disk exists at `/var/data` and `DB_PATH` is unset, PocketTab falls back to `/var/data/pockettab.db`.
- If on Render in production without durable path, startup fails by default.
- Emergency override exists via `ALLOW_EPHEMERAL_RENDER_DB_FALLBACK=true`, but data becomes non-durable.

### Post-deploy smoke test

```bash
SMOKE_BASE_URL=https://your-domain npm run smoke:staging
```

## Testing Guide

### Full suite

```bash
npm test
```

### Focused test patterns

```bash
node --test --test-name-pattern "household access" test/api.test.js
```

### What tests currently validate

- Multi-household isolation and cross-household denial behavior
- Request and payment lifecycle transitions
- Role and permission enforcement
- Session handling and revocation
- PIN lockout and PIN recovery/reset paths
- Backup and operational integration behavior (where applicable)

## Security Model

- Production requires `JWT_SECRET` and `PIN_PEPPER`
- PIN and household code verification use bcrypt hashes
- Session records include token hash and revocation state
- Browser sessions use httpOnly same-site cookies
- Rate limiting protects global API and auth routes
- Dedicated limiter protects `/api/auth/household/access`
- JSON content-type enforcement helps reject malformed non-JSON writes
- Household and role checks are enforced on protected resources
- Content Security Policy is enabled in security headers

## Known Gaps and Non-Goals

Current limitations:

- No self-service unauthenticated “forgot PIN” recovery flow
- No built-in mediator workflow after payment disputes
- No group split request model (requests are one-to-one)
- No guest/read-only role
- Settlement API exists, but guided settlement UX remains API-first
- Household login ID format is intentionally temporary (`PT-{FRUIT}`), with suffix fallback if collisions increase
- Detailed hardening findings and prioritized remediation plan are tracked in `ClaudeFixes.md` (single source of truth)

## Troubleshooting

### App fails on startup in production

Likely missing one of:

- `JWT_SECRET`
- `PIN_PEPPER`
- `DB_PATH` (or no Render persistent disk)

### Render logs mention localhost URL

This is expected process logging inside container context. Verify externally via your public URL and `/api/health`.

### `415 Unsupported Media Type`

POST/PATCH API routes require `Content-Type: application/json` when a body is sent.

### `423 Account is temporarily locked`

Too many failed PIN attempts. Wait for `PIN_LOCK_MINUTES` or perform a parent/admin PIN reset flow.

### Backup verification fails

Check:

- `DB_BACKUP_DIR` exists and is writable
- backup count and age thresholds (`DB_BACKUP_MIN_COUNT`, `DB_BACKUP_MAX_AGE_HOURS`)
- cron execution output and permissions

---

If you are extending PocketTab, keep this README aligned with route changes, new env vars, and flow changes as part of the same PR.
