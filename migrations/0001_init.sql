-- SF-Panel CF v2 schema

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL DEFAULT '',
  totp_secret TEXT DEFAULT '',
  totp_enabled INTEGER DEFAULT 0,
  last_login INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  api_url TEXT NOT NULL DEFAULT '',
  api_token TEXT NOT NULL DEFAULT '',
  public_host TEXT NOT NULL,
  port INTEGER DEFAULT 443,
  transport TEXT DEFAULT 'ws',
  path_prefix TEXT DEFAULT '/sf-vpn',
  sni TEXT DEFAULT '',
  host_header TEXT DEFAULT '',
  security TEXT DEFAULT 'tls',
  fingerprint TEXT DEFAULT 'chrome',
  alpn TEXT DEFAULT 'http/1.1',
  allow_insecure INTEGER DEFAULT 0,
  enable INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0,
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 30,
  limit_gb INTEGER NOT NULL DEFAULT 50,
  price INTEGER NOT NULL DEFAULT 0,
  node_id INTEGER,
  is_active INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0,
  description TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  tg_id INTEGER PRIMARY KEY,
  username TEXT DEFAULT '',
  balance INTEGER DEFAULT 0,
  ref_code TEXT NOT NULL UNIQUE,
  ref_by INTEGER,
  ref_earnings INTEGER DEFAULT 0,
  buys_count INTEGER DEFAULT 0,
  trial_last INTEGER DEFAULT 0,
  is_blocked INTEGER DEFAULT 0,
  note TEXT DEFAULT '',
  joined_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan_id INTEGER,
  node_id INTEGER,
  email TEXT NOT NULL,
  uuid TEXT NOT NULL,
  sub_id TEXT NOT NULL UNIQUE,
  remote_id TEXT DEFAULT '',
  limit_bytes INTEGER DEFAULT 0,
  up_bytes INTEGER DEFAULT 0,
  down_bytes INTEGER DEFAULT 0,
  expiry INTEGER DEFAULT 0,
  enable INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  note TEXT DEFAULT '',
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  file_id TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  admin_note TEXT DEFAULT '',
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  percent INTEGER DEFAULT 0,
  amount_off INTEGER DEFAULT 0,
  max_uses INTEGER DEFAULT 0,
  used INTEGER DEFAULT 0,
  expires_at INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS coupon_uses (
  coupon_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (coupon_id, user_id)
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  subject TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_msgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT DEFAULT 'info',
  msg TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_sub ON accounts(sub_id);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status);
CREATE INDEX IF NOT EXISTS idx_users_ref ON users(ref_code);
CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
