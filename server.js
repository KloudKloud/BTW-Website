require('dotenv').config();
const express  = require('express');
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { Resend } = require('resend');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const https    = require('https');

// ── Avatar upload ─────────────────────────────────────────────────────────────
const AVATARS_DIR = '/var/www/btw/images/avatars';

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATARS_DIR),
  filename:    (req, file, cb) => {
    const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' })[file.mimetype] || '.jpg';
    cb(null, `${req.user.id}${ext}`);
  },
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype));
  },
});

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  host:     'localhost',
  database: 'btw',
  user:     'btw_user',
  password: process.env.DB_PASSWORD,
  port:     5432,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                SERIAL      PRIMARY KEY,
      username          TEXT        UNIQUE NOT NULL,
      display_name      TEXT,
      email             TEXT        UNIQUE NOT NULL,
      password_hash     TEXT        NOT NULL,
      verified          BOOLEAN     DEFAULT false,
      verify_token      TEXT,
      avatar            TEXT,
      pending_email     TEXT,
      email_change_token TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS likes (
      id         SERIAL      PRIMARY KEY,
      user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_type  TEXT        NOT NULL,
      item_id    INTEGER     NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, item_type, item_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id         SERIAL      PRIMARY KEY,
      art_id     INTEGER     NOT NULL,
      user_id    INTEGER     NOT NULL,
      body       TEXT        NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inbox_messages (
      id              SERIAL      PRIMARY KEY,
      from_user_id    INTEGER,
      to_user_id      INTEGER,
      body            TEXT        NOT NULL,
      attachment_url  TEXT,
      attachment_name TEXT,
      is_admin        BOOLEAN     DEFAULT false,
      read_at         TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS community_posts (
      id              SERIAL      PRIMARY KEY,
      user_id         INTEGER     NOT NULL,
      body            TEXT        NOT NULL,
      tag             TEXT        DEFAULT 'General',
      attachment_url  TEXT,
      attachment_name TEXT,
      pinned          BOOLEAN     DEFAULT false,
      nsfw            BOOLEAN     DEFAULT false,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS community_likes (
      id      SERIAL  PRIMARY KEY,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      UNIQUE(post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS community_comments (
      id         SERIAL      PRIMARY KEY,
      post_id    INTEGER     NOT NULL,
      user_id    INTEGER     NOT NULL,
      body       TEXT        NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS community_posts_search_idx
    ON community_posts USING GIN(to_tsvector('english', body))
  `).catch(() => {});

  await pool.query(`
    ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS attachments TEXT;
    ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS gif_url TEXT;
  `).catch(() => {});

  await pool.query(`
    ALTER TABLE community_comments ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES community_comments(id) ON DELETE CASCADE;
  `).catch(() => {});

  await pool.query(`UPDATE community_posts SET tag = 'Art/Fanart' WHERE tag = 'Fanart'`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS page_views (
      id         SERIAL      PRIMARY KEY,
      path       TEXT        NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS donations (
      id         SERIAL      PRIMARY KEY,
      donor_name TEXT        NOT NULL DEFAULT 'Anonymous',
      amount     NUMERIC(10,2) NOT NULL,
      currency   TEXT        NOT NULL DEFAULT 'USD',
      source     TEXT        NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(() => {});

  // Add email_hash column if missing
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_hash TEXT`).catch(() => {});
  // Account-level fanpage profile fields — deliberately separate from a
  // story's own "Meet <author>" text (moderator_sites.bio). This is the
  // person's own /fanpages/:username About box.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pronouns TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS favorite_pokemon TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_bio TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS fun_fact TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_links JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_banner_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_banner_position_x INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_banner_position_y INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_position_x INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_position_y INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_theme TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_theme_bg_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_theme TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_theme_bg_url TEXT NOT NULL DEFAULT '';
  `).catch(e => console.error('account profile fields migration:', e.message));
  // Add newsletter opt-in column if missing (default true for existing users)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_newsletter BOOLEAN DEFAULT true`).catch(() => {});
  // Inbox threading columns
  await pool.query(`ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS thread_id INTEGER`).catch(e => console.error('migration thread_id:', e.message));
  await pool.query(`ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS subject TEXT DEFAULT 'No Subject'`).catch(e => console.error('migration subject:', e.message));
  // Backfill thread_id for existing messages (each becomes its own root)
  await pool.query(`UPDATE inbox_messages SET thread_id = id WHERE thread_id IS NULL`).catch(e => console.error('migration backfill:', e.message));
  // Multi-attachment support
  await pool.query(`ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'`).catch(e => console.error('migration inbox attachments:', e.message));
  // Per-user soft-delete (trash)
  await pool.query(`ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS user_deleted_at TIMESTAMPTZ`).catch(e => console.error('migration user_deleted_at:', e.message));
  // Password reset table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id         SERIAL      PRIMARY KEY,
      user_id    INTEGER     NOT NULL,
      token      TEXT        NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});

  // ── Moderator creator panel ──────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moderator_sites (
      id           SERIAL      PRIMARY KEY,
      slug         TEXT        UNIQUE NOT NULL,
      owner_user_id INTEGER    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      site_title   TEXT        NOT NULL DEFAULT 'Above All Else',
      synopsis     TEXT        NOT NULL DEFAULT '',
      bio          TEXT        NOT NULL DEFAULT '',
      links        JSONB       NOT NULL DEFAULT '[]',
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS moderator_chapters (
      id         SERIAL      PRIMARY KEY,
      site_id    INTEGER     NOT NULL REFERENCES moderator_sites(id) ON DELETE CASCADE,
      title      TEXT        NOT NULL,
      url        TEXT        NOT NULL DEFAULT '',
      sort_order INTEGER     NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS moderator_characters (
      id         SERIAL      PRIMARY KEY,
      site_id    INTEGER     NOT NULL REFERENCES moderator_sites(id) ON DELETE CASCADE,
      name        TEXT        NOT NULL,
      ref_image   TEXT        NOT NULL DEFAULT '',
      description TEXT        NOT NULL DEFAULT '',
      stats      JSONB       NOT NULL DEFAULT '{}',
      facts      JSONB       NOT NULL DEFAULT '[]',
      lore       JSONB       NOT NULL DEFAULT '[]',
      sort_order INTEGER     NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS moderator_gallery (
      id         SERIAL      PRIMARY KEY,
      site_id    INTEGER     NOT NULL REFERENCES moderator_sites(id) ON DELETE CASCADE,
      category   TEXT        NOT NULL CHECK (category IN ('sfw','sketches','spicy')),
      image_url  TEXT        NOT NULL,
      title      TEXT        NOT NULL DEFAULT '',
      sort_order INTEGER     NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(e => console.error('moderator tables migration:', e.message));

  // Banner image + positioning + theme for the moderator's cover
  await pool.query(`
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS banner_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS banner_position INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS theme_bg_url TEXT NOT NULL DEFAULT '';
  `).catch(e => console.error('moderator_sites banner/theme migration:', e.message));

  // Book cover — sits beside the story description, like BTW's own synopsis-cover
  await pool.query(`
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS cover_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS cover_position_x INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS cover_position_y INTEGER NOT NULL DEFAULT 50;
  `).catch(e => console.error('moderator_sites cover migration:', e.message));

  // Quick-nav card art — the Characters/Chapters/Gallery shortcut cards on the
  // story home page. Blank until the author uploads their own, same as banner/cover.
  await pool.query(`
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS characters_card_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS chapters_card_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS gallery_card_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS characters_card_position_x INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS characters_card_position_y INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS chapters_card_position_x INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS chapters_card_position_y INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS gallery_card_position_x INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS gallery_card_position_y INTEGER NOT NULL DEFAULT 50;
  `).catch(e => console.error('moderator_sites nav-card migration:', e.message));

  // Reference-image crop position for character cards
  await pool.query(`
    ALTER TABLE moderator_characters ADD COLUMN IF NOT EXISTS ref_position_x INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE moderator_characters ADD COLUMN IF NOT EXISTS ref_position_y INTEGER NOT NULL DEFAULT 50;
  `).catch(e => console.error('moderator_characters ref-position migration:', e.message));

  // e621/Wattpad-style discovery tags — up to 100 per story, feed the search bar.
  await pool.query(`
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]';
  `).catch(e => console.error('moderator_sites tags migration:', e.message));

  // Structured relationships — replaces the old free-text stats.Relationships
  // string. Each entry is { name, type, character_id }, where character_id
  // (nullable) lets one character's relationship list link straight to
  // another character in the same story for fast-travel on click.
  await pool.query(`
    ALTER TABLE moderator_characters ADD COLUMN IF NOT EXISTS relationships JSONB NOT NULL DEFAULT '[]';
  `).catch(e => console.error('moderator_characters relationships migration:', e.message));

  // Bookmarks — lets any logged-in user save a fanpage to their hub profile
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moderator_bookmarks (
      id         SERIAL      PRIMARY KEY,
      user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      site_id    INTEGER     NOT NULL REFERENCES moderator_sites(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, site_id)
    );
  `).catch(e => console.error('moderator_bookmarks migration:', e.message));

  // Likes on gallery posts — mirrors moderator_bookmarks, feeds the Library's "Galleries" tab.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moderator_gallery_likes (
      id         SERIAL      PRIMARY KEY,
      user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gallery_id INTEGER     NOT NULL REFERENCES moderator_gallery(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, gallery_id)
    );
  `).catch(e => console.error('moderator_gallery_likes migration:', e.message));

  // Fanpages hub billboard — admin-managed promo carousel on /fanpages.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hub_billboard_slides (
      id         SERIAL      PRIMARY KEY,
      image_url  TEXT        NOT NULL,
      position_x INTEGER     NOT NULL DEFAULT 50,
      position_y INTEGER     NOT NULL DEFAULT 50,
      zoom       INTEGER     NOT NULL DEFAULT 100,
      caption    TEXT        NOT NULL DEFAULT '',
      credit     TEXT        NOT NULL DEFAULT '',
      link       TEXT        NOT NULL DEFAULT '',
      sort_order INTEGER     NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(e => console.error('hub_billboard_slides migration:', e.message));

  // Slow pan/zoom animation while a slide is active — position_x/y/zoom is the
  // start frame, end_* is where it eases to over the slide's full time on screen.
  await pool.query(`
    ALTER TABLE hub_billboard_slides ADD COLUMN IF NOT EXISTS animation_type TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE hub_billboard_slides ADD COLUMN IF NOT EXISTS end_position_x INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE hub_billboard_slides ADD COLUMN IF NOT EXISTS end_position_y INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE hub_billboard_slides ADD COLUMN IF NOT EXISTS end_zoom INTEGER NOT NULL DEFAULT 100;
  `).catch(e => console.error('hub_billboard_slides animation migration:', e.message));

  // Notifications — the bell icon on Fanpages. Covers system messages (the
  // welcome note) today; bookmark/follow/like/comment/social activity gets
  // wired up to insert rows here as those features land.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id            SERIAL      PRIMARY KEY,
      user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_user_id INTEGER     REFERENCES users(id) ON DELETE SET NULL,
      type          TEXT        NOT NULL DEFAULT 'system',
      message       TEXT        NOT NULL,
      link          TEXT,
      is_read       BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
  `).catch(e => console.error('notifications migration:', e.message));

  // Notifications page banner — single-row admin-adjustable crop, mirrors the
  // billboard's position_x/y + zoom fields but with no animation.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notif_page_banner (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      image_url  TEXT    NOT NULL DEFAULT '/images/gallery/autumnleave_11.png',
      position_x INTEGER NOT NULL DEFAULT 50,
      position_y INTEGER NOT NULL DEFAULT 40,
      zoom       INTEGER NOT NULL DEFAULT 100,
      CONSTRAINT notif_page_banner_singleton CHECK (id = 1)
    );
    INSERT INTO notif_page_banner (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `).catch(e => console.error('notif_page_banner migration:', e.message));

  // Backfill the default welcome notification for every user who doesn't
  // have one yet (covers both existing accounts on first deploy and any
  // account created before this migration ran on a given restart).
  await pool.query(`
    INSERT INTO notifications (user_id, actor_user_id, type, message)
    SELECT u.id, (SELECT id FROM users WHERE email_hash = $1), 'welcome',
           'Welcome to Between Two Worlds! Where adventure awaits~'
    FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.type = 'welcome')
  `, [process.env.ADMIN_EMAIL_HASH]).catch(e => console.error('notifications welcome backfill:', e.message));

  // story_path is the actual URL under /fanpages/ (e.g. "blue/above-all-else") —
  // separate from slug (the moderator's own identity) since one person can
  // eventually have more than one story nested under their own folder.
  await pool.query(`ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS story_path TEXT`)
    .catch(e => console.error('moderator_sites story_path migration:', e.message));
  await pool.query(`UPDATE moderator_sites SET story_path = slug WHERE story_path IS NULL`)
    .catch(e => console.error('moderator_sites story_path backfill:', e.message));
  await pool.query(`UPDATE moderator_sites SET story_path = 'blue/above-all-else' WHERE slug = 'blue' AND story_path = 'blue'`)
    .catch(e => console.error('moderator_sites blue story_path fix:', e.message));

  // "One story per account" is over — slug (the owner's identity) can no
  // longer be the unique key since multiple stories share it; story_path
  // (the actual per-story URL) becomes the real unique identifier instead.
  await pool.query(`ALTER TABLE moderator_sites DROP CONSTRAINT IF EXISTS moderator_sites_slug_key`)
    .catch(e => console.error('moderator_sites slug-unique drop migration:', e.message));
  await pool.query(`ALTER TABLE moderator_sites ADD CONSTRAINT moderator_sites_story_path_key UNIQUE (story_path)`)
    .catch(e => { if (!['42710', '42P07'].includes(e.code)) console.error('moderator_sites story_path-unique add migration:', e.message); });

  // Following — generic user-to-user, powers each author's /fanpages/:username profile
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_follows (
      id          SERIAL      PRIMARY KEY,
      follower_id INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followed_id INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(follower_id, followed_id)
    );
  `).catch(e => console.error('user_follows migration:', e.message));

  // Fanpages DM system — a genuine user-to-user chat (separate from the
  // admin-only /inbox note system). Starting a chat with someone requires
  // already following them, and creates a 'pending' thread; the recipient
  // has to accept before it counts as a real conversation.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_threads (
      id          SERIAL      PRIMARY KEY,
      user_a_id   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b_id   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status      TEXT        NOT NULL DEFAULT 'pending',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ,
      CHECK (user_a_id <> user_b_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_threads_pair
      ON dm_threads (LEAST(user_a_id, user_b_id), GREATEST(user_a_id, user_b_id));

    CREATE TABLE IF NOT EXISTS dm_messages (
      id         SERIAL      PRIMARY KEY,
      thread_id  INTEGER     NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
      sender_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body       TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_dm_messages_thread ON dm_messages(thread_id, created_at);
  `).catch(e => console.error('dm_threads/dm_messages migration:', e.message));

  // High Priority broadcasts — every newsletter also lands as a dismissible
  // chat from the "BTW Team" system account instead of just an email.
  await pool.query(`
    ALTER TABLE dm_threads ADD COLUMN IF NOT EXISTS is_priority BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE dm_threads ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;
  `).catch(e => console.error('dm_threads priority migration:', e.message));

  await pool.query(`
    ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]';
  `).catch(e => console.error('dm_messages attachments migration:', e.message));

  await (async () => {
    const { rows: [existing] } = await pool.query("SELECT id FROM users WHERE username = 'btwteam'");
    if (existing) return;
    const teamPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    await pool.query(
      `INSERT INTO users (username, display_name, email, email_hash, password_hash, verified, avatar)
       VALUES ('btwteam', 'BTW Team', $1, $2, $3, true, '/images/gallery/pixiegarden_5.png')`,
      [encryptEmail('btwteam@system.internal'), hashEmail('btwteam@system.internal'), teamPasswordHash]
    );
  })().catch(e => console.error('btwteam system user create:', e.message));

  // Featured Characters / Featured Gallery on a user's /fanpages/:username profile.
  // Deliberately denormalized (cached title/image/link) rather than a strict
  // foreign key, because a featured item can point at ANY story's character
  // or gallery entry — including BTW's own hardcoded cast, which isn't a DB
  // row at all. The future editor is what resolves a chosen item into these
  // cached fields at selection time.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_featured_items (
      id         SERIAL      PRIMARY KEY,
      user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT        NOT NULL CHECK (kind IN ('character','gallery')),
      source     TEXT        NOT NULL CHECK (source IN ('btw','fanpage')),
      site_slug  TEXT,
      ref_id     TEXT        NOT NULL,
      title      TEXT        NOT NULL DEFAULT '',
      image_url  TEXT        NOT NULL DEFAULT '',
      link_url   TEXT        NOT NULL DEFAULT '',
      sort_order INTEGER     NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(e => console.error('user_featured_items migration:', e.message));

  // Widen the gallery category constraint to include "sketches" (added after the original CHECK)
  await pool.query(`
    ALTER TABLE moderator_gallery DROP CONSTRAINT IF EXISTS moderator_gallery_category_check;
    ALTER TABLE moderator_gallery ADD CONSTRAINT moderator_gallery_category_check CHECK (category IN ('sfw','sketches','spicy'));
  `).catch(e => console.error('moderator_gallery category migration:', e.message));

  await pool.query(`
    ALTER TABLE moderator_gallery ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
  `).catch(e => console.error('moderator_gallery description migration:', e.message));

  // Gallery tile crop position — same H/V reposition pattern used for
  // banners/covers/character refs/avatars, so the small grid preview can be
  // cropped independently of the full-size image shown on the detail page.
  await pool.query(`
    ALTER TABLE moderator_gallery ADD COLUMN IF NOT EXISTS position_x INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE moderator_gallery ADD COLUMN IF NOT EXISTS position_y INTEGER NOT NULL DEFAULT 50;
  `).catch(e => console.error('moderator_gallery position migration:', e.message));

  // Characters and gallery posts become independent of any single story:
  // ownership moves to the creating user (site_id becomes optional/legacy),
  // and a junction table tracks which stories a character/gallery post is
  // linked into — many-to-many, so e.g. one recurring character can be
  // linked into ten different one-shots at once.
  await pool.query(`
    ALTER TABLE moderator_characters ALTER COLUMN site_id DROP NOT NULL;
    ALTER TABLE moderator_gallery ALTER COLUMN site_id DROP NOT NULL;
    ALTER TABLE moderator_characters ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE moderator_gallery ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

    UPDATE moderator_characters mc SET owner_user_id = ms.owner_user_id
      FROM moderator_sites ms WHERE ms.id = mc.site_id AND mc.owner_user_id IS NULL;
    UPDATE moderator_gallery mg SET owner_user_id = ms.owner_user_id
      FROM moderator_sites ms WHERE ms.id = mg.site_id AND mg.owner_user_id IS NULL;

    CREATE TABLE IF NOT EXISTS character_story_links (
      id           SERIAL      PRIMARY KEY,
      character_id INTEGER     NOT NULL REFERENCES moderator_characters(id) ON DELETE CASCADE,
      site_id      INTEGER     NOT NULL REFERENCES moderator_sites(id) ON DELETE CASCADE,
      sort_order   INTEGER     NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(character_id, site_id)
    );
    CREATE TABLE IF NOT EXISTS gallery_story_links (
      id         SERIAL      PRIMARY KEY,
      gallery_id INTEGER     NOT NULL REFERENCES moderator_gallery(id) ON DELETE CASCADE,
      site_id    INTEGER     NOT NULL REFERENCES moderator_sites(id) ON DELETE CASCADE,
      sort_order INTEGER     NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(gallery_id, site_id)
    );

    INSERT INTO character_story_links (character_id, site_id, sort_order)
      SELECT id, site_id, sort_order FROM moderator_characters WHERE site_id IS NOT NULL
      ON CONFLICT (character_id, site_id) DO NOTHING;
    INSERT INTO gallery_story_links (gallery_id, site_id, sort_order)
      SELECT id, site_id, sort_order FROM moderator_gallery WHERE site_id IS NOT NULL
      ON CONFLICT (gallery_id, site_id) DO NOTHING;

    -- site_id is now fully superseded by the link tables above (and new rows
    -- never set it going forward) — null it out so the column's original
    -- "ON DELETE CASCADE REFERENCES moderator_sites" FK can never again
    -- delete a character/gallery post just because ONE of its linked
    -- stories was deleted.
    UPDATE moderator_characters SET site_id = NULL WHERE site_id IS NOT NULL;
    UPDATE moderator_gallery SET site_id = NULL WHERE site_id IS NOT NULL;
  `).catch(e => console.error('character/gallery story-links migration:', e.message));

  // Chapter authoring: teaser blurb, multiple "where to read" links, an optional
  // per-chapter cover image (falls back to the story cover when unset), and an
  // optional PDF/Docx attachment readers can view in-page or download.
  await pool.query(`
    ALTER TABLE moderator_chapters ADD COLUMN IF NOT EXISTS teaser TEXT NOT NULL DEFAULT '';
    ALTER TABLE moderator_chapters ADD COLUMN IF NOT EXISTS links JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE moderator_chapters ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE moderator_chapters ADD COLUMN IF NOT EXISTS file_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE moderator_chapters ADD COLUMN IF NOT EXISTS file_name TEXT NOT NULL DEFAULT '';
  `).catch(e => console.error('moderator_chapters authoring migration:', e.message));

  // Seed Blue's site row if it doesn't exist yet, once his account is registered.
  // slug is no longer unique (authors can have multiple stories), so this is
  // guarded with an explicit existence check instead of ON CONFLICT.
  await pool.query(`
    INSERT INTO moderator_sites (slug, owner_user_id)
    SELECT 'blue', u.id FROM users u
    WHERE u.email_hash = $1 AND NOT EXISTS (SELECT 1 FROM moderator_sites WHERE slug = 'blue')
  `, [hashEmail('xrcblue@gmail.com')]).catch(e => console.error('moderator site seed:', e.message));

  // Migrate plaintext emails → encrypted + hash
  const { rows: unmigratedUsers } = await pool.query('SELECT id, email FROM users WHERE email_hash IS NULL');
  for (const u of unmigratedUsers) {
    try {
      await pool.query('UPDATE users SET email = $1, email_hash = $2 WHERE id = $3',
        [encryptEmail(u.email), hashEmail(u.email), u.id]);
    } catch (e) { console.error('Email migration failed for user', u.id, e.message); }
  }
}

// ── Email encryption helpers ──────────────────────────────────────────────────
function getEmailKey() {
  return Buffer.from(process.env.EMAIL_ENCRYPTION_KEY, 'hex');
}
function encryptEmail(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEmailKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${enc.toString('hex')}:${cipher.getAuthTag().toString('hex')}`;
}
function decryptEmail(ct) {
  if (!ct || !ct.includes(':')) return ct; // already plaintext (migration window)
  const [ivH, dataH, tagH] = ct.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEmailKey(), Buffer.from(ivH, 'hex'));
  decipher.setAuthTag(Buffer.from(tagH, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataH, 'hex')), decipher.final()]).toString('utf8');
}
function hashEmail(email) {
  return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

// ── Email ─────────────────────────────────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);

// ── Helpers ───────────────────────────────────────────────────────────────────
const signToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '30d' });

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ error: 'Not authenticated.' });
  try {
    req.user = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

async function checkAdmin(req) {
  const { rows: [user] } = await pool.query('SELECT email_hash FROM users WHERE id = $1', [req.user.id]);
  if (!user) return false;
  return user.email_hash === process.env.ADMIN_EMAIL_HASH;
}

async function requireAdmin(req, res, next) {
  if (!await checkAdmin(req)) return res.status(403).json({ error: 'Forbidden.' });
  next();
}

// ── Moderators ────────────────────────────────────────────────────────────────
// "Moderator" just means "owns at least one story" — anyone who creates a
// story via Create Story becomes one. No hardcoded allowlist: Blue owns a
// moderator_sites row the same way any other user would after creating
// their own story, so his page never needs special-cased code going forward.
async function checkModerator(req) {
  const { rows } = await pool.query('SELECT 1 FROM moderator_sites WHERE owner_user_id = $1 LIMIT 1', [req.user.id]);
  return rows.length > 0;
}

// ── Email templates ───────────────────────────────────────────────────────────
const emailShell = (body) => `
  <div style="background:#eef2f7;padding:40px 16px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:520px;margin:0 auto;">
      <div style="background:#1a237e;border-radius:10px 10px 0 0;padding:28px 32px;text-align:center;">
        <h1 style="color:#ffffff;font-family:Georgia,serif;font-size:1.6rem;margin:0 0 4px;letter-spacing:0.02em;">Between Two Worlds</h1>
        <p style="color:rgba(255,255,255,0.55);font-size:0.75rem;margin:0;letter-spacing:0.12em;text-transform:uppercase;">A Pokémon Fan Fiction</p>
      </div>
      <div style="background:#ffffff;padding:36px 32px;border-left:1px solid #dde3f0;border-right:1px solid #dde3f0;">
        ${body}
      </div>
      <div style="background:#e8eaf6;border-radius:0 0 10px 10px;padding:16px 32px;text-align:center;border:1px solid #dde3f0;border-top:none;">
        <p style="color:#9fa8da;font-size:0.75rem;margin:0;">Between Two Worlds &mdash; a Pokémon fan fiction. Not affiliated with Nintendo or Game Freak.</p>
      </div>
    </div>
  </div>
`;

const emailActivate = (name, verifyUrl) => emailShell(`
  <h2 style="color:#1a237e;font-size:1.2rem;margin:0 0 12px;">Hello, <span style="color:#e65100;">${name}</span>!</h2>
  <p style="color:#424242;font-size:0.95rem;line-height:1.7;margin:0 0 10px;">
    Thanks for creating an account. You're one step away — click the button below to activate your account.
  </p>
  <p style="color:#757575;font-size:0.85rem;line-height:1.6;margin:0 0 28px;">
    Once activated you'll have full access to the site, including member-only content.
  </p>
  <div style="text-align:center;margin-bottom:28px;">
    <a href="${verifyUrl}"
       style="display:inline-block;background:#00796b;color:#ffffff;text-decoration:none;padding:13px 36px;border-radius:6px;font-weight:bold;font-size:1rem;letter-spacing:0.02em;">
      Activate your Account
    </a>
  </div>
  <p style="color:#bdbdbd;font-size:0.78rem;text-align:center;margin:0;">
    If you didn't sign up for Between Two Worlds, you can safely ignore this email.
  </p>
`);

const emailConfirmEmailChange = (name, confirmUrl) => emailShell(`
  <h2 style="color:#1a237e;font-size:1.2rem;margin:0 0 12px;">Hi, <span style="color:#e65100;">${name}</span>!</h2>
  <p style="color:#424242;font-size:0.95rem;line-height:1.7;margin:0 0 10px;">
    You requested to change your email address on Between Two Worlds. Click the button below to confirm your new email.
  </p>
  <p style="color:#757575;font-size:0.85rem;line-height:1.6;margin:0 0 28px;">
    If you didn't request this, you can safely ignore this email — your address won't be changed.
  </p>
  <div style="text-align:center;margin-bottom:28px;">
    <a href="${confirmUrl}"
       style="display:inline-block;background:#00796b;color:#ffffff;text-decoration:none;padding:13px 36px;border-radius:6px;font-weight:bold;font-size:1rem;letter-spacing:0.02em;">
      Confirm New Email
    </a>
  </div>
  <p style="color:#bdbdbd;font-size:0.78rem;text-align:center;margin:0;">
    If you didn't request an email change, no action is needed.
  </p>
`);

const emailWelcome = (name, loginUrl) => emailShell(`
  <div style="text-align:center;margin-bottom:24px;">
    <div style="display:inline-block;background:#e8f5e9;border-radius:50%;width:60px;height:60px;line-height:60px;font-size:1.8rem;">✓</div>
  </div>
  <h2 style="color:#1a237e;font-size:1.25rem;text-align:center;margin:0 0 8px;">Thank you for signing up!</h2>
  <p style="color:#2e7d32;font-size:1rem;text-align:center;font-weight:bold;margin:0 0 20px;">Your account is now active.</p>
  <p style="color:#424242;font-size:0.95rem;line-height:1.7;text-align:center;margin:0 0 28px;">
    Welcome aboard, <strong style="color:#e65100;">${name}</strong>! Click the button below to head back and log in to your new account.
  </p>
  <div style="text-align:center;margin-bottom:28px;">
    <a href="${loginUrl}"
       style="display:inline-block;background:#1565c0;color:#ffffff;text-decoration:none;padding:13px 36px;border-radius:6px;font-weight:bold;font-size:1rem;letter-spacing:0.02em;">
      Login to the site
    </a>
  </div>
  <p style="color:#bdbdbd;font-size:0.78rem;text-align:center;margin:0;">
    This link will log you in automatically — no password needed.
  </p>
`);

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, display_name, email, password, from } = req.body;

    if (!username || !email || !password)
      return res.status(400).json({ error: 'Username, email and password are required.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!/^[a-zA-Z0-9_]+$/.test(username))
      return res.status(400).json({ error: 'Username may only contain letters, numbers and underscores.' });

    const { rows: [existing] } = await pool.query(
      'SELECT id FROM users WHERE email_hash = $1 OR username = $2',
      [hashEmail(email), username.toLowerCase()]
    );
    if (existing)
      return res.status(409).json({ error: 'That username or email is already registered.' });

    const password_hash = await bcrypt.hash(password, 12);
    const verify_token  = crypto.randomBytes(32).toString('hex');
    const dname         = (display_name?.trim() || username).slice(0, 20);

    const { rows: [newUser] } = await pool.query(
      'INSERT INTO users (username, display_name, email, email_hash, password_hash, verify_token) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [username.toLowerCase(), dname, encryptEmail(email.toLowerCase()), hashEmail(email), password_hash, verify_token]
    );

    await pool.query(
      `INSERT INTO notifications (user_id, actor_user_id, type, message)
       VALUES ($1, (SELECT id FROM users WHERE email_hash = $2), 'welcome',
               'Welcome to Between Two Worlds! Where adventure awaits~')`,
      [newUser.id, process.env.ADMIN_EMAIL_HASH]
    ).catch(e => console.error('welcome notification insert:', e.message));

    const verifyUrl = `https://${process.env.SITE_HOST}/api/auth/verify?token=${verify_token}`
      + (from ? `&from=${encodeURIComponent(from)}` : '');

    await resend.emails.send({
      from: 'Between Two Worlds <hello@btwfanfic.net>',
      reply_to: 'hello@btwfanfic.net',
      to: email,
      subject: 'Activate your Between Two Worlds account',
      html: emailActivate(dname, verifyUrl),
      text: `Hello, ${dname}!\n\nThanks for signing up for Between Two Worlds.\n\nClick the link below to activate your account:\n${verifyUrl}\n\nIf you didn't sign up, you can safely ignore this email.\n\n— Between Two Worlds`,
    });

    res.json({ message: 'Account created! Check your email to activate your account before logging in.' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/auth/verify?token=xxx — shows confirmation page (safe for email scanners)
app.get('/api/auth/verify', async (req, res) => {
  const { token, from } = req.query;
  if (!token) return res.redirect(`https://${process.env.SITE_HOST}/login`);

  // Check token exists but do NOT consume it — scanner-safe
  const { rows: [user] } = await pool.query('SELECT id FROM users WHERE verify_token = $1', [token]);
  if (!user) {
    return res.status(400).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Invalid Link — Between Two Worlds</title>
<style>body{font-family:Arial,sans-serif;background:#0d0d1a;color:#ccc;text-align:center;padding:60px 20px;}
h2{color:#e55;}a{color:#7ca0ff;}</style></head>
<body><h2>Invalid or expired link</h2>
<p>This activation link has already been used or is invalid.</p>
<a href="https://${process.env.SITE_HOST}/login">Back to login →</a></body></html>`);
  }

  // Show a button — only a POST actually activates (scanners don't submit forms)
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Activate Account — Between Two Worlds</title>
<style>
  body{font-family:Arial,sans-serif;background:#0d0d1a;color:#ccc;display:flex;align-items:center;
       justify-content:center;min-height:100vh;margin:0;}
  .box{background:#161625;border:1px solid rgba(255,255,255,0.08);border-radius:14px;
       padding:48px 40px;max-width:420px;text-align:center;}
  h2{color:#fff;margin:0 0 12px;}
  p{color:rgba(200,190,230,0.7);font-size:0.95rem;line-height:1.6;margin:0 0 28px;}
  button{background:#00796b;color:#fff;border:none;border-radius:8px;padding:14px 36px;
         font-size:1rem;font-weight:bold;cursor:pointer;transition:background .15s;}
  button:hover{background:#009688;}
  button:disabled{opacity:0.6;cursor:default;}
  .msg{margin-top:16px;font-size:0.9rem;min-height:1.2em;}
</style></head>
<body><div class="box">
  <h2>Almost there!</h2>
  <p>Click the button below to activate your Between Two Worlds account and start exploring.</p>
  <button id="btn" onclick="activate()">Activate My Account</button>
  <div class="msg" id="msg"></div>
</div>
<script>
async function activate() {
  const btn = document.getElementById('btn');
  const msg = document.getElementById('msg');
  btn.disabled = true; btn.textContent = 'Activating…';
  try {
    const r = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({token: ${JSON.stringify(token)}, from: ${JSON.stringify(from || '')}})
    });
    const d = await r.json();
    if (d.redirect) { window.location.href = d.redirect; }
    else { msg.style.color='#e55'; msg.textContent = d.error || 'Something went wrong.'; btn.disabled=false; btn.textContent='Try Again'; }
  } catch(e) { msg.style.color='#e55'; msg.textContent='Network error — please try again.'; btn.disabled=false; btn.textContent='Try Again'; }
}
</script></body></html>`);
});

// POST /api/auth/verify — actually activates the account
app.post('/api/auth/verify', async (req, res) => {
  const { token, from: fromPath } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token.' });

  const { rows: [user] } = await pool.query('SELECT * FROM users WHERE verify_token = $1', [token]);
  if (!user) return res.status(400).json({ error: 'This link has already been used or is invalid.' });

  await pool.query('UPDATE users SET verified = true, verify_token = NULL WHERE id = $1', [user.id]);

  const autoToken = signToken(user.id);
  const loginUrl  = `https://${process.env.SITE_HOST}/login?autotoken=${autoToken}`
    + (fromPath ? `&from=${encodeURIComponent(fromPath)}` : '');

  try {
    await resend.emails.send({
      from: 'Between Two Worlds <hello@btwfanfic.net>',
      reply_to: 'hello@btwfanfic.net',
      to: decryptEmail(user.email),
      subject: 'Welcome to Between Two Worlds!',
      html: emailWelcome(user.display_name || user.username, loginUrl),
      text: `Hi ${user.display_name || user.username},\n\nYour Between Two Worlds account is now active!\n\nClick the link below to log in automatically:\n${loginUrl}\n\nWelcome aboard!\n\n— Between Two Worlds`,
    });
  } catch (err) {
    console.error('Welcome email error:', err.message);
  }

  res.json({ redirect: loginUrl });
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password)
      return res.status(400).json({ error: 'Please fill in all fields.' });

    const { rows: [user] } = await pool.query(
      'SELECT * FROM users WHERE username = $1 OR email_hash = $2',
      [identifier.toLowerCase(), hashEmail(identifier)]
    );

    if (!user)
      return res.status(401).json({ error: 'Incorrect username/email or password.' });
    if (!user.verified)
      return res.status(403).json({ error: 'Please verify your email before logging in. Check your inbox.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Incorrect username/email or password.' });

    const token = signToken(user.id);
    res.json({
      token,
      user: { id: user.id, username: user.username, display_name: user.display_name, avatar: user.avatar || null },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { rows: [user] } = await pool.query(
    `SELECT id, username, display_name, avatar, avatar_position_x, avatar_position_y, email_hash,
            notif_theme, notif_theme_bg_url
     FROM users WHERE id = $1`, [req.user.id]
  );
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const is_admin = user.email_hash === process.env.ADMIN_EMAIL_HASH;
  const { rows: modRows } = await pool.query('SELECT 1 FROM moderator_sites WHERE owner_user_id = $1 LIMIT 1', [user.id]);
  const is_moderator = modRows.length > 0;
  res.json({ user: {
    id: user.id, username: user.username, display_name: user.display_name, avatar: user.avatar || null,
    avatar_position_x: user.avatar_position_x, avatar_position_y: user.avatar_position_y,
    is_admin, is_moderator,
    notif_theme: user.notif_theme || 'default', notif_theme_bg_url: user.notif_theme_bg_url || '',
  } });
});

// POST /api/auth/logout
app.post('/api/auth/logout', requireAuth, (req, res) => {
  res.json({ message: 'Logged out.' });
});

// ── Comments (art) ────────────────────────────────────────────────────────────

app.get('/api/comments', async (req, res) => {
  const art_id = parseInt(req.query.art_id, 10);
  if (!art_id) return res.json({ comments: [] });

  const { rows } = await pool.query(`
    SELECT c.id, c.body, c.created_at, c.user_id, u.display_name, u.username, u.avatar
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.art_id = $1
    ORDER BY c.created_at ASC
  `, [art_id]);

  res.json({ comments: rows });
});

app.post('/api/comments', requireAuth, async (req, res) => {
  try {
    const { art_id, body } = req.body;
    if (!art_id || !body?.trim())
      return res.status(400).json({ error: 'art_id and body are required.' });
    if (body.trim().length > 500)
      return res.status(400).json({ error: 'Comment must be 500 characters or fewer.' });

    const { rows: [row] } = await pool.query(
      'INSERT INTO comments (art_id, user_id, body) VALUES ($1, $2, $3) RETURNING id',
      [art_id, req.user.id, body.trim()]
    );

    const { rows: [user] } = await pool.query(
      'SELECT display_name, username, avatar FROM users WHERE id = $1', [req.user.id]
    );

    res.json({
      comment: {
        id:           row.id,
        body:         body.trim(),
        display_name: user.display_name,
        username:     user.username,
        avatar:       user.avatar,
        created_at:   new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('Comment error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.put('/api/comments/:id', requireAuth, async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Body is required.' });
  if (body.trim().length > 500) return res.status(400).json({ error: 'Max 500 characters.' });

  const { rows: [comment] } = await pool.query('SELECT * FROM comments WHERE id = $1', [req.params.id]);
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.user_id !== req.user.id) return res.status(403).json({ error: 'Not your comment.' });

  await pool.query('UPDATE comments SET body = $1 WHERE id = $2', [body.trim(), req.params.id]);
  res.json({ body: body.trim() });
});

app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  const { rows: [comment] } = await pool.query('SELECT * FROM comments WHERE id = $1', [req.params.id]);
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.user_id !== req.user.id && !await checkAdmin(req))
    return res.status(403).json({ error: 'Not your comment.' });

  await pool.query('DELETE FROM comments WHERE id = $1', [req.params.id]);
  res.json({ message: 'Deleted.' });
});

// ── Profile ───────────────────────────────────────────────────────────────────

app.put('/api/auth/profile', requireAuth, async (req, res) => {
  try {
    const { display_name, email, current_password, email_newsletter } = req.body;
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const updates = {};

    if (display_name !== undefined) {
      const dn = display_name.trim().slice(0, 20);
      if (!dn) return res.status(400).json({ error: 'Display name cannot be empty.' });
      updates.display_name = dn;
    }

    if (email_newsletter !== undefined) {
      updates.email_newsletter = !!email_newsletter;
    }

    if (email !== undefined && hashEmail(email) !== user.email_hash) {
      if (!current_password) return res.status(400).json({ error: 'Current password required to change email.' });
      const valid = await bcrypt.compare(current_password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Incorrect password.' });

      const { rows: [exists] } = await pool.query(
        'SELECT id FROM users WHERE email_hash = $1 AND id != $2', [hashEmail(email), user.id]
      );
      if (exists) return res.status(409).json({ error: 'That email is already in use.' });

      const changeToken = crypto.randomBytes(32).toString('hex');
      await pool.query(
        'UPDATE users SET pending_email = $1, email_change_token = $2 WHERE id = $3',
        [encryptEmail(email.toLowerCase()), changeToken, user.id]
      );

      const confirmUrl = `https://${process.env.SITE_HOST}/api/auth/confirm-email?token=${changeToken}`;
      try {
        await resend.emails.send({
          from:      'Between Two Worlds <hello@btwfanfic.net>',
          reply_to:  'hello@btwfanfic.net',
          to:        email,
          subject:   'Confirm your new email — Between Two Worlds',
          html:      emailConfirmEmailChange(user.display_name || user.username, confirmUrl),
          text:      `Hi ${user.display_name || user.username},\n\nClick below to confirm your new email address:\n${confirmUrl}\n\nIf you didn't request this, ignore this email.\n\n— Between Two Worlds`,
        });
      } catch (err) { console.error('Email change send error:', err.message); }

      if (updates.display_name) {
        await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', [updates.display_name, user.id]);
      }
      return res.json({ message: `Verification email sent to ${email}. Click the link to confirm your new address.`, emailPending: true });
    }

    if (Object.keys(updates).length === 0)
      return res.json({ message: 'No changes.' });

    const keys = Object.keys(updates);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    await pool.query(
      `UPDATE users SET ${setClauses} WHERE id = $${keys.length + 1}`,
      [...Object.values(updates), user.id]
    );

    const { rows: [updated] } = await pool.query(
      'SELECT id, username, display_name, email, avatar FROM users WHERE id = $1', [user.id]
    );
    res.json({ message: 'Profile updated.', user: updated });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.put('/api/auth/password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password)
      return res.status(400).json({ error: 'Both current and new password are required.' });
    if (new_password.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });

    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
    res.json({ message: 'Password changed.' });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ── Forgot password ───────────────────────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  const identifier = (req.body.identifier || '').trim().toLowerCase();
  if (!identifier) return res.status(400).json({ error: 'Please provide your username or email.' });

  const { rows: [user] } = await pool.query(
    'SELECT id, email, username, display_name FROM users WHERE username = $1 OR email_hash = $2',
    [identifier, hashEmail(identifier)]
  );

  // Always respond the same regardless of whether the account exists (prevents enumeration)
  if (!user) return res.json({ message: 'If that account exists, a reset link has been sent to the registered email.' });

  const token   = require('crypto').randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await pool.query(
    'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [user.id, token, expires]
  );

  const toEmail  = decryptEmail(user.email);
  const toName   = user.display_name || user.username;
  const resetUrl = `https://btwfanfic.net/login?reset=${token}`;
  resend.emails.send({
    from: 'Between Two Worlds <noreply@btwfanfic.net>',
    to: toEmail,
    subject: 'Reset your password — Between Two Worlds',
    html: emailShell(`
      <h2 style="color:#1a237e;font-size:1.1rem;margin:0 0 12px;">Password Reset Request</h2>
      <p style="color:#424242;font-size:0.9rem;margin:0 0 8px;">Hi <strong>${toName}</strong>!</p>
      <p style="color:#424242;font-size:0.9rem;margin:0 0 16px;">Someone requested a password reset for your account. Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
      <a href="${resetUrl}" style="display:inline-block;background:#7b5ea7;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-size:0.95rem;font-weight:600;">Reset My Password</a>
      <p style="color:#888;font-size:0.82rem;margin:18px 0 0;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
    `),
  }).catch(console.error);

  res.json({ message: 'If that account exists, a reset link has been sent to the registered email.' });
});

// ── Reset password (with token) ───────────────────────────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Missing required fields.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const { rows: [reset] } = await pool.query(
    'SELECT * FROM password_resets WHERE token = $1 AND expires_at > NOW() AND used_at IS NULL',
    [token]
  );
  if (!reset) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });

  const hash = await bcrypt.hash(password, 12);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, reset.user_id]);
  await pool.query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [reset.id]);

  res.json({ message: 'Password updated! You can now log in with your new password.' });
});

