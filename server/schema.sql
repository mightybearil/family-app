-- =========================================================
-- Family Tasks App - SQLite Database Schema
-- סכמת מסד נתונים SQLite - אפליקציית משימות משפחתיות
-- =========================================================

-- Members table / טבלת חברי המשפחה
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT DEFAULT '👤',
  phone TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tasks table / טבלת משימות
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT NOT NULL CHECK(category IN ('house','shopping','general','projects','events')),
  assignee TEXT,
  priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','overdue')),
  progress INTEGER DEFAULT 0 CHECK(progress >= 0 AND progress <= 100),
  due_date DATE,
  -- Events need a clock time and a place; a plain task usually has neither.
  due_time TEXT,
  location TEXT,
  quantity INTEGER DEFAULT 1,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (assignee) REFERENCES members(id),
  FOREIGN KEY (created_by) REFERENCES members(id)
);

-- Comments table / טבלת תגובות
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (author) REFERENCES members(id)
);

-- Photos table / טבלת תמונות
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  uploaded_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Links table / טבלת קישורים
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT DEFAULT '',
  added_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Activity log table / יומן פעילויות
CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  source TEXT NOT NULL CHECK(source IN ('user','nanobot')),
  actor TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

-- Indexes for performance / אינדקסים לשיפור ביצועים
CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
CREATE INDEX IF NOT EXISTS idx_photos_task ON photos(task_id);
CREATE INDEX IF NOT EXISTS idx_links_task ON links(task_id);
CREATE INDEX IF NOT EXISTS idx_activity_task ON activity_log(task_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);

-- Task assignees / משויכים למשימה
-- A join table rather than a wider tasks row: a chore can belong to one of them
-- or to both, and `tasks.assignee` can only hold a single member id.
-- `tasks.assignee` is kept in sync with the first assignee so older readers and
-- the existing foreign key still work.
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  PRIMARY KEY (task_id, member_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id)
);

CREATE INDEX IF NOT EXISTS idx_task_assignees_member ON task_assignees(member_id);

-- Backfill from the single-assignee column for tasks created before this table.
INSERT OR IGNORE INTO task_assignees (task_id, member_id)
  SELECT id, assignee FROM tasks WHERE assignee IS NOT NULL AND assignee <> '';

-- Insert default members / הוספת חברי ברירת מחדל
INSERT OR IGNORE INTO members (id, name, avatar) VALUES ('member1', 'אמיר', '👨');
INSERT OR IGNORE INTO members (id, name, avatar) VALUES ('member2', 'יעל', '👩');
-- The agent authors comments and activity of its own, and both columns are
-- foreign keys into this table, so it needs a row like any other actor.
INSERT OR IGNORE INTO members (id, name, avatar) VALUES ('nanobot', 'ננובוט', '🤖');
