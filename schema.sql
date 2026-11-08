-- بيتنشأ تلقائياً من الـ Worker عند أول طلب. الملف ده للتشغيل اليدوي فقط:
-- npx wrangler d1 execute adwmx --remote --file=./schema.sql
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users ( id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, token TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'user', points INTEGER NOT NULL DEFAULT 0, banned INTEGER NOT NULL DEFAULT 0, vip INTEGER NOT NULL DEFAULT 0, vip_plan TEXT NOT NULL DEFAULT '', prime_until INTEGER NOT NULL DEFAULT 0, prime_used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages ( id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, sender_id INTEGER NOT NULL, recipient_id INTEGER NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(sender_id) REFERENCES users(id), FOREIGN KEY(recipient_id) REFERENCES users(id));
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id,delivered,id);
CREATE TABLE IF NOT EXISTS groups_chat (group_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS group_members ( group_id TEXT NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member', joined_at INTEGER NOT NULL, PRIMARY KEY(group_id,user_id), FOREIGN KEY(group_id) REFERENCES groups_chat(group_id), FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS group_messages ( id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL, sender_id INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(group_id) REFERENCES groups_chat(group_id), FOREIGN KEY(sender_id) REFERENCES users(id));
CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id,id);
CREATE TABLE IF NOT EXISTS admin_sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, reporter_id INTEGER NOT NULL, target_phone TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_phone,status);
CREATE TABLE IF NOT EXISTS prime_requests ( id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, phone TEXT NOT NULL, name TEXT NOT NULL, plan TEXT NOT NULL, price INTEGER NOT NULL, first INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS withdrawals (id TEXT PRIMARY KEY, phone TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS avatars (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, v INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media ( id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, to_id INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, dur INTEGER NOT NULL DEFAULT 0, store TEXT NOT NULL DEFAULT 'd1', chunks INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at);
CREATE TABLE IF NOT EXISTS media_chunks (media_id TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(media_id,n));
-- (عمود bio بيتضاف تلقائياً من الـ Worker للقواعد القديمة)