app.post('/api/auth/avatar', requireAuth, (req, res, next) => {
  uploadAvatar.single('avatar')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const exts = ['.jpg', '.png', '.webp', '.gif'];
    const newFile = req.file.filename;
    exts.forEach(ext => {
      const old = path.join(AVATARS_DIR, `${req.user.id}${ext}`);
      if (path.basename(old) !== newFile && fs.existsSync(old)) fs.unlinkSync(old);
    });

    const avatarUrl = `/images/avatars/${req.file.filename}`;
    // Position resets to center on every new upload, same as banner/cover/character-ref uploads.
    await pool.query(
      'UPDATE users SET avatar = $1, avatar_position_x = 50, avatar_position_y = 50 WHERE id = $2',
      [avatarUrl, req.user.id]
    );
    res.json({ avatar: avatarUrl, position_x: 50, position_y: 50 });
  });
});

app.put('/api/auth/avatar-position', requireAuth, async (req, res) => {
  const x = parseInt(req.body.position_x, 10);
  const y = parseInt(req.body.position_y, 10);
  if (![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 100)) return res.status(400).json({ error: 'Positions must be 0-100.' });
  await pool.query('UPDATE users SET avatar_position_x = $1, avatar_position_y = $2 WHERE id = $3', [x, y, req.user.id]);
  res.json({ position_x: x, position_y: y });
});

