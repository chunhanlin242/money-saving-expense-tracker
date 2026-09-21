-- travel-money：旅行記帳
--
-- 設計重點
-- 1. 所有可同步的表都有 id(客戶端 UUID) / updated_at / deleted_at / server_seq
-- 2. 刻意「不」加外鍵：同步時子資料（例如 splits）可能比父資料（entries）先到，
--    有外鍵會直接被擋下來。完整性由應用層負責。
-- 3. server_seq 是伺服器發的單調遞增號碼，客戶端靠它問「上次之後有什麼新東西」，
--    避免依賴會有時差的裝置時鐘。

-- 同步用的全域序號
CREATE TABLE IF NOT EXISTS sync_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  seq          INTEGER NOT NULL DEFAULT 0,
  last_fx_sync TEXT
);
INSERT OR IGNORE INTO sync_state (id, seq) VALUES (1, 0);

-- 旅程
CREATE TABLE IF NOT EXISTS trips (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  local_currency TEXT NOT NULL DEFAULT 'GBP',
  start_date     TEXT,
  end_date       TEXT,
  daily_budget   REAL,
  archived       INTEGER NOT NULL DEFAULT 0,
  sort           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  server_seq     INTEGER NOT NULL DEFAULT 0
);

-- 旅伴（純名單，對方不需要帳號）
CREATE TABLE IF NOT EXISTS people (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  server_seq INTEGER NOT NULL DEFAULT 0
);

-- 付款方式：現金錢包或信用卡
CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'card',   -- 'cash' | 'card'
  currency       TEXT NOT NULL DEFAULT 'TWD',    -- 現金錢包用；卡片為結帳幣別
  monthly_limit  REAL,                           -- 每月上限，每月 1 號歸零
  limit_currency TEXT NOT NULL DEFAULT 'TWD',
  color          TEXT,
  sort           INTEGER NOT NULL DEFAULT 0,
  archived       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  server_seq     INTEGER NOT NULL DEFAULT 0
);

-- 分類
CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT NOT NULL DEFAULT '•',
  kind       TEXT NOT NULL DEFAULT 'expense',   -- 'expense' | 'income'
  sort       INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  server_seq INTEGER NOT NULL DEFAULT 0
);

-- 主帳目
CREATE TABLE IF NOT EXISTS entries (
  id                TEXT PRIMARY KEY,
  trip_id           TEXT,
  type              TEXT NOT NULL DEFAULT 'expense',  -- 'expense' | 'income' | 'exchange'
  amount            REAL NOT NULL,                    -- 原幣金額
  currency          TEXT NOT NULL,
  rate_to_twd       REAL NOT NULL,                    -- 記帳當下凍結
  amount_twd        REAL NOT NULL,                    -- amount * rate_to_twd，凍結
  reference_amount  REAL,                             -- 本來可能要花的錢（原價／沒選的替代方案）；省下 = 這個 − amount
  saving_note       TEXT,                             -- 怎麼省的（會員價／早鳥票／走路不搭車）；跟描述買了什麼的 note 分開
  category_id       TEXT,
  account_id        TEXT,
  country           TEXT,                             -- ISO 3166-1 alpha-2
  spent_at          TEXT NOT NULL,                    -- 完整 ISO 時間
  spent_date        TEXT NOT NULL,                    -- 當地 YYYY-MM-DD，跨時區分組用
  note              TEXT,
  is_prepaid        INTEGER NOT NULL DEFAULT 0,       -- 行前在台灣就付掉的
  tax_refund        INTEGER NOT NULL DEFAULT 0,       -- 可退稅
  tax_refund_status TEXT,                             -- 'marked' | 'claimed'
  paid_by           TEXT NOT NULL DEFAULT 'me',       -- 'me' | people.id
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,
  server_seq        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_entries_seq  ON entries(server_seq);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(spent_date);
CREATE INDEX IF NOT EXISTS idx_entries_trip ON entries(trip_id);

-- 換現／換匯（搭配 type='exchange' 的 entry）
CREATE TABLE IF NOT EXISTS exchanges (
  id            TEXT PRIMARY KEY,
  entry_id      TEXT NOT NULL,
  from_currency TEXT NOT NULL,
  from_amount   REAL NOT NULL,
  to_currency   TEXT NOT NULL,
  to_amount     REAL NOT NULL,
  to_account_id TEXT,
  fee_twd       REAL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  server_seq    INTEGER NOT NULL DEFAULT 0
);

-- 分帳：一筆 entry 拆給哪些人各分攤多少
CREATE TABLE IF NOT EXISTS splits (
  id           TEXT PRIMARY KEY,
  entry_id     TEXT NOT NULL,
  person_id    TEXT NOT NULL,
  share_amount REAL NOT NULL,      -- 原幣
  share_twd    REAL NOT NULL,      -- 用該筆凍結匯率換算
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  server_seq   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_splits_entry  ON splits(entry_id);
CREATE INDEX IF NOT EXISTS idx_splits_person ON splits(person_id);

-- 結清紀錄
CREATE TABLE IF NOT EXISTS settlements (
  id         TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL,
  amount_twd REAL NOT NULL,
  direction  TEXT NOT NULL,        -- 'they_paid_me' | 'i_paid_them'
  settled_at TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  server_seq INTEGER NOT NULL DEFAULT 0
);

-- 匯率快取：一律以 TWD 為基準幣，其他幣別互換由此推導
CREATE TABLE IF NOT EXISTS fx_rates (
  date        TEXT NOT NULL,       -- YYYY-MM-DD
  currency    TEXT NOT NULL,
  rate_to_twd REAL NOT NULL,       -- 1 單位該幣 = ? TWD
  source      TEXT,
  PRIMARY KEY (date, currency)
);

CREATE INDEX IF NOT EXISTS idx_fx_date ON fx_rates(date);
