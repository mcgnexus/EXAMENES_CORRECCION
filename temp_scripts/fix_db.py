import io

p = 'server/db.ts'
s = io.open(p, encoding='utf-8').read()
old = """{id:'003_omr_answers',sql:`CREATE TABLE IF NOT EXISTS submission_omr_answers (
    submission_id BIGINT PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
    answers JSONB NOT NULL,
    config JSONB NOT NULL,
    confirmed_at TEXT NOT NULL
  );`},"""
new = old + """
  {id:'004_omr_overrides',sql:`ALTER TABLE submission_omr_answers ADD COLUMN IF NOT EXISTS overrides JSONB NOT NULL DEFAULT '{}'::jsonb;`},"""
assert old in s, 'old missing'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