app.delete('/api/auth/account', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required.' });

    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password.' });

    if (user.avatar) {
      const filePath = path.join('/var/www/btw', user.avatar);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await pool.query('DELETE FROM comments WHERE user_id = $1', [user.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);

    res.json({ message: 'Account deleted.' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/api/auth/confirm-email', async (req, res) => {
  const { token } = req.query;
  const { rows: [user] } = await pool.query(
    'SELECT * FROM users WHERE email_change_token = $1', [token]
  );
  if (!user || !user.pending_email) {
    return res.status(400).send(`
      <html><body style="background:#f5f5f5;color:#1a1a2e;font-family:Arial;text-align:center;padding:60px 20px;">
        <h2 style="color:#c0392b;">Invalid or expired link</h2>
        <p>This email confirmation link has already been used or is invalid.</p>
        <a href="https://${process.env.SITE_HOST}/profile" style="color:#1565c0;">Back to profile</a>
      </body></html>
    `);
  }
  await pool.query(
    'UPDATE users SET email = $1, email_hash = $2, pending_email = NULL, email_change_token = NULL WHERE id = $3',
    [user.pending_email, hashEmail(decryptEmail(user.pending_email)), user.id]
  );
  res.redirect(`https://${process.env.SITE_HOST}/profile?email_verified=1`);
});

app.get('/api/auth/profile', requireAuth, async (req, res) => {
  const { rows: [user] } = await pool.query(
    'SELECT id, username, display_name, email, avatar, email_newsletter FROM users WHERE id = $1', [req.user.id]
  );
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: { ...user, email: decryptEmail(user.email) } });
});

// ── Protected spicy image delivery ────────────────────────────────────────────
app.get('/api/spicy-img/:filename', (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const filename = path.basename(req.params.filename);
  if (!/\.(png|jpg|jpeg|webp|gif)$/i.test(filename)) return res.status(400).end();
  res.setHeader('X-Accel-Redirect', `/protected-spicy/${filename}`);
  res.end();
});

// ── Likes (art/chapter) ───────────────────────────────────────────────────────

app.get('/api/likes/counts/:type', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT item_id, COUNT(*)::int as count FROM likes WHERE item_type = $1 GROUP BY item_id',
    [req.params.type]
  );
  const counts = {};
  rows.forEach(r => { counts[r.item_id] = r.count; });
  res.json({ counts });
});

app.get('/api/likes/mine/:type', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.json({ liked: [] });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await pool.query(
      'SELECT item_id FROM likes WHERE user_id = $1 AND item_type = $2',
      [payload.id, req.params.type]
    );
    res.json({ liked: rows.map(r => r.item_id) });
  } catch { res.json({ liked: [] }); }
});

app.post('/api/likes/toggle/:type/:id', requireAuth, async (req, res) => {
  const { type, id } = req.params;
  const itemId = parseInt(id, 10);
  if (!['art', 'chapter'].includes(type) || isNaN(itemId))
    return res.status(400).json({ error: 'Invalid type or id' });

  const { rows: [existing] } = await pool.query(
    'SELECT id FROM likes WHERE user_id = $1 AND item_type = $2 AND item_id = $3',
    [req.user.id, type, itemId]
  );

  if (existing) {
    await pool.query('DELETE FROM likes WHERE id = $1', [existing.id]);
  } else {
    await pool.query(
      'INSERT INTO likes (user_id, item_type, item_id) VALUES ($1, $2, $3)',
      [req.user.id, type, itemId]
    );
  }

  const { rows: [{ count }] } = await pool.query(
    'SELECT COUNT(*)::int as count FROM likes WHERE item_type = $1 AND item_id = $2',
    [type, itemId]
  );

  res.json({ liked: !existing, count });
});

// ── Inbox ─────────────────────────────────────────────────────────────────────

const INBOX_DIR = '/var/www/btw/images/inbox';
if (!fs.existsSync(INBOX_DIR)) fs.mkdirSync(INBOX_DIR, { recursive: true });

const inboxStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, INBOX_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, Date.now() + '_' + req.user.id + ext);
  },
});
const uploadInbox = multer({
  storage: inboxStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','image/gif','image/avif',
                'video/mp4','video/webm','application/pdf'].includes(file.mimetype);
    cb(null, ok);
  },
});

// ── Inbox: start a new thread ─────────────────────────────────────────────────
app.post('/api/inbox/send', requireAuth, uploadInbox.array('attachments', 4), async (req, res) => {
  const body    = (req.body.body    || '').trim();
  const subject = (req.body.subject || '').trim() || 'No Subject';
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (body.length > 20000) return res.status(400).json({ error: 'Message too long (max 20,000 chars).' });

  const files = req.files || [];
  const attachments = files.map(f => ({ url: '/images/inbox/' + f.filename, name: f.originalname }));
  // Legacy single-attachment fields (keep for backwards compat)
  const attachmentUrl  = attachments[0]?.url  || null;
  const attachmentName = attachments[0]?.name || null;

  const { rows: [row] } = await pool.query(
    'INSERT INTO inbox_messages (from_user_id, body, subject, attachment_url, attachment_name, attachments, is_admin) VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING *',
    [req.user.id, body, subject, attachmentUrl, attachmentName, JSON.stringify(attachments)]
  );
  // thread_id = own id (this message is the root of the thread)
  await pool.query('UPDATE inbox_messages SET thread_id = $1 WHERE id = $1', [row.id]);
  const fullRow = { ...row, thread_id: row.id };

  const { rows: [sender] } = await pool.query('SELECT username, display_name FROM users WHERE id = $1', [req.user.id]);
  const senderName = (sender && (sender.display_name || sender.username)) || 'Someone';
  const attachHtml = attachments.length
    ? attachments.map(a => `<p style="margin:8px 0 0;font-size:0.85rem;color:#555;">Attachment: <a href="https://btwfanfic.net${a.url}">${a.name}</a></p>`).join('')
    : '';
  resend.emails.send({
    from: 'BTW Inbox <noreply@btwfanfic.net>',
    to: process.env.ADMIN_EMAIL,
    subject: `[BTW Inbox] ${subject} — from ${senderName}`,
    html: emailShell(`
      <h2 style="color:#1a237e;font-size:1.1rem;margin:0 0 12px;">New Message</h2>
      <p style="color:#424242;font-size:0.9rem;margin:0 0 6px;"><strong>From:</strong> ${senderName}</p>
      <p style="color:#424242;font-size:0.9rem;margin:0 0 12px;"><strong>Subject:</strong> ${subject}</p>
      <div style="background:#f5f5f5;border-left:3px solid #c2547a;padding:12px 16px;border-radius:4px;margin:12px 0;">
        <p style="color:#212121;font-size:0.95rem;margin:0;white-space:pre-wrap;">${body}</p>
      </div>
      ${attachHtml}
    `),
  }).catch(console.error);

  res.json({ message: fullRow });
});

// ── Inbox: reply within a thread ──────────────────────────────────────────────
app.post('/api/inbox/thread/:id/reply', requireAuth, uploadInbox.array('attachments', 4), async (req, res) => {
  const threadId = parseInt(req.params.id);
  const body     = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Reply cannot be empty.' });
  if (body.length > 20000) return res.status(400).json({ error: 'Reply too long.' });

  const { rows: [root] } = await pool.query(
    'SELECT * FROM inbox_messages WHERE id = $1 AND thread_id = id', [threadId]
  );
  if (!root) return res.status(404).json({ error: 'Thread not found.' });

  const isAdmin = await checkAdmin(req);
  const files = req.files || [];
  const attachments = files.map(f => ({ url: '/images/inbox/' + f.filename, name: f.originalname }));
  const attachmentUrl  = attachments[0]?.url  || null;
  const attachmentName = attachments[0]?.name || null;

  if (isAdmin) {
    // Admin replying to user
    const { rows: [reply] } = await pool.query(
      'INSERT INTO inbox_messages (to_user_id, body, thread_id, is_admin, attachment_url, attachment_name, attachments) VALUES ($1, $2, $3, true, $4, $5, $6) RETURNING *',
      [root.from_user_id, body, threadId, attachmentUrl, attachmentName, JSON.stringify(attachments)]
    );
    // Notify the user by email
    const { rows: [toUser] } = await pool.query('SELECT email, username, display_name FROM users WHERE id = $1', [root.from_user_id]);
    if (toUser) {
      const toEmail = decryptEmail(toUser.email);
      const toName  = toUser.display_name || toUser.username;
      resend.emails.send({
        from: 'VeekitPaw <noreply@btwfanfic.net>',
        to: toEmail,
        subject: `Re: ${root.subject || 'Your message'} — Between Two Worlds`,
        html: emailShell(`
          <h2 style="color:#1a237e;font-size:1.1rem;margin:0 0 12px;">VeekitPaw replied to your message!</h2>
          <p style="color:#424242;font-size:0.9rem;margin:0 0 12px;">Hi ${toName}! You got a reply to your message "<strong>${root.subject || 'No Subject'}</strong>".</p>
          <div style="background:#f5f5f5;border-left:3px solid #7b5ea7;padding:12px 16px;border-radius:4px;margin:12px 0;">
            <p style="color:#212121;font-size:0.95rem;margin:0;white-space:pre-wrap;">${body}</p>
          </div>
          <p style="margin-top:16px;"><a href="https://btwfanfic.net/inbox" style="color:#c2547a;">View in your inbox →</a></p>
        `),
      }).catch(console.error);
    }
    res.json({ message: reply });
  } else {
    // Regular user replying within thread — verify they own this thread
    if (root.from_user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden.' });
    const { rows: [reply] } = await pool.query(
      'INSERT INTO inbox_messages (from_user_id, body, thread_id, is_admin, attachment_url, attachment_name, attachments) VALUES ($1, $2, $3, false, $4, $5, $6) RETURNING *',
      [req.user.id, body, threadId, attachmentUrl, attachmentName, JSON.stringify(attachments)]
    );
    // Notify admin of user reply
    const { rows: [sender] } = await pool.query('SELECT username, display_name FROM users WHERE id = $1', [req.user.id]);
    const senderName = (sender && (sender.display_name || sender.username)) || 'Someone';
    resend.emails.send({
      from: 'BTW Inbox <noreply@btwfanfic.net>',
      to: process.env.ADMIN_EMAIL,
      subject: `[BTW Reply] ${root.subject || 'No Subject'} — from ${senderName}`,
      html: emailShell(`
        <h2 style="color:#1a237e;font-size:1.1rem;margin:0 0 12px;">New Reply in Thread</h2>
        <p style="color:#424242;font-size:0.9rem;margin:0 0 6px;"><strong>From:</strong> ${senderName}</p>
        <p style="color:#424242;font-size:0.9rem;margin:0 0 12px;"><strong>Thread:</strong> ${root.subject || 'No Subject'}</p>
        <div style="background:#f5f5f5;border-left:3px solid #c2547a;padding:12px 16px;border-radius:4px;margin:12px 0;">
          <p style="color:#212121;font-size:0.95rem;margin:0;white-space:pre-wrap;">${body}</p>
        </div>
      `),
    }).catch(console.error);
    res.json({ message: reply });
  }
});

// ── Inbox: get messages in a thread (optionally up to a specific message) ─────
app.get('/api/inbox/thread/:id', requireAuth, async (req, res) => {
  const threadId = parseInt(req.params.id);
  const uptoId   = req.query.upto ? parseInt(req.query.upto) : null;
  const isAdmin  = await checkAdmin(req);

  let rows;
  if (uptoId) {
    const result = await pool.query(`
      SELECT m.*, u.username, u.display_name, u.avatar
      FROM inbox_messages m
      LEFT JOIN users u ON m.from_user_id = u.id
      WHERE (m.thread_id = $1 OR m.id = $1)
        AND m.created_at <= (SELECT created_at FROM inbox_messages WHERE id = $2)
      ORDER BY m.created_at ASC
    `, [threadId, uptoId]);
    rows = result.rows;
  } else {
    const result = await pool.query(`
      SELECT m.*, u.username, u.display_name, u.avatar
      FROM inbox_messages m
      LEFT JOIN users u ON m.from_user_id = u.id
      WHERE m.thread_id = $1 OR m.id = $1
      ORDER BY m.created_at ASC
    `, [threadId]);
    rows = result.rows;
  }

  if (!rows.length) return res.status(404).json({ error: 'Thread not found.' });

  // Security: non-admin can only view threads they own or were addressed to them
  if (!isAdmin) {
    const root = rows.find(r => r.id === threadId);
    if (!root) return res.status(403).json({ error: 'Forbidden.' });
    const isOwner = root.from_user_id === req.user.id ||
                    (root.is_admin && root.to_user_id === req.user.id);
    if (!isOwner) return res.status(403).json({ error: 'Forbidden.' });
  }

  // Mark messages as read when viewed
  if (!isAdmin) {
    if (uptoId) {
      await pool.query(
        `UPDATE inbox_messages SET read_at = NOW()
         WHERE (thread_id = $1 OR id = $1) AND is_admin = true AND to_user_id = $2 AND read_at IS NULL
           AND created_at <= (SELECT created_at FROM inbox_messages WHERE id = $3)`,
        [threadId, req.user.id, uptoId]
      );
    } else {
      await pool.query(
        `UPDATE inbox_messages SET read_at = NOW()
         WHERE (thread_id = $1 OR id = $1) AND is_admin = true AND to_user_id = $2 AND read_at IS NULL`,
        [threadId, req.user.id]
      );
    }
  } else {
    // Admin reading user messages
    await pool.query(
      `UPDATE inbox_messages SET read_at = NOW()
       WHERE (thread_id = $1 OR id = $1) AND is_admin = false AND from_user_id IS NOT NULL AND read_at IS NULL`,
      [threadId]
    );
  }

  res.json({ messages: rows });
});

// ── Inbox: received — one card per admin message (FA-style) ──────────────────
app.get('/api/inbox/received', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT m.id, m.thread_id, m.body, m.created_at, m.read_at,
           r.subject
    FROM inbox_messages m
    JOIN inbox_messages r ON r.id = m.thread_id
    WHERE m.is_admin = true
      AND m.to_user_id = $1
      AND m.user_deleted_at IS NULL
    ORDER BY m.created_at DESC
    LIMIT 100
  `, [req.user.id]);
  res.json({ messages: rows });
});

// ── Inbox: unread count for nav badge ────────────────────────────────────────
app.get('/api/inbox/unread-count', requireAuth, async (req, res) => {
  const isAdmin = await checkAdmin(req);
  let count = 0;
  if (isAdmin) {
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM inbox_messages
       WHERE is_admin = false AND from_user_id IS NOT NULL AND read_at IS NULL AND user_deleted_at IS NULL`
    );
    count = row.count || 0;
  } else {
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM inbox_messages
       WHERE is_admin = true AND to_user_id = $1 AND read_at IS NULL AND user_deleted_at IS NULL`,
      [req.user.id]
    );
    count = row.count || 0;
  }
  res.json({ count });
});

// ── Inbox: sent — one card per user message (FA-style) ───────────────────────
app.get('/api/inbox/sent', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT m.id, m.thread_id, m.body, m.created_at,
           r.subject
    FROM inbox_messages m
    JOIN inbox_messages r ON r.id = m.thread_id
    WHERE m.is_admin = false
      AND m.from_user_id = $1
      AND m.user_deleted_at IS NULL
    ORDER BY m.created_at DESC
    LIMIT 100
  `, [req.user.id]);
  res.json({ messages: rows });
});

// ── Inbox: trash — soft-delete messages ──────────────────────────────────────
app.post('/api/inbox/trash', requireAuth, async (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'No IDs provided.' });
  if (await checkAdmin(req)) {
    // Admin inbox shows user→admin messages (to_user_id IS NULL, is_admin=false)
    await pool.query(
      `UPDATE inbox_messages SET user_deleted_at = NOW()
       WHERE id = ANY($1) AND is_admin = false AND from_user_id IS NOT NULL`,
      [ids]
    );
  } else {
    await pool.query(
      `UPDATE inbox_messages SET user_deleted_at = NOW()
       WHERE id = ANY($1) AND (to_user_id = $2 OR from_user_id = $2)`,
      [ids, req.user.id]
    );
  }
  res.json({ ok: true });
});

// ── Inbox: trash — hard-delete (permanent) ───────────────────────────────────
app.post('/api/inbox/delete', requireAuth, async (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'No IDs provided.' });
  if (await checkAdmin(req)) {
    await pool.query(
      `DELETE FROM inbox_messages
       WHERE id = ANY($1) AND is_admin = false AND from_user_id IS NOT NULL AND user_deleted_at IS NOT NULL`,
      [ids]
    );
  } else {
    await pool.query(
      `DELETE FROM inbox_messages
       WHERE id = ANY($1) AND (to_user_id = $2 OR from_user_id = $2) AND user_deleted_at IS NOT NULL`,
      [ids, req.user.id]
    );
  }
  res.json({ ok: true });
});

// ── Inbox: trash — restore messages ──────────────────────────────────────────
app.post('/api/inbox/restore', requireAuth, async (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'No IDs provided.' });
  if (await checkAdmin(req)) {
    await pool.query(
      `UPDATE inbox_messages SET user_deleted_at = NULL
       WHERE id = ANY($1) AND is_admin = false AND from_user_id IS NOT NULL`,
      [ids]
    );
  } else {
    await pool.query(
      `UPDATE inbox_messages SET user_deleted_at = NULL
       WHERE id = ANY($1) AND (to_user_id = $2 OR from_user_id = $2)`,
      [ids, req.user.id]
    );
  }
  res.json({ ok: true });
});

// ── Inbox: trash — list deleted messages (lazy-expire after 30 days) ─────────
app.get('/api/inbox/trash', requireAuth, async (req, res) => {
  const isAdmin = await checkAdmin(req);
  if (isAdmin) {
    // Admin trash: user→admin messages (to_user_id IS NULL, is_admin=false)
    await pool.query(
      `DELETE FROM inbox_messages
       WHERE is_admin = false AND from_user_id IS NOT NULL
         AND user_deleted_at < NOW() - INTERVAL '30 days'`
    );
    const { rows } = await pool.query(`
      SELECT m.id, m.thread_id, m.body, m.created_at, m.user_deleted_at, m.is_admin,
             r.subject, u.username, u.display_name
      FROM inbox_messages m
      JOIN inbox_messages r ON r.id = m.thread_id
      LEFT JOIN users u ON m.from_user_id = u.id
      WHERE m.is_admin = false AND m.from_user_id IS NOT NULL
        AND m.user_deleted_at IS NOT NULL
        AND m.user_deleted_at > NOW() - INTERVAL '30 days'
      ORDER BY m.user_deleted_at DESC
      LIMIT 200
    `);
    res.json({ messages: rows });
  } else {
    await pool.query(
      `DELETE FROM inbox_messages
       WHERE (to_user_id = $1 OR from_user_id = $1)
         AND user_deleted_at < NOW() - INTERVAL '30 days'`,
      [req.user.id]
    );
    const { rows } = await pool.query(`
      SELECT m.id, m.thread_id, m.body, m.created_at, m.user_deleted_at, m.is_admin,
             r.subject
      FROM inbox_messages m
      JOIN inbox_messages r ON r.id = m.thread_id
      WHERE (m.to_user_id = $1 OR m.from_user_id = $1)
        AND m.user_deleted_at IS NOT NULL
        AND m.user_deleted_at > NOW() - INTERVAL '30 days'
      ORDER BY m.user_deleted_at DESC
      LIMIT 200
    `, [req.user.id]);
    res.json({ messages: rows });
  }
});

