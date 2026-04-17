# PocketTab

**Brutalist Family Expense Tracker** — Track shared expenses, send payment requests, and settle debts across multiple users and devices.

## Features

- **Household tenancy** — Multi-household support with invite-code onboarding and household-scoped access control
- **Role-aware access** — `admin`, `parent`, and `member/child` role workflows
- **PIN auth + session controls** — 4-digit PIN login, lockout on repeated failures, revocable sessions
- **PIN recovery assistance** — In-household assisted reset flow (`pin-recovery-request`, parent/admin reset)
- **Money requests** — Create, approve/reject, and partially settle request balances
- **Recurring requests** — Weekly/monthly recurring rules with due-run generation
- **Payments** — Send payments with confirm/dispute recipient workflow
- **Settlement engine API** — Net balances and suggested minimal transfers (`/api/settlements/net`)
- **Chat + attachments** — Message threads and file attachments on requests/payments
- **Notifications + reminders** — In-app notifications and stale-item reminder generation
- **Reporting** — Summary, trends, CSV export, and lightweight PDF-like export endpoints
- **Dashboard + history** — At-a-glance balances and activity timeline

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: SQLite (via better-sqlite3)
- **Auth**: bcrypt PIN hashing + JWT sessions
- **Frontend**: Vanilla HTML/CSS/JS (brutalist design)
- **Currency**: ZAR (South African Rand)

## Getting Started

```bash
# Install dependencies
npm install

# Start the server
npm start

# Run automated API tests
npm test

# Create a database backup now
npm run backup:db
```

The app will be available at <http://localhost:3000>.

## Environment Variables

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PORT` | `3000` | Server port |
| `JWT_SECRET` | required; ephemeral random fallback only when missing outside production | Secret key for JWT tokens (must be explicitly set in development, staging, and production) |
| `PIN_PEPPER` | required; ephemeral random fallback only when missing outside production | Server-side PIN pepper appended before hashing |
| `PIN_BCRYPT_ROUNDS` | `12` (minimum `12`) | Bcrypt cost factor for PIN hashing |
| `NODE_ENV` | `development` | Set to `production` to enforce strict secret and pepper handling |
| `DB_PATH` | `./pockettab.db` (dev), auto `/var/data/pockettab.db` on Render production | SQLite database file path override |
| `ALLOW_EPHEMERAL_RENDER_DB_FALLBACK` | `false` | Emergency-only: when `true`, allows Render production startup without `/var/data` by using app-local ephemeral DB |
| `ALLOW_DATA_RESET` | `false` | Set `true` to enable `DELETE /api/users/reset-all` |
| `SLOW_REQUEST_MS` | `1000` | Warn-level logging threshold for slow HTTP requests |
| `JSON_BODY_LIMIT` | `1mb` in production, else `10mb` | Max JSON request payload size |
| `TRUST_PROXY` | `1` in production, else `false` | Express trust-proxy setting for HTTPS/load balancer setups |
| `SESSION_TTL_DAYS` | `7` (clamped to 1-30) | JWT/session lifetime in days |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Shared time window for API rate limits |
| `GLOBAL_RATE_LIMIT_MAX` | `300` in production, else `100` | Max API requests per IP per window |
| `AUTH_RATE_LIMIT_MAX` | `30` in production, else `10` | Max login/register requests per IP per window |
| `DB_BACKUP_DIR` | `./backups` | Directory where backup files are written |
| `DB_BACKUP_KEEP` | `14` | Number of recent backups to keep (older ones are pruned) |
| `DB_BACKUP_MIN_COUNT` | `1` | Minimum backup count expected by backup verification |
| `DB_BACKUP_MAX_AGE_HOURS` | `30` | Maximum age for latest backup in verification checks |

## Project Structure

```text
├── public/
│   ├── index.html          # Frontend markup
│   ├── styles.css          # Frontend styles
│   └── app.js              # Frontend app logic
├── scripts/
│   ├── backup-db.js         # Automated SQLite backup + retention pruning
│   ├── check-backups.js     # Backup freshness/retention verification
│   ├── monitor-health.js    # Health endpoint monitor script
│   ├── restore-db.js        # DB restore utility
│   ├── smoke-check.js       # Post-deploy smoke tests
│   └── verify-backup-restore.js
├── server/
│   ├── app.js               # Express app (exported for tests)
│   ├── index.js             # Server entry point (listen)
│   ├── db.js                # SQLite database setup
│   ├── middleware/
│   │   ├── auth.js          # JWT authentication middleware
│   │   ├── household.js     # Household tenancy guards
│   │   └── observability.js # Structured logging and error handling
│   └── routes/
│       ├── auth.js          # Register, login, list users
│       ├── allowances.js
│       ├── attachments.js
│       ├── requests.js      # Money request CRUD
│       ├── payments.js      # Payment CRUD
│       ├── messages.js      # Chat messages
│       ├── notifications.js
│       ├── recurring.js
│       ├── reports.js
│       ├── settlements.js
│       └── users.js         # PIN, role, sessions, recovery, reset endpoints
├── .github/
│   └── workflows/
│       └── ci.yml           # GitHub Actions: install + test on push/PR
├── test/
│   └── api.test.js          # Node test runner + Supertest API tests
├── package.json
└── README.md
```

## Data Model Note

- Amounts are persisted using integer cents (`amount_cents`) to avoid floating-point drift.
- API responses still return `amount` as decimal ZAR values for frontend compatibility.

## API Endpoints

### Health

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/health` | No | Service/database health check |

