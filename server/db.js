const Database = require('better-sqlite3');
const { ensureDbDirectory, resolveDbPath } = require('./db-path');
const { hashPin } = require('./services/pin-security');
const {
  normalizeHouseholdLoginId,
  generateHouseholdCode,
  generateUniqueHouseholdLoginId
} = require('./services/household-login');

const dbPath = resolveDbPath();
ensureDbDirectory(dbPath);
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
    login_id TEXT,
    login_code_hash TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS household_invites (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id),
    code TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    household_id TEXT REFERENCES households(id),
    name TEXT NOT NULL COLLATE NOCASE,
    pin_hash TEXT NOT NULL,
    pin_hash_needs_rehash INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'child',
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    google_sub TEXT,
    google_email TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES users(id),
    to_id TEXT NOT NULL REFERENCES users(id),
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

  CREATE TABLE IF NOT EXISTS rate_limit_attempts (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    window_start INTEGER NOT NULL
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

function hasLegacyGlobalUserNameConstraint() {
  const usersTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!usersTable || typeof usersTable.sql !== 'string') {
    return false;
  }

  return /name\s+TEXT\s+NOT\s+NULL\s+UNIQUE\s+COLLATE\s+NOCASE/i.test(usersTable.sql);
}

function ensureUsersHouseholdScopedNameUniqueness() {
  if (!hasLegacyGlobalUserNameConstraint()) {
    return;
  }

  const migrateUsersTable = db.transaction(() => {
    db.exec(`
      CREATE TABLE users_next (
        id TEXT PRIMARY KEY,
        household_id TEXT REFERENCES households(id),
        name TEXT NOT NULL COLLATE NOCASE,
        pin_hash TEXT NOT NULL,
        pin_hash_needs_rehash INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL DEFAULT 'child',
        failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        google_sub TEXT,
        google_email TEXT,
        created_at TEXT NOT NULL
      );
    `);

    db.exec(`
      INSERT INTO users_next (
        id,
        household_id,
        name,
        pin_hash,
        pin_hash_needs_rehash,
        role,
        failed_login_attempts,
        locked_until,
        google_sub,
        google_email,
        created_at
      )
      SELECT
        id,
        household_id,
        name,
        pin_hash,
        pin_hash_needs_rehash,
        role,
        failed_login_attempts,
        locked_until,
        google_sub,
        google_email,
        created_at
      FROM users;
    `);

    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_next RENAME TO users');
  });

  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  if (foreignKeysEnabled) {
    db.pragma('foreign_keys = OFF');
  }

  try {
    migrateUsersTable();
  } finally {
    if (foreignKeysEnabled) {
      db.pragma('foreign_keys = ON');
    }
  }
}

function ensureMoneyTablesUseCentsOnly() {
  const requestsHasAmount = hasColumn('requests', 'amount');
  const paymentsHasAmount = hasColumn('payments', 'amount');

  if (!requestsHasAmount && !paymentsHasAmount) {
    return;
  }

  const migrateMoneyTables = db.transaction(() => {
    if (requestsHasAmount) {
      db.exec(`
        CREATE TABLE requests_next (
          id TEXT PRIMARY KEY,
          from_id TEXT NOT NULL REFERENCES users(id),
          to_id TEXT NOT NULL REFERENCES users(id),
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
      `);

      db.exec(`
        INSERT INTO requests_next (
          id,
          from_id,
          to_id,
          amount_cents,
          reason,
          category,
          tags_json,
          recurring_id,
          settled_cents,
          requires_approval,
          approved_by,
          approved_at,
          status,
          created_at,
          resolved_at
        )
        SELECT
          id,
          from_id,
          to_id,
          amount_cents,
          reason,
          category,
          tags_json,
          recurring_id,
          settled_cents,
          requires_approval,
          approved_by,
          approved_at,
          status,
          created_at,
          resolved_at
        FROM requests;
      `);

      db.exec('DROP TABLE requests');
      db.exec('ALTER TABLE requests_next RENAME TO requests');
    }

    if (paymentsHasAmount) {
      db.exec(`
        CREATE TABLE payments_next (
          id TEXT PRIMARY KEY,
          from_id TEXT NOT NULL REFERENCES users(id),
          to_id TEXT NOT NULL REFERENCES users(id),
          amount_cents INTEGER NOT NULL,
          request_id TEXT REFERENCES requests(id),
          message TEXT,
          category TEXT,
          tags_json TEXT,
          status TEXT NOT NULL DEFAULT 'sent',
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );
      `);

      db.exec(`
        INSERT INTO payments_next (
          id,
          from_id,
          to_id,
          amount_cents,
          request_id,
          message,
          category,
          tags_json,
          status,
          created_at,
          resolved_at
        )
        SELECT
          id,
          from_id,
          to_id,
          amount_cents,
          request_id,
          message,
          category,
          tags_json,
          status,
          created_at,
          resolved_at
        FROM payments;
      `);

      db.exec('DROP TABLE payments');
      db.exec('ALTER TABLE payments_next RENAME TO payments');
    }
  });

  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  if (foreignKeysEnabled) {
    db.pragma('foreign_keys = OFF');
  }

  try {
    migrateMoneyTables();
  } finally {
    if (foreignKeysEnabled) {
      db.pragma('foreign_keys = ON');
    }
  }
}