// ── Inbox: admin — all user messages (one card per message, FA-style) ────────
app.get('/api/inbox/admin/all', requireAuth, async (req, res) => {
  if (!await checkAdmin(req)) return res.status(403).json({ error: 'Forbidden.' });
  const { rows } = await pool.query(`
    SELECT m.id, m.thread_id, m.body, m.created_at, m.read_at,
           r.subject,
           u.username, u.display_name
    FROM inbox_messages m
    JOIN inbox_messages r ON r.id = m.thread_id
    LEFT JOIN users u ON m.from_user_id = u.id
    WHERE m.is_admin = false
      AND m.from_user_id IS NOT NULL
      AND m.user_deleted_at IS NULL
    ORDER BY m.created_at DESC
    LIMIT 500
  `);
  res.json({ messages: rows });
});

// ── Inbox: admin — unreplied threads (latest message is from user) ────────────
app.get('/api/inbox/admin/unreplied', requireAuth, async (req, res) => {
  if (!await checkAdmin(req)) return res.status(403).json({ error: 'Forbidden.' });
  try {
    const { rows } = await pool.query(`
      SELECT * FROM (
        SELECT DISTINCT ON (m.thread_id)
          m.thread_id,
          r.subject,
          r.from_user_id,
          u.username, u.display_name,
          m.body        AS preview,
          m.is_admin    AS latest_is_admin,
          m.created_at  AS latest_at
        FROM inbox_messages m
        JOIN inbox_messages r ON r.id = m.thread_id
        LEFT JOIN users u ON r.from_user_id = u.id
        WHERE r.from_user_id IS NOT NULL
        ORDER BY m.thread_id, m.created_at DESC
      ) sub
      WHERE latest_is_admin = false
      ORDER BY latest_at DESC
      LIMIT 200
    `);
    res.json({ threads: rows });
  } catch (e) {
    console.error('admin/unreplied error:', e);
    res.json({ threads: [] });
  }
});

// ── Inbox: admin — sent replies (one card per reply, FA-style) ────────────────
app.get('/api/inbox/admin/sent', requireAuth, async (req, res) => {
  if (!await checkAdmin(req)) return res.status(403).json({ error: 'Forbidden.' });
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.thread_id, m.body, m.created_at,
             r.subject, r.from_user_id,
             u.username, u.display_name
      FROM inbox_messages m
      JOIN inbox_messages r ON r.id = m.thread_id
      LEFT JOIN users u ON r.from_user_id = u.id
      WHERE m.is_admin = true
        AND m.id != m.thread_id
        AND m.user_deleted_at IS NULL
      ORDER BY m.created_at DESC
      LIMIT 200
    `);
    res.json({ messages: rows });
  } catch (e) {
    console.error('admin/sent error:', e);
    res.json({ messages: [] });
  }
});

// ── Community ─────────────────────────────────────────────────────────────────

const COMMUNITY_DIR = '/var/www/btw/images/community';
if (!fs.existsSync(COMMUNITY_DIR)) fs.mkdirSync(COMMUNITY_DIR, { recursive: true });

const communityImgStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, COMMUNITY_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, Date.now() + '_' + Math.random().toString(36).slice(2,8) + '_' + req.user.id + ext);
  },
});
const uploadCommunityImg = multer({
  storage: communityImgStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','image/gif','image/avif'].includes(file.mimetype);
    cb(null, ok);
  },
});

const COMMUNITY_TAGS = ['General', 'Art/Fanart', 'Theories & Predictions', 'Other'];

// GET /api/community/posts
app.get('/api/community/posts', async (req, res) => {
  let userId = null;
  try {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) userId = jwt.verify(h.slice(7), process.env.JWT_SECRET).id;
  } catch {}

  const { tag, before } = req.query;
  const where = [];
  const params = [];

  if (tag && COMMUNITY_TAGS.includes(tag)) {
    params.push('%,' + tag + ',%');
    where.push(`(',' || p.tag || ',') LIKE $${params.length}`);
  }
  if (before) {
    params.push(parseInt(before));
    where.push(`(p.pinned = false AND p.id < $${params.length})`);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const userLikedExpr = userId
    ? `(SELECT COUNT(*)::int FROM community_likes WHERE post_id = p.id AND user_id = ${userId})`
    : '0';

  const { rows } = await pool.query(`
    SELECT p.*, u.username, u.display_name, u.avatar,
      (SELECT COUNT(*)::int FROM community_likes WHERE post_id = p.id) AS like_count,
      (SELECT COUNT(*)::int FROM community_comments WHERE post_id = p.id) AS comment_count,
      ${userLikedExpr} AS user_liked
    FROM community_posts p
    LEFT JOIN users u ON p.user_id = u.id
    ${whereClause}
    ORDER BY p.pinned DESC, p.created_at DESC
    LIMIT 20
  `, params);

  res.json({ posts: rows });
});

// GET /api/community/search?q=...
app.get('/api/community/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ posts: [] });

  let userId = null;
  try {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) userId = jwt.verify(h.slice(7), process.env.JWT_SECRET).id;
  } catch {}

  const userLikedExpr = userId
    ? `(SELECT COUNT(*)::int FROM community_likes WHERE post_id = p.id AND user_id = ${userId})`
    : '0';

  const { rows } = await pool.query(`
    SELECT p.*, u.username, u.display_name, u.avatar,
      (SELECT COUNT(*)::int FROM community_likes WHERE post_id = p.id) AS like_count,
      (SELECT COUNT(*)::int FROM community_comments WHERE post_id = p.id) AS comment_count,
      ${userLikedExpr} AS user_liked,
      ts_rank(to_tsvector('english', p.body), plainto_tsquery('english', $1)) AS rank
    FROM community_posts p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE to_tsvector('english', p.body) @@ plainto_tsquery('english', $1)
    ORDER BY rank DESC, p.created_at DESC
    LIMIT 20
  `, [q]);

  res.json({ posts: rows });
});

function giphyFetch(url, res) {
  https.get(url, (r) => {
    let data = '';
    r.on('data', c => data += c);
    r.on('end', () => {
      try {
        const json = JSON.parse(data);
        const gifs = (json.data || []).map(g => ({
          id:      g.id,
          title:   g.title,
          preview: (g.images && g.images.fixed_width_small && g.images.fixed_width_small.url) || (g.images && g.images.preview_gif && g.images.preview_gif.url) || '',
          url:     (g.images && g.images.fixed_width && g.images.fixed_width.url)             || (g.images && g.images.original && g.images.original.url) || '',
        }));
        res.json({ gifs });
      } catch { res.json({ gifs: [] }); }
    });
  }).on('error', () => res.json({ gifs: [] }));
}

// GET /api/giphy/trending
app.get('/api/giphy/trending', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '24', 10), 48);
  if (!process.env.GIPHY_API_KEY) return res.json({ gifs: [] });
  giphyFetch(`https://api.giphy.com/v1/gifs/trending?api_key=${process.env.GIPHY_API_KEY}&limit=${limit}&rating=pg-13`, res);
});

// GET /api/giphy/search?q=...
app.get('/api/giphy/search', (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit || '24', 10), 48);
  if (!q || !process.env.GIPHY_API_KEY) return res.json({ gifs: [] });
  giphyFetch(`https://api.giphy.com/v1/gifs/search?api_key=${process.env.GIPHY_API_KEY}&q=${encodeURIComponent(q)}&limit=${limit}&rating=pg-13`, res);
});

// POST /api/community/posts
app.post('/api/community/posts', requireAuth, uploadCommunityImg.array('attachments', 4), async (req, res) => {
  const body = (req.body.body || '').trim();
  const rawTags = (req.body.tag || '').split(',').map(t => t.trim()).filter(t => COMMUNITY_TAGS.includes(t));
  const tag = rawTags.length ? rawTags.join(',') : 'General';
  const nsfw = req.body.nsfw === 'true' || req.body.nsfw === true;
  if (!body) return res.status(400).json({ error: 'Post cannot be empty.' });
  if (body.length > 20000) return res.status(400).json({ error: 'Post too long (max 20,000 chars).' });

  const gifUrl         = (req.body.gif_url || '').trim() || null;
  const files          = req.files || [];
  const attachmentUrls = files.map(f => '/images/community/' + f.filename);
  const attachmentsJson = attachmentUrls.length > 0 ? JSON.stringify(attachmentUrls) : null;
  const attachmentUrl   = attachmentUrls[0] || null;
  const attachmentName  = files[0] ? files[0].originalname : null;
  const pinned = await checkAdmin(req);

  const { rows: [row] } = await pool.query(
    'INSERT INTO community_posts (user_id, body, tag, attachment_url, attachment_name, attachments, gif_url, pinned, nsfw) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
    [req.user.id, body, tag, attachmentUrl, attachmentName, attachmentsJson, gifUrl, pinned, nsfw]
  );

  const { rows: [post] } = await pool.query(`
    SELECT p.*, u.username, u.display_name, u.avatar, 0 AS like_count, 0 AS comment_count, 0 AS user_liked
    FROM community_posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = $1
  `, [row.id]);

  res.json({ post });
});

// POST /api/community/posts/:id/like
app.post('/api/community/posts/:id/like', requireAuth, async (req, res) => {
  const postId = parseInt(req.params.id);
  const userId = req.user.id;
  const { rows: [existing] } = await pool.query(
    'SELECT id FROM community_likes WHERE post_id = $1 AND user_id = $2', [postId, userId]
  );
  if (existing) {
    await pool.query('DELETE FROM community_likes WHERE post_id = $1 AND user_id = $2', [postId, userId]);
  } else {
    await pool.query(
      'INSERT INTO community_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [postId, userId]
    );
  }
  const { rows: [{ like_count }] } = await pool.query(
    'SELECT COUNT(*)::int AS like_count FROM community_likes WHERE post_id = $1', [postId]
  );
  res.json({ liked: !existing, like_count });
});

// GET /api/community/posts/:id/comments
app.get('/api/community/posts/:id/comments', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id, c.post_id, c.user_id, c.body, c.parent_id, c.created_at,
           u.username, u.display_name, u.avatar
    FROM community_comments c
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.post_id = $1 ORDER BY c.created_at ASC LIMIT 500
  `, [parseInt(req.params.id)]);
  res.json({ comments: rows });
});

// POST /api/community/posts/:id/comments
app.post('/api/community/posts/:id/comments', requireAuth, async (req, res) => {
  const postId = parseInt(req.params.id);
  const body     = (req.body.body || '').trim();
  const parentId = req.body.parent_id ? parseInt(req.body.parent_id) : null;
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
  if (body.length > 500) return res.status(400).json({ error: 'Comment too long (max 500 chars).' });

  const { rows: [row] } = await pool.query(
    'INSERT INTO community_comments (post_id, user_id, body, parent_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [postId, req.user.id, body, parentId]
  );

  const { rows: [comment] } = await pool.query(`
    SELECT c.id, c.post_id, c.user_id, c.body, c.parent_id, c.created_at,
           u.username, u.display_name, u.avatar
    FROM community_comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.id = $1
  `, [row.id]);

  res.json({ comment });
});

// PATCH /api/community/posts/:id/nsfw  (admin only — toggle NSFW flag)
app.patch('/api/community/posts/:id/nsfw', requireAuth, async (req, res) => {
  if (!await checkAdmin(req)) return res.status(403).json({ error: 'Forbidden.' });
  const postId = parseInt(req.params.id);
  const { rows: [post] } = await pool.query('SELECT nsfw FROM community_posts WHERE id = $1', [postId]);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const newVal = !post.nsfw;
  await pool.query('UPDATE community_posts SET nsfw = $1 WHERE id = $2', [newVal, postId]);
  res.json({ nsfw: newVal });
});

// DELETE /api/community/posts/:id/comments/:commentId
app.delete('/api/community/posts/:id/comments/:commentId', requireAuth, async (req, res) => {
  const commentId = parseInt(req.params.commentId);
  const { rows: [comment] } = await pool.query('SELECT * FROM community_comments WHERE id = $1', [commentId]);
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.user_id !== req.user.id && !await checkAdmin(req))
    return res.status(403).json({ error: 'Forbidden.' });

  await pool.query('DELETE FROM community_comments WHERE id = $1', [commentId]);
  res.json({ message: 'Deleted.' });
});

// DELETE /api/community/posts/:id
app.delete('/api/community/posts/:id', requireAuth, async (req, res) => {
  const postId = parseInt(req.params.id);
  const { rows: [post] } = await pool.query(
    'SELECT * FROM community_posts WHERE id = $1', [postId]
  );
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (post.user_id !== req.user.id && !await checkAdmin(req))
    return res.status(403).json({ error: 'Forbidden.' });

  if (post.attachments) {
    try { JSON.parse(post.attachments).forEach(u => { const fp = path.join('/var/www/btw', u); if (fs.existsSync(fp)) fs.unlinkSync(fp); }); } catch {}
  } else if (post.attachment_url) {
    const fp = path.join('/var/www/btw', post.attachment_url);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM community_posts WHERE id = $1', [postId]);
    await client.query('DELETE FROM community_likes WHERE post_id = $1', [postId]);
    await client.query('DELETE FROM community_comments WHERE post_id = $1', [postId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  res.json({ ok: true });
});

// ── Page tracking (no PII) ────────────────────────────────────────────────────
// ── Report ────────────────────────────────────────────────────────────────────
app.post('/api/report', requireAuth, async (req, res) => {
  const { type, id, description } = req.body;
  if (!description || !description.trim()) return res.status(400).json({ error: 'Description is required.' });
  if (description.length > 1000) return res.status(400).json({ error: 'Description too long (max 1000 chars).' });
  if (!['post', 'comment', 'art-comment'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });

  const { rows: [reporter] } = await pool.query(
    'SELECT username, display_name FROM users WHERE id = $1', [req.user.id]
  );
  const reporterName = (reporter && (reporter.display_name || reporter.username)) || 'Unknown';
  const typeLabel = type === 'post' ? 'Community Post' : type === 'comment' ? 'Community Comment' : 'Art Comment';

  resend.emails.send({
    from: 'BTW Reports <noreply@btwfanfic.net>',
    to: process.env.ADMIN_EMAIL,
    subject: `Content Report — ${typeLabel} #${id} — Between Two Worlds`,
    html: emailShell(`
      <h2 style="color:#c2547a;font-size:1.1rem;margin:0 0 12px;">⚠️ Content Report</h2>
      <p style="color:#424242;font-size:0.9rem;margin:0 0 6px;"><strong>Reported by:</strong> ${reporterName}</p>
      <p style="color:#424242;font-size:0.9rem;margin:0 0 6px;"><strong>Content type:</strong> ${typeLabel} (ID: ${id})</p>
      <div style="background:#fff8f8;border-left:3px solid #c2547a;padding:12px 16px;border-radius:4px;margin:12px 0;">
        <p style="color:#212121;font-size:0.95rem;margin:0;white-space:pre-wrap;">${String(description).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
      </div>
    `),
  }).catch(console.error);

  res.json({ message: 'Report submitted. Thank you.' });
});

app.post('/api/track', async (req, res) => {
  res.sendStatus(200);
  const raw = (req.body.path || '').slice(0, 200);
  const path_clean = raw.split('?')[0] || '/';
  if (path_clean === '/stats') return;
  try { await pool.query('INSERT INTO page_views (path) VALUES ($1)', [path_clean]); } catch {}
});

// ── Admin stats ───────────────────────────────────────────────────────────────
// POST /api/admin/newsletter — send email blast to all opted-in users
app.post('/api/admin/newsletter', requireAuth, uploadInbox.array('attachments', 4), async (req, res) => {
  if (!await checkAdmin(req)) return res.status(403).json({ error: 'Forbidden.' });
  const { subject, body } = req.body;
  if (!subject?.trim()) return res.status(400).json({ error: 'Subject is required.' });
  if (!body?.trim())    return res.status(400).json({ error: 'Message body is required.' });

  const files = req.files || [];
  const attachments = files.map(f => ({ url: '/images/inbox/' + f.filename, name: f.originalname }));
  const attachmentUrl  = attachments[0]?.url  || null;
  const attachmentName = attachments[0]?.name || null;

  // Two different audiences: EVERY user gets the in-app notice (main-site
  // inbox + Fanpages High Priority chat) — only opted-in, verified users
  // also get the actual email.
  const { rows: allUsers } = await pool.query("SELECT id FROM users WHERE username <> 'btwteam'");
  const { rows: emailRows } = await pool.query(
    `SELECT id, email FROM users WHERE email_newsletter = true AND verified = true`
  );

  const escaped = body.trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  const attachHtml = attachments
    .filter(a => /\.(jpe?g|png|webp|gif|avif)$/i.test(a.url))
    .map(a => `<div style="margin-top:12px;"><img src="https://${process.env.SITE_HOST}${a.url}" alt="${a.name}" style="max-width:100%;border-radius:8px;" /></div>`)
    .join('');

  // Actual email — opted-in + verified only.
  let sent = 0;
  for (const row of emailRows) {
    const to = decryptEmail(row.email);
    if (!to || !to.includes('@')) continue;
    try {
      await resend.emails.send({
        from:       'Between Two Worlds <hello@btwfanfic.net>',
        reply_to:   'hello@btwfanfic.net',
        to,
        subject:    subject.trim(),
        html:       emailShell(`<div style="font-size:0.95rem;color:#424242;line-height:1.7;">${escaped}</div>${attachHtml}<p style="font-size:0.78rem;color:#999;margin-top:24px;">You're receiving this because you opted in to BTW newsletters. You can turn this off any time in your <a href="https://${process.env.SITE_HOST}/profile">profile settings</a>.</p>`),
        text:       body.trim() + '\n\n---\nYou can unsubscribe at any time via your profile settings at https://' + process.env.SITE_HOST + '/profile',
      });
      sent++;
    } catch (err) { console.error('Newsletter send error to', to, err.message); }
  }

  // Main-site /inbox delivery + Fanpages High Priority chat — every user,
  // regardless of email opt-in, since both are native in-app channels.
  const { rows: [teamUser] } = await pool.query("SELECT id FROM users WHERE username = 'btwteam'");
  const priorityBody = `📢 ${subject.trim()}\n\n${body.trim()}`;
  for (const u of allUsers) {
    try {
      const { rows: [nm] } = await pool.query(
        'INSERT INTO inbox_messages (to_user_id, body, subject, is_admin, attachment_url, attachment_name, attachments) VALUES ($1, $2, $3, true, $4, $5, $6) RETURNING id',
        [u.id, body.trim(), subject.trim(), attachmentUrl, attachmentName, JSON.stringify(attachments)]
      );
      await pool.query('UPDATE inbox_messages SET thread_id = $1 WHERE id = $1', [nm.id]);
    } catch (err) { console.error('Newsletter inbox delivery error:', err.message); }

    if (teamUser) {
      try {
        const { rows: [thread] } = await pool.query(
          `INSERT INTO dm_threads (user_a_id, user_b_id, status, is_priority, accepted_at, dismissed_at)
           VALUES ($1, $2, 'accepted', true, NOW(), NULL)
           ON CONFLICT (LEAST(user_a_id, user_b_id), GREATEST(user_a_id, user_b_id))
           DO UPDATE SET is_priority = true, status = 'accepted', dismissed_at = NULL
           RETURNING id`,
          [teamUser.id, u.id]
        );
        await pool.query(
          'INSERT INTO dm_messages (thread_id, sender_id, body, attachments) VALUES ($1, $2, $3, $4)',
          [thread.id, teamUser.id, priorityBody, JSON.stringify(attachments)]
        );
      } catch (err) { console.error('Newsletter high-priority broadcast error:', err.message); }
    }
  }

  res.json({ sent, total: emailRows.length, notified: allUsers.length });
});

// GET /api/admin/newsletter/count — how many opted-in users
app.get('/api/admin/newsletter/count', requireAuth, async (req, res) => {
  if (!await checkAdmin(req)) return res.status(403).json({ error: 'Forbidden.' });
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM users WHERE email_newsletter = true AND verified = true`
  );
  res.json({ count: r.count });
});

app.get('/api/admin/stats', requireAuth, async (req, res) => {
  if (!await checkAdmin(req)) return res.status(403).json({ error: 'Forbidden.' });
  try {
    const [users, signups, topPages, pagesByDay, viewTotal, donations, community] = await Promise.all([
      pool.query(`SELECT username, display_name, created_at FROM users ORDER BY created_at DESC`),
      pool.query(`
        SELECT DATE(created_at) AS date, COUNT(*)::int AS count
        FROM users WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at) ORDER BY date
      `),
      pool.query(`
        SELECT path, COUNT(*)::int AS count FROM page_views
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY path ORDER BY count DESC LIMIT 10
      `),
      pool.query(`
        SELECT DATE(created_at) AS date, COUNT(*)::int AS count
        FROM page_views WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at) ORDER BY date
      `),
      pool.query(`SELECT COUNT(*)::int AS total FROM page_views WHERE created_at > NOW() - INTERVAL '30 days'`),
      pool.query(`
        SELECT source, COUNT(*)::int AS count, SUM(amount)::float AS amount
        FROM donations GROUP BY source
      `),
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM community_posts) AS posts,
          (SELECT COUNT(*)::int FROM community_comments) AS comments
      `),
    ]);
    res.json({
      users:     { total: users.rows.length, list: users.rows },
      signups:   signups.rows,
      pageViews: { total: viewTotal.rows[0].total, byPath: topPages.rows, byDay: pagesByDay.rows },
      donations: donations.rows,
      community: community.rows[0],
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to load stats.' });
  }
});

// ── Donations ─────────────────────────────────────────────────────────────────

// GET /api/donations — public, newest first
app.get('/api/donations', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT donor_name, amount, currency, source, created_at FROM donations ORDER BY created_at DESC LIMIT 100'
    );
    res.json({ donations: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load donations' });
  }
});