### Auth and Household

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/auth/users` | No | List users; supports `inviteCode` and `householdId` filters |
| POST | `/api/auth/register` | No | Create user; supports `inviteCode`, or `createHousehold` + `householdName` |
| POST | `/api/auth/login` | No | Login with PIN |
| POST | `/api/auth/logout` | Yes | Revoke current session |
| GET | `/api/auth/invites/:code` | No | Validate invite and preview household/member list |
| GET | `/api/auth/household` | Yes | Get current household details |
| POST | `/api/auth/household/invites` | Yes (admin) | Create household join invite (`ttlHours`) |
| PATCH | `/api/auth/household/members/:userId/role` | Yes (admin) | Set member role (`admin` or `member`) |

### Users, PIN, Sessions

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/users/me` | Yes | Get current user profile |
| GET | `/api/users/members` | Yes (parent/admin) | List household members |
| PATCH | `/api/users/:id/role` | Yes (admin) | Set role (`admin`, `parent`, `child`) |
| PATCH | `/api/users/pin` | Yes | Change own PIN |
| POST | `/api/users/pin-recovery-request` | Yes | Request parent/admin PIN recovery help |
| POST | `/api/users/:id/pin-reset` | Yes (parent/admin) | Reset another member's PIN |
| GET | `/api/users/sessions` | Yes | List sessions for self (or `userId` when admin) |
| DELETE | `/api/users/sessions/:id` | Yes | Revoke session (self or admin) |
| DELETE | `/api/users/reset-all` | Yes (parent/admin) | Reset household data (only when `ALLOW_DATA_RESET=true`) |

### Requests and Payments

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/requests` | Yes | List requests (`limit`/`offset` + filters/search) |
| POST | `/api/requests` | Yes | Create money request |
| PATCH | `/api/requests/:id` | Yes | Recipient accepts/rejects request |
| POST | `/api/requests/:id/approve-child` | Yes (parent/admin) | Approve child request |
| POST | `/api/requests/:id/reject-child` | Yes (parent/admin) | Reject child request |
| GET | `/api/payments` | Yes | List payments (`limit`/`offset` + filters/search) |
| POST | `/api/payments` | Yes | Send payment (optionally linked via `requestId`) |
| PATCH | `/api/payments/:id` | Yes | Recipient confirms/disputes payment |

### Messaging and Attachments

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/messages` | Yes | List messages for `refType` + `refId` |
| POST | `/api/messages` | Yes | Post message to request/payment thread |
| GET | `/api/attachments` | Yes | List attachments for `refType` + `refId` |
| POST | `/api/attachments` | Yes | Upload base64 attachment |
| GET | `/api/attachments/:id/download` | Yes | Download attachment |
| DELETE | `/api/attachments/:id` | Yes | Delete attachment (owner or parent/admin) |

