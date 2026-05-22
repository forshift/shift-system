-- ============================================================
-- シフト決定システム Supabase スキーマ
-- 使い方:
--   1. Supabaseダッシュボード → SQL Editor → New query
--   2. このファイル全体を貼り付けて Run
-- ============================================================

-- 名前リスト (月をまたいで永続化)
CREATE TABLE IF NOT EXISTS names (
  id BIGSERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 月別設定
CREATE TABLE IF NOT EXISTS month_config (
  id BIGSERIAL PRIMARY KEY,
  year_month TEXT UNIQUE NOT NULL,    -- 例: '2026-06'
  total_people INTEGER NOT NULL DEFAULT 10,
  study_days JSONB NOT NULL DEFAULT '[]'::jsonb,         -- ["2026-06-18", ...]
  extra_holidays JSONB NOT NULL DEFAULT '[]'::jsonb,     -- 追加祝日
  removed_holidays JSONB NOT NULL DEFAULT '[]'::jsonb,   -- 除外したデフォルト祝日
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 回答 (人 × 月)
CREATE TABLE IF NOT EXISTS responses (
  id BIGSERIAL PRIMARY KEY,
  year_month TEXT NOT NULL,
  name TEXT NOT NULL,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- 形式: { "2026-06-01_pm": "circle"|"triangle"|"cross", ... }
  max_per_week TEXT DEFAULT 'none',     -- 'none' | '0'..'7'
  saturday_pref TEXT DEFAULT 'none',    -- 'none' | 'am' | 'pm'
  is_beginner BOOLEAN DEFAULT FALSE,    -- 初心者フラグ (土曜午前に○不可, 入った枠の定員+1)
  submitted BOOLEAN DEFAULT FALSE,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (year_month, name)
);

CREATE INDEX IF NOT EXISTS idx_responses_ym ON responses (year_month);
CREATE INDEX IF NOT EXISTS idx_responses_submitted ON responses (year_month, submitted);
ALTER TABLE responses ADD COLUMN IF NOT EXISTS is_beginner BOOLEAN DEFAULT FALSE;

-- 決定したシフト
CREATE TABLE IF NOT EXISTS decisions (
  id BIGSERIAL PRIMARY KEY,
  year_month TEXT UNIQUE NOT NULL,
  shift_data JSONB NOT NULL,
    -- 形式: { "2026-06-02_pm": ["田中","鈴木"], ... }
  shift_count JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- 形式: { "田中": 5, "鈴木": 4, ... }
  decided_at TIMESTAMPTZ DEFAULT NOW(),
  posted_at TIMESTAMPTZ,               -- LINEに投稿済みなら時刻が入る (冪等性のため)
  post_count INTEGER NOT NULL DEFAULT 0 -- 累計の投稿回数 (1=初投稿, 2以降=修正)
);
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS post_count INTEGER NOT NULL DEFAULT 0;

-- updated_at の自動更新トリガー
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_month_config_updated ON month_config;
CREATE TRIGGER trg_month_config_updated BEFORE UPDATE ON month_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_responses_updated ON responses;
CREATE TRIGGER trg_responses_updated BEFORE UPDATE ON responses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- RLS (Row Level Security) ポリシー
-- プロトタイプでは anon でフルアクセス可能にする
-- 本番では認証を入れて適切に絞る
-- ============================================================
ALTER TABLE names ENABLE ROW LEVEL SECURITY;
ALTER TABLE month_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon all" ON names;
CREATE POLICY "anon all" ON names FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon all" ON month_config;
CREATE POLICY "anon all" ON month_config FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon all" ON responses;
CREATE POLICY "anon all" ON responses FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon all" ON decisions;
CREATE POLICY "anon all" ON decisions FOR ALL TO anon USING (true) WITH CHECK (true);
