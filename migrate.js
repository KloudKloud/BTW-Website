require('dotenv').config();
const { Pool } = require('pg');
const Database = require('better-sqlite3');
const path = require('path');

const pool = new Pool({
  host: 'localhost', database: 'btw', user: 'btw_user',
  password: process.env.DB_PASSWORD, port: 5432,
});

async function migrate() {
  const db = new Database(path.join(__dirname, 'btw.db'));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT,
      email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, verified BOOLEAN DEFAULT false,
      verify_token TEXT, avatar TEXT, pending_email TEXT, email_change_token TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS likes (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL, item_id INTEGER NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, item_type, item_id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY, art_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      body TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS inbox_messages (
      id SERIAL PRIMARY KEY, from_user_id INTEGER, to_user_id INTEGER,
      body TEXT NOT NULL, attachment_url TEXT, attachment_name TEXT,
      is_admin BOOLEAN DEFAULT false, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS community_posts (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, body TEXT NOT NULL,
      tag TEXT DEFAULT 'General', attachment_url TEXT, attachment_name TEXT,
      pinned BOOLEAN DEFAULT false, nsfw BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS community_likes (
      id SERIAL PRIMARY KEY, post_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      UNIQUE(post_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS community_comments (
      id SERIAL PRIMARY KEY, post_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      body TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Schema created');

  const users = db.prepare('SELECT * FROM users').all();
  for (const u of users) {
    await pool.query(
      'INSERT INTO users (id, username, display_name, email, password_hash, verified, verify_token, avatar, pending_email, email_change_token, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING',
      [u.id, u.username, u.display_name, u.email, u.password_hash, !!u.verified, u.verify_token, u.avatar, u.pending_email, u.email_change_token, u.created_at]
    );
  }
  await pool.query("SELECT setval('users_id_seq', (SELECT MAX(id) FROM users))");
  console.log('Users migrated:', users.length);

  const likes = db.prepare('SELECT * FROM likes').all();
  for (const l of likes) {
    await pool.query(
      'INSERT INTO likes (id, user_id, item_type, item_id, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [l.id, l.user_id, l.item_type, l.item_id, l.created_at]
    );
  }
  if (likes.length) await pool.query("SELECT setval('likes_id_seq', (SELECT MAX(id) FROM likes))");
  console.log('Likes migrated:', likes.length);

  await pool.query("CREATE INDEX IF NOT EXISTS community_posts_search_idx ON community_posts USING GIN(to_tsvector('english', body))").catch(() => {});

  console.log('Migration complete!');
  await pool.end();
  db.close();
}

migrate().catch(e => { console.error(e); process.exit(1); });