// POST /api/webhooks/kofi
app.post('/api/webhooks/kofi', express.urlencoded({ extended: true }), async (req, res) => {
  res.sendStatus(200); // Ko-fi needs a fast 200 to stop retrying
  try {
    const data = JSON.parse(req.body.data || '{}');
    if (data.verification_token !== process.env.KOFI_VERIFICATION_TOKEN) return;
    const name   = data.is_public !== false ? (data.from_name || 'Anonymous') : 'Anonymous';
    const amount = parseFloat(data.amount) || 0;
    if (amount <= 0) return;
    await pool.query(
      'INSERT INTO donations (donor_name, amount, currency, source) VALUES ($1, $2, $3, $4)',
      [name, amount, data.currency || 'USD', 'kofi']
    );
  } catch (err) {
    console.error('Ko-fi webhook error:', err);
  }
});

// POST /api/webhooks/paypal  (IPN verification)
app.post('/api/webhooks/paypal', express.urlencoded({ extended: true }), (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  const verifyBody = Buffer.from('cmd=_notify-validate&' + new URLSearchParams(body).toString());
  const options = {
    hostname: 'ipnpb.paypal.com',
    path:     '/cgi-bin/webscr',
    method:   'POST',
    headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': verifyBody.length },
  };
  const verifyReq = https.request(options, verifyRes => {
    let text = '';
    verifyRes.on('data', c => text += c);
    verifyRes.on('end', async () => {
      if (text !== 'VERIFIED') return;
      if (body.payment_status !== 'Completed') return;
      try {
        const first = (body.first_name || '').trim();
        const last  = (body.last_name  || '').trim();
        const name  = [first, last].filter(Boolean).join(' ') || 'Anonymous';
        const amount = parseFloat(body.mc_gross) || 0;
        if (amount <= 0) return;

        // Skip if this is a Ko-fi passthrough — Ko-fi forwards donations to PayPal
        // automatically, which would duplicate the entry with the donor's real name.
        // A matching Ko-fi donation within the last 30 minutes at the same amount = passthrough.
        const { rows: existing } = await pool.query(
          `SELECT id FROM donations
           WHERE source = 'kofi'
             AND ABS(amount - $1) < 0.01
             AND created_at > NOW() - INTERVAL '30 minutes'
           LIMIT 1`,
          [amount]
        );
        if (existing.length > 0) return;

        await pool.query(
          'INSERT INTO donations (donor_name, amount, currency, source) VALUES ($1, $2, $3, $4)',
          [name, amount, body.mc_currency || 'USD', 'paypal']
        );
      } catch (err) {
        console.error('PayPal IPN save error:', err);
      }
    });
  });
  verifyReq.on('error', err => console.error('PayPal IPN verify error:', err));
  verifyReq.write(verifyBody);
  verifyReq.end();
});

// ── Moderator Creator Panel ─────────────────────────────────────────────────────
const MOD_IMAGES_DIR = '/var/www/btw/images/moderators';
if (!fs.existsSync(MOD_IMAGES_DIR)) fs.mkdirSync(MOD_IMAGES_DIR, { recursive: true });

const uploadModImage = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, MOD_IMAGES_DIR),
    filename: (req, file, cb) => {
      const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' })[file.mimetype] || '.jpg';
      cb(null, `${req.user.id}_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype));
  },
});

// Chapter cover images share the moderator images dir; the readable PDF/Docx
// attachment gets its own dir since it isn't an image and needs to keep its
// original filename around for the download prompt.
const MOD_CHAPTER_FILES_DIR = '/var/www/btw/moderators/files';
if (!fs.existsSync(MOD_CHAPTER_FILES_DIR)) fs.mkdirSync(MOD_CHAPTER_FILES_DIR, { recursive: true });

const CHAPTER_DOC_MIMES = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
};

const uploadChapter = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, file.fieldname === 'file' ? MOD_CHAPTER_FILES_DIR : MOD_IMAGES_DIR),
    filename: (req, file, cb) => {
      if (file.fieldname === 'file') {
        cb(null, `${req.user.id}_${Date.now()}${CHAPTER_DOC_MIMES[file.mimetype] || ''}`);
        return;
      }
      const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' })[file.mimetype] || '.jpg';
      cb(null, `${req.user.id}_${Date.now()}_cover${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'file') {
      cb(null, Object.keys(CHAPTER_DOC_MIMES).includes(file.mimetype));
    } else {
      cb(null, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype));
    }
  },
});

// Authors can own multiple stories now, so "my site" is ambiguous without a
// hint — every story-template page sends its own story_path (owner/story) in
// the X-Story-Path header. Falls back to "whichever site is theirs" for any
// caller that doesn't send it yet (single-story authors, or older pages).
async function getMySite(req) {
  const storyPath = req.headers['x-story-path'];
  if (storyPath) {
    const { rows: [site] } = await pool.query(
      'SELECT * FROM moderator_sites WHERE story_path = $1 AND owner_user_id = $2', [storyPath, req.user.id]
    );
    if (site) return site;
  }
  const { rows: [site] } = await pool.query('SELECT * FROM moderator_sites WHERE owner_user_id = $1 ORDER BY created_at ASC LIMIT 1', [req.user.id]);
  return site || null;
}

// Confirms the user is a moderator AND has a site row, then attaches it to req.modSite
async function requireModerator(req, res, next) {
  if (!await checkModerator(req)) return res.status(403).json({ error: 'Forbidden.' });
  const site = await getMySite(req);
  if (!site) return res.status(404).json({ error: 'No moderator site found for this account.' });
  req.modSite = site;
  next();
}

// ── Fanpages hub billboard (admin-only management) ──────────────────────────
app.get('/api/hub-billboard', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM hub_billboard_slides ORDER BY sort_order, id');
  res.json({ slides: rows });
});

const HUB_ANIMATION_TYPES = ['none', 'pan_v', 'pan_h', 'zoom'];
function clampZoom(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 100 && n <= 400 ? n : fallback;
}

app.post('/api/admin/hub-billboard', requireAuth, requireAdmin, uploadModImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const { caption, credit, link } = req.body;
  const positionX = clampPosition(req.body.position_x);
  const positionY = clampPosition(req.body.position_y);
  const zoom = clampZoom(req.body.zoom, 100);
  const animationType = HUB_ANIMATION_TYPES.includes(req.body.animation_type) ? req.body.animation_type : 'none';
  const endPositionX = clampPosition(req.body.end_position_x);
  const endPositionY = clampPosition(req.body.end_position_y);
  const endZoom = clampZoom(req.body.end_zoom, 100);
  const imageUrl = `/images/moderators/${req.file.filename}`;
  const { rows: [{ maxOrder }] } = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder" FROM hub_billboard_slides');
  const { rows: [slide] } = await pool.query(
    `INSERT INTO hub_billboard_slides
       (image_url, position_x, position_y, zoom, caption, credit, link, sort_order,
        animation_type, end_position_x, end_position_y, end_zoom)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [imageUrl, positionX, positionY, zoom, (caption || '').trim(), (credit || '').trim(), (link || '').trim(), maxOrder + 1,
     animationType, endPositionX, endPositionY, endZoom]
  );
  res.json({ slide });
});

app.put('/api/admin/hub-billboard/:id', requireAuth, requireAdmin, uploadModImage.single('image'), async (req, res) => {
  const { rows: [existing] } = await pool.query('SELECT * FROM hub_billboard_slides WHERE id = $1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found.' });

  const { caption, credit, link } = req.body;
  const positionX = req.body.position_x !== undefined ? clampPosition(req.body.position_x) : existing.position_x;
  const positionY = req.body.position_y !== undefined ? clampPosition(req.body.position_y) : existing.position_y;
  const zoom = req.body.zoom !== undefined ? clampZoom(req.body.zoom, existing.zoom) : existing.zoom;
  const animationType = req.body.animation_type !== undefined
    ? (HUB_ANIMATION_TYPES.includes(req.body.animation_type) ? req.body.animation_type : existing.animation_type)
    : existing.animation_type;
  const endPositionX = req.body.end_position_x !== undefined ? clampPosition(req.body.end_position_x) : existing.end_position_x;
  const endPositionY = req.body.end_position_y !== undefined ? clampPosition(req.body.end_position_y) : existing.end_position_y;
  const endZoom = req.body.end_zoom !== undefined ? clampZoom(req.body.end_zoom, existing.end_zoom) : existing.end_zoom;

  let imageUrl = existing.image_url;
  if (req.file) {
    imageUrl = `/images/moderators/${req.file.filename}`;
    if (existing.image_url.startsWith('/images/moderators/')) {
      const oldPath = path.join('/var/www/btw', existing.image_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }

  const { rows: [slide] } = await pool.query(
    `UPDATE hub_billboard_slides SET
       image_url = $1, position_x = $2, position_y = $3, zoom = $4,
       caption = COALESCE($5, caption), credit = COALESCE($6, credit), link = COALESCE($7, link),
       animation_type = $8, end_position_x = $9, end_position_y = $10, end_zoom = $11
     WHERE id = $12 RETURNING *`,
    [imageUrl, positionX, positionY, zoom, caption != null ? caption.trim() : null,
     credit != null ? credit.trim() : null, link != null ? link.trim() : null,
     animationType, endPositionX, endPositionY, endZoom, existing.id]
  );
  res.json({ slide });
});

app.delete('/api/admin/hub-billboard/:id', requireAuth, requireAdmin, async (req, res) => {
  const { rows: [slide] } = await pool.query('SELECT * FROM hub_billboard_slides WHERE id = $1', [req.params.id]);
  if (!slide) return res.status(404).json({ error: 'Not found.' });
  if (slide.image_url.startsWith('/images/moderators/')) {
    const filePath = path.join('/var/www/btw', slide.image_url);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  await pool.query('DELETE FROM hub_billboard_slides WHERE id = $1', [slide.id]);
  res.json({ message: 'Deleted.' });
});

// ── Notifications page banner (admin-adjustable crop) ───────────────────────
app.get('/api/notifications-banner', async (req, res) => {
  const { rows: [banner] } = await pool.query('SELECT * FROM notif_page_banner WHERE id = 1');
  res.json({ banner });
});

app.put('/api/admin/notifications-banner', requireAuth, requireAdmin, uploadModImage.single('image'), async (req, res) => {
  const { rows: [existing] } = await pool.query('SELECT * FROM notif_page_banner WHERE id = 1');
  const positionX = clampPosition(req.body.position_x);
  const positionY = clampPosition(req.body.position_y);
  const zoom = clampZoom(req.body.zoom, 100);

  let imageUrl = existing.image_url;
  if (req.file) {
    imageUrl = `/images/moderators/${req.file.filename}`;
    if (existing.image_url.startsWith('/images/moderators/')) {
      const oldPath = path.join('/var/www/btw', existing.image_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }

  const { rows: [banner] } = await pool.query(
    'UPDATE notif_page_banner SET image_url = $1, position_x = $2, position_y = $3, zoom = $4 WHERE id = 1 RETURNING *',
    [imageUrl, positionX, positionY, zoom]
  );
  res.json({ banner });
});

// POST /api/moderator/site/create — the Create Story onboarding flow.
// Authors can have multiple stories; slug stays their username (their
// fanpage identity), while story_path is the unique per-story
// /fanpages/<slug>/<story> URL, slugified from the title and de-duped if it
// collides with an existing story (their own or anyone else's).
app.post('/api/moderator/site/create', requireAuth, async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 60);
  if (!title) return res.status(400).json({ error: 'A title is required.' });

  const { rows: [user] } = await pool.query('SELECT username FROM users WHERE id = $1', [req.user.id]);
  const slug = user.username.toLowerCase();

  const baseStorySlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'story';
  let storyPath = `${slug}/${baseStorySlug}`;
  let suffix = 2;
  while ((await pool.query('SELECT 1 FROM moderator_sites WHERE story_path = $1', [storyPath])).rows.length) {
    storyPath = `${slug}/${baseStorySlug}-${suffix}`;
    suffix++;
  }

  try {
    const { rows: [site] } = await pool.query(
      `INSERT INTO moderator_sites (slug, owner_user_id, site_title, story_path) VALUES ($1, $2, $3, $4) RETURNING *`,
      [slug, req.user.id, title, storyPath]
    );
    res.json({ site });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That story URL is already taken — please try again.' });
    throw e;
  }
});

// GET /api/moderator-sites — public list of every fanpage, for the hub's
// browse/recommended rows. Includes each site's bookmark state when the
// request carries a valid token.
app.get('/api/moderator-sites', async (req, res) => {
  let userId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { userId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }

  const q = (req.query.q || '').trim();
  const { rows: sites } = await pool.query(`
    SELECT ms.id, ms.slug, ms.story_path, ms.site_title, ms.cover_url, ms.banner_url, ms.tags,
           u.username, u.display_name, u.avatar
    FROM moderator_sites ms
    JOIN users u ON u.id = ms.owner_user_id
    WHERE $1 = '' OR
      ms.site_title ILIKE '%' || $1 || '%' OR
      u.username ILIKE '%' || $1 || '%' OR
      u.display_name ILIKE '%' || $1 || '%' OR
      EXISTS (SELECT 1 FROM jsonb_array_elements_text(ms.tags) tag WHERE tag ILIKE '%' || $1 || '%')
    ORDER BY ms.created_at ASC
  `, [q]);

  let bookmarkedIds = new Set();
  if (userId) {
    const { rows } = await pool.query('SELECT site_id FROM moderator_bookmarks WHERE user_id = $1', [userId]);
    bookmarkedIds = new Set(rows.map(r => r.site_id));
  }

  res.json({
    sites: sites.map(s => ({
      slug: s.slug,
      story_path: s.story_path || s.slug,
      site_title: s.site_title,
      cover_url: s.cover_url,
      banner_url: s.banner_url,
      tags: s.tags || [],
      author: s.display_name || s.username,
      author_username: s.username,
      author_avatar: s.avatar || null,
      bookmarked: bookmarkedIds.has(s.id),
    })),
  });
});

// ── Bookmarks — save a fanpage to your hub profile ────────────────────────────
app.get('/api/bookmarks', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT ms.slug, ms.story_path, ms.site_title, ms.cover_url, u.username, u.display_name, u.avatar
    FROM moderator_bookmarks mb
    JOIN moderator_sites ms ON ms.id = mb.site_id
    JOIN users u ON u.id = ms.owner_user_id
    WHERE mb.user_id = $1
    ORDER BY mb.created_at DESC
  `, [req.user.id]);
  res.json({
    bookmarks: rows.map(r => ({
      slug: r.slug, story_path: r.story_path || r.slug, site_title: r.site_title, cover_url: r.cover_url,
      author: r.display_name || r.username, author_username: r.username, author_avatar: r.avatar || null,
    })),
  });
});

// Single-segment :slug still works for an author's only story (or as a
// fallback); by-path/:owner/:story is the precise lookup once an author has
// more than one, since slug (their identity) is no longer unique.
async function findSiteBySlugParam(req) {
  const { owner, story } = req.params;
  if (owner && story) {
    const { rows: [site] } = await pool.query('SELECT id FROM moderator_sites WHERE story_path = $1', [`${owner}/${story}`]);
    return site || null;
  }
  const { rows: [site] } = await pool.query('SELECT id FROM moderator_sites WHERE slug = $1 ORDER BY created_at ASC LIMIT 1', [req.params.slug]);
  return site || null;
}

app.post(['/api/bookmarks/:slug', '/api/bookmarks/by-path/:owner/:story'], requireAuth, async (req, res) => {
  const site = await findSiteBySlugParam(req);
  if (!site) return res.status(404).json({ error: 'Not found.' });
  await pool.query(
    'INSERT INTO moderator_bookmarks (user_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.user.id, site.id]
  );
  res.json({ message: 'Bookmarked.' });
});

app.delete(['/api/bookmarks/:slug', '/api/bookmarks/by-path/:owner/:story'], requireAuth, async (req, res) => {
  const site = await findSiteBySlugParam(req);
  if (!site) return res.status(404).json({ error: 'Not found.' });
  await pool.query('DELETE FROM moderator_bookmarks WHERE user_id = $1 AND site_id = $2', [req.user.id, site.id]);
  res.json({ message: 'Removed.' });
});

