-- ─────────────────────────────────────────────────────────────────────────────
-- Egemeo Ardhi SACCO – Seed Data (2 per member type)
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Shareholders ─────────────────────────────────────────────────────────────

INSERT INTO shareholders (name, phone, email, id_passport, joined_date, status, avatar_color)
VALUES
  ('Bancy Wambui',   '0723396650', 'bancy.wambui@gmail.com',  '29341122', '2013-03-04', 'Active', '#14b8a6'),
  ('Martin Muriuki', '0727853964', 'martin.muriuki@gmail.com','30127854', '2013-05-12', 'Active', '#6366f1')
ON CONFLICT (phone) DO NOTHING;

-- ─── Clients ──────────────────────────────────────────────────────────────────

INSERT INTO clients (name, phone, email, id_passport, joined_date, status, avatar_color)
VALUES
  ('Lucy Njoroge',  '0726790209', 'lucy.njoroge@gmail.com', '27891034', '2014-08-15', 'Active', '#a855f7'),
  ('James Muchira', '0722700777', 'james.muchira@gmail.com', '31445678', '2015-02-10', 'Active', '#ec4899')
ON CONFLICT (phone) DO NOTHING;

-- ─── Investors ────────────────────────────────────────────────────────────────

INSERT INTO investors (name, phone, email, id_passport, joined_date, status, avatar_color)
VALUES
  ('Samuel Kingori', '0722964939', 'samuel.kingori@gmail.com', '31009822', '2015-06-03', 'Active', '#eab308'),
  ('Grace Wanjiku',  '0711234567', 'grace.wanjiku@gmail.com',  '33112045', '2017-04-22', 'Active', '#f97316')
ON CONFLICT (phone) DO NOTHING;
