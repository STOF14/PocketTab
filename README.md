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
```

The app will be available at **http://localhost:3000**.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `JWT_SECRET` | dev default | Secret key for JWT tokens (change in production!) |

## Project Structure

```
├── public/
│   └── index.html          # Frontend (HTML + CSS + JS)
├── server/
│   ├── index.js             # Express server entry point
│   ├── db.js                # SQLite database setup
│   ├── middleware/
│   │   └── auth.js          # JWT authentication middleware
│   └── routes/
│       ├── auth.js          # Register, login, list users
│       ├── requests.js      # Money request CRUD
│       ├── payments.js      # Payment CRUD
│       ├── messages.js      # Chat messages
│       └── users.js         # Change PIN
├── package.json
└── README.md
```

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/auth/users` | No | List all users |
| POST | `/api/auth/register` | No | Create a new user |
| POST | `/api/auth/login` | No | Login with PIN |
| GET | `/api/requests` | Yes | List user's requests |
| POST | `/api/requests` | Yes | Create a money request |
| PATCH | `/api/requests/:id` | Yes | Accept/reject a request |
| GET | `/api/payments` | Yes | List user's payments |
| POST | `/api/payments` | Yes | Send a payment |
| PATCH | `/api/payments/:id` | Yes | Confirm/dispute a payment |
| GET | `/api/messages` | Yes | Get messages for a request/payment |
| POST | `/api/messages` | Yes | Send a chat message |
| PATCH | `/api/users/pin` | Yes | Change PIN |