// ── Author profile — /fanpages/:username, Twitter-style header + their stories ──
app.get('/api/fanpage-profile/:username', async (req, res) => {
  const { rows: [author] } = await pool.query(
    `SELECT id, username, display_name, avatar, avatar_position_x, avatar_position_y,
            pronouns, favorite_pokemon, account_bio, fun_fact, account_links,
            account_banner_url, account_banner_position_x, account_banner_position_y,
            profile_theme, profile_theme_bg_url
     FROM users WHERE username = $1`,
    [req.params.username.toLowerCase()]
  );
  if (!author) return res.status(404).json({ error: 'Not found.' });

  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }

  const [{ rows: sites }, followerCount, followingCount, isFollowing, featuredChars, featuredGallery] = await Promise.all([
    pool.query(
      'SELECT slug, story_path, site_title, cover_url, banner_url FROM moderator_sites WHERE owner_user_id = $1 ORDER BY created_at ASC',
      [author.id]
    ),
    pool.query('SELECT COUNT(*)::int AS n FROM user_follows WHERE followed_id = $1', [author.id]),
    pool.query('SELECT COUNT(*)::int AS n FROM user_follows WHERE follower_id = $1', [author.id]),
    viewerId
      ? pool.query('SELECT 1 FROM user_follows WHERE follower_id = $1 AND followed_id = $2', [viewerId, author.id])
      : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT title, image_url, link_url FROM user_featured_items
       WHERE user_id = $1 AND kind = 'character' ORDER BY sort_order LIMIT 3`,
      [author.id]
    ),
    pool.query(
      `SELECT title, image_url, link_url FROM user_featured_items
       WHERE user_id = $1 AND kind = 'gallery' ORDER BY sort_order LIMIT 3`,
      [author.id]
    ),
  ]);

  res.json({
    author: {
      username: author.username,
      display_name: author.display_name || author.username,
      avatar: author.avatar || null,
      avatar_position_x: author.avatar_position_x != null ? author.avatar_position_x : 50,
      avatar_position_y: author.avatar_position_y != null ? author.avatar_position_y : 50,
      // Deliberately NOT falling back to a story's banner_url here — the
      // account profile banner is its own thing and must stay blank (falls
      // through to the shared placeholder image on the frontend) until the
      // user explicitly sets one via the profile editor.
      banner_url: author.account_banner_url || '',
      banner_position_x: author.account_banner_url ? author.account_banner_position_x : 50,
      banner_position_y: author.account_banner_url ? author.account_banner_position_y : 50,
      pronouns: author.pronouns || '',
      favorite_pokemon: author.favorite_pokemon || '',
      account_bio: author.account_bio || '',
      fun_fact: author.fun_fact || '',
      account_links: author.account_links || [],
      profile_theme: author.profile_theme || 'default',
      profile_theme_bg_url: author.profile_theme_bg_url || '',
      featured_characters: featuredChars.rows,
      featured_gallery: featuredGallery.rows,
      is_self: viewerId === author.id,
    },
    stories: sites.map(s => ({
      slug: s.slug, story_path: s.story_path || s.slug, site_title: s.site_title, cover_url: s.cover_url,
    })),
    follower_count: followerCount.rows[0].n,
    following_count: followingCount.rows[0].n,
    is_following: isFollowing.rows.length > 0,
  });
});

// Shared by the followers/following list modal — each row carries enough to
// render a Wattpad-style card (avatar, works count, follower count) plus
// whether the viewer already follows that row, for an inline Follow button.
async function fanpageFollowList(req, res, direction) {
  const { rows: [author] } = await pool.query(
    'SELECT id FROM users WHERE username = $1', [req.params.username.toLowerCase()]
  );
  if (!author) return res.status(404).json({ error: 'Not found.' });

  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }

  const joinCol = direction === 'followers' ? 'f.follower_id' : 'f.followed_id';
  const whereCol = direction === 'followers' ? 'f.followed_id' : 'f.follower_id';
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.avatar,
            (SELECT COUNT(*)::int FROM moderator_sites WHERE owner_user_id = u.id) AS works_count,
            (SELECT COUNT(*)::int FROM user_follows WHERE followed_id = u.id) AS follower_count,
            EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $2 AND followed_id = u.id) AS is_following
     FROM user_follows f
     JOIN users u ON u.id = ${joinCol}
     WHERE ${whereCol} = $1
     ORDER BY f.created_at DESC`,
    [author.id, viewerId || 0]
  );
  res.json({
    users: rows.map(r => ({
      username: r.username, display_name: r.display_name || r.username, avatar: r.avatar || null,
      works_count: r.works_count, follower_count: r.follower_count,
      is_following: r.is_following, is_self: viewerId === r.id,
    })),
  });
}
app.get('/api/fanpage-profile/:username/followers', (req, res) => fanpageFollowList(req, res, 'followers'));
app.get('/api/fanpage-profile/:username/following', (req, res) => fanpageFollowList(req, res, 'following'));

// Full Characters / Gallery tabs on a user's profile — every character or
// gallery post across ALL of that user's stories, not just the 3 featured
// picks shown on Home. Gallery is filtered to sfw+sketches, same rule as
// everywhere else spicy content is kept out of public-facing feeds.
app.get('/api/fanpage-profile/:username/all-characters', async (req, res) => {
  const { rows: [author] } = await pool.query(
    'SELECT id FROM users WHERE username = $1', [req.params.username.toLowerCase()]
  );
  if (!author) return res.status(404).json({ error: 'Not found.' });
  const { rows } = await pool.query(
    `SELECT mc.id, mc.name, mc.ref_image, mc.ref_position_x, mc.ref_position_y,
            ms.story_path, ms.slug, ms.site_title
     FROM moderator_characters mc
     LEFT JOIN LATERAL (
       SELECT site_id FROM character_story_links WHERE character_id = mc.id ORDER BY site_id LIMIT 1
     ) csl ON true
     LEFT JOIN moderator_sites ms ON ms.id = csl.site_id
     WHERE mc.owner_user_id = $1
     ORDER BY mc.created_at DESC`,
    [author.id]
  );
  res.json({
    characters: rows.map(r => ({
      id: r.id, name: r.name, image: r.ref_image || null,
      position_x: r.ref_position_x, position_y: r.ref_position_y,
      story_path: r.story_path || r.slug || null, site_title: r.site_title || null,
    })),
  });
});

app.get('/api/fanpage-profile/:username/all-gallery', async (req, res) => {
  const { rows: [author] } = await pool.query(
    'SELECT id FROM users WHERE username = $1', [req.params.username.toLowerCase()]
  );
  if (!author) return res.status(404).json({ error: 'Not found.' });
  const { rows } = await pool.query(
    `SELECT mg.id, mg.image_url, mg.title, mg.position_x, mg.position_y,
            ms.story_path, ms.slug, ms.site_title
     FROM moderator_gallery mg
     LEFT JOIN LATERAL (
       SELECT site_id FROM gallery_story_links WHERE gallery_id = mg.id ORDER BY site_id LIMIT 1
     ) gsl ON true
     LEFT JOIN moderator_sites ms ON ms.id = gsl.site_id
     WHERE mg.owner_user_id = $1 AND mg.category IN ('sfw', 'sketches')
     ORDER BY mg.created_at DESC`,
    [author.id]
  );
  res.json({
    gallery: rows.map(r => ({
      id: r.id, image: r.image_url, title: r.title,
      position_x: r.position_x, position_y: r.position_y,
      story_path: r.story_path || r.slug || null, site_title: r.site_title || null,
    })),
  });
});

app.post('/api/follows/:username', requireAuth, async (req, res) => {
  const { rows: [target] } = await pool.query('SELECT id FROM users WHERE username = $1', [req.params.username.toLowerCase()]);
  if (!target) return res.status(404).json({ error: 'Not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't follow yourself." });
  await pool.query(
    'INSERT INTO user_follows (follower_id, followed_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.user.id, target.id]
  );
  res.json({ message: 'Followed.' });
});

app.delete('/api/follows/:username', requireAuth, async (req, res) => {
  const { rows: [target] } = await pool.query('SELECT id FROM users WHERE username = $1', [req.params.username.toLowerCase()]);
  if (!target) return res.status(404).json({ error: 'Not found.' });
  await pool.query('DELETE FROM user_follows WHERE follower_id = $1 AND followed_id = $2', [req.user.id, target.id]);
  res.json({ message: 'Unfollowed.' });
});

// ── Fanpages DM system ───────────────────────────────────────────────────────
async function findDmThread(id, userId) {
  const { rows: [thread] } = await pool.query(
    'SELECT * FROM dm_threads WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)',
    [id, userId]
  );
  return thread || null;
}

// Chats = accepted conversations, plus my own pending sent requests (so I can
// see them awaiting the other person's response instead of them vanishing).
app.get('/api/dm/chats', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.status, t.is_priority, t.user_a_id, t.user_b_id,
            u.id AS other_id, u.username AS other_username, u.display_name AS other_display_name, u.avatar AS other_avatar,
            m.body AS last_body, m.attachments AS last_attachments, m.created_at AS last_at, m.sender_id AS last_sender_id,
            (SELECT COUNT(*)::int FROM dm_messages WHERE thread_id = t.id AND sender_id <> $1 AND read_at IS NULL) AS unread_count
     FROM dm_threads t
     JOIN users u ON u.id = (CASE WHEN t.user_a_id = $1 THEN t.user_b_id ELSE t.user_a_id END)
     LEFT JOIN LATERAL (
       SELECT body, attachments, created_at, sender_id FROM dm_messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1
     ) m ON true
     WHERE (t.user_a_id = $1 OR t.user_b_id = $1)
       AND (
         (t.is_priority = true AND t.dismissed_at IS NULL)
         OR (t.is_priority = false AND t.status = 'accepted')
         OR (t.is_priority = false AND t.status = 'pending' AND t.user_a_id = $1)
       )
     ORDER BY t.is_priority DESC, COALESCE(m.created_at, t.created_at) DESC`,
    [req.user.id]
  );
  const mapped = rows.map(r => ({
    id: r.id,
    status: r.status,
    is_priority: r.is_priority,
    other_user: { username: r.other_username, display_name: r.other_display_name || r.other_username, avatar: r.other_avatar || null },
    last_message: r.last_at
      ? { body: r.last_body || (r.last_attachments && r.last_attachments.length ? '📎 Attachment' : ''), created_at: r.last_at, is_mine: r.last_sender_id === req.user.id }
      : null,
    unread_count: r.unread_count,
  }));
  res.json({
    priority: mapped.filter(c => c.is_priority),
    chats: mapped.filter(c => !c.is_priority),
  });
});

// Requests = pending threads. Default (direction=received) is people who
// messaged me, awaiting my accept/deny. direction=sent is the flip side —
// my own outgoing requests still awaiting the other person's decision.
app.get('/api/dm/requests', requireAuth, async (req, res) => {
  const sent = req.query.direction === 'sent';
  const otherCol = sent ? 't.user_b_id' : 't.user_a_id';
  const meCol    = sent ? 't.user_a_id' : 't.user_b_id';
  const { rows } = await pool.query(
    `SELECT t.id, t.created_at,
            u.username AS other_username, u.display_name AS other_display_name, u.avatar AS other_avatar,
            m.body AS first_body
     FROM dm_threads t
     JOIN users u ON u.id = ${otherCol}
     LEFT JOIN LATERAL (
       SELECT body FROM dm_messages WHERE thread_id = t.id ORDER BY created_at ASC LIMIT 1
     ) m ON true
     WHERE t.status = 'pending' AND t.is_priority = false AND ${meCol} = $1
     ORDER BY t.created_at DESC`,
    [req.user.id]
  );
  res.json({
    requests: rows.map(r => ({
      id: r.id,
      created_at: r.created_at,
      other_user: { username: r.other_username, display_name: r.other_display_name || r.other_username, avatar: r.other_avatar || null },
      first_message: r.first_body || '',
    })),
  });
});

// Who can I start a new chat with — accounts I follow, optionally filtered.
app.get('/api/dm/following', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const { rows } = await pool.query(
    `SELECT u.username, u.display_name, u.avatar
     FROM user_follows f
     JOIN users u ON u.id = f.followed_id
     WHERE f.follower_id = $1 ${q ? 'AND (LOWER(u.username) LIKE $2 OR LOWER(u.display_name) LIKE $2)' : ''}
     ORDER BY u.username ASC LIMIT 30`,
    q ? [req.user.id, `%${q}%`] : [req.user.id]
  );
  res.json({ users: rows });
});

app.post('/api/dm/start', requireAuth, uploadInbox.array('attachments', 4), async (req, res) => {
  const username = String(req.body.username || '').toLowerCase();
  const body = String(req.body.body || '').trim().slice(0, 4000);
  const files = req.files || [];
  const attachments = files.map(f => ({ url: '/images/inbox/' + f.filename, name: f.originalname }));
  const gifUrl = (req.body.gif_url || '').trim();
  if (gifUrl) attachments.push({ url: gifUrl, name: 'GIF' });
  if (!body && !attachments.length) return res.status(400).json({ error: 'Message is required.' });

  const { rows: [target] } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't chat with yourself." });

  const { rows: [isFollowing] } = await pool.query(
    'SELECT 1 FROM user_follows WHERE follower_id = $1 AND followed_id = $2', [req.user.id, target.id]
  );
  if (!isFollowing) return res.status(403).json({ error: 'You can only start a chat with someone you follow.' });

  let { rows: [thread] } = await pool.query(
    'SELECT * FROM dm_threads WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)',
    [req.user.id, target.id]
  );
  if (!thread) {
    ({ rows: [thread] } = await pool.query(
      `INSERT INTO dm_threads (user_a_id, user_b_id) VALUES ($1, $2) RETURNING *`,
      [req.user.id, target.id]
    ));
  }
  await pool.query(
    'INSERT INTO dm_messages (thread_id, sender_id, body, attachments) VALUES ($1, $2, $3, $4)',
    [thread.id, req.user.id, body, JSON.stringify(attachments)]
  );
  res.json({ thread_id: thread.id, status: thread.status });
});

app.post('/api/dm/:id/accept', requireAuth, async (req, res) => {
  const { rows: [thread] } = await pool.query(
    "SELECT * FROM dm_threads WHERE id = $1 AND user_b_id = $2 AND status = 'pending'", [req.params.id, req.user.id]
  );
  if (!thread) return res.status(404).json({ error: 'Not found.' });
  await pool.query("UPDATE dm_threads SET status = 'accepted', accepted_at = NOW() WHERE id = $1", [thread.id]);
  res.json({ message: 'Accepted.' });
});

app.post('/api/dm/:id/deny', requireAuth, async (req, res) => {
  const { rows: [thread] } = await pool.query(
    "SELECT * FROM dm_threads WHERE id = $1 AND user_b_id = $2 AND status = 'pending'", [req.params.id, req.user.id]
  );
  if (!thread) return res.status(404).json({ error: 'Not found.' });
  await pool.query('DELETE FROM dm_threads WHERE id = $1', [thread.id]);
  res.json({ message: 'Denied.' });
});

// "Scrap" a High Priority broadcast — hides it until the next newsletter
// brings it back (dismissed_at is cleared whenever a new one goes out).
app.post('/api/dm/:id/dismiss', requireAuth, async (req, res) => {
  const { rows: [thread] } = await pool.query(
    'SELECT * FROM dm_threads WHERE id = $1 AND is_priority = true AND (user_a_id = $2 OR user_b_id = $2)',
    [req.params.id, req.user.id]
  );
  if (!thread) return res.status(404).json({ error: 'Not found.' });
  await pool.query('UPDATE dm_threads SET dismissed_at = NOW() WHERE id = $1', [thread.id]);
  res.json({ message: 'Dismissed.' });
});

// Deletes a regular chat outright (not for High Priority — those only ever
// go through /dismiss, since a future newsletter needs to be able to bring
// them back).
app.delete('/api/dm/:id', requireAuth, async (req, res) => {
  const { rows: [thread] } = await pool.query(
    'SELECT * FROM dm_threads WHERE id = $1 AND is_priority = false AND (user_a_id = $2 OR user_b_id = $2)',
    [req.params.id, req.user.id]
  );
  if (!thread) return res.status(404).json({ error: 'Not found.' });
  await pool.query('DELETE FROM dm_threads WHERE id = $1', [thread.id]);
  res.json({ message: 'Deleted.' });
});

app.get('/api/dm/:id/messages', requireAuth, async (req, res) => {
  const thread = await findDmThread(req.params.id, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Not found.' });

  // Included so a thread can be opened directly (e.g. restoring from a URL
  // hash on refresh) without the caller already knowing who's on the other end.
  const otherId = thread.user_a_id === req.user.id ? thread.user_b_id : thread.user_a_id;
  const { rows: [otherUser] } = await pool.query(
    'SELECT username, display_name, avatar FROM users WHERE id = $1', [otherId]
  );

  const { rows } = await pool.query(
    'SELECT id, sender_id, body, attachments, created_at FROM dm_messages WHERE thread_id = $1 ORDER BY created_at ASC',
    [thread.id]
  );
  await pool.query(
    'UPDATE dm_messages SET read_at = NOW() WHERE thread_id = $1 AND sender_id <> $2 AND read_at IS NULL',
    [thread.id, req.user.id]
  );
  res.json({
    thread: {
      id: thread.id, status: thread.status, is_priority: thread.is_priority,
      other_user: otherUser
        ? { username: otherUser.username, display_name: otherUser.display_name || otherUser.username, avatar: otherUser.avatar || null }
        : null,
    },
    messages: rows.map(m => ({
      id: m.id, body: m.body, attachments: m.attachments || [],
      created_at: m.created_at, is_mine: m.sender_id === req.user.id,
    })),
  });
});

app.post('/api/dm/:id/messages', requireAuth, uploadInbox.array('attachments', 4), async (req, res) => {
  const thread = await findDmThread(req.params.id, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Not found.' });
  const body = String(req.body.body || '').trim().slice(0, 4000);
  const files = req.files || [];
  const attachments = files.map(f => ({ url: '/images/inbox/' + f.filename, name: f.originalname }));
  const gifUrl = (req.body.gif_url || '').trim();
  if (gifUrl) attachments.push({ url: gifUrl, name: 'GIF' });
  if (!body && !attachments.length) return res.status(400).json({ error: 'Message is required.' });
  const { rows: [msg] } = await pool.query(
    'INSERT INTO dm_messages (thread_id, sender_id, body, attachments) VALUES ($1, $2, $3, $4) RETURNING id, body, attachments, created_at',
    [thread.id, req.user.id, body, JSON.stringify(attachments)]
  );
  res.json({ message: { id: msg.id, body: msg.body, attachments: msg.attachments || [], created_at: msg.created_at, is_mine: true } });
});

app.get('/api/dm/unread-count', requireAuth, async (req, res) => {
  const { rows: [{ count }] } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM dm_messages m
     JOIN dm_threads t ON t.id = m.thread_id AND t.status = 'accepted'
     WHERE (t.user_a_id = $1 OR t.user_b_id = $1) AND m.sender_id <> $1 AND m.read_at IS NULL`,
    [req.user.id]
  );
  res.json({ count });
});

// PUT /api/account/profile — the in-line "Edit Profile" editor on a user's
// own /fanpages/:username page writes the same about-section fields the
// old root /profile page already exposed for reading.
// Every field here is opt-in via COALESCE — omitting a key from the request
// body leaves that column untouched, so a caller updating just one field
// (e.g. the display-name-only modal) can't accidentally blank out the rest.
app.put('/api/account/profile', requireAuth, async (req, res) => {
  const pronouns = req.body.pronouns !== undefined ? String(req.body.pronouns).slice(0, 60) : null;
  const favoritePokemon = req.body.favorite_pokemon !== undefined ? String(req.body.favorite_pokemon).slice(0, 60) : null;
  const accountBio = req.body.account_bio !== undefined ? String(req.body.account_bio).slice(0, 1000) : null;
  const funFact = req.body.fun_fact !== undefined ? String(req.body.fun_fact).slice(0, 300) : null;
  const links = Array.isArray(req.body.account_links)
    ? JSON.stringify(req.body.account_links
        .filter(l => l && l.url)
        .slice(0, 10)
        .map(l => ({ label: String(l.label || l.url).slice(0, 40), url: String(l.url).slice(0, 300) })))
    : null;
  // display_name is shared account-wide (main BTW site, Fanpages, chat, etc).
  const displayName = req.body.display_name !== undefined
    ? String(req.body.display_name).trim().slice(0, 20) || null
    : null;

  await pool.query(
    `UPDATE users SET
       pronouns = COALESCE($1, pronouns),
       favorite_pokemon = COALESCE($2, favorite_pokemon),
       account_bio = COALESCE($3, account_bio),
       fun_fact = COALESCE($4, fun_fact),
       account_links = COALESCE($5, account_links),
       display_name = COALESCE($7, display_name)
     WHERE id = $6`,
    [pronouns, favoritePokemon, accountBio, funFact, links, req.user.id, displayName]
  );
  res.json({ message: 'Profile updated.' });
});

// Profile page theme — same default/custom-blurred-background pattern as a
// story's theme, just scoped to the account instead of a moderator_sites row.
app.put('/api/account/theme', requireAuth, async (req, res) => {
  const theme = req.body.theme === 'custom' ? 'custom' : 'default';
  await pool.query('UPDATE users SET profile_theme = $1 WHERE id = $2', [theme, req.user.id]);
  res.json({ theme });
});

app.put('/api/account/theme-bg', requireAuth, uploadModImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const bgUrl = `/images/moderators/${req.file.filename}`;
  await pool.query(`UPDATE users SET profile_theme_bg_url = $1, profile_theme = 'custom' WHERE id = $2`, [bgUrl, req.user.id]);
  res.json({ theme: 'custom', theme_bg_url: bgUrl });
});

// Same default/custom-background pattern, scoped to the Notifications/Inbox
// page instead of the profile page — its own separate background.
app.put('/api/account/notif-theme', requireAuth, async (req, res) => {
  const theme = req.body.theme === 'custom' ? 'custom' : 'default';
  await pool.query('UPDATE users SET notif_theme = $1 WHERE id = $2', [theme, req.user.id]);
  res.json({ theme });
});

app.put('/api/account/notif-theme-bg', requireAuth, uploadModImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const bgUrl = `/images/moderators/${req.file.filename}`;
  await pool.query(`UPDATE users SET notif_theme_bg_url = $1, notif_theme = 'custom' WHERE id = $2`, [bgUrl, req.user.id]);
  res.json({ theme: 'custom', theme_bg_url: bgUrl });
});

// PUT /api/account/banner — the profile page's own banner image, distinct
// from a moderator's story banner. Reuses the moderator image upload dir
// since it's already public under /images/moderators/.
app.put('/api/account/banner', requireAuth, uploadModImage.single('banner'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const bannerUrl = `/images/moderators/${req.file.filename}`;
  const x = parseInt(req.body.position_x, 10);
  const y = parseInt(req.body.position_y, 10);
  const posX = Number.isFinite(x) ? x : 50;
  const posY = Number.isFinite(y) ? y : 50;
  await pool.query(
    `UPDATE users SET account_banner_url = $1, account_banner_position_x = $2, account_banner_position_y = $3 WHERE id = $4`,
    [bannerUrl, posX, posY, req.user.id]
  );
  res.json({ banner_url: bannerUrl, position_x: posX, position_y: posY });
});

app.put('/api/account/banner-position', requireAuth, async (req, res) => {
  const x = parseInt(req.body.position_x, 10);
  const y = parseInt(req.body.position_y, 10);
  if (![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 100)) return res.status(400).json({ error: 'Positions must be 0-100.' });
  await pool.query('UPDATE users SET account_banner_position_x = $1, account_banner_position_y = $2 WHERE id = $3', [x, y, req.user.id]);
  res.json({ message: 'Updated.' });
});

// GET /api/featured-search — powers the Featured Characters / Featured
// Gallery pickers in the in-line profile editor. Searches across every
// fanpage story's characters/gallery (not just the viewer's own), so users
// can feature a favorite from any community story. Results from the
// viewer's own site(s) are surfaced first.
app.get('/api/featured-search', requireAuth, async (req, res) => {
  const kind = req.query.kind === 'gallery' ? 'gallery' : 'character';
  const q = `%${String(req.query.q || '').slice(0, 60)}%`;

  // Characters/gallery can now be linked to zero, one, or several stories —
  // pick any ONE linked story (if any) just to build a link_url; when none
  // exists, the item lives standalone on its owner's profile instead.
  let rows;
  if (kind === 'character') {
    ({ rows } = await pool.query(
      `SELECT mc.id, mc.name AS title, mc.ref_image AS image_url, mc.owner_user_id,
              ms.story_path, ms.slug, u.username AS owner_username
       FROM moderator_characters mc
       LEFT JOIN LATERAL (
         SELECT site_id FROM character_story_links WHERE character_id = mc.id ORDER BY site_id LIMIT 1
       ) csl ON true
       LEFT JOIN moderator_sites ms ON ms.id = csl.site_id
       JOIN users u ON u.id = mc.owner_user_id
       WHERE mc.name ILIKE $1 ORDER BY mc.name LIMIT 30`,
      [q]
    ));
  } else {
    ({ rows } = await pool.query(
      `SELECT mg.id, mg.title AS title, mg.image_url AS image_url, mg.owner_user_id,
              ms.story_path, ms.slug, u.username AS owner_username
       FROM moderator_gallery mg
       LEFT JOIN LATERAL (
         SELECT site_id FROM gallery_story_links WHERE gallery_id = mg.id ORDER BY site_id LIMIT 1
       ) gsl ON true
       LEFT JOIN moderator_sites ms ON ms.id = gsl.site_id
       JOIN users u ON u.id = mg.owner_user_id
       WHERE mg.category != 'spicy' AND mg.title ILIKE $1 ORDER BY mg.title LIMIT 30`,
      [q]
    ));
  }

  const results = rows
    .map(r => ({
      ref_id: String(r.id),
      title: r.title || 'Untitled',
      image_url: r.image_url || '',
      link_url: r.story_path || r.slug
        ? `/fanpages/${r.story_path || r.slug}${kind === 'character' ? '/characters' : '/gallery'}`
        : `/fanpages/${r.owner_username}`,
      mine: r.owner_user_id === req.user.id,
    }))
    .sort((a, b) => (b.mine - a.mine));

  res.json({ results });
});

// PUT /api/account/featured — replaces the caller's featured-characters or
// featured-gallery set (max 3) in one shot.
app.put('/api/account/featured', requireAuth, async (req, res) => {
  const kind = req.body.kind === 'gallery' ? 'gallery' : 'character';
  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 3) : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_featured_items WHERE user_id = $1 AND kind = $2', [req.user.id, kind]);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await client.query(
        `INSERT INTO user_featured_items (user_id, kind, source, site_slug, ref_id, title, image_url, link_url, sort_order)
         VALUES ($1, $2, 'fanpage', $3, $4, $5, $6, $7, $8)`,
        [req.user.id, kind, it.site_slug || null, String(it.ref_id || ''), String(it.title || '').slice(0, 80),
         String(it.image_url || '').slice(0, 300), String(it.link_url || '').slice(0, 300), i]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ message: 'Featured items updated.' });
});

