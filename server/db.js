const Database = require('better-sqlite3');
const path = require('path');

if (process.env.NODE_ENV === 'production' && !process.env.DB_PATH) {
  throw new Error('DB_PATH is required when NODE_ENV=production to ensure durable storage configuration');
}

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'pockettab.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS household_invites (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id),
    code TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    used_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    household_id TEXT REFERENCES households(id),
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pin_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'child',
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES users(id),
    to_id TEXT NOT NULL REFERENCES users(id),
    amount REAL NOT NULL,
    amount_cents INTEGER NOT NULL,
    reason TEXT,
    category TEXT,
    tags_json TEXT,
    recurring_id TEXT,
    settled_cents INTEGER NOT NULL DEFAULT 0,
    requires_approval INTEGER NOT NULL DEFAULT 0,
    approved_by TEXT REFERENCES users(id),
    approved_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES users(id),
    to_id TEXT NOT NULL REFERENCES users(id),
    amount REAL NOT NULL,
    amount_cents INTEGER NOT NULL,
    request_id TEXT REFERENCES requests(id),
    message TEXT,
    category TEXT,
    tags_json TEXT,
    status TEXT NOT NULL DEFAULT 'sent',
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    ref_type TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    jti TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_seen_at TEXT,
    user_agent TEXT,
    ip TEXT
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    meta_json TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    read_at TEXT
  );

  CREATE TABLE IF NOT EXISTS recurring_requests (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL REFERENCES users(id),
    from_id TEXT NOT NULL REFERENCES users(id),
    to_id TEXT NOT NULL REFERENCES users(id),
    amount_cents INTEGER NOT NULL,
    reason TEXT,
    category TEXT,
    tags_json TEXT,
    frequency TEXT NOT NULL,
    next_run_at TEXT NOT NULL,
    last_run_at TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS allowances (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL REFERENCES users(id),
    child_id TEXT NOT NULL REFERENCES users(id),
    budget_cents INTEGER NOT NULL,
    period TEXT NOT NULL,
    approval_threshold_cents INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    ref_type TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pin_reset_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    requested_by TEXT NOT NULL REFERENCES users(id),
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT REFERENCES users(id)
  );
`);

function hasColumn(table, column) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  return info.some((c) => c.name === column);
}

function ensureColumn(table, definition) {
  const [columnName] = definition.trim().split(/\s+/);
  if (!hasColumn(table, columnName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function ensureBaseMigrations() {
  ensureColumn('users', 'household_id TEXT');
  ensureColumn('users', "role TEXT NOT NULL DEFAULT 'child'");
  ensureColumn('users', 'failed_login_attempts INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'locked_until TEXT');

  ensureColumn('requests', 'amount_cents INTEGER');
  ensureColumn('requests', 'category TEXT');
  ensureColumn('requests', 'tags_json TEXT');
  ensureColumn('requests', 'recurring_id TEXT');
  ensureColumn('requests', 'settled_cents INTEGER NOT NULL DEFAULT 0');
  ensureColumn('requests', 'requires_approval INTEGER NOT NULL DEFAULT 0');
  ensureColumn('requests', 'approved_by TEXT');
  ensureColumn('requests', 'approved_at TEXT');

  ensureColumn('payments', 'amount_cents INTEGER');
  ensureColumn('payments', 'request_id TEXT');
  ensureColumn('payments', 'category TEXT');
  ensureColumn('payments', 'tags_json TEXT');

  const householdCount = db.prepare('SELECT COUNT(*) AS total FROM households').get().total;
  if (householdCount === 0) {
    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)').run(
      'default-household',
      'Default household',
      createdAt
    );
  }

  db.exec("UPDATE users SET household_id = 'default-household' WHERE household_id IS NULL OR TRIM(household_id) = ''");

  db.exec("UPDATE users SET role = 'child' WHERE role IS NULL OR TRIM(role) = ''");
  db.exec('UPDATE users SET failed_login_attempts = 0 WHERE failed_login_attempts IS NULL');
  db.exec('UPDATE requests SET amount_cents = CAST(ROUND(amount * 100) AS INTEGER) WHERE amount_cents IS NULL');
  db.exec('UPDATE requests SET settled_cents = 0 WHERE settled_cents IS NULL');
  db.exec('UPDATE requests SET requires_approval = 0 WHERE requires_approval IS NULL');
  db.exec('UPDATE payments SET amount_cents = CAST(ROUND(amount * 100) AS INTEGER) WHERE amount_cents IS NULL');

  const adminCount = db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'").get().total;
  if (adminCount === 0) {
    const firstUser = db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get();
    if (firstUser) {
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(firstUser.id);
    }
  }
}

ensureBaseMigrations();

db.exec('CREATE INDEX IF NOT EXISTS idx_requests_to_status ON requests(to_id, status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_requests_from_status ON requests(from_id, status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_payments_to_status ON payments(to_id, status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_payments_request_id ON payments(request_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_ref ON messages(ref_type, ref_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id, revoked_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_recurring_next_run ON recurring_requests(active, next_run_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_allowances_child_active ON allowances(child_id, active)');
db.exec('CREATE INDEX IF NOT EXISTS idx_attachments_ref ON attachments(ref_type, ref_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_users_household ON users(household_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_household_invites_lookup ON household_invites(code, household_id, used_at, expires_at)');

module.exports = db;