### Notifications

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/notifications` | Yes | List notifications (`unreadOnly`, paging) |
| PATCH | `/api/notifications/:id/read` | Yes | Mark one notification as read |
| PATCH | `/api/notifications/read-all` | Yes | Mark all notifications as read |
| POST | `/api/notifications/reminders/run` | Yes (parent/admin) | Generate stale pending reminders |

### Recurring, Allowances, Settlements, Reports

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/recurring` | Yes | List recurring request rules |
| POST | `/api/recurring` | Yes (parent/admin) | Create recurring rule |
| PATCH | `/api/recurring/:id` | Yes (parent/admin) | Update recurring rule |
| POST | `/api/recurring/run` | Yes (parent/admin) | Trigger recurring generation run |
| GET | `/api/allowances` | Yes | List allowance rules |
| POST | `/api/allowances` | Yes (parent/admin) | Create allowance rule |
| PATCH | `/api/allowances/:id` | Yes (parent/admin) | Update allowance rule |
| GET | `/api/settlements/net` | Yes | Net balances + suggested transfers (`scope=mine` or `scope=household`) |
| GET | `/api/reports/summary` | Yes | Aggregate report summary |
| GET | `/api/reports/trends` | Yes | Monthly trend + categories |
| GET | `/api/reports/export.csv` | Yes | CSV export |
| GET | `/api/reports/export.pdf` | Yes | Lightweight PDF-like export |

## Security Notes

- In production (`NODE_ENV=production`), both `JWT_SECRET` and `PIN_PEPPER` are mandatory.
- PIN hashes use bcrypt cost factor `12` minimum with server-side peppering, and legacy hashes are re-hashed on next successful login.
- PIN login attempts are lockout-protected (`PIN_MAX_ATTEMPTS`, `PIN_LOCK_MINUTES`).
- Message read/write now checks request/payment ownership before access.
- Global and auth-specific rate limits are active on API routes and persisted in SQLite so counters survive restarts.

## Operations

### Monitoring and Logging

- `GET /api/health` returns service/db health + uptime for uptime checks.
- API responses include `X-Request-Id` for traceability.
- Request and error logs are structured JSON, including status and latency.

### Automated Backups

- Run ad-hoc backup: `npm run backup:db`
- Daily-style backup with 30 retention: `npm run backup:db:daily`
- Verify backup freshness/retention policy: `npm run verify:backups`
- Restore from a backup file: `npm run restore:db -- /absolute/path/to/pockettab-YYYYMMDD-....db`
- For Linux cron, run backup once per day at 02:15:

```bash
15 2 * * * cd /path/to/PocketTab && npm run backup:db:daily >> /var/log/pockettab-backup.log 2>&1
```

- Verify backups shortly after backup and fail loudly to logs/mail/webhook:

```bash
25 2 * * * cd /path/to/PocketTab && npm run verify:backups >> /var/log/pockettab-backup-verify.log 2>&1 || logger -t pockettab-backup "backup verification failed"
```

- Optional webhook alert example when verification fails:

```bash
25 2 * * * cd /path/to/PocketTab && npm run verify:backups >> /var/log/pockettab-backup-verify.log 2>&1 || curl -fsS -X POST https://example-alert-webhook -H 'Content-Type: application/json' -d '{"service":"pockettab","event":"backup_verify_failed"}'
```

#### Restore Procedure