// GET /api/moderator-sites/:slug — public read, powers the static moderator pages.
// Spicy gallery items are only included when the request carries a valid token,
// mirroring how BTW's own /spicy page gates content. Kept for callers with only
// a single-segment identity (an author's one-and-only story, or legacy links);
// authors with multiple stories are looked up by the more specific story_path
// route below instead, since slug (their identity) is no longer unique.
app.get('/api/moderator-sites/:slug', async (req, res) => {
  await sendSiteLookup(
    `SELECT ms.*, u.display_name AS author_display_name, u.username AS author_username, u.avatar AS author_avatar
     FROM moderator_sites ms JOIN users u ON u.id = ms.owner_user_id
     WHERE ms.slug = $1 ORDER BY ms.created_at ASC LIMIT 1`,
    [req.params.slug], req, res
  );
});

// GET /api/moderator-sites/by-path/:owner/:story — the precise per-story
// lookup, used by every story-template page now that one author can have
// several stories sharing the same slug/identity.
app.get('/api/moderator-sites/by-path/:owner/:story', async (req, res) => {
  await sendSiteLookup(
    `SELECT ms.*, u.display_name AS author_display_name, u.username AS author_username, u.avatar AS author_avatar
     FROM moderator_sites ms JOIN users u ON u.id = ms.owner_user_id
     WHERE ms.story_path = $1`,
    [`${req.params.owner}/${req.params.story}`], req, res
  );
});

async function sendSiteLookup(query, params, req, res) {
  const { rows: [site] } = await pool.query(query, params);
  if (!site) return res.status(404).json({ error: 'Not found.' });

  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }
  const loggedIn = viewerId !== null;

  const [{ rows: chapters }, { rows: characters }, { rows: gallery }, isFollowing, isBookmarked, likedGalleryIds] = await Promise.all([
    pool.query('SELECT id, title, teaser, links, image_url, file_url, file_name FROM moderator_chapters WHERE site_id = $1 ORDER BY sort_order, id', [site.id]),
    pool.query(`
      SELECT mc.id, mc.name, mc.ref_image, mc.ref_position_x, mc.ref_position_y, mc.description, mc.stats, mc.facts, mc.lore, mc.relationships
      FROM character_story_links csl JOIN moderator_characters mc ON mc.id = csl.character_id
      WHERE csl.site_id = $1 ORDER BY csl.sort_order, mc.id
    `, [site.id]),
    pool.query(`
      SELECT mg.id, mg.category, mg.image_url, mg.title, mg.description, mg.position_x, mg.position_y,
             (SELECT count(*) FROM moderator_gallery_likes WHERE gallery_id = mg.id) AS like_count
      FROM gallery_story_links gsl JOIN moderator_gallery mg ON mg.id = gsl.gallery_id
      WHERE gsl.site_id = $1 ORDER BY gsl.sort_order, mg.id
    `, [site.id]),
    viewerId
      ? pool.query('SELECT 1 FROM user_follows WHERE follower_id = $1 AND followed_id = $2', [viewerId, site.owner_user_id])
      : Promise.resolve({ rows: [] }),
    viewerId
      ? pool.query('SELECT 1 FROM moderator_bookmarks WHERE user_id = $1 AND site_id = $2', [viewerId, site.id])
      : Promise.resolve({ rows: [] }),
    viewerId
      ? pool.query('SELECT gallery_id FROM moderator_gallery_likes WHERE user_id = $1', [viewerId])
      : Promise.resolve({ rows: [] }),
  ]);

  const likedSet = new Set(likedGalleryIds.rows.map(r => r.gallery_id));
  gallery.forEach(g => {
    g.like_count = Number(g.like_count);
    g.liked = likedSet.has(g.id);
  });

  res.json({
    site: {
      slug: site.slug, story_path: site.story_path, site_title: site.site_title, synopsis: site.synopsis,
      bio: site.bio, links: site.links, banner_url: site.banner_url,
      banner_position: site.banner_position, theme: site.theme, theme_bg_url: site.theme_bg_url,
      cover_url: site.cover_url, cover_position_x: site.cover_position_x, cover_position_y: site.cover_position_y,
      characters_card_url: site.characters_card_url, chapters_card_url: site.chapters_card_url, gallery_card_url: site.gallery_card_url,
      characters_card_position_x: site.characters_card_position_x, characters_card_position_y: site.characters_card_position_y,
      chapters_card_position_x: site.chapters_card_position_x, chapters_card_position_y: site.chapters_card_position_y,
      gallery_card_position_x: site.gallery_card_position_x, gallery_card_position_y: site.gallery_card_position_y,
      author_display_name: site.author_display_name, author_username: site.author_username,
      author_avatar: site.author_avatar || null,
      tags: site.tags || [],
      is_self: viewerId === site.owner_user_id,
      is_following: isFollowing.rows.length > 0,
      is_bookmarked: isBookmarked.rows.length > 0,
    },
    chapters,
    characters,
    gallery_sfw:      gallery.filter(g => g.category === 'sfw'),
    gallery_sketches: gallery.filter(g => g.category === 'sketches'),
    gallery_spicy:    loggedIn ? gallery.filter(g => g.category === 'spicy') : [],
  });
}

// GET /api/moderator-sites/:slug/is-owner — does the logged-in user own THIS
// specific site? (Not just "are they a moderator somewhere" — important once
// there's more than one moderator, so one moderator never sees another's
// Edit Profile button.)
app.get('/api/moderator-sites/:slug/is-owner', requireAuth, async (req, res) => {
  const { rows: [site] } = await pool.query('SELECT owner_user_id FROM moderator_sites WHERE slug = $1', [req.params.slug]);
  res.json({ isOwner: !!site && site.owner_user_id === req.user.id });
});

// GET /api/moderator/my-sites — every story the logged-in user owns, for the
// "My Stories" page. Doesn't go through requireModerator since that resolves
// to a single story — this deliberately lists all of them.
app.get('/api/moderator/my-sites', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ms.id, ms.slug, ms.story_path, ms.site_title, ms.cover_url, ms.banner_url, u.avatar
     FROM moderator_sites ms JOIN users u ON u.id = ms.owner_user_id
     WHERE ms.owner_user_id = $1 ORDER BY ms.created_at ASC`,
    [req.user.id]
  );
  res.json({ sites: rows.map(s => ({ ...s, author_avatar: s.avatar || null, avatar: undefined })) });
});

// ── Site (Above All Else / Meet Blue text + links) ────────────────────────────
app.get('/api/moderator/site', requireAuth, requireModerator, async (req, res) => {
  res.json({ site: req.modSite });
});

app.put('/api/moderator/site/banner', requireAuth, requireModerator, uploadModImage.single('banner'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const bannerUrl = `/images/moderators/${req.file.filename}`;
  const position = parseInt(req.body.position, 10);
  const { rows: [site] } = await pool.query(
    'UPDATE moderator_sites SET banner_url = $1, banner_position = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
    [bannerUrl, Number.isFinite(position) ? position : 50, req.modSite.id]
  );
  res.json({ site });
});

app.put('/api/moderator/site/banner-position', requireAuth, requireModerator, async (req, res) => {
  const position = parseInt(req.body.position, 10);
  if (!Number.isFinite(position) || position < 0 || position > 100) return res.status(400).json({ error: 'Position must be 0-100.' });
  const { rows: [site] } = await pool.query(
    'UPDATE moderator_sites SET banner_position = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [position, req.modSite.id]
  );
  res.json({ site });
});

// ── Book cover — sits beside the story description on the About section ──────
app.put('/api/moderator/site/cover', requireAuth, requireModerator, uploadModImage.single('cover'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const coverUrl = `/images/moderators/${req.file.filename}`;
  const x = parseInt(req.body.position_x, 10);
  const y = parseInt(req.body.position_y, 10);
  const { rows: [site] } = await pool.query(
    `UPDATE moderator_sites SET cover_url = $1, cover_position_x = $2, cover_position_y = $3, updated_at = NOW() WHERE id = $4 RETURNING *`,
    [coverUrl, Number.isFinite(x) ? x : 50, Number.isFinite(y) ? y : 50, req.modSite.id]
  );
  res.json({ site });
});

app.put('/api/moderator/site/cover-position', requireAuth, requireModerator, async (req, res) => {
  const x = parseInt(req.body.position_x, 10);
  const y = parseInt(req.body.position_y, 10);
  if (![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 100)) return res.status(400).json({ error: 'Positions must be 0-100.' });
  const { rows: [site] } = await pool.query(
    'UPDATE moderator_sites SET cover_position_x = $1, cover_position_y = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
    [x, y, req.modSite.id]
  );
  res.json({ site });
});

// Uploaded custom blurred background image, used when theme = 'custom'
app.put('/api/moderator/site/theme-bg', requireAuth, requireModerator, uploadModImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const bgUrl = `/images/moderators/${req.file.filename}`;
  const { rows: [site] } = await pool.query(
    `UPDATE moderator_sites SET theme_bg_url = $1, theme = 'custom', updated_at = NOW() WHERE id = $2 RETURNING *`,
    [bgUrl, req.modSite.id]
  );
  res.json({ site });
});

// Quick-nav card art (Characters/Chapters/Gallery shortcut cards on the story
// home page). :kind is checked against a fixed whitelist before being used
// in the column names, so this is safe from injection despite the interpolation.
const NAV_CARD_COLUMNS = {
  characters: { url: 'characters_card_url', x: 'characters_card_position_x', y: 'characters_card_position_y' },
  chapters:   { url: 'chapters_card_url',   x: 'chapters_card_position_x',   y: 'chapters_card_position_y' },
  gallery:    { url: 'gallery_card_url',    x: 'gallery_card_position_x',    y: 'gallery_card_position_y' },
};
app.put('/api/moderator/site/nav-card/:kind', requireAuth, requireModerator, uploadModImage.single('image'), async (req, res) => {
  const cols = NAV_CARD_COLUMNS[req.params.kind];
  if (!cols) return res.status(400).json({ error: 'Invalid card.' });
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const url = `/images/moderators/${req.file.filename}`;
  const { rows: [site] } = await pool.query(
    `UPDATE moderator_sites SET ${cols.url} = $1, ${cols.x} = 50, ${cols.y} = 50, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [url, req.modSite.id]
  );
  res.json({ site });
});

app.put('/api/moderator/site/nav-card/:kind/position', requireAuth, requireModerator, async (req, res) => {
  const cols = NAV_CARD_COLUMNS[req.params.kind];
  if (!cols) return res.status(400).json({ error: 'Invalid card.' });
  const x = parseInt(req.body.position_x, 10);
  const y = parseInt(req.body.position_y, 10);
  if (![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 100)) return res.status(400).json({ error: 'Positions must be 0-100.' });
  const { rows: [site] } = await pool.query(
    `UPDATE moderator_sites SET ${cols.x} = $1, ${cols.y} = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
    [x, y, req.modSite.id]
  );
  res.json({ site });
});

// Wattpad/e621-style tags: lowercased, whitespace collapsed to underscores,
// deduped, capped at 100. Bad input silently gets cleaned up rather than
// rejected — this is discovery metadata, not user-facing prose.
function sanitizeTags(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const clean = t.trim().replace(/\s+/g, '_').toLowerCase().slice(0, 40);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 100) break;
  }
  return out;
}

app.put('/api/moderator/site', requireAuth, requireModerator, async (req, res) => {
  const { site_title, synopsis, bio, links, theme } = req.body;
  const tags = req.body.tags !== undefined ? sanitizeTags(req.body.tags) : undefined;
  const { rows: [site] } = await pool.query(
    `UPDATE moderator_sites SET
       site_title = COALESCE($1, site_title),
       synopsis   = COALESCE($2, synopsis),
       bio        = COALESCE($3, bio),
       links      = COALESCE($4, links),
       theme      = COALESCE($5, theme),
       tags       = COALESCE($6, tags),
       updated_at = NOW()
     WHERE id = $7 RETURNING *`,
    [site_title, synopsis, bio, links !== undefined ? JSON.stringify(links) : null, theme,
     tags !== undefined ? JSON.stringify(tags) : null, req.modSite.id]
  );
  res.json({ site });
});

// DELETE /api/moderator/site — permanently deletes the whole story. Characters/
// chapters/gallery/bookmarks cascade via FK; uploaded images/files are best-effort
// cleaned up first (shared static assets on migrated data are never touched).
app.delete('/api/moderator/site', requireAuth, requireModerator, async (req, res) => {
  const site = req.modSite;
  const isUploadedFile = (url) => !!url && (url.startsWith('/images/moderators/') || url.startsWith('/moderators/files/'));
  const unlinkIfUploaded = (url) => {
    if (!isUploadedFile(url)) return;
    const fp = path.join('/var/www/btw', url);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  };

  // Characters and gallery posts are independent entities now (may be linked
  // to other stories, or standalone on the profile) — deleting a site must
  // NOT touch their images. Only chapters still belong exclusively to a site.
  const { rows: chapters } = await pool.query(
    'SELECT image_url, file_url FROM moderator_chapters WHERE site_id = $1', [site.id]
  );

  [site.banner_url, site.cover_url, site.theme_bg_url, site.characters_card_url, site.chapters_card_url, site.gallery_card_url]
    .forEach(unlinkIfUploaded);
  chapters.forEach(c => { unlinkIfUploaded(c.image_url); unlinkIfUploaded(c.file_url); });

  await pool.query('DELETE FROM moderator_sites WHERE id = $1', [site.id]);
  res.json({ message: 'Deleted.' });
});

// ── Chapters ───────────────────────────────────────────────────────────────────
app.get('/api/moderator/chapters', requireAuth, requireModerator, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM moderator_chapters WHERE site_id = $1 ORDER BY sort_order, id', [req.modSite.id]);
  res.json({ chapters: rows });
});

function parseChapterLinks(raw) {
  let links = [];
  try { links = JSON.parse(raw || '[]'); } catch { links = []; }
  if (!Array.isArray(links)) return [];
  return links
    .filter(l => l && l.label && l.url)
    .map(l => ({ label: String(l.label).trim(), url: String(l.url).trim() }));
}

app.post('/api/moderator/chapters', requireAuth, requireModerator, uploadChapter.fields([{ name: 'image', maxCount: 1 }, { name: 'file', maxCount: 1 }]), async (req, res) => {
  const { title, teaser } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
  const links = parseChapterLinks(req.body.links);

  const imageFile = req.files && req.files.image && req.files.image[0];
  const docFile   = req.files && req.files.file  && req.files.file[0];
  const imageUrl  = imageFile ? `/images/moderators/${imageFile.filename}` : '';
  const fileUrl   = docFile   ? `/moderators/files/${docFile.filename}`    : '';
  const fileName  = docFile   ? docFile.originalname : '';

  const { rows: [{ maxOrder }] } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder" FROM moderator_chapters WHERE site_id = $1', [req.modSite.id]
  );
  const { rows: [chapter] } = await pool.query(
    `INSERT INTO moderator_chapters (site_id, title, teaser, links, image_url, file_url, file_name, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [req.modSite.id, title.trim(), (teaser || '').trim(), JSON.stringify(links), imageUrl, fileUrl, fileName, maxOrder + 1]
  );
  res.json({ chapter });
});

app.put('/api/moderator/chapters/:id', requireAuth, requireModerator, uploadChapter.fields([{ name: 'image', maxCount: 1 }, { name: 'file', maxCount: 1 }]), async (req, res) => {
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM moderator_chapters WHERE id = $1 AND site_id = $2', [req.params.id, req.modSite.id]
  );
  if (!existing) return res.status(404).json({ error: 'Not found.' });

  const { title, teaser } = req.body;
  const links = req.body.links !== undefined ? parseChapterLinks(req.body.links) : existing.links;

  const imageFile = req.files && req.files.image && req.files.image[0];
  const docFile   = req.files && req.files.file  && req.files.file[0];

  // Only ever delete files that live under the uploads dirs — migrated
  // chapters can point image_url at a shared site asset (e.g. a main-site
  // chapter cover), which must never be unlinked from disk.
  const isUploadedFile = (url) => !!url && (url.startsWith('/images/moderators/') || url.startsWith('/moderators/files/'));

  let imageUrl = existing.image_url;
  if (imageFile) {
    imageUrl = `/images/moderators/${imageFile.filename}`;
    if (isUploadedFile(existing.image_url)) fs.unlinkSync(path.join('/var/www/btw', existing.image_url));
  } else if (req.body.remove_image === 'true') {
    imageUrl = '';
    if (isUploadedFile(existing.image_url)) fs.unlinkSync(path.join('/var/www/btw', existing.image_url));
  }
  let fileUrl = existing.file_url;
  let fileName = existing.file_name;
  if (docFile) {
    fileUrl = `/moderators/files/${docFile.filename}`;
    fileName = docFile.originalname;
    if (isUploadedFile(existing.file_url)) fs.unlinkSync(path.join('/var/www/btw', existing.file_url));
  }

  const { rows: [chapter] } = await pool.query(
    `UPDATE moderator_chapters SET
       title = COALESCE($1, title), teaser = COALESCE($2, teaser),
       links = $3, image_url = $4, file_url = $5, file_name = $6
     WHERE id = $7 RETURNING *`,
    [title ? title.trim() : null, teaser !== undefined ? teaser.trim() : null, JSON.stringify(links), imageUrl, fileUrl, fileName, existing.id]
  );
  res.json({ chapter });
});

app.delete('/api/moderator/chapters/:id', requireAuth, requireModerator, async (req, res) => {
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM moderator_chapters WHERE id = $1 AND site_id = $2', [req.params.id, req.modSite.id]
  );
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  const isUploadedFile = (url) => !!url && (url.startsWith('/images/moderators/') || url.startsWith('/moderators/files/'));
  if (isUploadedFile(existing.image_url)) fs.unlinkSync(path.join('/var/www/btw', existing.image_url));
  if (isUploadedFile(existing.file_url)) fs.unlinkSync(path.join('/var/www/btw', existing.file_url));
  await pool.query('DELETE FROM moderator_chapters WHERE id = $1', [existing.id]);
  res.json({ message: 'Deleted.' });
});

// ── Characters ─────────────────────────────────────────────────────────────────
// Standalone image upload — returns a URL to embed as ref_image in the
// character's create/update JSON payload, since the character doesn't need
// to exist yet (or might just be having its image swapped) for this step.
app.post('/api/moderator/character-image', requireAuth, uploadModImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  res.json({ url: `/images/moderators/${req.file.filename}` });
});

// A story's Characters roster — now a many-to-many via character_story_links,
// so this lists whatever's linked to the CURRENT story, not everything the
// user owns.
app.get('/api/moderator/characters', requireAuth, requireModerator, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT mc.*, csl.sort_order AS link_sort_order
     FROM character_story_links csl
     JOIN moderator_characters mc ON mc.id = csl.character_id
     WHERE csl.site_id = $1
     ORDER BY csl.sort_order, mc.id`,
    [req.modSite.id]
  );
  res.json({ characters: rows });
});

// Instant "create + attach to this story" — same one-click flow authors are
// used to. Ownership lives on the character itself (owner_user_id); the
// link to this story is a separate row, so the same character can later be
// linked into other stories too without being duplicated.
app.post('/api/moderator/characters', requireAuth, requireModerator, async (req, res) => {
  const { name, ref_image, description, stats, facts, lore, relationships } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  const { rows: [character] } = await pool.query(
    `INSERT INTO moderator_characters (owner_user_id, name, ref_image, description, stats, facts, lore, relationships)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [req.user.id, name.trim(), ref_image || '/images/defaultchar.jpg', description || '',
     JSON.stringify(stats || {}), JSON.stringify(facts || []), JSON.stringify(lore || []),
     JSON.stringify(relationships || [])]
  );
  const { rows: [{ maxOrder }] } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder" FROM character_story_links WHERE site_id = $1', [req.modSite.id]
  );
  await pool.query(
    'INSERT INTO character_story_links (character_id, site_id, sort_order) VALUES ($1, $2, $3)',
    [character.id, req.modSite.id, maxOrder + 1]
  );
  res.json({ character });
});

// Editing a character is about owning it, not which story screen you're on —
// works the same whether it's linked to one story, ten, or none at all.
app.put('/api/moderator/characters/:id', requireAuth, async (req, res) => {
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM moderator_characters WHERE id = $1 AND owner_user_id = $2', [req.params.id, req.user.id]
  );
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  const { name, ref_image, description, stats, facts, lore, relationships, sort_order } = req.body;
  const { rows: [character] } = await pool.query(
    `UPDATE moderator_characters SET
       name          = COALESCE($1, name),
       ref_image     = COALESCE($2, ref_image),
       description   = COALESCE($3, description),
       stats         = COALESCE($4, stats),
       facts         = COALESCE($5, facts),
       lore          = COALESCE($6, lore),
       relationships = COALESCE($7, relationships),
       sort_order    = COALESCE($8, sort_order)
     WHERE id = $9 RETURNING *`,
    [name, ref_image, description,
     stats !== undefined ? JSON.stringify(stats) : null,
     facts !== undefined ? JSON.stringify(facts) : null,
     lore !== undefined ? JSON.stringify(lore) : null,
     relationships !== undefined ? JSON.stringify(relationships) : null,
     sort_order, existing.id]
  );
  res.json({ character });
});

app.put('/api/moderator/characters/:id/position', requireAuth, async (req, res) => {
  const x = parseInt(req.body.position_x, 10);
  const y = parseInt(req.body.position_y, 10);
  if (![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 100)) return res.status(400).json({ error: 'Positions must be 0-100.' });
  const { rows: [existing] } = await pool.query(
    'SELECT id FROM moderator_characters WHERE id = $1 AND owner_user_id = $2', [req.params.id, req.user.id]
  );
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  const { rows: [character] } = await pool.query(
    'UPDATE moderator_characters SET ref_position_x = $1, ref_position_y = $2 WHERE id = $3 RETURNING *',
    [x, y, existing.id]
  );
  res.json({ character });
});