function ensureHouseholdLoginCredentials() {
  const households = db.prepare('SELECT id, login_id, login_code_hash FROM households ORDER BY created_at ASC').all();
  if (households.length === 0) {
    return;
  }

  const findByNormalizedLoginId = db.prepare('SELECT id FROM households WHERE UPPER(login_id) = ? LIMIT 1');
  const updateHouseholdLoginAuth = db.prepare('UPDATE households SET login_id = ?, login_code_hash = ? WHERE id = ?');

  for (const household of households) {
    const normalizedLoginId = normalizeHouseholdLoginId(household.login_id);
    let nextLoginId = normalizedLoginId;
    let nextLoginCodeHash = household.login_code_hash;
    let shouldUpdate = false;

    if (nextLoginId) {
      const conflicting = findByNormalizedLoginId.get(nextLoginId);
      if (conflicting && conflicting.id !== household.id) {
        nextLoginId = '';
        shouldUpdate = true;
      }
    }

    if (!nextLoginId) {
      nextLoginId = generateUniqueHouseholdLoginId((candidate) => {
        const existing = findByNormalizedLoginId.get(candidate);
        return Boolean(existing && existing.id !== household.id);
      });
      shouldUpdate = true;
    }

    if (!nextLoginCodeHash || String(nextLoginCodeHash).trim() === '') {
      nextLoginCodeHash = hashPin(generateHouseholdCode());
      shouldUpdate = true;
    }

    if (shouldUpdate || nextLoginId !== household.login_id) {
      updateHouseholdLoginAuth.run(nextLoginId, nextLoginCodeHash, household.id);
    }
  }
}

function ensureBaseMigrations() {
  ensureColumn('households', 'login_id TEXT');
  ensureColumn('households', 'login_code_hash TEXT');

  ensureColumn('users', 'household_id TEXT');
  ensureColumn('users', "role TEXT NOT NULL DEFAULT 'child'");
  ensureColumn('users', 'failed_login_attempts INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'locked_until TEXT');
  ensureColumn('users', 'google_sub TEXT');
  ensureColumn('users', 'google_email TEXT');

  ensureUsersHouseholdScopedNameUniqueness();

  const hadPinRehashColumn = hasColumn('users', 'pin_hash_needs_rehash');
  ensureColumn('users', 'pin_hash_needs_rehash INTEGER NOT NULL DEFAULT 0');

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
    db.prepare('INSERT INTO households (id, name, login_id, login_code_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'default-household',
      'Default household',
      generateUniqueHouseholdLoginId(() => false),
      hashPin(generateHouseholdCode()),
      createdAt
    );
  }

  ensureHouseholdLoginCredentials();

  db.exec("UPDATE users SET household_id = 'default-household' WHERE household_id IS NULL OR TRIM(household_id) = ''");

  db.exec("UPDATE users SET role = 'child' WHERE role IS NULL OR TRIM(role) = ''");
  db.exec('UPDATE users SET failed_login_attempts = 0 WHERE failed_login_attempts IS NULL');
  db.exec('UPDATE users SET pin_hash_needs_rehash = 0 WHERE pin_hash_needs_rehash IS NULL');

  if (!hadPinRehashColumn) {
    db.exec('UPDATE users SET pin_hash_needs_rehash = 1');
  }

  if (hasColumn('requests', 'amount')) {
    db.exec('UPDATE requests SET amount_cents = CAST(ROUND(amount * 100) AS INTEGER) WHERE amount_cents IS NULL');
  }
  db.exec('UPDATE requests SET settled_cents = 0 WHERE settled_cents IS NULL');
  db.exec('UPDATE requests SET requires_approval = 0 WHERE requires_approval IS NULL');

  if (hasColumn('payments', 'amount')) {
    db.exec('UPDATE payments SET amount_cents = CAST(ROUND(amount * 100) AS INTEGER) WHERE amount_cents IS NULL');
  }

  ensureMoneyTablesUseCentsOnly();

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
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_household_name_unique ON users(household_id, name COLLATE NOCASE)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub_unique ON users(google_sub) WHERE google_sub IS NOT NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_users_google_email ON users(google_email)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_households_login_id ON households(login_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_household_invites_lookup ON household_invites(code, household_id, used_at, expires_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_rate_limit_window_start ON rate_limit_attempts(window_start)');

module.exports = db;