1. Stop writes to the app (maintenance mode / stop the app process).
2. Restore from a known-good backup:
   - `npm run restore:db -- /absolute/path/to/backup.db`
3. Start the app.
4. Run `npm run verify:backups` and `npm test` to confirm integrity.

### Deployment (Always-on + HTTPS)

- Keep the existing same-origin setup: Express serves both API and frontend.
- Deploy behind HTTPS with a public domain (reverse proxy/load balancer).
- Set production runtime vars at minimum:
  - `NODE_ENV=production`
  - `JWT_SECRET=<strong-random-secret>`
  - `PIN_PEPPER=<random-32-byte-hex>`
  - `DB_PATH=<durable managed volume path>`
  - `TRUST_PROXY=1`
- Render note: if `DB_PATH` is not set and a persistent disk is mounted at `/var/data`, PocketTab defaults to `/var/data/pockettab.db`.
- If no persistent disk is mounted, startup now fails by default to prevent accidental non-durable storage in production.
- Emergency-only override: set `ALLOW_EPHEMERAL_RENDER_DB_FALLBACK=true` to allow app-local `./pockettab.db` fallback (ephemeral data, not recommended for normal operation).
- Run health monitoring against `GET /api/health`:
  - `HEALTH_URL=https://your-domain/api/health npm run monitor:health`
- Run staged smoke tests before release:
  - `SMOKE_BASE_URL=https://your-domain npm run smoke:staging`

### Token Handling Policy

- Tokens are always sent as `Authorization: Bearer <token>`.
- Session TTL is controlled by `SESSION_TTL_DAYS` (1-30 day guardrail).
- In production, `JWT_SECRET` and `PIN_PEPPER` are mandatory.

### Multi-family (Household Tenancy)

- Users are linked to a household (`users.household_id`) and core write operations are household-scoped.
- New APIs:
  - `GET /api/auth/invites/:code` — validate invite and preview household/members
  - `GET /api/auth/household` — current household details
  - `POST /api/auth/household/invites` — create join invite (admin only, supports `ttlHours`)
  - `PATCH /api/auth/household/members/:userId/role` — assign household role (`admin` or `member`, admin only)
- Registration supports:
  - `inviteCode` to join an existing household
  - `createHousehold: true` and optional `householdName` to start a new household
- Invites are single-use and expire; backend rejects invalid/used/expired codes.

### PIN Recovery (Assisted)

- Child/member can request assistance: `POST /api/users/pin-recovery-request`.
- Parent/admin can reset household member PIN: `POST /api/users/:id/pin-reset`.
- Admin-only rule applies when resetting another admin PIN.

## Current Product Gaps

These are known limitations in the current product shape:

- **No guest/observer role**: all users are active participants under `admin`/`parent`/`child` role model.
- **No self-service forgot-PIN screen**: recovery currently depends on an authenticated parent/admin helper, not an unauthenticated login-reset flow.
- **Flat household structure**: no sub-groups (for example, room/car/activity-level ledgers) within one household.
- **One-to-one requests only**: group split requests are not modeled yet.
- **Payment dispute is terminal**: `disputed` status exists, but there is no built-in mediation/escalation/reopen workflow.
- **Settlement suggestions are API-first**: `/api/settlements/net` exists, but dashboard UI does not yet present guided settlement flows.
- **Invite lifecycle visibility is limited**: expiry is shown when generated, but there is no dedicated endpoint/UI for historical invite usage tracking.

### Frontend Runtime Network Config (Optional)

You can tune retry behavior by defining `window.POCKETTAB_CONFIG` before loading `app.js`:

- `requestTimeoutMs` (default `10000`)
- `maxSafeRetries` (default `2`, applied to `GET` requests only)
- `retryBaseDelayMs` (default `300`)

### Continuous Integration

- GitHub Actions workflow in `.github/workflows/ci.yml` runs `npm ci` and `npm test` on every push and pull request.