// "Remove" from a story's roster now means UNLINK, not delete — the same
// character might be linked into other stories, or exist standalone on the
// owner's profile, and neither should vanish just because it was pulled out
// of this one book. Permanent deletion lives at DELETE /api/characters/:id.
app.delete('/api/moderator/characters/:id', requireAuth, requireModerator, async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM character_story_links WHERE character_id = $1 AND site_id = $2', [req.params.id, req.modSite.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Not found.' });
  res.json({ message: 'Unlinked from this story.' });
});

// Search the current user's OWN characters not yet linked to this story —
// feeds the "+ Link Existing" picker.
// Every character the requesting user owns, regardless of story links —
// backs the relationship "tag an existing character" picker, which cares
// only about "does this character exist," not whether it's on the current
// story's roster (a relationship can point anywhere, in or out of context).
app.get('/api/characters/mine', requireAuth, async (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const { rows } = await pool.query(
    `SELECT id, name, ref_image FROM moderator_characters WHERE owner_user_id = $1 AND name ILIKE $2 ORDER BY name LIMIT 30`,
    [req.user.id, q]
  );
  res.json({ characters: rows });
});

// Cross-owner character search — the "Other Characters" tab of the
// relationship picker, so e.g. tagging a friend's character (a different
// Hydra than your own) on one of yours is findable. Always includes the
// owner's name/avatar alongside each result so same-named characters from
// different people are never ambiguous before you click one.
app.get('/api/characters/search', requireAuth, async (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const { rows } = await pool.query(
    `SELECT mc.id, mc.name, mc.ref_image, u.username AS owner_username, u.display_name AS owner_display_name
     FROM moderator_characters mc
     JOIN users u ON u.id = mc.owner_user_id
     WHERE mc.owner_user_id <> $1 AND mc.name ILIKE $2
     ORDER BY mc.name LIMIT 30`,
    [req.user.id, q]
  );
  res.json({
    characters: rows.map(r => ({
      id: r.id, name: r.name, ref_image: r.ref_image,
      owner_username: r.owner_username, owner_display_name: r.owner_display_name || r.owner_username,
    })),
  });
});

app.get('/api/moderator/characters/linkable', requireAuth, requireModerator, async (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const { rows } = await pool.query(
    `SELECT id, name, ref_image
     FROM moderator_characters
     WHERE owner_user_id = $1 AND name ILIKE $2
       AND id NOT IN (SELECT character_id FROM character_story_links WHERE site_id = $3)
     ORDER BY name LIMIT 30`,
    [req.user.id, q, req.modSite.id]
  );
  res.json({ characters: rows });
});

app.post('/api/moderator/characters/:id/link', requireAuth, requireModerator, async (req, res) => {
  const { rows: [character] } = await pool.query(
    'SELECT id FROM moderator_characters WHERE id = $1 AND owner_user_id = $2', [req.params.id, req.user.id]
  );
  if (!character) return res.status(404).json({ error: 'Not found.' });
  const { rows: [{ maxOrder }] } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder" FROM character_story_links WHERE site_id = $1', [req.modSite.id]
  );
  await pool.query(
    'INSERT INTO character_story_links (character_id, site_id, sort_order) VALUES ($1, $2, $3) ON CONFLICT (character_id, site_id) DO NOTHING',
    [character.id, req.modSite.id, maxOrder + 1]
  );
  res.json({ message: 'Linked.' });
});

// Public, unscoped character lookup — fetches ANY character by id regardless
// of who owns it or which story (if any) it's linked to. Backs two things:
// the standalone canonical character page, and the "ghost slot" that shows
// a relationship-linked character who isn't part of the current story's
// cast (or the current profile's roster) without navigating away.
app.get('/api/characters/:id', async (req, res) => {
  const { rows: [character] } = await pool.query(
    `SELECT mc.*, u.username AS owner_username, u.display_name AS owner_display_name
     FROM moderator_characters mc
     JOIN users u ON u.id = mc.owner_user_id
     WHERE mc.id = $1`,
    [req.params.id]
  );
  if (!character) return res.status(404).json({ error: 'Not found.' });
  res.json({ character });
});

// Standalone creation — no story context at all, lands on the owner's
// profile Characters tab. Requires nothing beyond a regular account (not
// requireModerator — RPers/artists with zero stories should still be able
// to make characters).
app.post('/api/characters', requireAuth, async (req, res) => {
  const { name, ref_image, description, stats, facts, lore, relationships } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  const { rows: [character] } = await pool.query(
    `INSERT INTO moderator_characters (owner_user_id, name, ref_image, description, stats, facts, lore, relationships)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [req.user.id, name.trim(), ref_image || '/images/defaultchar.jpg', description || '',
     JSON.stringify(stats || {}), JSON.stringify(facts || []), JSON.stringify(lore || []),
     JSON.stringify(relationships || [])]
  );
  res.json({ character });
});

// Permanent delete — the only way a character actually goes away. Cascades
// character_story_links automatically via FK.
app.delete('/api/characters/:id', requireAuth, async (req, res) => {
  const { rows: [existing] } = await pool.query(
    'SELECT id FROM moderator_characters WHERE id = $1 AND owner_user_id = $2', [req.params.id, req.user.id]
  );
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  await pool.query('DELETE FROM moderator_characters WHERE id = $1', [existing.id]);
  res.json({ message: 'Deleted.' });
});

// ── Gallery (SFW + Spicy) ──────────────────────────────────────────────────────
// A story's Gallery roster — many-to-many via gallery_story_links, same
// pattern as characters (lists what's linked to THIS story).
app.get('/api/moderator/gallery', requireAuth, requireModerator, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT mg.*, gsl.sort_order AS link_sort_order
     FROM gallery_story_links gsl
     JOIN moderator_gallery mg ON mg.id = gsl.gallery_id
     WHERE gsl.site_id = $1
     ORDER BY gsl.sort_order, mg.id`,
    [req.modSite.id]
  );
  res.json({ gallery: rows });
});

function clampPosition(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 50;
}

// Instant "create + attach to this story" — mirrors the character flow.
app.post('/api/moderator/gallery', requireAuth, requireModerator, uploadModImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const { category, title, description } = req.body;
  if (!['sfw', 'sketches', 'spicy'].includes(category)) return res.status(400).json({ error: 'Category must be sfw, sketches, or spicy.' });

  const imageUrl = `/images/moderators/${req.file.filename}`;
  const positionX = clampPosition(req.body.position_x);
  const positionY = clampPosition(req.body.position_y);
  const { rows: [item] } = await pool.query(
    `INSERT INTO moderator_gallery (owner_user_id, category, image_url, title, description, position_x, position_y)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [req.user.id, category, imageUrl, (title || '').trim(), (description || '').trim(), positionX, positionY]
  );
  const { rows: [{ maxOrder }] } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder" FROM gallery_story_links WHERE site_id = $1', [req.modSite.id]
  );
  await pool.query(
    'INSERT INTO gallery_story_links (gallery_id, site_id, sort_order) VALUES ($1, $2, $3)',
    [item.id, req.modSite.id, maxOrder + 1]
  );
  res.json({ item });
});

// Editing/deleting a gallery post is about owning it, same as characters —
// works from any context, story-linked or standalone.
app.put('/api/moderator/gallery/:id', requireAuth, uploadModImage.single('image'), async (req, res) => {
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM moderator_gallery WHERE id = $1 AND owner_user_id = $2', [req.params.id, req.user.id]
  );
  if (!existing) return res.status(404).json({ error: 'Not found.' });

  const { category, title, description } = req.body;
  if (category && !['sfw', 'sketches', 'spicy'].includes(category)) return res.status(400).json({ error: 'Category must be sfw, sketches, or spicy.' });

  let imageUrl = existing.image_url;
  if (req.file) {
    imageUrl = `/images/moderators/${req.file.filename}`;
    // Migrated posts can point image_url at a shared site asset — never unlink those.
    if (existing.image_url.startsWith('/images/moderators/')) {
      const oldPath = path.join('/var/www/btw', existing.image_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }
  const positionX = req.body.position_x !== undefined ? clampPosition(req.body.position_x) : existing.position_x;
  const positionY = req.body.position_y !== undefined ? clampPosition(req.body.position_y) : existing.position_y;

  const { rows: [item] } = await pool.query(
    `UPDATE moderator_gallery SET
       category    = COALESCE($1, category),
       title       = COALESCE($2, title),
       description = COALESCE($3, description),
       image_url   = $4,
       position_x  = $5,
       position_y  = $6
     WHERE id = $7 RETURNING *`,
    [category || null, title != null ? title.trim() : null, description != null ? description.trim() : null, imageUrl, positionX, positionY, existing.id]
  );
  res.json({ item });
});

// "Remove" from a story's gallery now means UNLINK, not delete — same
// reasoning as characters. Permanent deletion lives at DELETE /api/gallery/:id.
app.delete('/api/moderator/gallery/:id', requireAuth, requireModerator, async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM gallery_story_links WHERE gallery_id = $1 AND site_id = $2', [req.params.id, req.modSite.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Not found.' });
  res.json({ message: 'Unlinked from this story.' });
});

// Search the current user's OWN gallery posts not yet linked to this story —
// feeds the "+ Link Existing" picker.
app.get('/api/moderator/gallery/linkable', requireAuth, requireModerator, async (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const { rows } = await pool.query(
    `SELECT id, title, image_url
     FROM moderator_gallery
     WHERE owner_user_id = $1 AND title ILIKE $2
       AND id NOT IN (SELECT gallery_id FROM gallery_story_links WHERE site_id = $3)
     ORDER BY title LIMIT 30`,
    [req.user.id, q, req.modSite.id]
  );
  res.json({ gallery: rows });
});

app.post('/api/moderator/gallery/:id/link', requireAuth, requireModerator, async (req, res) => {
  const { rows: [item] } = await pool.query(
    'SELECT id FROM moderator_gallery WHERE id = $1 AND owner_user_id = $2', [req.params.id, req.user.id]
  );
  if (!item) return res.status(404).json({ error: 'Not found.' });
  const { rows: [{ maxOrder }] } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder" FROM gallery_story_links WHERE site_id = $1', [req.modSite.id]
  );
  await pool.query(
    'INSERT INTO gallery_story_links (gallery_id, site_id, sort_order) VALUES ($1, $2, $3) ON CONFLICT (gallery_id, site_id) DO NOTHING',
    [item.id, req.modSite.id, maxOrder + 1]
  );
  res.json({ message: 'Linked.' });
});

// Standalone creation — no story context, lands on the owner's profile
// Gallery tab. Plain requireAuth, same reasoning as standalone characters.
app.post('/api/gallery', requireAuth, uploadModImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const { category, title, description } = req.body;
  if (!['sfw', 'sketches', 'spicy'].includes(category)) return res.status(400).json({ error: 'Category must be sfw, sketches, or spicy.' });
  const imageUrl = `/images/moderators/${req.file.filename}`;
  const positionX = clampPosition(req.body.position_x);
  const positionY = clampPosition(req.body.position_y);
  const { rows: [item] } = await pool.query(
    `INSERT INTO moderator_gallery (owner_user_id, category, image_url, title, description, position_x, position_y)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [req.user.id, category, imageUrl, (title || '').trim(), (description || '').trim(), positionX, positionY]
  );
  res.json({ item });
});

// Permanent delete — cascades gallery_story_links automatically via FK.
app.delete('/api/gallery/:id', requireAuth, async (req, res) => {
  const { rows: [item] } = await pool.query(
    'SELECT * FROM moderator_gallery WHERE id = $1 AND owner_user_id = $2', [req.params.id, req.user.id]
  );
  if (!item) return res.status(404).json({ error: 'Not found.' });
  if (item.image_url.startsWith('/images/moderators/')) {
    const filePath = path.join('/var/www/btw', item.image_url);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  await pool.query('DELETE FROM moderator_gallery WHERE id = $1', [item.id]);
  res.json({ message: 'Deleted.' });
});

// ── Gallery likes — any logged-in user can like any story's gallery post ────
app.post('/api/moderator/gallery/:id/like', requireAuth, async (req, res) => {
  const { rows: [item] } = await pool.query('SELECT id FROM moderator_gallery WHERE id = $1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Not found.' });
  await pool.query(
    'INSERT INTO moderator_gallery_likes (user_id, gallery_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.user.id, item.id]
  );
  const { rows: [{ count }] } = await pool.query('SELECT count(*) FROM moderator_gallery_likes WHERE gallery_id = $1', [item.id]);
  res.json({ liked: true, like_count: Number(count) });
});

app.delete('/api/moderator/gallery/:id/like', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM moderator_gallery_likes WHERE user_id = $1 AND gallery_id = $2', [req.user.id, req.params.id]);
  const { rows: [{ count }] } = await pool.query('SELECT count(*) FROM moderator_gallery_likes WHERE gallery_id = $1', [req.params.id]);
  res.json({ liked: false, like_count: Number(count) });
});

// GET /api/library — bookmarked stories + liked gallery art, across every
// story, for the avatar dropdown's "Library" page.
app.get('/api/library', requireAuth, async (req, res) => {
  const [{ rows: stories }, { rows: gallery }] = await Promise.all([
    pool.query(`
      SELECT ms.slug, ms.story_path, ms.site_title, ms.cover_url, u.username, u.display_name, u.avatar
      FROM moderator_bookmarks mb
      JOIN moderator_sites ms ON ms.id = mb.site_id
      JOIN users u ON u.id = ms.owner_user_id
      WHERE mb.user_id = $1
      ORDER BY mb.created_at DESC
    `, [req.user.id]),
    pool.query(`
      SELECT mg.id, mg.image_url, mg.title, mg.category, ms.slug, ms.story_path, ms.site_title, u.username AS owner_username
      FROM moderator_gallery_likes mgl
      JOIN moderator_gallery mg ON mg.id = mgl.gallery_id
      LEFT JOIN LATERAL (
        SELECT site_id FROM gallery_story_links WHERE gallery_id = mg.id ORDER BY site_id LIMIT 1
      ) gsl ON true
      LEFT JOIN moderator_sites ms ON ms.id = gsl.site_id
      JOIN users u ON u.id = mg.owner_user_id
      WHERE mgl.user_id = $1
      ORDER BY mgl.created_at DESC
    `, [req.user.id]),
  ]);
  res.json({
    stories: stories.map(r => ({
      slug: r.slug, story_path: r.story_path || r.slug, site_title: r.site_title, cover_url: r.cover_url,
      author: r.display_name || r.username, author_username: r.username, author_avatar: r.avatar || null,
    })),
    gallery: gallery.map(r => ({
      id: r.id, image_url: r.image_url, title: r.title, category: r.category,
      story_path: r.story_path || r.slug || null, site_title: r.site_title || null,
      owner_username: r.owner_username,
    })),
  });
});

// ── Notifications ─────────────────────────────────────────────────────────────
app.get('/api/notifications', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT n.id, n.type, n.message, n.link, n.is_read, n.created_at,
           u.username AS actor_username, u.display_name AS actor_display_name, u.avatar AS actor_avatar
    FROM notifications n
    LEFT JOIN users u ON u.id = n.actor_user_id
    WHERE n.user_id = $1
    ORDER BY n.created_at DESC
    LIMIT 100
  `, [req.user.id]);
  res.json({ notifications: rows });
});

app.get('/api/notifications/unread-count', requireAuth, async (req, res) => {
  const { rows: [{ count }] } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND is_read = false',
    [req.user.id]
  );
  res.json({ count });
});

app.post('/api/notifications/mark-read', requireAuth, async (req, res) => {
  await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false', [req.user.id]);
  res.json({ ok: true });
});

// ── Fanpages hub spotlight boxes — random picks across every story ──────────
app.get('/api/spotlight/characters', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 12, 30);
  const { rows } = await pool.query(
    `SELECT mc.id, mc.name, mc.ref_image, mc.ref_position_x, mc.ref_position_y,
            ms.story_path, ms.slug, ms.site_title, u.username AS owner_username, u.display_name AS owner_display_name
     FROM moderator_characters mc
     LEFT JOIN LATERAL (
       SELECT site_id FROM character_story_links WHERE character_id = mc.id ORDER BY site_id LIMIT 1
     ) csl ON true
     LEFT JOIN moderator_sites ms ON ms.id = csl.site_id
     JOIN users u ON u.id = mc.owner_user_id
     WHERE mc.ref_image IS NOT NULL AND mc.ref_image <> '' AND mc.ref_image <> '/images/defaultchar.jpg'
     ORDER BY RANDOM() LIMIT $1`,
    [limit]
  );
  res.json({
    characters: rows.map(r => ({
      id: r.id, name: r.name, image: r.ref_image,
      position_x: r.ref_position_x, position_y: r.ref_position_y,
      story_path: r.story_path || r.slug || null, site_title: r.site_title || null,
      owner_username: r.owner_username, owner_display_name: r.owner_display_name || r.owner_username,
    })),
  });
});

app.get('/api/spotlight/gallery', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 12, 30);
  const { rows } = await pool.query(
    `SELECT mg.id, mg.image_url, mg.title, mg.position_x, mg.position_y,
            ms.story_path, ms.slug, ms.site_title, u.username AS owner_username, u.display_name AS owner_display_name
     FROM moderator_gallery mg
     LEFT JOIN LATERAL (
       SELECT site_id FROM gallery_story_links WHERE gallery_id = mg.id ORDER BY site_id LIMIT 1
     ) gsl ON true
     LEFT JOIN moderator_sites ms ON ms.id = gsl.site_id
     JOIN users u ON u.id = mg.owner_user_id
     WHERE mg.category IN ('sfw', 'sketches')
     ORDER BY RANDOM() LIMIT $1`,
    [limit]
  );
  res.json({
    gallery: rows.map(r => ({
      id: r.id, image: r.image_url, title: r.title,
      position_x: r.position_x, position_y: r.position_y,
      story_path: r.story_path || r.slug || null, site_title: r.site_title || null,
      owner_username: r.owner_username, owner_display_name: r.owner_display_name || r.owner_username,
    })),
  });
});

app.get('/api/spotlight/stories', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 12, 30);
  const { rows } = await pool.query(
    `SELECT ms.slug, ms.story_path, ms.site_title, ms.cover_url, u.username, u.display_name, u.avatar
     FROM moderator_sites ms
     JOIN users u ON u.id = ms.owner_user_id
     ORDER BY RANDOM() LIMIT $1`,
    [limit]
  );
  res.json({
    stories: rows.map(r => ({
      slug: r.slug, story_path: r.story_path || r.slug, site_title: r.site_title, cover_url: r.cover_url,
      author: r.display_name || r.username, author_username: r.username, author_avatar: r.avatar || null,
    })),
  });
});

// ── Recent Submissions feed — newest stories/chapters/art/characters across
// every fanpage, newest first. Gallery is filtered to sfw+sketches only. ────
app.get('/api/activity-feed', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 24, 40);
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT 'story' AS type, ms.id AS item_id, ms.created_at AS created_at,
              ms.site_title AS title, ms.cover_url AS image,
              ms.cover_position_x AS position_x, ms.cover_position_y AS position_y,
              ms.story_path, ms.site_title AS site_title,
              u.username, u.display_name, u.avatar
       FROM moderator_sites ms
       JOIN users u ON u.id = ms.owner_user_id

       UNION ALL

       SELECT 'chapter', mc.id, mc.created_at,
              mc.title, ms.cover_url,
              ms.cover_position_x, ms.cover_position_y,
              ms.story_path, ms.site_title,
              u.username, u.display_name, u.avatar
       FROM moderator_chapters mc
       JOIN moderator_sites ms ON ms.id = mc.site_id
       JOIN users u ON u.id = ms.owner_user_id

       UNION ALL

       SELECT 'art', mg.id, mg.created_at,
              mg.title, mg.image_url,
              mg.position_x, mg.position_y,
              ms.story_path, ms.site_title,
              u.username, u.display_name, u.avatar
       FROM moderator_gallery mg
       LEFT JOIN LATERAL (
         SELECT site_id FROM gallery_story_links WHERE gallery_id = mg.id ORDER BY site_id LIMIT 1
       ) gsl ON true
       LEFT JOIN moderator_sites ms ON ms.id = gsl.site_id
       JOIN users u ON u.id = mg.owner_user_id
       WHERE mg.category IN ('sfw', 'sketches')

       UNION ALL

       SELECT 'character', mch.id, mch.created_at,
              mch.name, mch.ref_image,
              mch.ref_position_x, mch.ref_position_y,
              ms.story_path, ms.site_title,
              u.username, u.display_name, u.avatar
       FROM moderator_characters mch
       LEFT JOIN LATERAL (
         SELECT site_id FROM character_story_links WHERE character_id = mch.id ORDER BY site_id LIMIT 1
       ) csl ON true
       LEFT JOIN moderator_sites ms ON ms.id = csl.site_id
       JOIN users u ON u.id = mch.owner_user_id
     ) feed
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  res.json({
    items: rows.map(r => ({
      type: r.type,
      id: r.item_id,
      created_at: r.created_at,
      title: r.title,
      image: r.image || null,
      position_x: r.position_x, position_y: r.position_y,
      story_path: r.story_path,
      site_title: r.site_title,
      author: r.display_name || r.username,
      author_username: r.username,
      author_avatar: r.avatar || null,
    })),
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDb().then(() => {
  app.listen(PORT, '127.0.0.1', () =>
    console.log(`BTW API listening on 127.0.0.1:${PORT}`)
  );
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
