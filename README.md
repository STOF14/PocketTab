# PocketTab

**Brutalist Family Expense Tracker** — Track shared expenses, send payment requests, and settle debts across multiple users and devices.

## Features

- **Multi-user support** — Unlimited users with PIN-based authentication
- **Multi-device sync** — All data stored on the server, accessible from any device
- **Money Requests** — Request money from other users, accept or reject incoming requests
- **Payments** — Send payments to settle debts, with confirm/dispute workflow
- **Chat Messages** — Message threads on every request and payment
- **Dashboard** — See what you owe and what's owed to you at a glance
- **Transaction History** — Full activity log of all requests and payments

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
| `JWT_SECRET` | dev fallback in non-production | Secret key for JWT tokens (required in production) |
| `NODE_ENV` | `development` | Set to `production` to enforce strict secret handling |
| `DB_PATH` | `./pockettab.db` (dev), auto `/var/data/pockettab.db` on Render production | SQLite database file path override |
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
│   └── backup-db.js         # Automated SQLite backup + retention pruning
├── server/
│   ├── app.js               # Express app (exported for tests)
│   ├── index.js             # Server entry point (listen)
│   ├── db.js                # SQLite database setup
│   ├── middleware/
│   │   └── auth.js          # JWT authentication middleware
│   └── routes/
│       ├── auth.js          # Register, login, list users
│       ├── requests.js      # Money request CRUD
│       ├── payments.js      # Payment CRUD
│       ├── messages.js      # Chat messages
│       └── users.js         # Change PIN + reset endpoint
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

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/auth/users` | No | List all users |
| POST | `/api/auth/register` | No | Create a new user |
| POST | `/api/auth/login` | No | Login with PIN |
| GET | `/api/requests` | Yes | List user's requests (`limit`/`offset` supported) |
| POST | `/api/requests` | Yes | Create a money request |
| PATCH | `/api/requests/:id` | Yes | Accept/reject a request |
| GET | `/api/payments` | Yes | List user's payments (`limit`/`offset` supported) |
| POST | `/api/payments` | Yes | Send a payment |
| PATCH | `/api/payments/:id` | Yes | Confirm/dispute a payment |
| GET | `/api/messages` | Yes | Get messages for a request/payment (`limit`/`offset` supported) |
| POST | `/api/messages` | Yes | Send a chat message |
| PATCH | `/api/users/pin` | Yes | Change PIN |
| DELETE | `/api/users/reset-all` | Yes | Reset all data (only when `ALLOW_DATA_RESET=true`) |

## Security Notes

- In production (`NODE_ENV=production`), `JWT_SECRET` is mandatory.
- Message read/write now checks request/payment ownership before access.
- Global and auth-specific rate limits are active on API routes.

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
- For Linux cron, run once per day at 02:15:

```bash
15 2 * * * cd /path/to/PocketTab && npm run backup:db:daily >> /var/log/pockettab-backup.log 2>&1
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
  - `DB_PATH=<durable managed volume path>`
  - `TRUST_PROXY=1`
- Render note: if `DB_PATH` is not set and a persistent disk is mounted at `/var/data`, PocketTab now defaults to `/var/data/pockettab.db`. Setting `DB_PATH` explicitly is still recommended.
- Run health monitoring against `GET /api/health`:
  - `HEALTH_URL=https://your-domain/api/health npm run monitor:health`
- Run staged smoke tests before release:
  - `SMOKE_BASE_URL=https://your-domain npm run smoke:staging`

### Token Handling Policy

- Tokens are always sent as `Authorization: Bearer <token>`.
- Session TTL is controlled by `SESSION_TTL_DAYS` (1-30 day guardrail).
- In production, `JWT_SECRET` is mandatory and dev fallback secrets are blocked.

### Multi-family (Household Tenancy)

- Users are linked to a household (`users.household_id`) and core write operations are household-scoped.
- New APIs:
  - `GET /api/auth/household` — current household details
  - `POST /api/auth/household/invites` — create join invite (parent/admin)
- Registration supports:
  - `inviteCode` to join an existing household
  - `createHousehold: true` and optional `householdName` to start a new household

### Frontend Runtime Network Config (Optional)

You can tune retry behavior by defining `window.POCKETTAB_CONFIG` before loading `app.js`:

- `requestTimeoutMs` (default `10000`)
- `maxSafeRetries` (default `2`, applied to `GET` requests only)
- `retryBaseDelayMs` (default `300`)

### Continuous Integration

- GitHub Actions workflow in `.github/workflows/ci.yml` runs `npm ci` and `npm test` on every push and pull request.
