-- ─────────────────────────────────────────────────────────────────────────────
-- Egemeo Ardhi SACCO – Initial Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Global phone registry ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS member_phones (
  phone       VARCHAR(20) PRIMARY KEY,
  member_type VARCHAR(20) NOT NULL  -- 'shareholder' | 'client' | 'investor'
);

-- ─── Shareholders ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shareholders (
  id                  SERIAL PRIMARY KEY,
  member_number       INTEGER NOT NULL,
  name                VARCHAR(200) NOT NULL,
  phone               VARCHAR(20)  NOT NULL UNIQUE,
  email               VARCHAR(200),
  id_passport         VARCHAR(50),
  joined_date         DATE         NOT NULL DEFAULT CURRENT_DATE,
  status              VARCHAR(10)  NOT NULL DEFAULT 'Active',
  avatar_color        VARCHAR(10)  NOT NULL DEFAULT '#14b8a6',
  photo_url           VARCHAR(500),
  net_savings         NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_profits       NUMERIC(14,2) NOT NULL DEFAULT 0,
  contributions_count INTEGER       NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS shareholders_member_number_key ON shareholders (member_number);

-- ─── Clients ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS clients (
  id           SERIAL PRIMARY KEY,
  member_number INTEGER NOT NULL,
  name          VARCHAR(200) NOT NULL,
  phone         VARCHAR(20)  NOT NULL UNIQUE,
  email         VARCHAR(200),
  id_passport   VARCHAR(50),
  joined_date   DATE         NOT NULL DEFAULT CURRENT_DATE,
  status        VARCHAR(10)  NOT NULL DEFAULT 'Active',
  avatar_color  VARCHAR(10)  NOT NULL DEFAULT '#a855f7',
  photo_url     VARCHAR(500),
  loan_balance  NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS clients_member_number_key ON clients (member_number);

-- ─── Investors ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS investors (
  id                SERIAL PRIMARY KEY,
  member_number     INTEGER NOT NULL,
  name              VARCHAR(200) NOT NULL,
  phone             VARCHAR(20)  NOT NULL UNIQUE,
  email             VARCHAR(200),
  id_passport       VARCHAR(50),
  joined_date       DATE         NOT NULL DEFAULT CURRENT_DATE,
  status            VARCHAR(10)  NOT NULL DEFAULT 'Active',
  avatar_color      VARCHAR(10)  NOT NULL DEFAULT '#eab308',
  photo_url         VARCHAR(500),
  investment_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS investors_member_number_key ON investors (member_number);

-- ─── Auto-sync member_phones via triggers ─────────────────────────────────────

CREATE OR REPLACE FUNCTION sync_member_phone() RETURNS TRIGGER AS $$
DECLARE
  mtype TEXT;
BEGIN
  IF TG_TABLE_NAME = 'shareholders' THEN mtype := 'shareholder';
  ELSIF TG_TABLE_NAME = 'clients'   THEN mtype := 'client';
  ELSE                                    mtype := 'investor';
  END IF;

  IF TG_OP = 'DELETE' THEN
    DELETE FROM member_phones WHERE phone = OLD.phone;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.phone <> NEW.phone THEN
    DELETE FROM member_phones WHERE phone = OLD.phone;
  END IF;

  INSERT INTO member_phones (phone, member_type)
  VALUES (NEW.phone, mtype)
  ON CONFLICT (phone) DO UPDATE SET member_type = EXCLUDED.member_type;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Shareholders triggers
DROP TRIGGER IF EXISTS trg_shareholders_phone_ins ON shareholders;
CREATE TRIGGER trg_shareholders_phone_ins
  AFTER INSERT ON shareholders FOR EACH ROW EXECUTE PROCEDURE sync_member_phone();

DROP TRIGGER IF EXISTS trg_shareholders_phone_upd ON shareholders;
CREATE TRIGGER trg_shareholders_phone_upd
  AFTER UPDATE OF phone ON shareholders FOR EACH ROW EXECUTE PROCEDURE sync_member_phone();

DROP TRIGGER IF EXISTS trg_shareholders_phone_del ON shareholders;
CREATE TRIGGER trg_shareholders_phone_del
  AFTER DELETE ON shareholders FOR EACH ROW EXECUTE PROCEDURE sync_member_phone();

-- Clients triggers
DROP TRIGGER IF EXISTS trg_clients_phone_ins ON clients;
CREATE TRIGGER trg_clients_phone_ins
  AFTER INSERT ON clients FOR EACH ROW EXECUTE PROCEDURE sync_member_phone();

DROP TRIGGER IF EXISTS trg_clients_phone_upd ON clients;
CREATE TRIGGER trg_clients_phone_upd
  AFTER UPDATE OF phone ON clients FOR EACH ROW EXECUTE PROCEDURE sync_member_phone();

DROP TRIGGER IF EXISTS trg_clients_phone_del ON clients;
CREATE TRIGGER trg_clients_phone_del
  AFTER DELETE ON clients FOR EACH ROW EXECUTE PROCEDURE sync_member_phone();

-- Investors triggers
DROP TRIGGER IF EXISTS trg_investors_phone_ins ON investors;
CREATE TRIGGER trg_investors_phone_ins
  AFTER INSERT ON investors FOR EACH ROW EXECUTE PROCEDURE sync_member_phone();

DROP TRIGGER IF EXISTS trg_investors_phone_upd ON investors;
CREATE TRIGGER trg_investors_phone_upd
  AFTER UPDATE OF phone ON investors FOR EACH ROW EXECUTE PROCEDURE sync_member_phone();

DROP TRIGGER IF EXISTS trg_investors_phone_del ON investors;
CREATE TRIGGER trg_investors_phone_del
  AFTER DELETE ON investors FOR EACH ROW EXECUTE PROCEDURE sync_member_phone();

-- ─── Auto-update updated_at ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_shareholders_updated ON shareholders;
CREATE TRIGGER trg_shareholders_updated
  BEFORE UPDATE ON shareholders FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS trg_clients_updated ON clients;
CREATE TRIGGER trg_clients_updated
  BEFORE UPDATE ON clients FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS trg_investors_updated ON investors;
CREATE TRIGGER trg_investors_updated
  BEFORE UPDATE ON investors FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
