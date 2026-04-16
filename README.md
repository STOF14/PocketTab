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
| `DB_PATH` | `./pockettab.db` | SQLite database file path override |
| `ALLOW_DATA_RESET` | `false` | Set `true` to enable `DELETE /api/users/reset-all` |
| `SLOW_REQUEST_MS` | `1000` | Warn-level logging threshold for slow HTTP requests |
| `DB_BACKUP_DIR` | `./backups` | Directory where backup files are written |
| `DB_BACKUP_KEEP` | `14` | Number of recent backups to keep (older ones are pruned) |

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
- For Linux cron, run once per day at 02:15:

```bash
15 2 * * * cd /path/to/PocketTab && npm run backup:db:daily >> /var/log/pockettab-backup.log 2>&1
```

### Continuous Integration

- GitHub Actions workflow in `.github/workflows/ci.yml` runs `npm ci` and `npm test` on every push and pull request.
