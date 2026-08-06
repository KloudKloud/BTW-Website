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
    // Two files can land in the same request now (the baked crop + the
    // untouched original, see /api/auth/avatar) -- suffix by fieldname so
    // they don't collide on the same {userId}{ext} filename.
    const suffix = file.fieldname === 'avatar_original' ? '-original' : '';
    cb(null, `${req.user.id}${suffix}${ext}`);
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

// ── Guest identity ──────────────────────────────────────────────────────────
// Unregistered visitors can comment/like without ever creating an account,
// so they need SOME stable identity to attach those rows to and to dedupe
// repeat likes. A long-lived cookie stands in for that — issued the first
// time any visitor hits the API, reused on every request after. Uses the
// `cookie` package directly (not `cookie-parser`) since it's already a
// transitive dependency here and adding a new top-level one just for this
// felt unnecessary. req.guestId is always set to either the cookie's
// existing value or the one just minted for this response.
const cookieLib = require('cookie');
const GUEST_COOKIE = 'btw_guest_id';
const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year
app.use((req, res, next) => {
  const parsed = req.headers.cookie ? cookieLib.parse(req.headers.cookie) : {};
  let guestId = parsed[GUEST_COOKIE];
  if (!guestId) {
    guestId = crypto.randomUUID();
    res.append('Set-Cookie', cookieLib.serialize(GUEST_COOKIE, guestId, {
      maxAge: GUEST_COOKIE_MAX_AGE, path: '/', httpOnly: true, sameSite: 'lax', secure: true,
    }));
  }
  req.guestId = guestId;
  next();
});

// The Fanpage system now also serves from btwfics.net (sharing this same
// backend/DB), so email/redirect links built from a request must resolve to
// whichever domain the user is actually on rather than one static env value —
// otherwise a btwfics.net user's verification/reset/inbox links would always
// point at btwfanfic.net. Falls back to SITE_HOST for contexts with no request
// (e.g. none currently, but keeps behavior identical if one is ever added).
const ALLOWED_HOSTS = ['btwfanfic.net', 'www.btwfanfic.net', 'btwfics.net', 'www.btwfics.net'];
function siteHost(req) {
  const host = req && req.get('host');
  return host && ALLOWED_HOSTS.includes(host) ? host : process.env.SITE_HOST;
}

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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_original_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_theme TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_theme_bg_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_theme TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_theme_bg_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reader_theme TEXT NOT NULL DEFAULT 'dark';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reader_theme_bg_url TEXT NOT NULL DEFAULT '';
  `).catch(e => console.error('account profile fields migration:', e.message));
  // Add newsletter opt-in column if missing (default true for existing users)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_newsletter BOOLEAN DEFAULT true`).catch(() => {});
  // NSFW viewing mode — everyone agreed to 18+ at signup, so default ON for
  // both new and existing accounts; flipping it OFF opts into SFW Mode.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nsfw_enabled BOOLEAN NOT NULL DEFAULT true`).catch(() => {});
  // Zoom for the account banner/avatar crop — same 100-400 scale as the hub
  // billboard's zoom, 100 = no zoom (matches the pre-existing default crop).
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_banner_zoom INTEGER NOT NULL DEFAULT 100;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_zoom INTEGER NOT NULL DEFAULT 100;
  `).catch(e => console.error('banner/avatar zoom migration:', e.message));
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
      category   TEXT        NOT NULL CHECK (category IN ('sfw','mature','explicit')),
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

  // Uncropped source image behind banner_url — banner_url is always the
  // baked-in crop actually shown; without keeping the original around too,
  // "Recrop" had nothing to recrop but the already-cropped result, which
  // meant every recrop could only ever zoom further into a shrinking image.
  await pool.query(`
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS banner_original_url TEXT NOT NULL DEFAULT '';
  `).catch(e => console.error('moderator_sites banner_original_url migration:', e.message));

  // Book cover — sits beside the story description, like BTW's own synopsis-cover
  await pool.query(`
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS cover_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS cover_position_x INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS cover_position_y INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS cover_original_url TEXT NOT NULL DEFAULT '';
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

  // Uncropped source behind each nav card, same fix as banner_original_url —
  // *_card_url is always the baked-in crop, so Recrop had nothing but that
  // already-cropped result to work from without this.
  await pool.query(`
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS characters_card_original_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS chapters_card_original_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS gallery_card_original_url TEXT NOT NULL DEFAULT '';
  `).catch(e => console.error('moderator_sites nav-card original migration:', e.message));

  // Reference-image crop position for character cards
  await pool.query(`
    ALTER TABLE moderator_characters ADD COLUMN IF NOT EXISTS ref_position_x INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE moderator_characters ADD COLUMN IF NOT EXISTS ref_position_y INTEGER NOT NULL DEFAULT 50;
  `).catch(e => console.error('moderator_characters ref-position migration:', e.message));

  // e621/Wattpad-style discovery tags — up to 100 per story, feed the search bar.
  await pool.query(`
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]';
  `).catch(e => console.error('moderator_sites tags migration:', e.message));

  // AO3-style structured metadata — Rating (single value), Category (up to
  // 6 fixed options), Relationships (freeform, up to 20 per story). Feeds
  // the discoverability work — filtering/faceting comes in a later phase.
  await pool.query(`
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS rating TEXT NOT NULL DEFAULT 'General Audiences';
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS categories JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS relationships JSONB NOT NULL DEFAULT '[]';
  `).catch(e => console.error('moderator_sites metadata migration:', e.message));
  // Rating went from a 5-tier scale to 3 (General Audiences / Teen & Up /
  // Mature/Explicit (Adult)) — remap anything still on the old values so
  // existing stories don't end up on a rating that no longer exists.
  await pool.query(`
    UPDATE moderator_sites SET rating = 'General Audiences' WHERE rating = 'Not Rated';
    UPDATE moderator_sites SET rating = 'Teen & Up' WHERE rating = 'Teen And Up Audiences';
    UPDATE moderator_sites SET rating = 'Mature/Explicit (Adult)' WHERE rating IN ('Mature', 'Explicit');
    UPDATE moderator_sites SET categories = (
      SELECT jsonb_agg(CASE WHEN c = 'F/M' THEN 'M/F' ELSE c END)
      FROM jsonb_array_elements_text(categories) AS c
    ) WHERE categories::text LIKE '%F/M%';
  `).catch(e => console.error('moderator_sites rating/category remap:', e.message));

  // Rating switched again -- General Audiences/Teen & Up/Mature-Explicit
  // (Adult) collapsed down to the exact same 3-tier scale the gallery
  // already uses (sfw/mature/explicit), so a chapter's rating (inherited
  // from its story, see /api/search/submissions) can be checked against the
  // Posts ratings filter with the same values/logic as gallery posts
  // instead of a second incompatible scale. "Teen & Up" -> mature since it
  // sat above General but below the old Mature/Explicit tier.
  await pool.query(`
    ALTER TABLE moderator_sites ALTER COLUMN rating SET DEFAULT 'sfw';
    UPDATE moderator_sites SET rating = 'sfw' WHERE rating = 'General Audiences';
    UPDATE moderator_sites SET rating = 'mature' WHERE rating = 'Teen & Up';
    UPDATE moderator_sites SET rating = 'explicit' WHERE rating = 'Mature/Explicit (Adult)';
    UPDATE moderator_sites SET rating = 'mature' WHERE rating NOT IN ('sfw', 'mature', 'explicit');
  `).catch(e => console.error('moderator_sites rating 3-tier remap:', e.message));

  // Fandom — freeform, autocompleted against a shared catalog (AO3-style
  // tag wrangling, but seeded small and grown by hand over time).
  await pool.query(`
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS fandoms JSONB NOT NULL DEFAULT '[]';
    CREATE TABLE IF NOT EXISTS fandom_catalog (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
  `).catch(e => console.error('moderator_sites fandoms migration:', e.message));

  // Completion status, for the advanced work search's "Complete works
  // only / Works in progress only" filter — an explicit author-set flag
  // rather than something inferred, since "no more chapters yet" and
  // "finished on purpose" aren't distinguishable otherwise.
  await pool.query(`ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS is_complete BOOLEAN NOT NULL DEFAULT false`)
    .catch(e => console.error('moderator_sites is_complete migration:', e.message));

  // Marks throwaway seed/demo accounts and their stories so they can be
  // wiped in one shot (DELETE FROM users WHERE is_test_data, cascades to
  // everything they own) without touching any real author's content.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_test_data BOOLEAN NOT NULL DEFAULT false`)
    .catch(e => console.error('users is_test_data migration:', e.message));
  await pool.query(`
    INSERT INTO fandom_catalog (name) VALUES ('Pokemon'), ('Original Furry Characters'), ('Original Characters')
    ON CONFLICT (name) DO NOTHING;
  `).catch(e => console.error('fandom_catalog seed:', e.message));
  // Renamed after the initial seed shipped ("Furry Fandom" -> "Original
  // Furry Characters", then "Original Works" -> "Original Characters") —
  // the seed insert above already adds the new names, so this just drops
  // the stray old rows rather than UPDATE-ing (which would collide).
  await pool.query(`
    DELETE FROM fandom_catalog WHERE name IN ('Furry Fandom', 'Original Works');
  `).catch(e => console.error('fandom_catalog rename:', e.message));

  // Additional Tags / Relationships catalogs — same shared-vocabulary idea as
  // Fandom. Seeded day-one from 5 real AO3 works' public tag lists (Rating/
  // Archive Warnings excluded; Character tags folded in here too, since this
  // site doesn't have a separate Characters tag system — Japanese Pokemon
  // names collapsed to their English name).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tag_catalog (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS relationship_catalog (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
  `).catch(e => console.error('tag/relationship catalog migration:', e.message));
  const TAG_CATALOG_SEED = ['Umbreon', 'Espeon', 'Sylveon', 'Leafeon', 'Flareon', 'Jolteon', 'Lucario', 'Riolu', 'Blaziken', 'Meowscarada', 'Grovyle', 'Absol', 'Kloud', 'Saphero', 'Zoroark', 'Gallade', 'Arcanine', 'Eevee', 'Delcatty', 'Romance', 'Love', 'Psychological Horror', 'Pokemon', 'Comedy', 'Angst', 'Fluff', 'Slow Burn', 'Teasing', 'Flirting', 'Hurt/Comfort', 'Enemies to Lovers', 'Implied Sexual Content', 'Romantic Comedy', 'Intimacy', 'Slow Romance', 'Horror', 'Fluff and Angst', 'Action', 'Friends to Lovers', 'A little bit of everything', 'Adventure', 'Dimensions', 'Alternate Dimensions', 'Pokemon Only', 'Abuse', 'Sexual Content', 'Sexual Tension', 'Mystery', 'Stakes', 'Eeveelutions', 'PMD', 'Depression', 'Cuddling & Snuggling', 'intimate cuddling', 'Gay', 'gay relationships', 'Straight Relationships', 'Parallel Universe', 'Torracat', 'Lycanroc', 'Vulpix (Alolan)', 'Original Human Character(s)', 'Buizel', 'Glaceon', 'Seel', 'Floatzel', 'Pokephilia', 'Vaginal', 'Anal Sex', 'Blow Jobs', 'Clothed Sex', 'Knotting', 'Orgasm', 'Face-Fucking', 'Rough Oral Sex', 'Submissive Character', 'Multiple Sex Positions', 'Sex with Sentient Animals', 'Porn with Plot', 'Secret Relationship', 'Deepthroating', 'Sex on Furniture', 'Lust', 'Dominance', 'Oral Knotting', 'Rough Sex', 'Teen Romance', 'Interspecies Sex', 'Mating Cycles/In Heat', 'Cock Slut', 'Implied/Referenced Sex', 'Guilty Pleasures', 'Light Dom/sub', 'Blood', 'Mating Bites', 'Taboo', 'Bad Decisions', 'Poor Life Choices', 'Established Relationship', 'Hawaiian Character', 'Implied/Referenced Underage Sex', 'Condoms', 'Voyeurism', 'Possessive Behavior', 'Possessive Sex', 'Drunk Sex', 'Alcohol Abuse/Alcoholism', 'Crush at First Sight', 'Infidelity', 'Babysitting', 'Slice of Life', 'Waiters & Waitresses', 'Drama', 'Cars', 'Pictures', 'Audio Format: MP3', 'Braixen', 'Gardevoir', 'Liepard', 'Original Pokemon Trainer(s)', 'Delphox', 'Vaginal Sex', 'Pokemon Battle', 'Pokemon Journey', 'Action/Adventure', 'Pokemon Gym Leader(s)', 'Love Confessions', 'Loss of Virginity', 'Self Confidence Issues', 'Female Protagonist', 'Emotional Hurt/Comfort', 'Pokemon Training', 'Interspecies Romance', 'Telepathy', 'Telepathic Bond', 'Canon Dialogue', 'Platonic Relationships', 'Loss of Parent(s)', 'Romantic Fluff', 'Developing Relationship', 'Childhood Trauma', 'French Characters', 'French', 'Monogamy', 'Young Love', 'Non-Graphic Violence', 'Psychic Bond', 'Original Furry Character(s)', 'Original Anthropomorphic Character(s)', 'Original Male Character(s)', 'Original Female Character(s)', 'Nazi Germany', 'Nazis', 'War', 'World War II', 'Alternate History', 'Alternate Universe - Historical', 'Spies & Secret Agents', 'Undercover Missions', 'Undercover', 'Military', 'Alternate Universe - Military', 'Military Uniforms', 'Women in the Military', 'Military Kink', 'Femdom', 'Interspecies Relationship(s)', 'Rape/Non-con Elements', 'Dog', 'Racism', 'Period-Typical Racism', 'Rape', 'POV Second Person', 'Torture', 'Interrogation', 'Sexual Harassment', 'Face-Sitting', 'Cunnilingus', 'Oral Sex', 'Prostitution', 'Sex Toys', 'Scent Kink', 'Scent Marking', 'Communism', 'Irish Republicanism', 'Hand Jobs', 'Public Sex', 'Exhibitionism', 'Semi-Public Sex', 'Gender Role Reversal', 'Vaginal Fingering', 'Breastfeeding', 'Threesome - F/F/M', 'Rough Kissing', 'Kissing Kink', 'Estrus', 'Impregnation', 'Suspicions', 'Blackmail', 'Creampie', 'Human Male on Female Anthro', 'HMOFA (Furry)', 'Lopunny', 'Suicune', 'Mew', 'Vulpix', 'Ninetales', 'Primarina', 'Dragonair', 'Vaporeon', 'Luxray', 'Porn', 'Dubious Consent', 'Bondage', 'psychic bondage', 'Illusions', 'Flexibility', 'Breeding', 'Human/Pokemon Relationship(s)', 'Multiple Partners', 'Pornography', 'pornography watching', 'Oil', 'Erotic Electrostimulation', 'Electrocution', 'Imprisonment', 'open mouth', 'Dirty Talk'];
  const RELATIONSHIP_CATALOG_SEED = ['Umbreon/Espeon', 'Sylveon/Blaziken', 'Umbreon/Leafeon', 'Espeon/Jolteon', 'Lucario/Zoroark', 'Lycanroc/Original Character(s)', 'Pokemon/Original Human Character(s)', 'Pokemon/Original Character(s)', 'Original Female Character/Original Male Character', 'Floatzel/Original Character(s)', 'Buizel/Original Pokemon Trainer(s)', 'Arcanine/Original Female Character(s)', 'Umbreon/Glaceon', 'Eevee/Original Female Character(s)', 'Seel/Original Female Character(s)', 'Braixen/Original Female Character(s)', 'Riolu & Original Pokemon Trainer(s)', 'Gardevoir/Braixen', 'Delphox/Original Character(s)', 'Female Anthro/Male Human', 'Original Female Anthro Character(s)/Original Male Human Character(s)', 'Anthro/Human', 'Female Absol/Male Human', 'Female Ninetales/Male Human', 'Female Lopunny/Male Human', 'Female Suicune/Male Human', 'Female Mew/Male Human', 'Female Braixen/Male Human', 'Female Dragonair/Male Human', 'Female Eevee/Male Human', 'Female Lucario/Male Human', 'Female Vulpix/Male Human', 'Male Arcanine/Female Human', 'Female Lycanroc & Male Human', 'Female Leafeon/Male Human', 'Female Primarina/Male Human', 'Female Arcanine/Male Arcanine', 'Female Zoroark/Male Human', 'Female Vaporeon/Male Human', 'Female Luxray/Male Human', 'Female Lycanroc/Male Human', 'Female Arcanine/Male Human'];
  await pool.query(
    `INSERT INTO tag_catalog (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING`, [TAG_CATALOG_SEED]
  ).catch(e => console.error('tag_catalog seed:', e.message));
  await pool.query(
    `INSERT INTO relationship_catalog (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING`, [RELATIONSHIP_CATALOG_SEED]
  ).catch(e => console.error('relationship_catalog seed:', e.message));
  // Trimmed after the initial seed — these came from a WWII-furry source
  // work and don't belong in a general-purpose site tag catalog.
  await pool.query(`
    DELETE FROM tag_catalog WHERE lower(name) IN ('racism', 'nazis', 'nazi germany', 'world war ii', 'period-typical racism', 'torture');
  `).catch(e => console.error('tag_catalog trim:', e.message));

  // Species dictionary — same tag-wrangling idea as tag_catalog, but its own
  // separate vocabulary (a story tag catalog full of "Knotting"/"Rough Sex"
  // has nothing to do with what species a character is). Seeded from every
  // distinct species already typed in across existing characters, so
  // whatever Blue and VeekitPaws already used becomes the day-one dictionary
  // instead of starting empty.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS character_species_catalog (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
  `).catch(e => console.error('character_species_catalog migration:', e.message));
  await pool.query(`
    INSERT INTO character_species_catalog (name)
    SELECT DISTINCT trim(stats->>'Species') FROM moderator_characters
    WHERE stats ? 'Species' AND trim(COALESCE(stats->>'Species', '')) <> ''
    ON CONFLICT (name) DO NOTHING
  `).catch(e => console.error('character_species_catalog seed:', e.message));

  // Structured relationships — replaces the old free-text stats.Relationships
  // string. Each entry is { name, type, character_id }, where character_id
  // (nullable) lets one character's relationship list link straight to
  // another character in the same story for fast-travel on click.
  await pool.query(`
    ALTER TABLE moderator_characters ADD COLUMN IF NOT EXISTS relationships JSONB NOT NULL DEFAULT '[]';
  `).catch(e => console.error('moderator_characters relationships migration:', e.message));

  // Reference image NSFW flag — every existing ref image predates this
  // toggle and was SFW-only, so default false (SFW) backfills them correctly.
  await pool.query(`
    ALTER TABLE moderator_characters ADD COLUMN IF NOT EXISTS ref_is_nsfw BOOLEAN NOT NULL DEFAULT false;
  `).catch(e => console.error('moderator_characters ref_is_nsfw migration:', e.message));

  // Backs the Characters browse page's "Date Updated" sort -- created_at
  // alone would never move once a character's been edited.
  await pool.query(`
    ALTER TABLE moderator_characters ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
  `).catch(e => console.error('moderator_characters updated_at migration:', e.message));

  // Same naive per-load view counter as stories/gallery -- and its own
  // Bookmarks table, deliberately separate from moderator_character_likes:
  // "Like" is the quick heart-toggle scattered across every card; "Bookmark"
  // is the deliberate "save this for later" action that's the only thing
  // the Library page's Characters tab shows.
  await pool.query(`
    ALTER TABLE moderator_characters ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;
  `).catch(e => console.error('moderator_characters view_count migration:', e.message));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moderator_character_bookmarks (
      id           SERIAL      PRIMARY KEY,
      user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id INTEGER     NOT NULL REFERENCES moderator_characters(id) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, character_id)
    );
  `).catch(e => console.error('moderator_character_bookmarks migration:', e.message));

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

  // Likes on a whole story — distinct from moderator_bookmarks (save for
  // later) the same way gallery_likes is distinct from gallery_bookmarks.
  // Story comments don't need a new table: content_comments is already
  // polymorphic (target_type/target_id) with a user_id column, so
  // target_type='story' already gives per-user story comments for free —
  // nothing here needed for that part, it just needs to be used.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moderator_site_likes (
      id         SERIAL      PRIMARY KEY,
      user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      site_id    INTEGER     NOT NULL REFERENCES moderator_sites(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, site_id)
    );
  `).catch(e => console.error('moderator_site_likes migration:', e.message));

  // Story-level view counter — bumped once per home-page load (see the
  // /view endpoint below), separate from moderator_chapters.view_count
  // which tracks per-chapter reads instead.
  await pool.query(`
    ALTER TABLE moderator_sites ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;
  `).catch(e => console.error('moderator_sites view_count migration:', e.message));

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

  // Bookmarks on individual gallery posts — distinct from moderator_bookmarks
  // (which bookmarks a whole story). Feeds the Library's "Bookmarked Art" tab.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moderator_gallery_bookmarks (
      id         SERIAL      PRIMARY KEY,
      user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gallery_id INTEGER     NOT NULL REFERENCES moderator_gallery(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, gallery_id)
    );
  `).catch(e => console.error('moderator_gallery_bookmarks migration:', e.message));

  // Single "Like" on a character — one action that both marks the card
  // liked everywhere it renders AND feeds the Library's "Characters" tab
  // (unlike gallery posts, characters don't need a separate like/bookmark
  // distinction).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moderator_character_likes (
      id           SERIAL      PRIMARY KEY,
      user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id INTEGER     NOT NULL REFERENCES moderator_characters(id) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, character_id)
    );
  `).catch(e => console.error('moderator_character_likes migration:', e.message));

  // Universal comments — target_type/target_id makes this reusable for
  // gallery posts now, and Newspaper/Social posts later, without a new
  // table each time. Replies are exactly one level deep: a reply's
  // parent_id always points at a ROOT comment (never at another reply) —
  // enforced in the POST handler, not the schema.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_comments (
      id                SERIAL      PRIMARY KEY,
      target_type       TEXT        NOT NULL,
      target_id         INTEGER     NOT NULL,
      user_id           INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id         INTEGER     REFERENCES content_comments(id) ON DELETE CASCADE,
      reply_to_username TEXT,
      body              TEXT        NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_content_comments_target ON content_comments(target_type, target_id, created_at);
  `).catch(e => console.error('content_comments migration:', e.message));

  // paragraph_index: which paragraph a comment is pinned to, for the
  // Reader's inline paragraph comments (target_type = 'chapter_paragraph',
  // target_id = chapter id). NULL for every other comment type. gif_url:
  // an optional GIF attachment, same idea as the DM composer's GIF picker —
  // a comment can be text, a GIF, or both.
  await pool.query(`
    ALTER TABLE content_comments ADD COLUMN IF NOT EXISTS paragraph_index INTEGER;
    ALTER TABLE content_comments ADD COLUMN IF NOT EXISTS gif_url TEXT;
    CREATE INDEX IF NOT EXISTS idx_content_comments_paragraph ON content_comments(target_type, target_id, paragraph_index);
  `).catch(e => console.error('content_comments paragraph/gif migration:', e.message));

  // TOS Blobs — free-text reference storage for policy/rules copy (Terms of
  // Service, community guidelines, etc.), admin-only for now. Just a place
  // to write and keep drafts before real dedicated pages exist for them —
  // seeded once with the story-creation TOS that used to be hardcoded
  // directly into create.html, so the current wording isn't lost.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tos_blobs (
      id         SERIAL      PRIMARY KEY,
      name       TEXT        NOT NULL,
      content    TEXT        NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(e => console.error('tos_blobs migration:', e.message));
  await pool.query(`
    INSERT INTO tos_blobs (name, content)
    SELECT 'Story Creation TOS (legacy)', $1
    WHERE NOT EXISTS (SELECT 1 FROM tos_blobs)
  `, [
`By creating a story on this platform, you are agreeing to share your world with the community members across this website! Things you can look forward to:

- Promoting Your Existing Story Links To A Community of Readers
- Creating Beautiful Character Cards For The Cast In Your Story
- Posting Art You Make/Commission For Characters, Scenes, And Moments In Your Story
- Having A Real, Awesome Page Made and Designed By YOU! A Place You Can Share on AO3, Wattpad, Fanfic.net, or ANY Platform You Wish! Centralize All of Your Readers From All Over Into ONE Place!

Consider this a website FOR YOU, and a website that you can share to merge readers from AO3, Wattpad, Furaffinity, Fanfic.net, or wherever you post your writing/fics! Link to every platform you post on, your general socials (Discord servers, etc.), and any and everything you! I personally love my website because I now have a gallery to share all of the art I commission with my Between Two Worlds readers~

RULES

1. All media you post to this story's "gallery" section MUST be yours. That means you drew it, you commissioned it, or it was a gift made specifically for your book. The gallery section is meant to be original art ONLY. Don't just take art from online and label it as art belonging to your story.
2. Media you post for your "character" cards may be references from other places, but if it is artwork belonging to a specific person that is not yourself, please try and credit them and ensure it is free use. You can also specify in the builder that the character ref is "not" official. I know some stories have dozens of characters, and getting handmade art for each and every one takes a while. So feel free to use free, credited refs online if needed. (Alternatively, you could just use the default image as a placeholder until you get art for a specified character).
3. NSFW MEDIA IS FINE, BUT IT MUST BE LABELED AS "Mature" or "Explicit" for the gallery, or marked NSFW on the character cards! Non-logged in users will not be able to see NSFW posts until they make an account.

Overall, NSFW media is acceptable here! But please, label it correctly. Your gallery image may be removed if it is not labeled correctly.

I can't wait to browse your stories! Please read the terms above, and if you agree with them, click the box below and get to making!`
  ]).catch(e => console.error('tos_blobs seed:', e.message));

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

  // NSFW billboard slides — only shown to logged-in users with NSFW enabled
  // (same nsfw_enabled flag/gating as the spicy gallery), filtered server-side
  // in GET /api/hub-billboard via getViewerNsfwAccess.
  await pool.query(`
    ALTER TABLE hub_billboard_slides ADD COLUMN IF NOT EXISTS is_nsfw BOOLEAN NOT NULL DEFAULT false;
  `).catch(e => console.error('hub_billboard_slides is_nsfw migration:', e.message));

  // "VIP" slides (donation ads, important announcements) -- the frontend
  // guarantees one lands in every 4th slot of the shuffled rotation, on top
  // of being eligible for the normal random shuffle everywhere else too.
  await pool.query(`
    ALTER TABLE hub_billboard_slides ADD COLUMN IF NOT EXISTS is_vip BOOLEAN NOT NULL DEFAULT false;
  `).catch(e => console.error('hub_billboard_slides is_vip migration:', e.message));

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

  // Reports — user-safety flagging for stories/comments/DMs/etc. Same
  // target_type/target_id polymorphism as content_comments, so new
  // reportable content types just need a resolver branch (see
  // reportTargetInfo below), not a schema change.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id                SERIAL      PRIMARY KEY,
      reporter_user_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_type       TEXT        NOT NULL,
      target_id         INTEGER     NOT NULL,
      reason            TEXT        NOT NULL DEFAULT '',
      status            TEXT        NOT NULL DEFAULT 'pending',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_reports_status_created ON reports(status, created_at DESC);
  `).catch(e => console.error('reports migration:', e.message));

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

  // Newspaper — a lightweight journal/blog an account owner can post to
  // (story updates, shout-outs, hellos to followers). Attachments reuse the
  // same {url,name} shape as DM attachments, since it supports the same
  // kinds of media (images/gifs/video via upload, or an external gif url).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS newspaper_posts (
      id          SERIAL      PRIMARY KEY,
      user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT        NOT NULL DEFAULT '',
      body        TEXT        NOT NULL DEFAULT '',
      attachments JSONB       NOT NULL DEFAULT '[]',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_newspaper_posts_user ON newspaper_posts(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS newspaper_comments (
      id         SERIAL      PRIMARY KEY,
      post_id    INTEGER     NOT NULL REFERENCES newspaper_posts(id) ON DELETE CASCADE,
      user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body       TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_newspaper_comments_post ON newspaper_comments(post_id, created_at);
  `).catch(e => console.error('newspaper migration:', e.message));

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

  // Widen the kind CHECK to also allow 'story' -- CREATE TABLE IF NOT EXISTS
  // above doesn't touch the constraint on an already-existing table, so this
  // has to be its own explicit migration.
  await pool.query(`
    ALTER TABLE user_featured_items DROP CONSTRAINT IF EXISTS user_featured_items_kind_check;
    ALTER TABLE user_featured_items ADD CONSTRAINT user_featured_items_kind_check CHECK (kind IN ('character','gallery','story'));
  `).catch(e => console.error('user_featured_items kind widen migration:', e.message));

  // Rating overhaul -- "Sketches" is gone and "Spicy" is renamed "Explicit",
  // with a new "Mature" tier added in between. Every existing non-SFW post
  // (sketches or spicy, both) becomes "explicit" for now -- Blue/VeekitPaws
  // can manually re-tier anything that should actually be "mature" later.
  await pool.query(`ALTER TABLE moderator_gallery DROP CONSTRAINT IF EXISTS moderator_gallery_category_check;`)
    .catch(e => console.error('moderator_gallery category constraint drop:', e.message));
  await pool.query(`UPDATE moderator_gallery SET category = 'explicit' WHERE category NOT IN ('sfw')`)
    .catch(e => console.error('moderator_gallery category remap:', e.message));
  await pool.query(`ALTER TABLE moderator_gallery ADD CONSTRAINT moderator_gallery_category_check CHECK (category IN ('sfw','mature','explicit'));`)
    .catch(e => console.error('moderator_gallery category migration:', e.message));

  await pool.query(`
    ALTER TABLE moderator_gallery ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
  `).catch(e => console.error('moderator_gallery description migration:', e.message));

  // Same e621/Wattpad-style discovery tags as moderator_sites.tags, so
  // gallery posts (Submissions) can be tagged and searched the same way
  // stories are.
  await pool.query(`
    ALTER TABLE moderator_gallery ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]';
  `).catch(e => console.error('moderator_gallery tags migration:', e.message));

  // Same naive per-load view counter as moderator_sites.view_count -- the
  // detail-view stats box needs a real number to show.
  await pool.query(`
    ALTER TABLE moderator_gallery ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;
  `).catch(e => console.error('moderator_gallery view_count migration:', e.message));

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
    -- "Feature this character in this art piece" tags — purely descriptive/
    -- discovery (unlike the story links, nothing renders a roster off this),
    -- added via the gallery editor's "Link To: Characters" picker.
    CREATE TABLE IF NOT EXISTS gallery_character_links (
      id           SERIAL      PRIMARY KEY,
      gallery_id   INTEGER     NOT NULL REFERENCES moderator_gallery(id) ON DELETE CASCADE,
      character_id INTEGER     NOT NULL REFERENCES moderator_characters(id) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(gallery_id, character_id)
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

  // The new in-browser chapter editor: actual chapter text (`body`), a
  // draft/published state (drafts never show to readers), and a view
  // counter for the reader page that comes later. Existing chapters (all
  // created via the old link-based flow) default to 'published' so they
  // don't vanish from the story on upgrade.
  await pool.query(`
    ALTER TABLE moderator_chapters ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT '';
    ALTER TABLE moderator_chapters ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';
    ALTER TABLE moderator_chapters ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE moderator_chapters ADD COLUMN IF NOT EXISTS video_url TEXT NOT NULL DEFAULT '';
  `).catch(e => console.error('moderator_chapters editor migration:', e.message));

  // Last-touched timestamp — the "Continue Writing" chapter list on the
  // Creator Hub shows when each part was last saved/published, which
  // created_at alone can't answer once a chapter's been edited since.
  // Backfilled from created_at so existing chapters get a sane starting
  // value instead of NULL.
  await pool.query(`
    ALTER TABLE moderator_chapters ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
    UPDATE moderator_chapters SET updated_at = created_at WHERE updated_at IS NULL;
  `).catch(e => console.error('moderator_chapters updated_at migration:', e.message));

  // Chapter likes — same shape as moderator_gallery_likes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chapter_likes (
      id         SERIAL      PRIMARY KEY,
      chapter_id INTEGER     NOT NULL REFERENCES moderator_chapters(id) ON DELETE CASCADE,
      user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(chapter_id, user_id)
    );
  `).catch(e => console.error('chapter_likes migration:', e.message));

  // Guest identity — lets unregistered visitors comment and like without an
  // account (they never had to make one; a random guest_device_id cookie,
  // set the first time they hit the API, stands in for user_id everywhere
  // below). user_id becomes nullable on every one of these tables, and each
  // gets a guest_device_id column plus a partial unique index so the SAME
  // guest can't double-like the same thing (the existing UNIQUE(...,user_id)
  // constraints don't help here since Postgres treats every NULL as
  // distinct). Comments only need the column, not a unique index — replies
  // aren't deduplicated for logged-in users either.
  await pool.query(`
    ALTER TABLE content_comments ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE content_comments ADD COLUMN IF NOT EXISTS guest_name TEXT;
    ALTER TABLE content_comments ADD COLUMN IF NOT EXISTS guest_device_id TEXT;

    ALTER TABLE likes ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE likes ADD COLUMN IF NOT EXISTS guest_device_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS likes_guest_unique
      ON likes(item_type, item_id, guest_device_id) WHERE guest_device_id IS NOT NULL;

    ALTER TABLE moderator_site_likes ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE moderator_site_likes ADD COLUMN IF NOT EXISTS guest_device_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS moderator_site_likes_guest_unique
      ON moderator_site_likes(site_id, guest_device_id) WHERE guest_device_id IS NOT NULL;

    ALTER TABLE moderator_gallery_likes ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE moderator_gallery_likes ADD COLUMN IF NOT EXISTS guest_device_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS moderator_gallery_likes_guest_unique
      ON moderator_gallery_likes(gallery_id, guest_device_id) WHERE guest_device_id IS NOT NULL;

    ALTER TABLE moderator_character_likes ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE moderator_character_likes ADD COLUMN IF NOT EXISTS guest_device_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS moderator_character_likes_guest_unique
      ON moderator_character_likes(character_id, guest_device_id) WHERE guest_device_id IS NOT NULL;

    ALTER TABLE chapter_likes ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE chapter_likes ADD COLUMN IF NOT EXISTS guest_device_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS chapter_likes_guest_unique
      ON chapter_likes(chapter_id, guest_device_id) WHERE guest_device_id IS NOT NULL;
  `).catch(e => console.error('guest identity migration:', e.message));

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

  // ── Clubs — the Social page's new foundation. A club is a small
  // reddit-forum-style space: an owner, promotable admins, and a post feed.
  // Membership is its own table (not just a users<->clubs join) so role can
  // live right alongside it instead of a second lookup.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clubs (
      id                 SERIAL      PRIMARY KEY,
      slug               TEXT        NOT NULL UNIQUE,
      name               TEXT        NOT NULL,
      description        TEXT        NOT NULL DEFAULT '',
      banner_url         TEXT        NOT NULL DEFAULT '',
      banner_position_x  INTEGER     NOT NULL DEFAULT 50,
      banner_position_y  INTEGER     NOT NULL DEFAULT 50,
      icon_url           TEXT        NOT NULL DEFAULT '',
      owner_user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS club_members (
      id         SERIAL      PRIMARY KEY,
      club_id    INTEGER     NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT        NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
      joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(club_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS club_posts (
      id              SERIAL      PRIMARY KEY,
      club_id         INTEGER     NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      author_user_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title           TEXT        NOT NULL DEFAULT '',
      body            TEXT        NOT NULL DEFAULT '',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_club_posts_club ON club_posts(club_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_club_members_club ON club_members(club_id);
    CREATE INDEX IF NOT EXISTS idx_club_members_user ON club_members(user_id);
  `).catch(e => console.error('clubs migration:', e.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_post_likes (
      id         SERIAL      PRIMARY KEY,
      post_id    INTEGER     NOT NULL REFERENCES club_posts(id) ON DELETE CASCADE,
      user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(post_id, user_id)
    );
  `).catch(e => console.error('club_post_likes migration:', e.message));

  // Guests are still excluded from clubs generally (joining, commenting,
  // voting), but liking a club post specifically is allowed per a later
  // revision — same guest_device_id treatment as the other like tables.
  await pool.query(`
    ALTER TABLE club_post_likes ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE club_post_likes ADD COLUMN IF NOT EXISTS guest_device_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS club_post_likes_guest_unique
      ON club_post_likes(post_id, guest_device_id) WHERE guest_device_id IS NOT NULL;
  `).catch(e => console.error('club_post_likes guest migration:', e.message));

  // Tracks the last time a viewer opened a given club — powers the "Best"
  // feed's small personalization boost for clubs you've recently browsed
  // (in addition to the bigger boost for clubs you're actually a member
  // of). Upserted on every club page load, not just membership actions.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_visits (
      user_id        INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      club_id        INTEGER     NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      last_visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, club_id)
    );
  `).catch(e => console.error('club_visits migration:', e.message));

  // "Posts By Admin Team" is a per-post choice made at creation time, not
  // implied by the author being an admin — an owner/admin can still post to
  // the club's general feed and only some of their posts land here. Needs
  // its own flag rather than filtering by author role.
  await pool.query(`
    ALTER TABLE club_posts ADD COLUMN IF NOT EXISTS is_admin_post BOOLEAN NOT NULL DEFAULT FALSE;
  `).catch(e => console.error('club_posts is_admin_post migration:', e.message));

  // Each post can carry its own image (not the author's pfp) — shown in
  // the feed thumbnail and big on the post's own page. Empty means the
  // client falls back to a shared "no image" placeholder.
  await pool.query(`
    ALTER TABLE club_posts ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';
  `).catch(e => console.error('club_posts image_url migration:', e.message));

  // Posts can now carry several images (click-through in the post view, not
  // an auto-slideshow) plus a focal-point reposition for just the feed
  // thumbnail — same "never actually crop the source image" idea as the
  // gallery preview crop. image_url stays in sync as image_urls[0] so
  // existing thumbnail-rendering code doesn't need to change. A post can
  // also carry a simple poll (question/type/options) — voting/rendering on
  // the post itself comes later, this just makes sure the data isn't lost.
  await pool.query(`
    ALTER TABLE club_posts ADD COLUMN IF NOT EXISTS image_urls JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE club_posts ADD COLUMN IF NOT EXISTS preview_position_x INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE club_posts ADD COLUMN IF NOT EXISTS preview_position_y INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE club_posts ADD COLUMN IF NOT EXISTS poll JSONB;
  `).catch(e => console.error('club_posts images/poll migration:', e.message));
  await pool.query(`
    UPDATE club_posts SET image_urls = jsonb_build_array(image_url) WHERE image_url != '' AND image_urls = '[]'::jsonb;
  `).catch(e => console.error('club_posts image_urls backfill:', e.message));

  // Poll votes — once-castable (UNIQUE per post/user). option_indices is an
  // array so a single "multiple choice" vote can cover more than one
  // option; "single" polls just store a one-element array.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_post_poll_votes (
      id             SERIAL      PRIMARY KEY,
      post_id        INTEGER     NOT NULL REFERENCES club_posts(id) ON DELETE CASCADE,
      user_id        INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      option_indices INTEGER[]   NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(post_id, user_id)
    );
  `).catch(e => console.error('club_post_poll_votes migration:', e.message));

  // "Featured Cards" (was "Meet the Admins") — turned out clubs want to
  // spotlight whatever matters to them, not necessarily their admin roster
  // (e.g. a club's own cast of important characters). Each card is just a
  // name/description/picture an owner/admin fills out by hand — not tied to
  // any user account. Renamed from club_admin_cards (which was keyed to
  // user_id) rather than dropped, so the handful of test rows survive with
  // their old display name backfilled into the new free-text `name` field.
  await pool.query(`ALTER TABLE IF EXISTS club_admin_cards RENAME TO club_featured_cards;`)
    .catch(e => console.error('club_featured_cards rename migration:', e.message));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_featured_cards (
      id           SERIAL      PRIMARY KEY,
      club_id      INTEGER     NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      name         TEXT        NOT NULL DEFAULT '',
      description  TEXT        NOT NULL DEFAULT '',
      image_url    TEXT        NOT NULL DEFAULT '/images/defaultchar.jpg',
      sort_order   INTEGER     NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE club_featured_cards ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
    ALTER TABLE club_featured_cards ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
  `).catch(e => console.error('club_featured_cards migration:', e.message));
  await pool.query(`
    UPDATE club_featured_cards cfc SET name = COALESCE(u.display_name, u.username, 'Featured')
      FROM users u WHERE u.id = cfc.user_id AND cfc.name = '';
  `).catch(() => {}); // no-op once user_id is gone (or never existed)
  await pool.query(`ALTER TABLE club_featured_cards DROP COLUMN IF EXISTS user_id;`)
    .catch(e => console.error('club_featured_cards drop user_id migration:', e.message));

  // Section title is editable per club (defaults to "Featured Cards").
  await pool.query(`
    ALTER TABLE clubs ADD COLUMN IF NOT EXISTS icon_original_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE clubs ADD COLUMN IF NOT EXISTS featured_cards_title TEXT NOT NULL DEFAULT 'Featured Cards';
  `).catch(e => console.error('clubs featured_cards_title migration:', e.message));

  // Right sidebar: a smaller user-written title + splash message (separate
  // from the main "About"/description), an NSFW flag driving the
  // Public/Mature tag, and a rules list. Moderators list reuses
  // club_members (owner/admin rows) — no new table needed for that part.
  await pool.query(`
    ALTER TABLE clubs ADD COLUMN IF NOT EXISTS sidebar_title TEXT NOT NULL DEFAULT '';
    ALTER TABLE clubs ADD COLUMN IF NOT EXISTS sidebar_message TEXT NOT NULL DEFAULT '';
    ALTER TABLE clubs ADD COLUMN IF NOT EXISTS is_nsfw BOOLEAN NOT NULL DEFAULT FALSE;
  `).catch(e => console.error('clubs sidebar fields migration:', e.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_rules (
      id           SERIAL      PRIMARY KEY,
      club_id      INTEGER     NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      title        TEXT        NOT NULL DEFAULT '',
      description  TEXT        NOT NULL DEFAULT '',
      sort_order   INTEGER     NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).catch(e => console.error('club_rules migration:', e.message));

  // "More Pages" — one-off lore/info pages a club can build at its own
  // pace (a page for updates, a page per character, whatever). "Home" is
  // NOT a row here — it's the built-in default page (the Hub/Social view)
  // every club already has; this table is only the extra pages layered on
  // top of it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_pages (
      id           SERIAL      PRIMARY KEY,
      club_id      INTEGER     NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      slug         TEXT        NOT NULL,
      title        TEXT        NOT NULL DEFAULT '',
      content      TEXT        NOT NULL DEFAULT '',
      sort_order   INTEGER     NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(club_id, slug)
    );
  `).catch(e => console.error('club_pages migration:', e.message));

  // Club editor: the built-in "Home" page's Cover Image (static or
  // slideshow) and Welcome Title (separate from the club's name — defaults
  // to "Welcome To: <name>" client-side when empty, but is overridable).
  await pool.query(`
    ALTER TABLE clubs ADD COLUMN IF NOT EXISTS welcome_title TEXT NOT NULL DEFAULT '';
    ALTER TABLE clubs ADD COLUMN IF NOT EXISTS cover_mode TEXT NOT NULL DEFAULT 'static';
    ALTER TABLE clubs ADD COLUMN IF NOT EXISTS cover_image_url TEXT NOT NULL DEFAULT '';
  `).catch(e => console.error('clubs cover/welcome-title migration:', e.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_slideshow_images (
      id           SERIAL      PRIMARY KEY,
      club_id      INTEGER     NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      image_url    TEXT        NOT NULL,
      sort_order   INTEGER     NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).catch(e => console.error('club_slideshow_images migration:', e.message));

  // Page template — drives the little icon in the editor's Pages list
  // (ribbon/star/paintbrush) and, later, which specific editor/renderer a
  // page gets. Existing test pages (Solus/Inferno) default to 'general'.
  await pool.query(`
    ALTER TABLE club_pages ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'general';
  `).catch(e => console.error('club_pages type migration:', e.message));

  // General Page template — cover image/slideshow (same static/slideshow
  // toggle as the club Home page) plus up to three named text sections
  // (text_fields: [{title, body}, ...]).
  await pool.query(`
    ALTER TABLE club_pages ADD COLUMN IF NOT EXISTS cover_mode TEXT NOT NULL DEFAULT 'static';
    ALTER TABLE club_pages ADD COLUMN IF NOT EXISTS cover_image_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE club_pages ADD COLUMN IF NOT EXISTS text_fields JSONB NOT NULL DEFAULT '[]';
  `).catch(e => console.error('club_pages general-template migration:', e.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_page_slideshow_images (
      id           SERIAL      PRIMARY KEY,
      page_id      INTEGER     NOT NULL REFERENCES club_pages(id) ON DELETE CASCADE,
      image_url    TEXT        NOT NULL,
      sort_order   INTEGER     NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).catch(e => console.error('club_page_slideshow_images migration:', e.message));

  // Gallery Page template — a simple per-page image collection. Same
  // "locked preview crop" idea as moderator_gallery (position_x/position_y
  // store a focal point for object-position; the source image itself is
  // never re-cropped/re-uploaded) but a standalone table since club pages
  // aren't tied to owner_user_id/story-linking semantics.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_page_gallery_images (
      id           SERIAL      PRIMARY KEY,
      page_id      INTEGER     NOT NULL REFERENCES club_pages(id) ON DELETE CASCADE,
      image_url    TEXT        NOT NULL,
      title        TEXT        NOT NULL DEFAULT '',
      description  TEXT        NOT NULL DEFAULT '',
      position_x   INTEGER     NOT NULL DEFAULT 50,
      position_y   INTEGER     NOT NULL DEFAULT 50,
      sort_order   INTEGER     NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).catch(e => console.error('club_page_gallery_images migration:', e.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_page_gallery_likes (
      id         SERIAL      PRIMARY KEY,
      image_id   INTEGER     NOT NULL REFERENCES club_page_gallery_images(id) ON DELETE CASCADE,
      user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(image_id, user_id)
    );
  `).catch(e => console.error('club_page_gallery_likes migration:', e.message));

  // Promotion Page template — a vertical list of link-out cards (image,
  // title, description, a single link title+URL). Everything but the image
  // is required at creation.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_page_promotion_cards (
      id           SERIAL      PRIMARY KEY,
      page_id      INTEGER     NOT NULL REFERENCES club_pages(id) ON DELETE CASCADE,
      image_url    TEXT        NOT NULL DEFAULT '',
      title        TEXT        NOT NULL DEFAULT '',
      description  TEXT        NOT NULL DEFAULT '',
      link_title   TEXT        NOT NULL DEFAULT '',
      link_url     TEXT        NOT NULL DEFAULT '',
      sort_order   INTEGER     NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).catch(e => console.error('club_page_promotion_cards migration:', e.message));

  // Every club (new ones via POST /api/clubs, which never specifies a
  // banner_url, letting this column default kick in) starts with this
  // image as its banner rather than the plain fallback card.
  await pool.query(`
    ALTER TABLE clubs ALTER COLUMN banner_url SET DEFAULT '/images/gallery/solusgarnet_17.png';
    UPDATE clubs SET banner_url = '/images/gallery/solusgarnet_17.png' WHERE banner_url = '';
  `).catch(e => console.error('clubs default banner migration:', e.message));

  // Club page theme — same default (plain dark) / custom-blurred-background
  // pattern as a profile or story page, just scoped to the club.
  await pool.query(`
    ALTER TABLE clubs ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE clubs ADD COLUMN IF NOT EXISTS theme_bg_url TEXT NOT NULL DEFAULT '';
  `).catch(e => console.error('clubs theme migration:', e.message));

  // BTWClub — the site-wide default club every account belongs to (an
  // r/all equivalent). Owned by the admin account; seeded once, then every
  // existing user is backfilled into it on each restart (new signups join
  // it directly at registration instead of waiting for a restart).
  await pool.query(`
    INSERT INTO clubs (slug, name, description, icon_url, owner_user_id)
    SELECT 'btwclub', 'BTW Clubhouse', 'The default club everyone''s a part of — home base for the whole community.',
           '/images/gallery/kloudselfie_7.png', u.id
    FROM users u
    WHERE u.email_hash = $1 AND NOT EXISTS (SELECT 1 FROM clubs WHERE slug = 'btwclub')
  `, [process.env.ADMIN_EMAIL_HASH]).catch(e => console.error('BTWClub seed:', e.message));

  await pool.query(`
    UPDATE clubs SET name = 'BTW Clubhouse' WHERE slug = 'btwclub' AND name != 'BTW Clubhouse';
  `).catch(e => console.error('BTWClub rename migration:', e.message));

  // Club Types — Reddit-style topic tags (Sports, Writing, Gaming, etc.),
  // up to 3 per club. Fixed list (not a grown-by-hand catalog like Fandom),
  // powers the Explore page's topic filters.
  await pool.query(`
    ALTER TABLE clubs ADD COLUMN IF NOT EXISTS club_types JSONB NOT NULL DEFAULT '[]';
  `).catch(e => console.error('clubs club_types migration:', e.message));
  await pool.query(`
    UPDATE clubs SET club_types = '["Community", "Writing", "Gaming"]'::jsonb
    WHERE slug = 'btwclub' AND club_types = '[]'::jsonb;
  `).catch(e => console.error('BTWClub types seed:', e.message));


  await pool.query(`
    INSERT INTO club_members (club_id, user_id, role)
    SELECT c.id, u.id, CASE WHEN u.id = c.owner_user_id THEN 'owner' ELSE 'member' END
    FROM clubs c CROSS JOIN users u
    WHERE c.slug = 'btwclub' AND u.username NOT IN ('holly_allen', 'holly_chan')
    ON CONFLICT DO NOTHING
  `).catch(e => console.error('BTWClub membership backfill:', e.message));

  // Hard-excluded from discoverability sitewide (see /api/recommended-followers) —
  // keep them out of club membership too, in case they were ever added before
  // this exclusion existed.
  await pool.query(`
    DELETE FROM club_members WHERE user_id IN (SELECT id FROM users WHERE username IN ('holly_allen', 'holly_chan'))
  `).catch(e => console.error('holly_allen/holly_chan club membership cleanup:', e.message));
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

// Resolves the optional (not required) viewer from a Bearer token, and
// whether they're allowed to see NSFW content. Guests (no token at all)
// are allowed by default now — the AO3-style age gate at the door is what
// stands in for that instead. The ONLY way mature/explicit content is
// hidden is a logged-in account that has deliberately turned SFW Mode on.
// Used anywhere spicy/NSFW content might get shuffled into a public,
// no-auth-required feed (spotlights, activity feed) so it can be
// filtered/blurred server-side instead of trusting the client.
async function getViewerNsfwAccess(req) {
  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }
  if (viewerId === null) return { viewerId: null, nsfwAllowed: true };
  const { rows: [row] } = await pool.query('SELECT nsfw_enabled FROM users WHERE id = $1', [viewerId]);
  return { viewerId, nsfwAllowed: !!(row && row.nsfw_enabled) };
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

// Its own dark+gold shell (not emailShell, whose navy-blue header doesn't
// fit this one) — this is the very first email a new user sees, so it gets
// the full site-matching treatment: black-and-gold header, dark card body,
// gold gradient CTA button.
const emailActivate = (name, verifyUrl) => `
  <div style="background:#0a0908;padding:40px 16px;font-family:Georgia,'Times New Roman',serif;">
    <div style="max-width:520px;margin:0 auto;">
      <div style="background:#0d0b08;border:1px solid #3a2f1a;border-radius:14px 14px 0 0;padding:30px 32px;text-align:center;">
        <h1 style="color:#f0c060;font-size:1.7rem;margin:0;letter-spacing:0.04em;text-shadow:0 0 18px rgba(240,192,96,0.45);">
          ✨ Between Two Worlds ✨
        </h1>
      </div>
      <div style="background:#161116;padding:38px 34px;border-left:1px solid #3a2f1a;border-right:1px solid #3a2f1a;font-family:Arial,Helvetica,sans-serif;">
        <h2 style="color:#f2ece0;font-size:1.5rem;margin:0 0 16px;text-align:center;">
          Welcome, <span style="color:#f0c060;">${name}</span>!
        </h2>
        <p style="color:#c9c2d4;font-size:1rem;line-height:1.75;margin:0 0 30px;text-align:center;">
          You are now entering BTW, a world like no other! To activate your account, all you have to do is press the button below ^w^ Adventure awaits!
        </p>
        <div style="text-align:center;margin-bottom:8px;">
          <a href="${verifyUrl}"
             style="display:inline-block;background:linear-gradient(135deg,#f0c060,#d4a03f);color:#1a1510;text-decoration:none;padding:16px 44px;border-radius:10px;font-weight:bold;font-size:1.05rem;letter-spacing:0.02em;font-family:Arial,Helvetica,sans-serif;">
            Activate Your Account
          </a>
        </div>
      </div>
      <div style="background:#0d0b08;border:1px solid #3a2f1a;border-top:none;border-radius:0 0 14px 14px;padding:18px 32px;text-align:center;">
        <p style="color:#6b6470;font-size:0.78rem;margin:0;font-family:Arial,Helvetica,sans-serif;">
          If you didn't sign up for Between Two Worlds, you can safely ignore this email.
        </p>
      </div>
    </div>
  </div>
`;

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

    // Every account starts as a member of BTWClub, the site-wide default
    // club (r/all-equivalent) — see the clubs migration for how it's seeded.
    // holly_allen/holly_chan are hard-excluded from discoverability sitewide.
    if (!['holly_allen', 'holly_chan'].includes(username.toLowerCase())) {
      await pool.query(
        `INSERT INTO club_members (club_id, user_id, role)
         SELECT id, $1, 'member' FROM clubs WHERE slug = 'btwclub'
         ON CONFLICT DO NOTHING`,
        [newUser.id]
      ).catch(e => console.error('BTWClub auto-join insert:', e.message));
    }

    const verifyUrl = `https://${siteHost(req)}/api/auth/verify?token=${verify_token}`
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

// POST /api/auth/resend-verification — the "Send again" button under the
// post-registration "check your inbox" message. Reuses the existing
// verify_token (an old copy of the email in someone's inbox keeps working
// too — nothing gets invalidated by resending). Responds identically
// whether or not the email is registered/already verified so this can't
// be used to probe which addresses have accounts.
app.post('/api/auth/resend-verification', async (req, res) => {
  const { email, from } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  const genericMessage = { message: "If that email has a pending activation, we've sent it again." };

  const { rows: [user] } = await pool.query(
    'SELECT display_name, username, verify_token, verified FROM users WHERE email_hash = $1',
    [hashEmail(email)]
  );
  if (!user || user.verified || !user.verify_token) return res.json(genericMessage);

  const dname = user.display_name || user.username;
  const verifyUrl = `https://${siteHost(req)}/api/auth/verify?token=${user.verify_token}`
    + (from ? `&from=${encodeURIComponent(from)}` : '');

  try {
    await resend.emails.send({
      from: 'Between Two Worlds <hello@btwfanfic.net>',
      reply_to: 'hello@btwfanfic.net',
      to: email,
      subject: 'Activate your Between Two Worlds account',
      html: emailActivate(dname, verifyUrl),
      text: `Hello, ${dname}!\n\nThanks for signing up for Between Two Worlds.\n\nClick the link below to activate your account:\n${verifyUrl}\n\nIf you didn't sign up, you can safely ignore this email.\n\n— Between Two Worlds`,
    });
  } catch (err) {
    console.error('Resend verification email error:', err.message);
  }
  res.json(genericMessage);
});

// GET /api/auth/verify?token=xxx — shows confirmation page (safe for email scanners)
app.get('/api/auth/verify', async (req, res) => {
  const { token, from } = req.query;
  if (!token) return res.redirect(`https://${siteHost(req)}/login`);

  // Check token exists but do NOT consume it — scanner-safe
  const { rows: [user] } = await pool.query('SELECT id FROM users WHERE verify_token = $1', [token]);
  if (!user) {
    return res.status(400).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Invalid Link — Between Two Worlds</title>
<style>body{font-family:Arial,sans-serif;background:#0d0d1a;color:#ccc;text-align:center;padding:60px 20px;}
h2{color:#e55;}a{color:#7ca0ff;}</style></head>
<body><h2>Invalid or expired link</h2>
<p>This activation link has already been used or is invalid.</p>
<a href="https://${siteHost(req)}/login">Back to login →</a></body></html>`);
  }

  // Auto-activates via JS on load — no button/click required from the real
  // user, so there's no visible "second page" in the way. The raw GET
  // itself still never consumes the token (still scanner-safe: a dumb
  // HTTP-only link-scanner that doesn't execute JS never fires the POST
  // below), it's just that a real browser does it instantly instead of
  // waiting on a manual click.
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Activating… — Between Two Worlds</title>
<style>
  body{font-family:Arial,sans-serif;background:#0d0d1a;color:#ccc;display:flex;align-items:center;
       justify-content:center;min-height:100vh;margin:0;}
  .box{background:#161625;border:1px solid rgba(255,255,255,0.08);border-radius:14px;
       padding:48px 40px;max-width:420px;text-align:center;}
  h2{color:#fff;margin:0 0 12px;}
  p{color:rgba(200,190,230,0.7);font-size:0.95rem;line-height:1.6;margin:0 0 8px;}
  .spinner{width:32px;height:32px;margin:0 auto 20px;border:3px solid rgba(255,255,255,0.15);
       border-top-color:#00796b;border-radius:50%;animation:spin 0.8s linear infinite;}
  @keyframes spin{to{transform:rotate(360deg);}}
  .msg{margin-top:16px;font-size:0.9rem;min-height:1.2em;}
  button{background:#00796b;color:#fff;border:none;border-radius:8px;padding:14px 36px;
         font-size:1rem;font-weight:bold;cursor:pointer;transition:background .15s;display:none;}
  button:hover{background:#009688;}
</style></head>
<body><div class="box">
  <div class="spinner" id="spinner"></div>
  <h2 id="heading">Activating your account…</h2>
  <p id="subtext">Just a moment — this'll only take a second.</p>
  <div class="msg" id="msg"></div>
  <button id="retry-btn" onclick="activate()">Try Again</button>
</div>
<script>
async function activate() {
  document.getElementById('spinner').style.display = 'block';
  document.getElementById('heading').textContent = 'Activating your account…';
  document.getElementById('retry-btn').style.display = 'none';
  document.getElementById('msg').textContent = '';
  try {
    const r = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({token: ${JSON.stringify(token)}, from: ${JSON.stringify(from || '')}})
    });
    const d = await r.json();
    if (d.redirect) { window.location.href = d.redirect; }
    else {
      document.getElementById('spinner').style.display = 'none';
      document.getElementById('heading').textContent = 'Something went wrong';
      document.getElementById('msg').style.color = '#e55';
      document.getElementById('msg').textContent = d.error || 'Something went wrong.';
      document.getElementById('retry-btn').style.display = 'inline-block';
    }
  } catch (e) {
    document.getElementById('spinner').style.display = 'none';
    document.getElementById('heading').textContent = 'Network error';
    document.getElementById('msg').style.color = '#e55';
    document.getElementById('msg').textContent = 'Please try again.';
    document.getElementById('retry-btn').style.display = 'inline-block';
  }
}
activate();
</script></body></html>`);
});

// POST /api/auth/verify — actually activates the account
app.post('/api/auth/verify', async (req, res) => {
  const { token, from: fromPath } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token.' });

  const { rows: [user] } = await pool.query('SELECT * FROM users WHERE verify_token = $1', [token]);
  if (!user) return res.status(400).json({ error: 'This link has already been used or is invalid.' });

  await pool.query('UPDATE users SET verified = true, verify_token = NULL WHERE id = $1', [user.id]);

  // Every new account follows @btwteam by default — they're free to
  // unfollow afterward, this just seeds it so the welcome modal has
  // something real to show as already-followed.
  await pool.query(
    `INSERT INTO user_follows (follower_id, followed_id)
     SELECT $1, id FROM users WHERE username = 'btwteam'
     ON CONFLICT DO NOTHING`,
    [user.id]
  ).catch(e => console.error('btwteam auto-follow:', e.message));

  const autoToken = signToken(user.id);
  // No separate "welcome" email anymore — activation now auto-logs the
  // user in and redirects them into the site immediately, so a second
  // email with its own "Login to the site" link just arrived redundant
  // (they're usually already on the site, logged in, by the time it's read).
  const loginUrl  = `https://${siteHost(req)}/login?autotoken=${autoToken}&welcome=1`
    + (fromPath ? `&from=${encodeURIComponent(fromPath)}` : '');

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
            notif_theme, notif_theme_bg_url, reader_theme, reader_theme_bg_url, nsfw_enabled
     FROM users WHERE id = $1`, [req.user.id]
  );
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const is_admin = user.email_hash === process.env.ADMIN_EMAIL_HASH;
  const { rows: modRows } = await pool.query('SELECT 1 FROM moderator_sites WHERE owner_user_id = $1 LIMIT 1', [user.id]);
  const is_moderator = modRows.length > 0;
  res.json({ user: {
    id: user.id, username: user.username, display_name: user.display_name, avatar: user.avatar || null,
    avatar_position_x: user.avatar_position_x, avatar_position_y: user.avatar_position_y,
    is_admin, is_moderator, nsfw_enabled: user.nsfw_enabled,
    notif_theme: user.notif_theme || 'default', notif_theme_bg_url: user.notif_theme_bg_url || '',
    reader_theme: user.reader_theme || 'dark', reader_theme_bg_url: user.reader_theme_bg_url || '',
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
    const { display_name, email, current_password, email_newsletter, nsfw_enabled } = req.body;
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

    if (nsfw_enabled !== undefined) {
      updates.nsfw_enabled = !!nsfw_enabled;
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

      const confirmUrl = `https://${siteHost(req)}/api/auth/confirm-email?token=${changeToken}`;
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
      'SELECT id, username, display_name, email, avatar, nsfw_enabled FROM users WHERE id = $1', [user.id]
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
  const resetUrl = `https://${siteHost(req)}/login?reset=${token}`;
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
  uploadAvatar.fields([{ name: 'avatar', maxCount: 1 }, { name: 'avatar_original', maxCount: 1 }])(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    const avatarFile = req.files && req.files.avatar && req.files.avatar[0];
    if (!avatarFile) return res.status(400).json({ error: 'No file uploaded.' });

    const exts = ['.jpg', '.png', '.webp', '.gif'];
    const newFile = avatarFile.filename;
    exts.forEach(ext => {
      const old = path.join(AVATARS_DIR, `${req.user.id}${ext}`);
      if (path.basename(old) !== newFile && fs.existsSync(old)) fs.unlinkSync(old);
    });

    const avatarUrl = `/images/avatars/${avatarFile.filename}`;
    // `avatar_original` is only sent the first time a NEW source photo is
    // picked -- Recrop re-sends just `avatar` (a fresh bake) from the
    // existing original, so avatar_original_url stays untouched. Same
    // pattern as the story banner/cover-card fix.
    const originalFile = req.files.avatar_original && req.files.avatar_original[0];
    if (originalFile) {
      const originalUrl = `/images/avatars/${originalFile.filename}`;
      await pool.query(
        'UPDATE users SET avatar = $1, avatar_original_url = $2, avatar_position_x = 50, avatar_position_y = 50, avatar_zoom = 100 WHERE id = $3',
        [avatarUrl, originalUrl, req.user.id]
      );
    } else {
      await pool.query(
        'UPDATE users SET avatar = $1, avatar_position_x = 50, avatar_position_y = 50, avatar_zoom = 100 WHERE id = $2',
        [avatarUrl, req.user.id]
      );
    }
    const { rows: [u] } = await pool.query('SELECT avatar_original_url FROM users WHERE id = $1', [req.user.id]);
    res.json({ avatar: avatarUrl, avatar_original_url: u.avatar_original_url, position_x: 50, position_y: 50, zoom: 100 });
  });
});

app.put('/api/auth/avatar-position', requireAuth, async (req, res) => {
  const x = parseInt(req.body.position_x, 10);
  const y = parseInt(req.body.position_y, 10);
  if (![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 100)) return res.status(400).json({ error: 'Positions must be 0-100.' });
  const zoom = clampZoom(req.body.zoom, 100);
  await pool.query('UPDATE users SET avatar_position_x = $1, avatar_position_y = $2, avatar_zoom = $3 WHERE id = $4', [x, y, zoom, req.user.id]);
  res.json({ position_x: x, position_y: y, zoom });
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
        <a href="https://${siteHost(req)}/profile" style="color:#1565c0;">Back to profile</a>
      </body></html>
    `);
  }
  await pool.query(
    'UPDATE users SET email = $1, email_hash = $2, pending_email = NULL, email_change_token = NULL WHERE id = $3',
    [user.pending_email, hashEmail(decryptEmail(user.pending_email)), user.id]
  );
  res.redirect(`https://${siteHost(req)}/profile?email_verified=1`);
});

app.get('/api/auth/profile', requireAuth, async (req, res) => {
  const { rows: [user] } = await pool.query(
    'SELECT id, username, display_name, email, avatar, avatar_original_url, email_newsletter, nsfw_enabled FROM users WHERE id = $1', [req.user.id]
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
  const viewerId = optionalViewerId(req);
  const { rows } = await pool.query(
    viewerId
      ? 'SELECT item_id FROM likes WHERE user_id = $1 AND item_type = $2'
      : 'SELECT item_id FROM likes WHERE guest_device_id = $1 AND item_type = $2',
    [viewerId || req.guestId, req.params.type]
  );
  res.json({ liked: rows.map(r => r.item_id) });
});

app.post('/api/likes/toggle/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const itemId = parseInt(id, 10);
  if (!['art', 'chapter'].includes(type) || isNaN(itemId))
    return res.status(400).json({ error: 'Invalid type or id' });

  const viewerId = optionalViewerId(req);
  const { rows: [existing] } = await pool.query(
    viewerId
      ? 'SELECT id FROM likes WHERE user_id = $1 AND item_type = $2 AND item_id = $3'
      : 'SELECT id FROM likes WHERE guest_device_id = $1 AND item_type = $2 AND item_id = $3',
    [viewerId || req.guestId, type, itemId]
  );

  if (existing) {
    await pool.query('DELETE FROM likes WHERE id = $1', [existing.id]);
  } else {
    await pool.query(
      'INSERT INTO likes (user_id, guest_device_id, item_type, item_id) VALUES ($1, $2, $3, $4)',
      [viewerId, viewerId ? null : req.guestId, type, itemId]
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
    ? attachments.map(a => `<p style="margin:8px 0 0;font-size:0.85rem;color:#555;">Attachment: <a href="https://${siteHost(req)}${a.url}">${a.name}</a></p>`).join('')
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
          <p style="margin-top:16px;"><a href="https://${siteHost(req)}/inbox" style="color:#c2547a;">View in your inbox →</a></p>
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

// Resolves a {title, link} pair per reportable target type, for the admin
// notification email — same target_type/target_id polymorphism idea as
// commentTargetInfo() below, kept separate since the reportable set
// (story/comment/dm_message) doesn't line up with the commentable set.
async function reportTargetInfo(targetType, targetId) {
  if (targetType === 'user') {
    const { rows: [u] } = await pool.query('SELECT username, display_name FROM users WHERE id = $1', [targetId]);
    if (!u) return null;
    return { title: `User: ${u.display_name || u.username}`, link: `/${u.username}` };
  }
  if (targetType === 'story') {
    const { rows: [s] } = await pool.query(
      `SELECT ms.site_title, ms.story_path, u.username AS owner_username
       FROM moderator_sites ms JOIN users u ON u.id = ms.owner_user_id
       WHERE ms.id = $1`,
      [targetId]
    );
    if (!s) return null;
    return { title: s.site_title || 'Untitled Story', link: `/${s.story_path}` };
  }
  if (targetType === 'comment') {
    const { rows: [c] } = await pool.query(
      `SELECT cc.body, cc.target_type AS comment_target_type, cc.target_id AS comment_target_id, u.username
       FROM content_comments cc JOIN users u ON u.id = cc.user_id
       WHERE cc.id = $1`,
      [targetId]
    );
    if (!c) return null;
    const info = await commentTargetInfo(c.comment_target_type, c.comment_target_id).catch(() => null);
    return { title: `Comment by ${c.username}: "${(c.body || '').slice(0, 80)}"`, link: info ? info.link : null };
  }
  if (targetType === 'dm_message') {
    const { rows: [m] } = await pool.query(
      `SELECT dm.body, u.username FROM dm_messages dm JOIN users u ON u.id = dm.sender_id WHERE dm.id = $1`,
      [targetId]
    );
    if (!m) return null;
    return { title: `DM from ${m.username}: "${(m.body || '').slice(0, 80)}"`, link: null };
  }
  return null;
}

// POST /api/reports — user-safety flag on a story, comment, or DM message.
// Persists to the reports table (for a future admin review list) AND
// emails the admin immediately, same as the legacy /api/report above, since
// this is meant to be seen right away rather than discovered later.
app.post('/api/reports', requireAuth, async (req, res) => {
  const { target_type, target_id, reason } = req.body;
  if (!['story', 'comment', 'dm_message', 'user'].includes(target_type)) return res.status(400).json({ error: 'Invalid report type.' });
  const targetId = parseInt(target_id, 10);
  if (!targetId) return res.status(400).json({ error: 'Invalid target.' });
  const cleanReason = (reason || '').trim().slice(0, 1000);

  await pool.query(
    `INSERT INTO reports (reporter_user_id, target_type, target_id, reason) VALUES ($1, $2, $3, $4)`,
    [req.user.id, target_type, targetId, cleanReason]
  );

  const { rows: [reporter] } = await pool.query('SELECT username, display_name FROM users WHERE id = $1', [req.user.id]);
  const reporterName = (reporter && (reporter.display_name || reporter.username)) || 'Unknown';
  const info = await reportTargetInfo(target_type, targetId).catch(() => null);
  const typeLabel = { story: 'Story', comment: 'Comment', dm_message: 'DM Message', user: 'User' }[target_type];
  const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  resend.emails.send({
    from: 'BTW Reports <noreply@btwfanfic.net>',
    to: process.env.ADMIN_EMAIL,
    subject: `Content Report — ${typeLabel} — Between Two Worlds`,
    html: emailShell(`
      <h2 style="color:#c2547a;font-size:1.1rem;margin:0 0 12px;">⚠️ Content Report</h2>
      <p style="color:#424242;font-size:0.9rem;margin:0 0 6px;"><strong>Reported by:</strong> ${reporterName}</p>
      <p style="color:#424242;font-size:0.9rem;margin:0 0 6px;"><strong>Content:</strong> ${info ? escHtml(info.title) : `${typeLabel} #${targetId}`}</p>
      ${info && info.link ? `<p style="color:#424242;font-size:0.9rem;margin:0 0 12px;"><a href="https://${siteHost(req)}${info.link}">View content →</a></p>` : ''}
      ${cleanReason ? `<div style="background:#fff8f8;border-left:3px solid #c2547a;padding:12px 16px;border-radius:4px;margin:12px 0;">
        <p style="color:#212121;font-size:0.95rem;margin:0;white-space:pre-wrap;">${escHtml(cleanReason)}</p>
      </div>` : ''}
    `),
  }).catch(console.error);

  res.json({ message: 'Report submitted. Thank you for helping keep the community safe.' });
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
    .map(a => `<div style="margin-top:12px;"><img src="https://${siteHost(req)}${a.url}" alt="${a.name}" style="max-width:100%;border-radius:8px;" /></div>`)
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
        html:       emailShell(`<div style="font-size:0.95rem;color:#424242;line-height:1.7;">${escaped}</div>${attachHtml}<p style="font-size:0.78rem;color:#999;margin-top:24px;">You're receiving this because you opted in to BTW newsletters. You can turn this off any time in your <a href="https://${siteHost(req)}/profile">profile settings</a>.</p>`),
        text:       body.trim() + '\n\n---\nYou can unsubscribe at any time via your profile settings at https://' + siteHost(req) + '/profile',
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
      // fieldname suffix keeps this collision-free when a route uploads more
      // than one file at once (e.g. banner + banner_original together) —
      // Date.now() alone can land on the same millisecond for both.
      cb(null, `${req.user.id}_${Date.now()}_${file.fieldname}${ext}`);
    },
  }),
  // Bumped from 10MB — modern phone camera photos routinely land in the
  // 10-20MB range and were getting rejected outright, with no graceful
  // error handling below this to explain why the request failed.
  limits: { fileSize: 25 * 1024 * 1024 },
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
      `SELECT ms.*, u.avatar AS author_avatar FROM moderator_sites ms JOIN users u ON u.id = ms.owner_user_id
       WHERE ms.story_path = $1 AND ms.owner_user_id = $2`, [storyPath, req.user.id]
    );
    if (site) return site;
  }
  const { rows: [site] } = await pool.query(
    `SELECT ms.*, u.avatar AS author_avatar FROM moderator_sites ms JOIN users u ON u.id = ms.owner_user_id
     WHERE ms.owner_user_id = $1 ORDER BY ms.created_at ASC LIMIT 1`, [req.user.id]
  );
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
// This same endpoint backs both the public hub billboard AND the admin-only
// Hub Image Builder's management grid — an admin managing slides needs to
// see every slide regardless of their own personal NSFW toggle, otherwise a
// freshly-created NSFW slide would vanish from their own grid the moment
// SFW Mode happens to be on, looking exactly like the save silently failed.
app.get('/api/hub-billboard', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM hub_billboard_slides ORDER BY sort_order, id');
  const { viewerId, nsfwAllowed } = await getViewerNsfwAccess(req);
  let isAdmin = false;
  if (viewerId) {
    const { rows: [u] } = await pool.query('SELECT email_hash FROM users WHERE id = $1', [viewerId]);
    isAdmin = !!(u && u.email_hash === process.env.ADMIN_EMAIL_HASH);
  }
  res.json({ slides: (nsfwAllowed || isAdmin) ? rows : rows.filter(s => !s.is_nsfw) });
});

// ── TOS Blobs — simple named-text storage, admin only ──────────────────────
app.get('/api/admin/tos-blobs', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tos_blobs ORDER BY created_at ASC');
  res.json({ blobs: rows });
});
app.post('/api/admin/tos-blobs', requireAuth, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'A name is required.' });
  const { rows: [blob] } = await pool.query(
    'INSERT INTO tos_blobs (name, content) VALUES ($1, $2) RETURNING *',
    [name, String(req.body.content || '')]
  );
  res.json({ blob });
});
app.put('/api/admin/tos-blobs/:id', requireAuth, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'A name is required.' });
  const { rows: [blob] } = await pool.query(
    'UPDATE tos_blobs SET name = $1, content = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
    [name, String(req.body.content || ''), req.params.id]
  );
  if (!blob) return res.status(404).json({ error: 'Not found.' });
  res.json({ blob });
});
app.delete('/api/admin/tos-blobs/:id', requireAuth, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM tos_blobs WHERE id = $1', [req.params.id]);
  res.json({ message: 'Deleted.' });
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
  const isNsfw = req.body.is_nsfw === 'true' || req.body.is_nsfw === '1';
  const isVip = req.body.is_vip === 'true' || req.body.is_vip === '1';
  const imageUrl = `/images/moderators/${req.file.filename}`;
  const { rows: [{ maxOrder }] } = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder" FROM hub_billboard_slides');
  const { rows: [slide] } = await pool.query(
    `INSERT INTO hub_billboard_slides
       (image_url, position_x, position_y, zoom, caption, credit, link, sort_order,
        animation_type, end_position_x, end_position_y, end_zoom, is_nsfw, is_vip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [imageUrl, positionX, positionY, zoom, (caption || '').trim(), (credit || '').trim(), (link || '').trim(), maxOrder + 1,
     animationType, endPositionX, endPositionY, endZoom, isNsfw, isVip]
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
  const isNsfw = req.body.is_nsfw !== undefined ? (req.body.is_nsfw === 'true' || req.body.is_nsfw === '1') : existing.is_nsfw;
  const isVip = req.body.is_vip !== undefined ? (req.body.is_vip === 'true' || req.body.is_vip === '1') : existing.is_vip;

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
       animation_type = $8, end_position_x = $9, end_position_y = $10, end_zoom = $11, is_nsfw = $12, is_vip = $13
     WHERE id = $14 RETURNING *`,
    [imageUrl, positionX, positionY, zoom, caption != null ? caption.trim() : null,
     credit != null ? credit.trim() : null, link != null ? link.trim() : null,
     animationType, endPositionX, endPositionY, endZoom, isNsfw, isVip, existing.id]
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
// Title/description/rating are all required now — a story isn't just a
// name anymore, and this is also the only place left where a rating gets
// set before the very first chapter exists. Immediately chains into
// creating that story's first (draft) chapter too, so the frontend can
// send the author straight into the chapter editor instead of an empty
// story page — a story with zero chapters is never public (see
// isStoryPublic below), so landing them anywhere else just invites an
// abandoned, invisible story.
app.post('/api/moderator/site/create', requireAuth, async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 60);
  const synopsis = String(req.body.synopsis || '').trim();
  const rating = req.body.rating;
  if (!title) return res.status(400).json({ error: 'A title is required.' });
  if (!synopsis) return res.status(400).json({ error: 'A description is required.' });
  if (!RATING_OPTIONS.includes(rating)) return res.status(400).json({ error: 'A valid rating is required.' });

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
      `INSERT INTO moderator_sites (slug, owner_user_id, site_title, story_path, synopsis, rating) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [slug, req.user.id, title, storyPath, synopsis, rating]
    );
    const { rows: [chapter] } = await pool.query(
      `INSERT INTO moderator_chapters (site_id, title, sort_order, status, updated_at) VALUES ($1, 'Untitled Part: 1', 0, 'draft', NOW()) RETURNING *`,
      [site.id]
    );
    res.json({ site, chapter });
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
  // A story only counts as public/discoverable once it has at least one
  // chapter that's actually published *and* actually has text — a
  // published-but-empty chapter (or a still-draft one) doesn't count, so an
  // abandoned "just created it" story never surfaces here. Doesn't affect
  // the owner's own management views (My Stories, the Story Editor, or the
  // story's own page for its owner) — only this public browse/search list.
  const { rows: sites } = await pool.query(`
    SELECT ms.id, ms.slug, ms.story_path, ms.site_title, ms.cover_url, ms.banner_url, ms.tags, ms.synopsis,
           u.username, u.display_name, u.avatar
    FROM moderator_sites ms
    JOIN users u ON u.id = ms.owner_user_id
    WHERE (
      $1 = '' OR
      ms.site_title ILIKE '%' || $1 || '%' OR
      u.username ILIKE '%' || $1 || '%' OR
      u.display_name ILIKE '%' || $1 || '%' OR
      EXISTS (SELECT 1 FROM jsonb_array_elements_text(ms.tags) tag WHERE tag ILIKE '%' || $1 || '%')
    )
    AND EXISTS (
      SELECT 1 FROM moderator_chapters mc
      WHERE mc.site_id = ms.id AND mc.status = 'published' AND length(trim(mc.body)) > 0
    )
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
      synopsis: s.synopsis || '',
      author: s.display_name || s.username,
      author_username: s.username,
      author_avatar: s.avatar || null,
      bookmarked: bookmarkedIds.has(s.id),
    })),
  });
});

// ── Advanced work search — AO3-style faceted search over every publicly
// discoverable story (same "has a published chapter with real text" rule
// as /api/moderator-sites). Tag-ish params are comma-separated lists in the
// query string; include filters require ALL listed values present
// (jsonb ?& = "all of these array elements exist"), exclude filters reject
// ANY listed value present (jsonb ?| = "any of these exist"). ─────────────
function csvParam(raw) {
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
}
const SEARCH_SORTS = {
  best_match: null, // handled specially — falls back to updated when there's no query text
  updated:    'last_chapter_update DESC NULLS LAST',
  published:  'ms.created_at DESC',
  word_count: 'word_count DESC',
  hits:       'ms.view_count DESC',
  kudos:      'like_count DESC',
  comments:   'comment_count DESC',
  bookmarks:  'bookmark_count DESC',
};

app.get('/api/search/works', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const fandoms      = csvParam(req.query.fandoms);
  const tagsInclude   = csvParam(req.query.tags_include);
  const tagsExclude   = csvParam(req.query.tags_exclude);
  const categories    = csvParam(req.query.categories);
  const relationships = csvParam(req.query.relationships);
  const rating = RATING_OPTIONS.includes(req.query.rating) ? req.query.rating : '';
  const wordMin = Number.isFinite(parseInt(req.query.word_min, 10)) ? parseInt(req.query.word_min, 10) : null;
  const wordMax = Number.isFinite(parseInt(req.query.word_max, 10)) ? parseInt(req.query.word_max, 10) : null;
  const completion = ['complete', 'wip'].includes(req.query.completion) ? req.query.completion : 'all';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;

  let sortKey = SEARCH_SORTS.hasOwnProperty(req.query.sort) ? req.query.sort : (q ? 'best_match' : 'updated');
  if (sortKey === 'best_match' && !q) sortKey = 'updated';

  const relevanceExpr = q
    ? `(
        (CASE WHEN ms.site_title ILIKE '%' || $1 || '%' THEN 10 ELSE 0 END) +
        (CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(ms.tags) t WHERE t ILIKE $1) THEN 9 ELSE 0 END) +
        (CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(ms.tags) t WHERE t ILIKE '%' || $1 || '%') THEN 5 ELSE 0 END) +
        (CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(ms.fandoms) t WHERE t ILIKE '%' || $1 || '%') THEN 6 ELSE 0 END) +
        (CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(ms.relationships) t WHERE t ILIKE '%' || $1 || '%') THEN 4 ELSE 0 END) +
        (CASE WHEN u.username ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%' THEN 3 ELSE 0 END) +
        (CASE WHEN ms.synopsis ILIKE '%' || $1 || '%' THEN 2 ELSE 0 END)
      )`
    : '0';

  const orderBy = sortKey === 'best_match' ? `${relevanceExpr} DESC, last_chapter_update DESC NULLS LAST` : SEARCH_SORTS[sortKey];

  const params = [
    q, fandoms, tagsInclude, tagsExclude, categories, relationships,
    rating, wordMin, wordMax, completion, limit, offset,
  ];

  const { rows } = await pool.query(`
    SELECT ms.id, ms.slug, ms.story_path, ms.site_title, ms.cover_url, ms.synopsis,
           ms.tags, ms.fandoms, ms.categories, ms.relationships, ms.rating, ms.is_complete,
           ms.created_at, ms.view_count,
           u.username, u.display_name, u.avatar,
           pubchap.published_count, pubchap.word_count, pubchap.last_chapter_update,
           COALESCE(lc.count, 0) AS like_count,
           COALESCE(cc.count, 0) AS comment_count,
           COALESCE(bc.count, 0) AS bookmark_count,
           charsj.chars AS characters,
           ${relevanceExpr} AS relevance_score,
           COUNT(*) OVER() AS total_count
    FROM moderator_sites ms
    JOIN users u ON u.id = ms.owner_user_id
    JOIN LATERAL (
      SELECT COUNT(*)::int AS published_count,
             COALESCE(SUM(
               GREATEST(1, array_length(regexp_split_to_array(trim(regexp_replace(mc.body, '<[^>]+>', ' ', 'g')), '\\s+'), 1))
             ), 0) AS word_count,
             MAX(mc.updated_at) AS last_chapter_update
      FROM moderator_chapters mc
      WHERE mc.site_id = ms.id AND mc.status = 'published' AND length(trim(mc.body)) > 0
    ) pubchap ON true
    LEFT JOIN LATERAL (SELECT COUNT(*)::int AS count FROM moderator_site_likes WHERE site_id = ms.id) lc ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS count FROM content_comments cc2
      JOIN moderator_chapters mc2 ON mc2.id = cc2.target_id AND cc2.target_type = 'chapter_paragraph'
      WHERE mc2.site_id = ms.id
    ) cc ON true
    LEFT JOIN LATERAL (SELECT COUNT(*)::int AS count FROM moderator_bookmarks WHERE site_id = ms.id) bc ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) AS chars FROM (
        SELECT mc3.id, mc3.name, mc3.ref_image, u3.username AS owner_username
        FROM character_story_links csl
        JOIN moderator_characters mc3 ON mc3.id = csl.character_id
        JOIN users u3 ON u3.id = mc3.owner_user_id
        WHERE csl.site_id = ms.id ORDER BY csl.sort_order LIMIT 4
      ) t
    ) charsj ON true
    WHERE pubchap.published_count > 0
      AND ($1 = '' OR (
        ms.site_title ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%'
        OR ms.synopsis ILIKE '%' || $1 || '%'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(ms.tags) t WHERE t ILIKE '%' || $1 || '%')
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(ms.fandoms) t WHERE t ILIKE '%' || $1 || '%')
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(ms.relationships) t WHERE t ILIKE '%' || $1 || '%')
      ))
      AND (cardinality($2::text[]) = 0 OR ms.fandoms ?& $2)
      AND (cardinality($3::text[]) = 0 OR ms.tags ?& $3)
      AND (cardinality($4::text[]) = 0 OR NOT (ms.tags ?| $4))
      AND (cardinality($5::text[]) = 0 OR ms.categories ?& $5)
      AND (cardinality($6::text[]) = 0 OR ms.relationships ?& $6)
      AND ($7 = '' OR ms.rating = $7)
      AND ($8::int IS NULL OR pubchap.word_count >= $8)
      AND ($9::int IS NULL OR pubchap.word_count <= $9)
      AND ($10 = 'all' OR ($10 = 'complete' AND ms.is_complete) OR ($10 = 'wip' AND NOT ms.is_complete))
    ORDER BY ${orderBy}
    LIMIT $11 OFFSET $12
  `, params);

  res.json({
    works: rows.map(r => ({
      slug: r.slug, story_path: r.story_path || r.slug, site_title: r.site_title,
      cover_url: r.cover_url, synopsis: r.synopsis || '',
      tags: r.tags || [], fandoms: r.fandoms || [], categories: r.categories || [], relationships: r.relationships || [],
      rating: r.rating, is_complete: r.is_complete,
      author: r.display_name || r.username, author_username: r.username, author_avatar: r.avatar || null,
      published_chapters: r.published_count, word_count: r.word_count,
      updated_at: r.last_chapter_update, created_at: r.created_at,
      hits: r.view_count || 0, kudos: Number(r.like_count), comments: Number(r.comment_count), bookmarks: Number(r.bookmark_count),
      characters: r.characters || [],
    })),
    total: rows.length ? Number(rows[0].total_count) : 0,
    page, limit, sort: sortKey,
  });
});

// Popular tags — powers the "Tags" browse page's tag cloud, sized by usage
// frequency across every discoverable story (same publish-state rule).
app.get('/api/search/popular-tags', async (req, res) => {
  const limit = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 150));
  const { rows } = await pool.query(`
    SELECT tag, COUNT(*)::int AS count
    FROM moderator_sites ms, jsonb_array_elements_text(ms.tags) AS tag
    WHERE EXISTS (
      SELECT 1 FROM moderator_chapters mc
      WHERE mc.site_id = ms.id AND mc.status = 'published' AND length(trim(mc.body)) > 0
    )
    GROUP BY tag
    ORDER BY count DESC, tag ASC
    LIMIT $1
  `, [limit]);
  res.json({ tags: rows });
});

// Recently bookmarked — the Browse menu's "Bookmarks" entry, stories
// ordered by their single most recent bookmark (not bookmark count).
app.get('/api/search/recent-bookmarks', async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const { rows } = await pool.query(`
    SELECT ms.slug, ms.story_path, ms.site_title, ms.cover_url, ms.synopsis, ms.tags,
           u.username, u.display_name, u.avatar,
           mb.created_at AS bookmarked_at
    FROM moderator_bookmarks mb
    JOIN moderator_sites ms ON ms.id = mb.site_id
    JOIN users u ON u.id = ms.owner_user_id
    WHERE EXISTS (
      SELECT 1 FROM moderator_chapters mc
      WHERE mc.site_id = ms.id AND mc.status = 'published' AND length(trim(mc.body)) > 0
    )
    ORDER BY mb.created_at DESC
    LIMIT $1
  `, [limit]);
  res.json({
    works: rows.map(r => ({
      slug: r.slug, story_path: r.story_path || r.slug, site_title: r.site_title,
      cover_url: r.cover_url, synopsis: r.synopsis || '', tags: r.tags || [],
      author: r.display_name || r.username, author_username: r.username, author_avatar: r.avatar || null,
      bookmarked_at: r.bookmarked_at,
    })),
  });
});

// Wipes every account flagged is_test_data (and everything they own, via
// ON DELETE CASCADE) — the one-shot cleanup for search/algorithm demo seed
// data. Admin-only; real accounts never carry this flag.
app.delete('/api/admin/test-data', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('DELETE FROM users WHERE is_test_data = true RETURNING username');
  res.json({ deleted: rows.length, usernames: rows.map(r => r.username) });
});

// ── Personalized story recommendations — the Wattpad-style half of the
// discovery plan (the search/tags system above is the AO3-style, purely
// deterministic half). Not machine learning — a scored blend of three
// explainable signals, each cheap enough to compute fresh per request at
// this site's scale:
//   1. Follows (heaviest weight) — stories by authors the viewer follows.
//   2. Tag affinity — tags/fandoms that show up a lot across what the
//      viewer has bookmarked.
//   3. Similar readers — other people who bookmarked the same stories as
//      the viewer, weighted by how much else they've bookmarked in common
//      (a lightweight collaborative-filtering co-occurrence, not real ML).
// A small recency-decayed trending score is always added as a tiebreaker,
// and is the ONLY signal used for a logged-out viewer or one with no
// bookmarks/follows yet, so the section is never empty. Each result
// carries a `reason` string so it's visible *why* something was picked —
// both for the reader's benefit and for us to sanity-check the scoring. ──
function recTrendingScore(s) {
  const ageDays = s.last_chapter_update ? (Date.now() - new Date(s.last_chapter_update).getTime()) / 86400000 : 999;
  const engagement = (s.like_count || 0) * 2 + (s.bookmark_count || 0) * 3;
  return engagement / Math.pow(ageDays + 2, 0.7);
}
// Caps how many picks come from the same author so one prolific followed
// author doesn't crowd out everything else, same as the real thing would.
// Small per-request random jitter — without it, ties (very common: e.g.
// every story sharing exactly one tag scores identically) resolve in the
// same stable order every time, so a viewer with light/no signal saw the
// exact same picks on every refresh. The jitter is small relative to real
// signal gaps (follow = +100, one shared tag = +6) so it only reshuffles
// genuine ties/near-ties, never buries a strongly-matched story under a
// weakly-matched one.
function recDiversify(scored, limit, perAuthorCap) {
  scored.forEach(s => { s.score += Math.random() * 4; });
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  const authorCounts = {};
  for (const s of scored) {
    if (picked.length >= limit) break;
    const count = authorCounts[s.owner_user_id] || 0;
    if (count >= perAuthorCap) continue;
    authorCounts[s.owner_user_id] = count + 1;
    picked.push(s);
  }
  if (picked.length < limit) {
    for (const s of scored) {
      if (picked.length >= limit) break;
      if (picked.includes(s)) continue;
      picked.push(s);
    }
  }
  return picked.map(s => ({
    slug: s.slug, story_path: s.story_path || s.slug, site_title: s.site_title, cover_url: s.cover_url,
    synopsis: s.synopsis || '', tags: s.tags || [], author: s.display_name || s.username, author_username: s.username,
    author_avatar: s.avatar || null, bookmarked: !!s.bookmarked, reason: s.reason,
  }));
}

app.get('/api/recommendations/stories', async (req, res) => {
  const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 10));
  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }

  const { rows: pool_stories } = await pool.query(`
    SELECT ms.id, ms.slug, ms.story_path, ms.site_title, ms.cover_url, ms.synopsis, ms.tags, ms.fandoms, ms.owner_user_id,
           u.username, u.display_name, u.avatar,
           COALESCE(lc.count, 0) AS like_count, COALESCE(bc.count, 0) AS bookmark_count,
           pubchap.last_chapter_update
    FROM moderator_sites ms
    JOIN users u ON u.id = ms.owner_user_id
    JOIN LATERAL (
      SELECT COUNT(*)::int AS published_count, MAX(mc.updated_at) AS last_chapter_update
      FROM moderator_chapters mc WHERE mc.site_id = ms.id AND mc.status = 'published' AND length(trim(mc.body)) > 0
    ) pubchap ON true
    LEFT JOIN LATERAL (SELECT COUNT(*)::int AS count FROM moderator_site_likes WHERE site_id = ms.id) lc ON true
    LEFT JOIN LATERAL (SELECT COUNT(*)::int AS count FROM moderator_bookmarks WHERE site_id = ms.id) bc ON true
    WHERE pubchap.published_count > 0
  `);

  if (!viewerId) {
    const scored = pool_stories.map(s => ({ ...s, score: recTrendingScore(s), reason: 'Trending now' }));
    return res.json({ stories: recDiversify(scored, limit, 2) });
  }

  const [followedRows, myBookmarkRows, myOwnRows] = await Promise.all([
    pool.query('SELECT followed_id FROM user_follows WHERE follower_id = $1', [viewerId]),
    pool.query('SELECT site_id FROM moderator_bookmarks WHERE user_id = $1', [viewerId]),
    pool.query('SELECT id FROM moderator_sites WHERE owner_user_id = $1', [viewerId]),
  ]);
  const followedIds = new Set(followedRows.rows.map(r => r.followed_id));
  const myBookmarkedSiteIds = new Set(myBookmarkRows.rows.map(r => r.site_id));
  const myOwnSiteIds = new Set(myOwnRows.rows.map(r => r.id));

  const affinity = {};
  pool_stories.filter(s => myBookmarkedSiteIds.has(s.id)).forEach(s => {
    [...(s.tags || []), ...(s.fandoms || [])].forEach(t => { affinity[t] = (affinity[t] || 0) + 1; });
  });

  let cooccur = {};
  if (myBookmarkedSiteIds.size) {
    const { rows: similarUserRows } = await pool.query(
      `SELECT DISTINCT mb2.user_id FROM moderator_bookmarks mb1
       JOIN moderator_bookmarks mb2 ON mb1.site_id = mb2.site_id AND mb2.user_id != $1
       WHERE mb1.user_id = $1`,
      [viewerId]
    );
    const similarIds = similarUserRows.map(r => r.user_id);
    if (similarIds.length) {
      const { rows: coRows } = await pool.query(
        `SELECT site_id, COUNT(*)::int AS c FROM moderator_bookmarks WHERE user_id = ANY($1::int[]) GROUP BY site_id`,
        [similarIds]
      );
      coRows.forEach(r => { cooccur[r.site_id] = r.c; });
    }
  }

  const scored = pool_stories
    .filter(s => !myOwnSiteIds.has(s.id))
    .map(s => {
      let score = 0;
      let reason = null;
      if (followedIds.has(s.owner_user_id)) {
        score += 100;
        reason = `Because you follow ${s.display_name || s.username}`;
      }
      const tagOverlap = [...(s.tags || []), ...(s.fandoms || [])].reduce((sum, t) => sum + (affinity[t] || 0), 0);
      if (tagOverlap > 0) {
        score += tagOverlap * 6;
        if (!reason) reason = 'Because of tags you like';
      }
      const co = cooccur[s.id] || 0;
      if (co > 0) {
        score += co * 10;
        if (!reason) reason = 'Readers like you also bookmarked this';
      }
      score += recTrendingScore(s);
      return { ...s, score, reason: reason || 'Trending now', bookmarked: myBookmarkedSiteIds.has(s.id) };
    });

  res.json({ stories: recDiversify(scored, limit, 3) });
});

// ── Recommended Followers — for the Fanpage Hub's "Recommended Followers"
// row (and its "See More" expanded list). Recommends any registered user
// — having an actual fanpage/story isn't required, since a brand new
// account should still be discoverable before they've posted anything —
// never the BTW Team system account, and never anyone the viewer already
// follows — once you follow VeekitPaws she naturally drops out of her own
// pinned slot the same way everyone else does. ────────────────────────────
app.get('/api/recommended-followers', async (req, res) => {
  let userId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { userId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  // A real ranking instead of a coin flip: follower count (established
  // presence) weighted heaviest, story count (there's something to
  // actually read) next, with a flat bonus for anyone who's updated a
  // chapter in the last 30 days (still active). Tiebreak is u.id (not
  // random()) so that paging through with offset/limit -- the "Show More"
  // modal fetches 100 at a time -- returns a stable, non-overlapping
  // sequence instead of reshuffling between requests.
  const { rows } = await pool.query(`
    SELECT u.id, u.username, u.display_name, u.avatar, s.score,
           raw.follower_count, raw.following_count, raw.club_count
    FROM users u
    JOIN LATERAL (
      SELECT
        (SELECT COUNT(*)::int FROM user_follows f WHERE f.followed_id = u.id) AS follower_count,
        (SELECT COUNT(*)::int FROM user_follows f2 WHERE f2.follower_id = u.id) AS following_count,
        (SELECT COUNT(*)::int FROM club_members cm JOIN clubs c ON c.id = cm.club_id WHERE cm.user_id = u.id) AS club_count,
        (SELECT COUNT(*)::int FROM moderator_sites ms WHERE ms.owner_user_id = u.id) AS story_count,
        (SELECT MAX(mc.updated_at) FROM moderator_chapters mc JOIN moderator_sites ms ON ms.id = mc.site_id
         WHERE ms.owner_user_id = u.id AND mc.status = 'published') AS last_chapter_at
    ) raw ON true
    JOIN LATERAL (
      SELECT raw.follower_count * 4 + raw.story_count * 2
           + (CASE WHEN raw.last_chapter_at >= NOW() - INTERVAL '30 days' THEN 6 ELSE 0 END) AS score
    ) s ON true
    WHERE u.username NOT IN ('btwteam', 'holly_allen', 'holly_chan')
      AND ($1::int IS NULL OR u.id != $1)
      AND NOT EXISTS (
        SELECT 1 FROM user_follows f WHERE f.follower_id = $1 AND f.followed_id = u.id
      )
    ORDER BY (u.username = 'veekitpaws') DESC, s.score DESC, u.id ASC
    LIMIT $2 OFFSET $3
  `, [userId, limit, offset]);

  res.json({
    users: rows.map(u => ({
      username: u.username,
      display_name: u.display_name || u.username,
      avatar: u.avatar || null,
      follower_count: u.follower_count, following_count: u.following_count, club_count: u.club_count,
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
    const { rows: [site] } = await pool.query(
      'SELECT id, owner_user_id, site_title, story_path FROM moderator_sites WHERE story_path = $1', [`${owner}/${story}`]);
    return site || null;
  }
  const { rows: [site] } = await pool.query(
    'SELECT id, owner_user_id, site_title, story_path FROM moderator_sites WHERE slug = $1 ORDER BY created_at ASC LIMIT 1', [req.params.slug]);
  return site || null;
}

app.post(['/api/bookmarks/:slug', '/api/bookmarks/by-path/:owner/:story'], requireAuth, async (req, res) => {
  const site = await findSiteBySlugParam(req);
  if (!site) return res.status(404).json({ error: 'Not found.' });
  await pool.query(
    'INSERT INTO moderator_bookmarks (user_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.user.id, site.id]
  );
  await notifyUser(site.owner_user_id, req.user.id, 'story_bookmark',
    `bookmarked your story "${site.site_title || 'Untitled'}".`, `/${site.story_path}`);
  res.json({ message: 'Bookmarked.' });
});

app.delete(['/api/bookmarks/:slug', '/api/bookmarks/by-path/:owner/:story'], requireAuth, async (req, res) => {
  const site = await findSiteBySlugParam(req);
  if (!site) return res.status(404).json({ error: 'Not found.' });
  await pool.query('DELETE FROM moderator_bookmarks WHERE user_id = $1 AND site_id = $2', [req.user.id, site.id]);
  res.json({ message: 'Removed.' });
});

// Shared by a profile's Featured Stories (both the explicit picks and the
// "no picks yet" default-latest-updated fallback) -- fetches the same
// bcard-shaped fields the Search page's story cards use (stats/tags/
// character-teasers), by a specific ordered list of site ids. Order of the
// input `ids` array is preserved in the output so callers control sort.
async function fetchStoryCardsById(ids) {
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `SELECT ms.id, ms.slug, ms.story_path, ms.site_title, ms.cover_url, ms.synopsis,
            ms.rating, ms.is_complete, ms.view_count,
            u.username, u.display_name, u.avatar,
            pubchap.word_count, COALESCE(lc.count, 0) AS like_count,
            charsj.chars AS characters
     FROM moderator_sites ms
     JOIN users u ON u.id = ms.owner_user_id
     JOIN LATERAL (
       SELECT COALESCE(SUM(
         GREATEST(1, array_length(regexp_split_to_array(trim(regexp_replace(mc.body, '<[^>]+>', ' ', 'g')), '\\s+'), 1))
       ), 0) AS word_count
       FROM moderator_chapters mc WHERE mc.site_id = ms.id AND mc.status = 'published' AND length(trim(mc.body)) > 0
     ) pubchap ON true
     LEFT JOIN LATERAL (SELECT COUNT(*)::int AS count FROM moderator_site_likes WHERE site_id = ms.id) lc ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) AS chars FROM (
         SELECT mc3.id, mc3.name, mc3.ref_image, u3.username AS owner_username
         FROM character_story_links csl JOIN moderator_characters mc3 ON mc3.id = csl.character_id
         JOIN users u3 ON u3.id = mc3.owner_user_id
         WHERE csl.site_id = ms.id ORDER BY csl.sort_order LIMIT 4
       ) t
     ) charsj ON true
     WHERE ms.id = ANY($1::int[])`,
    [ids]
  );
  const byId = {};
  rows.forEach(r => { byId[r.id] = r; });
  return ids.map(id => byId[id]).filter(Boolean).map(r => ({
    id: r.id, slug: r.slug, story_path: r.story_path || r.slug, site_title: r.site_title, cover_url: r.cover_url,
    synopsis: r.synopsis || '', rating: r.rating, is_complete: !!r.is_complete,
    author: r.display_name || r.username, author_username: r.username, author_avatar: r.avatar || null,
    hits: r.view_count || 0, kudos: Number(r.like_count), word_count: r.word_count,
    characters: r.characters || [],
  }));
}

// A user's own latest-updated published stories, for Featured Stories'
// default (nothing manually featured yet) state.
async function fetchDefaultStoryCards(ownerId, limit) {
  const { rows } = await pool.query(
    `SELECT ms.id FROM moderator_sites ms
     JOIN LATERAL (
       SELECT COUNT(*)::int AS published_count, MAX(mc.updated_at) AS last_chapter_update
       FROM moderator_chapters mc WHERE mc.site_id = ms.id AND mc.status = 'published' AND length(trim(mc.body)) > 0
     ) pubchap ON true
     WHERE ms.owner_user_id = $1 AND pubchap.published_count > 0
     ORDER BY pubchap.last_chapter_update DESC NULLS LAST LIMIT $2`,
    [ownerId, limit]
  );
  return fetchStoryCardsById(rows.map(r => r.id));
}

// ── Author profile — /fanpages/:username, Twitter-style header + their stories ──
app.get('/api/fanpage-profile/:username', async (req, res) => {
  const { rows: [author] } = await pool.query(
    `SELECT id, username, display_name, avatar, avatar_original_url, avatar_position_x, avatar_position_y, avatar_zoom,
            pronouns, favorite_pokemon, account_bio, fun_fact, account_links,
            account_banner_url, account_banner_position_x, account_banner_position_y, account_banner_zoom,
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

  // Draft-only stories (nothing published with real text yet) are visible
  // only to their own owner — everyone else gets the same "actually
  // discoverable" rule used by search/browse/spotlight. The owner still
  // sees them, flagged is_draft_only so the card can read as a draft
  // instead of a real published story.
  const [{ rows: sites }, followerCount, followingCount, clubCount, isFollowing, featuredChars, featuredGallery, featuredStoryIds, activity] = await Promise.all([
    pool.query(
      `SELECT ms.id, ms.slug, ms.story_path, ms.site_title, ms.cover_url, ms.banner_url, ms.synopsis,
              ms.tags, ms.fandoms, ms.view_count,
              NOT EXISTS (
                SELECT 1 FROM moderator_chapters mc
                WHERE mc.site_id = ms.id AND mc.status = 'published' AND length(trim(mc.body)) > 0
              ) AS is_draft_only,
              COALESCE(lc.count, 0) AS like_count,
              COALESCE(bc.count, 0) AS bookmark_count,
              COALESCE(cc.count, 0) AS comment_count
       FROM moderator_sites ms
       LEFT JOIN LATERAL (SELECT COUNT(*)::int AS count FROM moderator_site_likes WHERE site_id = ms.id) lc ON true
       LEFT JOIN LATERAL (SELECT COUNT(*)::int AS count FROM moderator_bookmarks WHERE site_id = ms.id) bc ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS count FROM content_comments cc2
         JOIN moderator_chapters mc2 ON mc2.id = cc2.target_id AND cc2.target_type = 'chapter_paragraph'
         WHERE mc2.site_id = ms.id
       ) cc ON true
       WHERE ms.owner_user_id = $1
         AND ($2::int = $1 OR EXISTS (
           SELECT 1 FROM moderator_chapters mc3
           WHERE mc3.site_id = ms.id AND mc3.status = 'published' AND length(trim(mc3.body)) > 0
         ))
       ORDER BY ms.created_at ASC`,
      [author.id, viewerId]
    ),
    pool.query('SELECT COUNT(*)::int AS n FROM user_follows WHERE followed_id = $1', [author.id]),
    pool.query('SELECT COUNT(*)::int AS n FROM user_follows WHERE follower_id = $1', [author.id]),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM club_members cm JOIN clubs c ON c.id = cm.club_id WHERE cm.user_id = $1`,
      [author.id]
    ),
    viewerId
      ? pool.query('SELECT 1 FROM user_follows WHERE follower_id = $1 AND followed_id = $2', [viewerId, author.id])
      : Promise.resolve({ rows: [] }),
    // Featured items store a title/image_url *snapshot* from when they were
    // picked (see the user_featured_items migration comment above), but in
    // practice every row currently comes from this site's own characters/
    // gallery (source is always 'fanpage'), so we can — and should — join
    // back to the live row and prefer its current name/art over the stale
    // snapshot. The snapshot only survives as a fallback for the rare case
    // the original character/gallery post was since deleted.
    pool.query(
      `SELECT ufi.ref_id, COALESCE(mc.name, ufi.title) AS title,
              COALESCE(mc.ref_image, ufi.image_url) AS image_url, ufi.link_url
       FROM user_featured_items ufi
       LEFT JOIN moderator_characters mc ON ufi.ref_id ~ '^[0-9]+$' AND mc.id = ufi.ref_id::int
       WHERE ufi.user_id = $1 AND ufi.kind = 'character' ORDER BY ufi.sort_order LIMIT 3`,
      [author.id]
    ),
    pool.query(
      `SELECT ufi.ref_id, COALESCE(mg.title, ufi.title) AS title,
              COALESCE(mg.image_url, ufi.image_url) AS image_url, ufi.link_url
       FROM user_featured_items ufi
       LEFT JOIN moderator_gallery mg ON ufi.ref_id ~ '^[0-9]+$' AND mg.id = ufi.ref_id::int
       WHERE ufi.user_id = $1 AND ufi.kind = 'gallery' ORDER BY ufi.sort_order LIMIT 3`,
      [author.id]
    ),
    // Featured Stories just needs the ordered list of chosen site ids here --
    // the actual card data (stats/tags/characters) is fetched in bulk via
    // fetchStoryCardsById below, shared with the "no explicit picks yet"
    // default path so both render identically.
    pool.query(
      `SELECT ref_id FROM user_featured_items WHERE user_id = $1 AND kind = 'story' ORDER BY sort_order LIMIT 3`,
      [author.id]
    ),
    // Recent Activity -- no unified activity log exists, so this is a
    // hand-rolled UNION ALL across every place this user can act. Each
    // branch normalizes to the same (type, ts, label, context, ref_a,
    // owner_username) shape; the JSON response below turns that into a
    // human sentence + link. owner_username is only populated for the
    // "liked a character" branch -- every other type either belongs to this
    // user themselves (posted/commented types all link via story_path,
    // which is already owner-qualified, or a plain content id) or doesn't
    // need an owner to build its link.
    pool.query(
      `SELECT * FROM (
         (SELECT 'chapter' AS type, COALESCE(mc.updated_at, mc.created_at) AS ts,
                 mc.title AS label, ms.site_title AS context, COALESCE(ms.story_path, ms.slug) AS ref_a, NULL AS owner_username
          FROM moderator_chapters mc JOIN moderator_sites ms ON ms.id = mc.site_id
          WHERE ms.owner_user_id = $1 AND mc.status = 'published' AND length(trim(mc.body)) > 0
          ORDER BY ts DESC LIMIT 5)
         UNION ALL
         (SELECT 'character', created_at, name, NULL, id::text, NULL
          FROM moderator_characters WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 5)
         UNION ALL
         (SELECT 'gallery', created_at, title, NULL, id::text, NULL
          FROM moderator_gallery WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 5)
         UNION ALL
         (SELECT 'newspaper', created_at, title, NULL, id::text, NULL
          FROM newspaper_posts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5)
         UNION ALL
         (SELECT 'like_character', cl.created_at, mc.name, NULL, mc.id::text, u.username
          FROM moderator_character_likes cl JOIN moderator_characters mc ON mc.id = cl.character_id
          JOIN users u ON u.id = mc.owner_user_id
          WHERE cl.user_id = $1 ORDER BY cl.created_at DESC LIMIT 5)
         UNION ALL
         (SELECT 'like_chapter', chl.created_at, mc2.title, ms2.site_title, COALESCE(ms2.story_path, ms2.slug), NULL
          FROM chapter_likes chl JOIN moderator_chapters mc2 ON mc2.id = chl.chapter_id
          JOIN moderator_sites ms2 ON ms2.id = mc2.site_id
          WHERE chl.user_id = $1 ORDER BY chl.created_at DESC LIMIT 5)
         UNION ALL
         (SELECT 'like_gallery', gl.created_at, mg.title, NULL, mg.id::text, NULL
          FROM moderator_gallery_likes gl JOIN moderator_gallery mg ON mg.id = gl.gallery_id
          WHERE gl.user_id = $1 ORDER BY gl.created_at DESC LIMIT 5)
         UNION ALL
         (SELECT 'club_post', cp.created_at, cp.title, c.name, c.slug, NULL
          FROM club_posts cp JOIN clubs c ON c.id = cp.club_id
          WHERE cp.author_user_id = $1 ORDER BY cp.created_at DESC LIMIT 5)
         UNION ALL
         (SELECT 'comment_chapter', cc1.created_at, mc4.title, ms4.site_title, COALESCE(ms4.story_path, ms4.slug), NULL
          FROM content_comments cc1
          JOIN moderator_chapters mc4 ON mc4.id = cc1.target_id AND cc1.target_type = 'chapter_paragraph'
          JOIN moderator_sites ms4 ON ms4.id = mc4.site_id
          WHERE cc1.user_id = $1 ORDER BY cc1.created_at DESC LIMIT 5)
         UNION ALL
         (SELECT 'comment_gallery', cc2.created_at, mg2.title, NULL, mg2.id::text, NULL
          FROM content_comments cc2
          JOIN moderator_gallery mg2 ON mg2.id = cc2.target_id AND cc2.target_type = 'gallery'
          WHERE cc2.user_id = $1 ORDER BY cc2.created_at DESC LIMIT 5)
         UNION ALL
         (SELECT 'comment_club_post', cc3.created_at, cp2.title, c2.name, c2.slug, NULL
          FROM content_comments cc3
          JOIN club_posts cp2 ON cp2.id = cc3.target_id AND cc3.target_type = 'club_post'
          JOIN clubs c2 ON c2.id = cp2.club_id
          WHERE cc3.user_id = $1 ORDER BY cc3.created_at DESC LIMIT 5)
       ) combined
       ORDER BY ts DESC LIMIT 5`,
      [author.id]
    ),
  ]);

  // A few tagged-character thumbnails per story, for the Stories tab's
  // teaser cards — batched into one query instead of one per story.
  const siteIds = sites.map(s => s.id);
  const charsBySite = {};
  if (siteIds.length) {
    const { rows: siteChars } = await pool.query(
      `SELECT csl.site_id, mc.id, mc.name, mc.ref_image, u.username AS owner_username FROM character_story_links csl
       JOIN moderator_characters mc ON mc.id = csl.character_id
       JOIN users u ON u.id = mc.owner_user_id
       WHERE csl.site_id = ANY($1::int[]) ORDER BY csl.sort_order LIMIT 200`,
      [siteIds]
    );
    siteChars.forEach(c => {
      (charsBySite[c.site_id] = charsBySite[c.site_id] || []).push({ id: c.id, name: c.name, ref_image: c.ref_image, owner_username: c.owner_username });
    });
  }

  // Featured Characters/Gallery/Stories all share the same "default until
  // manually overridden" behavior: an empty user_featured_items set for that
  // kind means the user hasn't touched it yet, so fall back to a live
  // "latest N" query instead of an empty section. The moment they Save that
  // section's editor (see PUT /api/account/featured), real rows get written
  // and this fallback stops being reached — permanently "locking" it in,
  // with no separate locked flag needed.
  const featuredCharacters = featuredChars.rows.length
    ? featuredChars.rows
    : (await pool.query(
        `SELECT id::text AS ref_id, name AS title, ref_image AS image_url
         FROM moderator_characters WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 3`,
        [author.id]
      )).rows;
  const featuredGalleryItems = featuredGallery.rows.length
    ? featuredGallery.rows
    : (await pool.query(
        `SELECT id::text AS ref_id, title, image_url
         FROM moderator_gallery WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 3`,
        [author.id]
      )).rows;
  const featuredStories = featuredStoryIds.rows.length
    ? await fetchStoryCardsById(featuredStoryIds.rows.map(r => Number(r.ref_id)))
    : await fetchDefaultStoryCards(author.id, 3);

  // Recent Activity — turn the normalized (type, ts, label, context, ref_a,
  // owner_username) rows into a human sentence + link. Every type is
  // clickable now: character-based links need an explicit owner (a "like"
  // can point at someone else's character), everything else either belongs
  // to this profile's owner already or links via an owner-qualified
  // story_path / plain content id.
  const recentActivity = activity.rows.map(r => {
    switch (r.type) {
      case 'chapter': return { type: r.type, title: `Updated a chapter in "${r.context}"`, timestamp: r.ts, link: `/${r.ref_a}` };
      case 'character': return { type: r.type, title: `Posted a new character: "${r.label}"`, timestamp: r.ts, link: `/${author.username}?char=${r.ref_a}#characters` };
      case 'gallery': return { type: r.type, title: `Posted new gallery art: "${r.label}"`, timestamp: r.ts, link: `/gallery-post?id=${r.ref_a}` };
      case 'newspaper': return { type: r.type, title: `Made a newspaper post: "${r.label}"`, timestamp: r.ts, link: `/${author.username}#newspaper` };
      case 'like_character': return { type: r.type, title: `Liked a character: "${r.label}"`, timestamp: r.ts, link: `/${r.owner_username}?char=${r.ref_a}#characters` };
      case 'like_chapter': return { type: r.type, title: `Liked a chapter in "${r.context}"`, timestamp: r.ts, link: `/${r.ref_a}` };
      case 'like_gallery': return { type: r.type, title: `Liked a gallery post: "${r.label}"`, timestamp: r.ts, link: `/gallery-post?id=${r.ref_a}` };
      case 'club_post': return { type: r.type, title: `Posted in the "${r.context}" club`, timestamp: r.ts, link: `/club?slug=${r.ref_a}` };
      case 'comment_chapter': return { type: r.type, title: `Commented on a chapter in "${r.context}"`, timestamp: r.ts, link: `/${r.ref_a}` };
      case 'comment_gallery': return { type: r.type, title: `Commented on a gallery post: "${r.label}"`, timestamp: r.ts, link: `/gallery-post?id=${r.ref_a}` };
      case 'comment_club_post': return { type: r.type, title: `Commented on a post in the "${r.context}" club`, timestamp: r.ts, link: `/club?slug=${r.ref_a}` };
      default: return { type: r.type, title: r.label, timestamp: r.ts, link: null };
    }
  });

  res.json({
    author: {
      username: author.username,
      display_name: author.display_name || author.username,
      avatar: author.avatar || null,
      avatar_original_url: author.avatar_original_url || '',
      avatar_position_x: author.avatar_position_x != null ? author.avatar_position_x : 50,
      avatar_position_y: author.avatar_position_y != null ? author.avatar_position_y : 50,
      avatar_zoom: author.avatar_zoom || 100,
      // Deliberately NOT falling back to a story's banner_url here — the
      // account profile banner is its own thing and must stay blank (falls
      // through to the shared placeholder image on the frontend) until the
      // user explicitly sets one via the profile editor.
      banner_url: author.account_banner_url || '',
      banner_position_x: author.account_banner_url ? author.account_banner_position_x : 50,
      banner_position_y: author.account_banner_url ? author.account_banner_position_y : 50,
      banner_zoom: author.account_banner_url ? (author.account_banner_zoom || 100) : 100,
      pronouns: author.pronouns || '',
      favorite_pokemon: author.favorite_pokemon || '',
      account_bio: author.account_bio || '',
      fun_fact: author.fun_fact || '',
      account_links: author.account_links || [],
      profile_theme: author.profile_theme || 'default',
      profile_theme_bg_url: author.profile_theme_bg_url || '',
      featured_characters: featuredCharacters,
      featured_gallery: featuredGalleryItems,
      featured_stories: featuredStories,
      recent_activity: recentActivity,
      is_self: viewerId === author.id,
    },
    stories: sites.map(s => ({
      slug: s.slug, story_path: s.story_path || s.slug, site_title: s.site_title, cover_url: s.cover_url,
      synopsis: s.synopsis || '', characters: (charsBySite[s.id] || []).slice(0, 4),
      tags: s.tags || [], fandoms: s.fandoms || [], is_draft_only: s.is_draft_only,
      hits: s.view_count || 0, kudos: Number(s.like_count), comments: Number(s.comment_count), bookmarks: Number(s.bookmark_count),
    })),
    follower_count: followerCount.rows[0].n,
    following_count: followingCount.rows[0].n,
    club_count: clubCount.rows[0].n,
    is_following: isFollowing.rows.length > 0,
  });
});

// GET /api/fanpage-profile/:username/clubs — every club this user belongs
// to, for the profile page's "Clubs" stat modal. NSFW clubs are dropped for
// viewers who shouldn't see them (logged out or SFW Mode), same gate used
// everywhere else — otherwise this list would leak which NSFW club someone
// is in to a viewer who can't even open that club.
app.get('/api/fanpage-profile/:username/clubs', async (req, res) => {
  const { rows: [author] } = await pool.query('SELECT id FROM users WHERE username = $1', [req.params.username.toLowerCase()]);
  if (!author) return res.status(404).json({ error: 'Not found.' });

  const { viewerId, nsfwAllowed } = await getViewerNsfwAccess(req);
  const { rows } = await pool.query(
    `SELECT c.slug, c.name, c.icon_url, c.is_nsfw, cm.role
     FROM club_members cm JOIN clubs c ON c.id = cm.club_id
     WHERE cm.user_id = $1 ${nsfwAllowed || viewerId === author.id ? '' : 'AND c.is_nsfw = FALSE'}
     ORDER BY (cm.role = 'owner') DESC, (cm.role = 'admin') DESC, c.name ASC`,
    [author.id]
  );
  res.json({ clubs: rows.map(r => ({ slug: r.slug, name: r.name, icon_url: r.icon_url || null, is_nsfw: r.is_nsfw, role: r.role })) });
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

// ── Newspaper — a lightweight journal/blog on an author's profile ──────────
function mapNewspaperPost(r) {
  return {
    id: r.id,
    title: r.title || '',
    body: r.body || '',
    attachments: r.attachments || [],
    created_at: r.created_at,
    updated_at: r.updated_at,
    comment_count: r.comment_count != null ? Number(r.comment_count) : 0,
    author: { username: r.username, display_name: r.display_name || r.username, avatar: r.avatar || null },
  };
}

// Every post by a user, newest first — backs both the Home tab's "latest
// post" preview (just takes [0]) and the full Newspapers tab list.
app.get('/api/fanpage-profile/:username/newspaper', async (req, res) => {
  const { rows: [author] } = await pool.query('SELECT id FROM users WHERE username = $1', [req.params.username.toLowerCase()]);
  if (!author) return res.status(404).json({ error: 'Not found.' });
  const { rows } = await pool.query(
    `SELECT np.*, u.username, u.display_name, u.avatar,
            (SELECT COUNT(*)::int FROM newspaper_comments WHERE post_id = np.id) AS comment_count
     FROM newspaper_posts np JOIN users u ON u.id = np.user_id
     WHERE np.user_id = $1 ORDER BY np.created_at DESC LIMIT 100`,
    [author.id]
  );
  res.json({ posts: rows.map(mapNewspaperPost) });
});

app.get('/api/newspaper/post/:id', async (req, res) => {
  const { rows: [row] } = await pool.query(
    `SELECT np.*, u.username, u.display_name, u.avatar,
            (SELECT COUNT(*)::int FROM newspaper_comments WHERE post_id = np.id) AS comment_count
     FROM newspaper_posts np JOIN users u ON u.id = np.user_id
     WHERE np.id = $1`,
    [req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'Not found.' });
  res.json({ post: mapNewspaperPost(row) });
});

app.post('/api/newspaper', requireAuth, uploadInbox.array('attachments', 4), async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const body = String(req.body.body || '').trim().slice(0, 8000);
  const files = req.files || [];
  const attachments = files.map(f => ({ url: '/images/inbox/' + f.filename, name: f.originalname }));
  const gifUrl = (req.body.gif_url || '').trim();
  if (gifUrl) attachments.push({ url: gifUrl, name: 'GIF' });
  if (!title && !body && !attachments.length) return res.status(400).json({ error: 'A newspaper post needs at least a title, body, or attachment.' });

  const { rows: [post] } = await pool.query(
    `INSERT INTO newspaper_posts (user_id, title, body, attachments) VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.user.id, title, body, JSON.stringify(attachments)]
  );
  const { rows: [actor] } = await pool.query('SELECT username FROM users WHERE id = $1', [req.user.id]);
  await notifyFollowers(req.user.id, 'new_newspaper',
    `posted a new newspaper${title ? `: "${title}"` : '.'}`,
    `/${actor.username}?news=${post.id}#newspaper`);
  res.json({ post: { ...post, comment_count: 0 } });
});

app.put('/api/newspaper/:id', requireAuth, async (req, res) => {
  const { rows: [existing] } = await pool.query(
    'SELECT id FROM newspaper_posts WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]
  );
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  const title = req.body.title != null ? String(req.body.title).trim().slice(0, 120) : null;
  const body = req.body.body != null ? String(req.body.body).trim().slice(0, 8000) : null;
  const { rows: [post] } = await pool.query(
    `UPDATE newspaper_posts SET title = COALESCE($1, title), body = COALESCE($2, body), updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [title, body, existing.id]
  );
  res.json({ post });
});

app.delete('/api/newspaper/:id', requireAuth, async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM newspaper_posts WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Not found.' });
  res.json({ message: 'Deleted.' });
});

app.get('/api/newspaper/post/:id/comments', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT nc.id, nc.body, nc.created_at, u.username, u.display_name, u.avatar
     FROM newspaper_comments nc JOIN users u ON u.id = nc.user_id
     WHERE nc.post_id = $1 ORDER BY nc.created_at ASC LIMIT 500`,
    [req.params.id]
  );
  res.json({
    comments: rows.map(r => ({
      id: r.id, body: r.body, created_at: r.created_at,
      author: { username: r.username, display_name: r.display_name || r.username, avatar: r.avatar || null },
    })),
  });
});

app.post('/api/newspaper/post/:id/comments', requireAuth, async (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
  const { rows: [post] } = await pool.query(
    `SELECT np.id, np.user_id, np.title, u.username AS owner_username
     FROM newspaper_posts np JOIN users u ON u.id = np.user_id WHERE np.id = $1`, [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const { rows: [comment] } = await pool.query(
    `INSERT INTO newspaper_comments (post_id, user_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at`,
    [post.id, req.user.id, body]
  );
  const { rows: [me] } = await pool.query('SELECT username, display_name, avatar FROM users WHERE id = $1', [req.user.id]);
  await notifyUser(post.user_id, req.user.id, 'newspaper_comment',
    `commented on your newspaper${post.title ? ` "${post.title}"` : ''}.`,
    `/${post.owner_username}?news=${post.id}#newspaper`);
  res.json({
    comment: {
      id: comment.id, body: comment.body, created_at: comment.created_at,
      author: { username: me.username, display_name: me.display_name || me.username, avatar: me.avatar || null },
    },
  });
});

app.delete('/api/newspaper/comments/:id', requireAuth, async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM newspaper_comments WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Not found.' });
  res.json({ message: 'Deleted.' });
});

// Full Characters / Gallery tabs on a user's profile — every character or
// gallery post across ALL of that user's stories, not just the 3 featured
// picks shown on Home. Gallery includes every category (spicy included) —
// same as a story's own gallery feed, the client is what gates spicy behind
// a login wall, not the API.
app.get('/api/fanpage-profile/:username/all-characters', async (req, res) => {
  const { rows: [author] } = await pool.query(
    'SELECT id FROM users WHERE username = $1', [req.params.username.toLowerCase()]
  );
  if (!author) return res.status(404).json({ error: 'Not found.' });

  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }

  const { rows } = await pool.query(
    `SELECT mc.id, mc.name, mc.ref_image, mc.ref_position_x, mc.ref_position_y, mc.view_count,
            mc.description, mc.stats, mc.facts, mc.lore, mc.relationships,
            ms.story_path, ms.slug, ms.site_title,
            (SELECT COUNT(*)::int FROM moderator_character_likes mcl WHERE mcl.character_id = mc.id) AS like_count,
            EXISTS(SELECT 1 FROM moderator_character_likes mcl WHERE mcl.character_id = mc.id AND mcl.user_id = $2) AS liked,
            EXISTS(SELECT 1 FROM moderator_character_bookmarks mcb WHERE mcb.character_id = mc.id AND mcb.user_id = $2) AS bookmarked
     FROM moderator_characters mc
     LEFT JOIN LATERAL (
       SELECT site_id FROM character_story_links WHERE character_id = mc.id ORDER BY site_id LIMIT 1
     ) csl ON true
     LEFT JOIN moderator_sites ms ON ms.id = csl.site_id
     WHERE mc.owner_user_id = $1
     ORDER BY mc.created_at DESC`,
    [author.id, viewerId || 0]
  );
  res.json({
    characters: rows.map(r => ({
      id: r.id, name: r.name, image: r.ref_image || null,
      position_x: r.ref_position_x, position_y: r.ref_position_y,
      // Full-detail fields — used by the profile's "Characters" tab, which
      // renders a complete character page (not just a nav-list thumbnail).
      ref_image: r.ref_image || null, ref_position_x: r.ref_position_x, ref_position_y: r.ref_position_y,
      description: r.description, stats: r.stats || {}, facts: r.facts || [],
      lore: r.lore || [], relationships: r.relationships || [],
      story_path: r.story_path || r.slug || null, site_title: r.site_title || null,
      like_count: r.like_count, liked: r.liked, bookmarked: r.bookmarked, view_count: r.view_count || 0,
    })),
  });
});

app.get('/api/fanpage-profile/:username/all-gallery', async (req, res) => {
  const { rows: [author] } = await pool.query(
    'SELECT id FROM users WHERE username = $1', [req.params.username.toLowerCase()]
  );
  if (!author) return res.status(404).json({ error: 'Not found.' });

  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }
  const loggedIn = viewerId !== null;
  const viewerNsfwEnabled = loggedIn
    ? (await pool.query('SELECT nsfw_enabled FROM users WHERE id = $1', [viewerId])).rows[0]?.nsfw_enabled
    : false;
  const nsfwLock = !loggedIn ? 'login' : (!viewerNsfwEnabled ? 'sfw_mode' : null);

  const { rows } = await pool.query(
    `SELECT mg.id, mg.image_url, mg.title, mg.description, mg.category, mg.position_x, mg.position_y,
            mg.tags, mg.view_count,
            ms.story_path, ms.slug, ms.site_title,
            (SELECT COUNT(*)::int FROM moderator_gallery_likes WHERE gallery_id = mg.id) AS like_count,
            (SELECT COUNT(*)::int FROM content_comments WHERE target_type = 'gallery' AND target_id = mg.id) AS comment_count,
            EXISTS(SELECT 1 FROM moderator_gallery_likes WHERE gallery_id = mg.id AND user_id = $2) AS liked,
            EXISTS(SELECT 1 FROM moderator_gallery_bookmarks WHERE gallery_id = mg.id AND user_id = $2) AS bookmarked
     FROM moderator_gallery mg
     LEFT JOIN LATERAL (
       SELECT site_id FROM gallery_story_links WHERE gallery_id = mg.id ORDER BY site_id LIMIT 1
     ) gsl ON true
     LEFT JOIN moderator_sites ms ON ms.id = gsl.site_id
     WHERE mg.owner_user_id = $1 AND (mg.category = 'sfw' OR $3 = false)
     ORDER BY mg.created_at DESC`,
    [author.id, viewerId || 0, !!nsfwLock]
  );
  res.json({
    gallery: rows.map(r => ({
      id: r.id, image: r.image_url, title: r.title, description: r.description, category: r.category,
      position_x: r.position_x, position_y: r.position_y, tags: r.tags || [], view_count: r.view_count || 0,
      like_count: r.like_count, comment_count: r.comment_count, liked: r.liked, bookmarked: r.bookmarked,
      story_path: r.story_path || r.slug || null, site_title: r.site_title || null,
    })),
    nsfw_lock: nsfwLock,
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
  const { rows: [follower] } = await pool.query('SELECT username FROM users WHERE id = $1', [req.user.id]);
  await notifyUser(target.id, req.user.id, 'follow', 'started following you.', `/${follower.username}`);
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

// Same default/custom-background pattern, scoped to the Reader — a
// per-reader preference (not per-story), so it follows the same person
// into every story they read rather than living on the story record.
app.put('/api/account/reader-theme', requireAuth, async (req, res) => {
  const theme = req.body.theme === 'custom' ? 'custom' : 'dark';
  await pool.query('UPDATE users SET reader_theme = $1 WHERE id = $2', [theme, req.user.id]);
  res.json({ theme });
});

app.put('/api/account/reader-theme-bg', requireAuth, uploadModImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const bgUrl = `/images/moderators/${req.file.filename}`;
  await pool.query(`UPDATE users SET reader_theme_bg_url = $1, reader_theme = 'custom' WHERE id = $2`, [bgUrl, req.user.id]);
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
  // New upload resets zoom to 1x, same as avatar/cover/character-ref uploads.
  await pool.query(
    `UPDATE users SET account_banner_url = $1, account_banner_position_x = $2, account_banner_position_y = $3, account_banner_zoom = 100 WHERE id = $4`,
    [bannerUrl, posX, posY, req.user.id]
  );
  res.json({ banner_url: bannerUrl, position_x: posX, position_y: posY, zoom: 100 });
});

app.put('/api/account/banner-position', requireAuth, async (req, res) => {
  const x = parseInt(req.body.position_x, 10);
  const y = parseInt(req.body.position_y, 10);
  if (![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 100)) return res.status(400).json({ error: 'Positions must be 0-100.' });
  const zoom = clampZoom(req.body.zoom, 100);
  await pool.query('UPDATE users SET account_banner_position_x = $1, account_banner_position_y = $2, account_banner_zoom = $3 WHERE id = $4', [x, y, zoom, req.user.id]);
  res.json({ message: 'Updated.', zoom });
});

// GET /api/featured-search — powers the Featured Characters / Featured
// Gallery pickers in the in-line profile editor. Searches across every
// fanpage story's characters/gallery (not just the viewer's own), so users
// can feature a favorite from any community story. Results from the
// viewer's own site(s) are surfaced first.
app.get('/api/featured-search', requireAuth, async (req, res) => {
  const kind = ['gallery', 'story'].includes(req.query.kind) ? req.query.kind : 'character';
  const q = `%${String(req.query.q || '').slice(0, 60)}%`;
  const scope = req.query.scope === 'other' ? 'other' : 'mine';
  const ownerFilter = scope === 'mine' ? '=' : '!=';

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
       WHERE mc.name ILIKE $1 AND mc.owner_user_id ${ownerFilter} $2 ORDER BY mc.name LIMIT 30`,
      [q, req.user.id]
    ));
  } else if (kind === 'gallery') {
    ({ rows } = await pool.query(
      `SELECT mg.id, mg.title AS title, mg.image_url AS image_url, mg.owner_user_id,
              ms.story_path, ms.slug, u.username AS owner_username
       FROM moderator_gallery mg
       LEFT JOIN LATERAL (
         SELECT site_id FROM gallery_story_links WHERE gallery_id = mg.id ORDER BY site_id LIMIT 1
       ) gsl ON true
       LEFT JOIN moderator_sites ms ON ms.id = gsl.site_id
       JOIN users u ON u.id = mg.owner_user_id
       WHERE mg.category = 'sfw' AND mg.title ILIKE $1 AND mg.owner_user_id ${ownerFilter} $2 ORDER BY mg.title LIMIT 30`,
      [q, req.user.id]
    ));
  } else {
    ({ rows } = await pool.query(
      `SELECT ms.id, ms.site_title AS title, ms.cover_url AS image_url, ms.owner_user_id,
              ms.story_path, ms.slug, u.username AS owner_username
       FROM moderator_sites ms
       JOIN users u ON u.id = ms.owner_user_id
       WHERE ms.site_title ILIKE $1 AND ms.owner_user_id ${ownerFilter} $2 ORDER BY ms.site_title LIMIT 30`,
      [q, req.user.id]
    ));
  }

  const results = rows
    .map(r => ({
      ref_id: String(r.id),
      title: r.title || 'Untitled',
      image_url: r.image_url || '',
      link_url: kind === 'story'
        ? `/${r.story_path || r.slug}`
        : (r.story_path || r.slug
          ? `/${r.story_path || r.slug}${kind === 'character' ? '/characters' : '/gallery'}`
          : `/${r.owner_username}`),
      mine: r.owner_user_id === req.user.id,
      owner_username: r.owner_username,
    }))
    .sort((a, b) => (b.mine - a.mine));

  res.json({ results });
});

// PUT /api/account/featured — replaces the caller's featured-characters,
// featured-gallery, or featured-stories set (max 3 each) in
// one shot.
app.put('/api/account/featured', requireAuth, async (req, res) => {
  const kind = ['gallery', 'story'].includes(req.body.kind) ? req.body.kind : 'character';
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
// Mature/Explicit gallery items are only included when the request carries a
// valid token with NSFW enabled. Kept for callers with only
// a single-segment identity (an author's one-and-only story, or legacy links);
// authors with multiple stories are looked up by the more specific story_path
// route below instead, since slug (their identity) is no longer unique.
app.get('/api/moderator-sites/:slug', async (req, res) => {
  await sendSiteLookup(
    `SELECT ms.*, u.display_name AS author_display_name, u.username AS author_username, u.avatar AS author_avatar, u.account_bio AS author_bio
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
    `SELECT ms.*, u.display_name AS author_display_name, u.username AS author_username, u.avatar AS author_avatar, u.account_bio AS author_bio
     FROM moderator_sites ms JOIN users u ON u.id = ms.owner_user_id
     WHERE ms.story_path = $1`,
    [`${req.params.owner}/${req.params.story}`], req, res
  );
});

// POST .../view — bumps the story's home-page view counter. Fired once per
// page load from the story hub itself (not the Characters/Chapters/Gallery
// sub-pages, which all share the GET lookup above but shouldn't each count
// as a "view" of the story). The owner's own visits don't count, so authors
// previewing their own page can't inflate it. Easy/naive by design for now —
// "views" here just means home-page loads, no de-duping by visitor yet.
async function bumpSiteViewCount(req, res, whereClause, params) {
  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }
  const { rows: [site] } = await pool.query(`SELECT id, owner_user_id FROM moderator_sites WHERE ${whereClause}`, params);
  if (!site) return res.status(404).json({ error: 'Not found.' });
  if (viewerId !== site.owner_user_id) {
    await pool.query('UPDATE moderator_sites SET view_count = view_count + 1 WHERE id = $1', [site.id]);
  }
  res.json({ ok: true });
}
app.post('/api/moderator-sites/:slug/view', async (req, res) => {
  await bumpSiteViewCount(req, res, 'slug = $1', [req.params.slug]);
});
app.post('/api/moderator-sites/by-path/:owner/:story/view', async (req, res) => {
  await bumpSiteViewCount(req, res, 'story_path = $1', [`${req.params.owner}/${req.params.story}`]);
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
  const viewerNsfwEnabled = loggedIn
    ? (await pool.query('SELECT nsfw_enabled FROM users WHERE id = $1', [viewerId])).rows[0]?.nsfw_enabled
    : false;
  // Three states: logged out -> must log in; logged in but opted into SFW
  // Mode -> content stays NSFW-locked with a different message; logged in
  // + NSFW mode -> full access.
  const nsfwLock = !loggedIn ? 'login' : (!viewerNsfwEnabled ? 'sfw_mode' : null);

  const [{ rows: chapters }, { rows: characters }, { rows: gallery }, isFollowing, isBookmarked, likedGalleryIds, bookmarkedGalleryIds, siteLikeCount, siteCommentCount, siteBookmarkCount] = await Promise.all([
    // Drafts only ever show to the story's own owner (previewing via "View
    // as Reader") — everyone else only ever sees published chapters.
    pool.query(
      `SELECT mc.id, mc.title, mc.teaser, mc.links, mc.image_url, mc.video_url, mc.file_url, mc.file_name,
              mc.status, mc.body, mc.view_count, mc.created_at, mc.updated_at,
              (SELECT COUNT(*)::int FROM content_comments WHERE target_type = 'chapter_paragraph' AND target_id = mc.id) AS comment_count,
              (SELECT COUNT(*)::int FROM chapter_likes WHERE chapter_id = mc.id) AS like_count,
              EXISTS(SELECT 1 FROM chapter_likes WHERE chapter_id = mc.id AND user_id = $2) AS liked
       FROM moderator_chapters mc
       WHERE mc.site_id = $1 ${viewerId === site.owner_user_id ? '' : "AND mc.status = 'published'"}
       ORDER BY mc.sort_order, mc.id`,
      [site.id, viewerId]
    ),
    pool.query(`
      SELECT mc.id, mc.name, mc.ref_image, mc.ref_position_x, mc.ref_position_y, mc.description, mc.stats, mc.facts, mc.lore, mc.relationships, mc.owner_user_id, mc.ref_is_nsfw, mc.view_count,
             ou.display_name AS owner_display_name, ou.username AS owner_username,
             (SELECT COUNT(*)::int FROM moderator_character_likes mcl WHERE mcl.character_id = mc.id) AS like_count,
             EXISTS(SELECT 1 FROM moderator_character_likes mcl WHERE mcl.character_id = mc.id AND mcl.user_id = $2) AS liked,
             EXISTS(SELECT 1 FROM moderator_character_bookmarks mcb WHERE mcb.character_id = mc.id AND mcb.user_id = $2) AS bookmarked
      FROM character_story_links csl
      JOIN moderator_characters mc ON mc.id = csl.character_id
      JOIN users ou ON ou.id = mc.owner_user_id
      WHERE csl.site_id = $1 ORDER BY csl.sort_order, mc.id
    `, [site.id, viewerId]),
    pool.query(`
      SELECT mg.id, mg.category, mg.image_url, mg.title, mg.description, mg.position_x, mg.position_y,
             mg.tags, mg.view_count,
             (SELECT count(*) FROM moderator_gallery_likes WHERE gallery_id = mg.id) AS like_count,
             (SELECT count(*)::int FROM content_comments WHERE target_type = 'gallery' AND target_id = mg.id) AS comment_count
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
    viewerId
      ? pool.query('SELECT gallery_id FROM moderator_gallery_bookmarks WHERE user_id = $1', [viewerId])
      : Promise.resolve({ rows: [] }),
    pool.query('SELECT count(*) FROM moderator_site_likes WHERE site_id = $1', [site.id]),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM content_comments cc
       JOIN moderator_chapters mc ON mc.id = cc.target_id AND cc.target_type = 'chapter_paragraph'
       WHERE mc.site_id = $1`,
      [site.id]
    ),
    pool.query('SELECT COUNT(*)::int AS count FROM moderator_bookmarks WHERE site_id = $1', [site.id]),
  ]);

  const likedSet = new Set(likedGalleryIds.rows.map(r => r.gallery_id));
  const bookmarkedSet = new Set(bookmarkedGalleryIds.rows.map(r => r.gallery_id));
  gallery.forEach(g => {
    g.like_count = Number(g.like_count);
    g.liked = likedSet.has(g.id);
    g.bookmarked = bookmarkedSet.has(g.id);
  });

  // "Is this MY character" (I own it), not just "am I the story owner" —
  // a story owner can link a friend's character onto their roster, and that
  // borrowed character must never be editable through this story's page.
  characters.forEach(c => {
    c.is_mine = viewerId !== null && viewerId === c.owner_user_id;
    delete c.owner_user_id;
  });

  res.json({
    site: {
      slug: site.slug, story_path: site.story_path, site_title: site.site_title, synopsis: site.synopsis,
      bio: site.bio, links: site.links, banner_url: site.banner_url, banner_original_url: site.banner_original_url || '',
      banner_position: site.banner_position, theme: site.theme, theme_bg_url: site.theme_bg_url,
      cover_url: site.cover_url, cover_original_url: site.cover_original_url || '', cover_position_x: site.cover_position_x, cover_position_y: site.cover_position_y,
      characters_card_url: site.characters_card_url, chapters_card_url: site.chapters_card_url, gallery_card_url: site.gallery_card_url,
      characters_card_original_url: site.characters_card_original_url || '', chapters_card_original_url: site.chapters_card_original_url || '', gallery_card_original_url: site.gallery_card_original_url || '',
      characters_card_position_x: site.characters_card_position_x, characters_card_position_y: site.characters_card_position_y,
      chapters_card_position_x: site.chapters_card_position_x, chapters_card_position_y: site.chapters_card_position_y,
      gallery_card_position_x: site.gallery_card_position_x, gallery_card_position_y: site.gallery_card_position_y,
      author_display_name: site.author_display_name, author_username: site.author_username,
      author_avatar: site.author_avatar || null, author_bio: site.author_bio || '',
      tags: site.tags || [],
      rating: site.rating || 'sfw', categories: site.categories || [], relationships: site.relationships || [],
      fandoms: site.fandoms || [], is_complete: !!site.is_complete,
      is_self: viewerId === site.owner_user_id,
      is_following: isFollowing.rows.length > 0,
      is_bookmarked: isBookmarked.rows.length > 0,
      view_count: site.view_count || 0,
      like_count: Number(siteLikeCount.rows[0].count),
      comment_count: Number(siteCommentCount.rows[0].count),
      bookmark_count: Number(siteBookmarkCount.rows[0].count),
    },
    chapters,
    characters,
    // Single unified gallery list now -- no more SFW/Mature/Explicit tabs
    // to split it across. Non-SFW posts are filtered out server-side
    // entirely for a locked-out viewer rather than sent-but-hidden.
    gallery: nsfwLock ? gallery.filter(g => g.category === 'sfw') : gallery,
    nsfw_lock: nsfwLock,
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
    `SELECT ms.id, ms.slug, ms.story_path, ms.site_title, ms.cover_url, ms.banner_url, ms.view_count, ms.updated_at, u.avatar,
       (SELECT COUNT(*)::int FROM moderator_chapters mc WHERE mc.site_id = ms.id AND mc.status = 'published' AND length(trim(mc.body)) > 0) AS published_chapter_count,
       (SELECT COUNT(*)::int FROM moderator_chapters mc WHERE mc.site_id = ms.id AND (mc.status = 'draft' OR length(trim(mc.body)) = 0)) AS draft_chapter_count,
       (SELECT COUNT(*)::int FROM moderator_site_likes WHERE site_id = ms.id) AS like_count,
       (SELECT COUNT(*)::int FROM content_comments cc JOIN moderator_chapters mc ON mc.id = cc.target_id AND cc.target_type = 'chapter_paragraph' WHERE mc.site_id = ms.id) AS comment_count
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

// `banner` (the baked-in crop actually shown) is always required.
// `banner_original` is only sent the first time a NEW source photo is
// picked — Recrop re-sends just `banner` from the existing original, so
// banner_original_url stays untouched and there's always a full image left
// to recrop from, not just whatever was cropped last time.
app.put('/api/moderator/site/banner', requireAuth, requireModerator, uploadModImage.fields([{ name: 'banner', maxCount: 1 }, { name: 'banner_original', maxCount: 1 }]), async (req, res) => {
  const bannerFile = req.files && req.files.banner && req.files.banner[0];
  if (!bannerFile) return res.status(400).json({ error: 'Image is required.' });
  const bannerUrl = `/images/moderators/${bannerFile.filename}`;
  const originalFile = req.files.banner_original && req.files.banner_original[0];
  const position = Number.isFinite(parseInt(req.body.position, 10)) ? parseInt(req.body.position, 10) : 50;
  const { rows: [site] } = originalFile
    ? await pool.query(
        'UPDATE moderator_sites SET banner_url = $1, banner_original_url = $2, banner_position = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
        [bannerUrl, `/images/moderators/${originalFile.filename}`, position, req.modSite.id]
      )
    : await pool.query(
        'UPDATE moderator_sites SET banner_url = $1, banner_position = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
        [bannerUrl, position, req.modSite.id]
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
app.put('/api/moderator/site/cover', requireAuth, requireModerator, uploadModImage.fields([{ name: 'cover', maxCount: 1 }, { name: 'cover_original', maxCount: 1 }]), async (req, res) => {
  const coverFile = req.files && req.files.cover && req.files.cover[0];
  if (!coverFile) return res.status(400).json({ error: 'Image is required.' });
  const coverUrl = `/images/moderators/${coverFile.filename}`;
  const x = parseInt(req.body.position_x, 10);
  const y = parseInt(req.body.position_y, 10);
  // `cover_original` is only sent the first time a NEW source photo is
  // picked -- Recrop re-sends just `cover` (a fresh bake) from the
  // existing original, so cover_original_url stays untouched. Same
  // pattern as the story banner/nav-card fix.
  const originalFile = req.files.cover_original && req.files.cover_original[0];
  const { rows: [site] } = originalFile
    ? await pool.query(
        `UPDATE moderator_sites SET cover_url = $1, cover_original_url = $2, cover_position_x = $3, cover_position_y = $4, updated_at = NOW() WHERE id = $5 RETURNING *`,
        [coverUrl, `/images/moderators/${originalFile.filename}`, Number.isFinite(x) ? x : 50, Number.isFinite(y) ? y : 50, req.modSite.id]
      )
    : await pool.query(
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
  characters: { url: 'characters_card_url', original: 'characters_card_original_url', x: 'characters_card_position_x', y: 'characters_card_position_y' },
  chapters:   { url: 'chapters_card_url',   original: 'chapters_card_original_url',   x: 'chapters_card_position_x',   y: 'chapters_card_position_y' },
  gallery:    { url: 'gallery_card_url',    original: 'gallery_card_original_url',    x: 'gallery_card_position_x',    y: 'gallery_card_position_y' },
};
// `image` (the baked-in crop actually shown) is always required.
// `image_original` is only sent the first time a NEW source photo is
// picked — Recrop re-sends just `image` from the existing original, so
// *_card_original_url stays untouched. Same pattern as the banner fix.
app.put('/api/moderator/site/nav-card/:kind', requireAuth, requireModerator, uploadModImage.fields([{ name: 'image', maxCount: 1 }, { name: 'image_original', maxCount: 1 }]), async (req, res) => {
  const cols = NAV_CARD_COLUMNS[req.params.kind];
  if (!cols) return res.status(400).json({ error: 'Invalid card.' });
  const imageFile = req.files && req.files.image && req.files.image[0];
  if (!imageFile) return res.status(400).json({ error: 'Image is required.' });
  const url = `/images/moderators/${imageFile.filename}`;
  const originalFile = req.files.image_original && req.files.image_original[0];
  const { rows: [site] } = originalFile
    ? await pool.query(
        `UPDATE moderator_sites SET ${cols.url} = $1, ${cols.original} = $2, ${cols.x} = 50, ${cols.y} = 50, updated_at = NOW() WHERE id = $3 RETURNING *`,
        [url, `/images/moderators/${originalFile.filename}`, req.modSite.id]
      )
    : await pool.query(
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
// Snaps each submitted value to its catalog entry's exact casing when one
// matches case-insensitively (typing "umbreon" saves as the catalog's own
// "Umbreon" instead of forking into a lowercase near-duplicate that reads
// as a different tag everywhere it's displayed), falling back to the
// submitted value as-is for anything genuinely new. This is the real
// trust boundary — the client-side tag inputs already do this snap for a
// good UX, but a hand-crafted request could still send anything, so it
// has to be enforced again here.
async function snapToCatalogCasing(tableName, values, maxLen, maxCount) {
  const { rows } = await pool.query(`SELECT name FROM ${tableName}`);
  const catalogMap = new Map(rows.map(r => [r.name.toLowerCase(), r.name]));
  const seen = new Set();
  const out = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const collapsed = v.trim().replace(/\s+/g, ' ').slice(0, maxLen);
    if (!collapsed) continue;
    const clean = catalogMap.get(collapsed.toLowerCase()) || collapsed;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= maxCount) break;
  }
  return out;
}

async function sanitizeTags(raw) {
  if (!Array.isArray(raw)) return null;
  return snapToCatalogCasing('tag_catalog', raw, 40, 100);
}

// Story ratings now match the gallery's own three tiers exactly (was a
// separate General Audiences/Teen & Up/Mature-Explicit scale) -- same
// values, same "sfw visible to everyone, mature/explicit need NSFW" gating
// logic reused as-is for the Posts ratings filter (see /api/search/submissions).
const RATING_OPTIONS = ['sfw', 'mature', 'explicit'];
// Gallery post rating tiers -- "sfw" is visible to everyone; "mature" and
// "explicit" both require a logged-in viewer with NSFW enabled (no
// separate gate between them, same as the old single "spicy" tier).
const GALLERY_CATEGORIES = ['sfw', 'mature', 'explicit'];
const CATEGORY_OPTIONS = ['Gen', 'M/F', 'M/M', 'F/F', 'Multi', 'Other'];

function sanitizeCategories(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const c of raw) {
    if (typeof c !== 'string' || !CATEGORY_OPTIONS.includes(c) || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

function sanitizeRelationships(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    if (typeof r !== 'string') continue;
    const clean = r.trim().slice(0, 150);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 20) break;
  }
  return out;
}

// Fandom is freeform (like a tag) rather than locked to a fixed option list —
// the catalog only powers autocomplete suggestions; anything typed still
// saves, and popular freeform entries get promoted into the catalog by hand.
async function sanitizeFandoms(raw) {
  if (!Array.isArray(raw)) return null;
  return snapToCatalogCasing('fandom_catalog', raw, 100, 10);
}

// Species lives inside the character's freeform `stats` blob (stats.Species)
// rather than its own column -- this snaps just that one key to the
// species dictionary's canonical casing, same "type it or click the
// suggestion, either way it links to the real dictionary entry" rule as
// tags/fandoms. Everything else in stats passes through untouched.
async function sanitizeCharacterStats(stats) {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return stats;
  if (typeof stats.Species !== 'string' || !stats.Species.trim()) return stats;
  const [clean] = await snapToCatalogCasing('character_species_catalog', [stats.Species], 60, 1);
  return { ...stats, Species: clean || stats.Species.trim() };
}

app.put('/api/moderator/site', requireAuth, requireModerator, async (req, res) => {
  const { site_title, synopsis, bio, links, theme } = req.body;
  const tags = req.body.tags !== undefined ? await sanitizeTags(req.body.tags) : undefined;
  const rating = req.body.rating !== undefined && RATING_OPTIONS.includes(req.body.rating) ? req.body.rating : undefined;
  const categories = req.body.categories !== undefined ? sanitizeCategories(req.body.categories) : undefined;
  const relationships = req.body.relationships !== undefined ? sanitizeRelationships(req.body.relationships) : undefined;
  const fandoms = req.body.fandoms !== undefined ? await sanitizeFandoms(req.body.fandoms) : undefined;
  const isComplete = typeof req.body.is_complete === 'boolean' ? req.body.is_complete : undefined;
  const { rows: [site] } = await pool.query(
    `UPDATE moderator_sites SET
       site_title    = COALESCE($1, site_title),
       synopsis      = COALESCE($2, synopsis),
       bio           = COALESCE($3, bio),
       links         = COALESCE($4, links),
       theme         = COALESCE($5, theme),
       tags          = COALESCE($6, tags),
       rating        = COALESCE($7, rating),
       categories    = COALESCE($8, categories),
       relationships = COALESCE($9, relationships),
       fandoms       = COALESCE($10, fandoms),
       is_complete   = COALESCE($12, is_complete),
       updated_at    = NOW()
     WHERE id = $11 RETURNING *`,
    [site_title, synopsis, bio, links !== undefined ? JSON.stringify(links) : null, theme,
     tags !== undefined ? JSON.stringify(tags) : null, rating,
     categories !== undefined ? JSON.stringify(categories) : null,
     relationships !== undefined ? JSON.stringify(relationships) : null,
     fandoms !== undefined ? JSON.stringify(fandoms) : null,
     req.modSite.id, isComplete]
  );

  res.json({ site });
});

// GET /api/fandom-catalog — public, powers the Fandom field's typeahead.
// Starts seeded with a handful of options; new entries get added by hand
// as freeform fandoms typed on stories turn out to be popular, mirroring
// how AO3's tag wrangling promotes free-text tags into canonical ones.
app.get('/api/fandom-catalog', async (req, res) => {
  const { rows } = await pool.query('SELECT name FROM fandom_catalog ORDER BY name ASC');
  res.json({ fandoms: rows.map(r => r.name) });
});

// GET /api/tag-catalog + /api/relationship-catalog — same idea as fandoms,
// seeded from real AO3 works. Not wired into the editor's typeahead yet
// (Additional Tags/Relationships are still freeform-only) — these exist so
// that work can be added later without another data migration.
app.get('/api/tag-catalog', async (req, res) => {
  const { rows } = await pool.query('SELECT name FROM tag_catalog ORDER BY name ASC');
  res.json({ tags: rows.map(r => r.name) });
});
app.get('/api/relationship-catalog', async (req, res) => {
  const { rows } = await pool.query('SELECT name FROM relationship_catalog ORDER BY name ASC');
  res.json({ relationships: rows.map(r => r.name) });
});

// How many posts (stories + gallery submissions, combined) carry each of
// the given tags -- powers the e621-style "tag: count" rows on a gallery
// post's stats box.
app.get('/api/tag-usage', async (req, res) => {
  const tags = String(req.query.tags || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
  if (!tags.length) return res.json({ counts: {} });
  const { rows } = await pool.query(`
    SELECT t AS tag, count(*)::int AS count FROM (
      SELECT jsonb_array_elements_text(tags) AS t FROM moderator_sites
      UNION ALL
      SELECT jsonb_array_elements_text(tags) AS t FROM moderator_gallery
    ) all_tags
    WHERE t = ANY($1::text[])
    GROUP BY t
  `, [tags]);
  const counts = {};
  tags.forEach(t => { counts[t] = 0; });
  rows.forEach(r => { counts[r.tag] = r.count; });
  res.json({ counts });
});

// DELETE /api/admin/{fandom,tag,relationship}-catalog/:name — lets the
// admin prune entries straight from the Tag Dictionary panel (typos, or
// anything that shouldn't have made the initial seed). Name is unique per
// table, so it's enough of a key — no ids exposed on the public GETs above.
app.delete('/api/admin/fandom-catalog/:name', requireAuth, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM fandom_catalog WHERE name = $1', [req.params.name]);
  res.json({ message: 'Deleted.' });
});
app.delete('/api/admin/tag-catalog/:name', requireAuth, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM tag_catalog WHERE name = $1', [req.params.name]);
  res.json({ message: 'Deleted.' });
});
app.delete('/api/admin/relationship-catalog/:name', requireAuth, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM relationship_catalog WHERE name = $1', [req.params.name]);
  res.json({ message: 'Deleted.' });
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
  await pool.query(`DELETE FROM user_featured_items WHERE kind = 'story' AND ref_id = $1`, [String(site.id)]);
  res.json({ message: 'Deleted.' });
});

// Flips every published chapter back to draft in one shot — the Creator
// Hub's "Unpublish Story" action. Drafts stay drafts (nothing to flip), so
// this is safe to call even if the story's already partway unpublished.
app.put('/api/moderator/site/unpublish', requireAuth, requireModerator, async (req, res) => {
  await pool.query(
    `UPDATE moderator_chapters SET status = 'draft', updated_at = NOW() WHERE site_id = $1 AND status = 'published'`,
    [req.modSite.id]
  );
  res.json({ message: 'Unpublished.' });
});

// ── Chapters ───────────────────────────────────────────────────────────────────
app.get('/api/moderator/chapters', requireAuth, requireModerator, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT mc.*,
       (SELECT COUNT(*)::int FROM content_comments WHERE target_type = 'chapter_paragraph' AND target_id = mc.id) AS comment_count,
       (SELECT COUNT(*)::int FROM chapter_likes WHERE chapter_id = mc.id) AS like_count
     FROM moderator_chapters mc WHERE site_id = $1 ORDER BY sort_order, id`,
    [req.modSite.id]
  );
  res.json({ chapters: rows });
});

// Single chapter, with its full body text — feeds the chapter editor page.
app.get('/api/moderator/chapters/:id', requireAuth, requireModerator, async (req, res) => {
  const { rows: [chapter] } = await pool.query(
    'SELECT * FROM moderator_chapters WHERE id = $1 AND site_id = $2', [req.params.id, req.modSite.id]
  );
  if (!chapter) return res.status(404).json({ error: 'Not found.' });
  res.json({ chapter });
});

// POST /api/moderator/chapters/import-docx — pulls text out of a .docx into
// HTML for the chapter editor's "Import" button. Memory storage only, since
// the file itself never needs to be kept around — just read once, converted,
// discarded. Returns raw HTML from mammoth as-is; the client runs it through
// the same sanitizePastedHtml() pipeline already used for pasted Word/
// Wattpad content, so this doesn't need its own separate cleanup pass.
const mammoth = require('mammoth');
const uploadDocx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  },
});
app.post('/api/moderator/chapters/import-docx', requireAuth, requireModerator, uploadDocx.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A .docx file is required.' });
  try {
    const { value: html } = await mammoth.convertToHtml({ buffer: req.file.buffer });
    res.json({ html });
  } catch (e) {
    console.error('docx import error:', e.message);
    res.status(400).json({ error: "Couldn't read that file — make sure it's a valid .docx." });
  }
});

function parseChapterLinks(raw) {
  let links = [];
  try { links = JSON.parse(raw || '[]'); } catch { links = []; }
  if (!Array.isArray(links)) return [];
  return links
    .filter(l => l && l.label && l.url)
    .map(l => ({ label: String(l.label).trim(), url: String(l.url).trim() }));
}

// "+ New Chapter" is now instant — no form, no title required. It always
// lands as a draft with an auto-numbered placeholder title; the actual
// writing happens in the chapter editor page afterward.
app.post('/api/moderator/chapters', requireAuth, requireModerator, uploadChapter.fields([{ name: 'image', maxCount: 1 }, { name: 'file', maxCount: 1 }]), async (req, res) => {
  const { teaser } = req.body;
  const links = parseChapterLinks(req.body.links);

  const imageFile = req.files && req.files.image && req.files.image[0];
  const docFile   = req.files && req.files.file  && req.files.file[0];
  const imageUrl  = imageFile ? `/images/moderators/${imageFile.filename}` : '';
  const fileUrl   = docFile   ? `/moderators/files/${docFile.filename}`    : '';
  const fileName  = docFile   ? docFile.originalname : '';

  const { rows: [{ maxOrder, chapterCount }] } = await pool.query(
    `SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder", COUNT(*)::int AS "chapterCount"
     FROM moderator_chapters WHERE site_id = $1`, [req.modSite.id]
  );
  let title = req.body.title && req.body.title.trim();
  if (!title) title = `Untitled Part: ${chapterCount + 1}`;

  const { rows: [chapter] } = await pool.query(
    `INSERT INTO moderator_chapters (site_id, title, teaser, links, image_url, file_url, file_name, sort_order, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', NOW()) RETURNING *`,
    [req.modSite.id, title, (teaser || '').trim(), JSON.stringify(links), imageUrl, fileUrl, fileName, maxOrder + 1]
  );
  res.json({ chapter });
});

// Publish/unpublish — drafts never show to readers once a real reader page exists.
app.put('/api/moderator/chapters/:id/status', requireAuth, requireModerator, async (req, res) => {
  const status = req.body.status;
  if (!['draft', 'published'].includes(status)) return res.status(400).json({ error: 'status must be draft or published.' });
  const { rows: [existing] } = await pool.query(
    'SELECT status FROM moderator_chapters WHERE id = $1 AND site_id = $2', [req.params.id, req.modSite.id]
  );
  const { rows: [chapter] } = await pool.query(
    'UPDATE moderator_chapters SET status = $1, updated_at = NOW() WHERE id = $2 AND site_id = $3 RETURNING *',
    [status, req.params.id, req.modSite.id]
  );
  if (!chapter) return res.status(404).json({ error: 'Not found.' });
  // Only notify followers on the draft→published transition, not every save.
  if (existing && existing.status !== 'published' && status === 'published') {
    await notifyFollowers(req.user.id, 'new_chapter',
      `published a new chapter: "${chapter.title}".`,
      `/${req.modSite.story_path}/reader?ch=${chapter.id}`);
  }
  res.json({ chapter });
});

// Saves title + body text from the chapter editor page — plain JSON, no
// multipart, since there's no file/image involved in this save.
// image_url/video_url are optional — the editor's cover picker uploads the
// image separately (POST /api/moderator/chapter-image) and just passes the
// resulting URL through here alongside title/body, same save action as
// everything else in the editor. Picking one clears the other (a chapter
// cover is either an image or a YouTube link, not both).
app.put('/api/moderator/chapters/:id/body', requireAuth, requireModerator, async (req, res) => {
  const title = String(req.body.title || '').trim();
  const body = String(req.body.body || '');
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const hasImageUrl = req.body.image_url !== undefined;
  const hasVideoUrl = req.body.video_url !== undefined;
  const imageUrl = hasImageUrl ? String(req.body.image_url || '') : null;
  const videoUrl = hasVideoUrl ? String(req.body.video_url || '') : null;
  const { rows: [chapter] } = await pool.query(
    `UPDATE moderator_chapters SET
       title = $1, body = $2, updated_at = NOW(),
       image_url = CASE WHEN $3 THEN $4 ELSE image_url END,
       video_url = CASE WHEN $5 THEN $6 ELSE video_url END
     WHERE id = $7 AND site_id = $8 RETURNING *`,
    [title, body, hasImageUrl, imageUrl, hasVideoUrl, videoUrl, req.params.id, req.modSite.id]
  );
  if (!chapter) return res.status(404).json({ error: 'Not found.' });
  res.json({ chapter });
});

// Must be registered BEFORE PUT /api/moderator/chapters/:id below, or
// Express matches "reorder" as the :id param — same gotcha as the
// gallery/characters reorder routes elsewhere in this file.
app.put('/api/moderator/chapters/reorder', requireAuth, requireModerator, async (req, res) => {
  const order = req.body.order;
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order must be a non-empty array of chapter IDs.' });
  await pool.query('BEGIN');
  try {
    for (let i = 0; i < order.length; i++) {
      await pool.query(
        'UPDATE moderator_chapters SET sort_order = $1 WHERE id = $2 AND site_id = $3',
        [i, order[i], req.modSite.id]
      );
    }
    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    return res.status(500).json({ error: 'Could not save the new order.' });
  }
  res.json({ message: 'Order saved.' });
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

// Inline images dropped into a chapter's body text (the chapter editor) —
// same plain "upload it, get a URL back" shape, the editor embeds the URL
// itself in an image block within the saved body HTML.
app.post('/api/moderator/chapter-image', requireAuth, uploadModImage.single('image'), async (req, res) => {
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

// "Reorder Characters" (Characters page, story-context) — takes the full
// ordered list of character IDs currently linked to this story and rewrites
// their link's sort_order to match, 0-based. Only touches links that are
// both scoped to this story AND present in the submitted list, so a stale
// client can't accidentally wipe another character's ordering.
// Registered BEFORE PUT /api/moderator/characters/:id on purpose — Express
// matches routes in registration order, and :id would otherwise swallow
// "reorder" as a literal id value (and 500 on the resulting invalid-integer
// query, since :id is never actually numeric here).
app.put('/api/moderator/characters/reorder', requireAuth, requireModerator, async (req, res) => {
  const order = req.body.order;
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order must be a non-empty array of character IDs.' });
  await pool.query('BEGIN');
  try {
    for (let i = 0; i < order.length; i++) {
      await pool.query(
        'UPDATE character_story_links SET sort_order = $1 WHERE character_id = $2 AND site_id = $3',
        [i, order[i], req.modSite.id]
      );
    }
    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    return res.status(500).json({ error: 'Could not save the new order.' });
  }
  res.json({ message: 'Order saved.' });
});

// Instant "create + attach to this story" — same one-click flow authors are
// used to. Ownership lives on the character itself (owner_user_id); the
// link to this story is a separate row, so the same character can later be
// linked into other stories too without being duplicated.
app.post('/api/moderator/characters', requireAuth, requireModerator, async (req, res) => {
  const { name, ref_image, description, stats, facts, lore, relationships, ref_is_nsfw } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  const cleanStats = await sanitizeCharacterStats(stats || {});
  const { rows: [character] } = await pool.query(
    `INSERT INTO moderator_characters (owner_user_id, name, ref_image, description, stats, facts, lore, relationships, ref_is_nsfw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [req.user.id, name.trim(), ref_image || '/images/defaultchar.jpg', description || '',
     JSON.stringify(cleanStats), JSON.stringify(facts || []), JSON.stringify(lore || []),
     JSON.stringify(relationships || []), !!ref_is_nsfw]
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
  const { name, ref_image, description, stats, facts, lore, relationships, sort_order, ref_is_nsfw } = req.body;
  const cleanStats = stats !== undefined ? await sanitizeCharacterStats(stats) : undefined;
  const { rows: [character] } = await pool.query(
    `UPDATE moderator_characters SET
       name          = COALESCE($1, name),
       ref_image     = COALESCE($2, ref_image),
       description   = COALESCE($3, description),
       stats         = COALESCE($4, stats),
       facts         = COALESCE($5, facts),
       lore          = COALESCE($6, lore),
       relationships = COALESCE($7, relationships),
       sort_order    = COALESCE($8, sort_order),
       ref_is_nsfw   = COALESCE($9, ref_is_nsfw),
       updated_at    = NOW()
     WHERE id = $10 RETURNING *`,
    [name, ref_image, description,
     cleanStats !== undefined ? JSON.stringify(cleanStats) : null,
     facts !== undefined ? JSON.stringify(facts) : null,
     lore !== undefined ? JSON.stringify(lore) : null,
     relationships !== undefined ? JSON.stringify(relationships) : null,
     sort_order, ref_is_nsfw !== undefined ? !!ref_is_nsfw : null, existing.id]
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

// Same "You Own" / "Other" split as characters, for the gallery editor's
// "Link To: Story" picker.
app.get('/api/stories/mine', requireAuth, async (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const { rows } = await pool.query(
    `SELECT ms.id, ms.story_path, ms.slug, ms.site_title, ms.cover_url, u.avatar AS author_avatar
     FROM moderator_sites ms
     JOIN users u ON u.id = ms.owner_user_id
     WHERE ms.owner_user_id = $1 AND ms.site_title ILIKE $2
     ORDER BY ms.site_title LIMIT 30`,
    [req.user.id, q]
  );
  res.json({ stories: rows.map(r => ({ id: r.id, story_path: r.story_path || r.slug, site_title: r.site_title, cover_url: r.cover_url, author_avatar: r.author_avatar })) });
});

app.get('/api/stories/search', requireAuth, async (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const { rows } = await pool.query(
    `SELECT ms.id, ms.story_path, ms.slug, ms.site_title, ms.cover_url, u.username AS owner_username, u.display_name AS owner_display_name, u.avatar AS author_avatar
     FROM moderator_sites ms
     JOIN users u ON u.id = ms.owner_user_id
     WHERE ms.owner_user_id <> $1 AND ms.site_title ILIKE $2
     ORDER BY ms.site_title LIMIT 30`,
    [req.user.id, q]
  );
  res.json({
    stories: rows.map(r => ({
      id: r.id, story_path: r.story_path || r.slug, site_title: r.site_title, cover_url: r.cover_url,
      owner_username: r.owner_username, owner_display_name: r.owner_display_name || r.owner_username,
      author_avatar: r.author_avatar,
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
  // Not ownership-gated — a story owner can tag a friend's character onto
  // their own roster too, same as relationships can point to any character
  // regardless of who owns it.
  const { rows: [character] } = await pool.query(
    'SELECT id FROM moderator_characters WHERE id = $1', [req.params.id]
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
  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }
  const { rows: [character] } = await pool.query(
    `SELECT mc.*, u.username AS owner_username, u.display_name AS owner_display_name,
            (SELECT COUNT(*)::int FROM moderator_character_likes mcl WHERE mcl.character_id = mc.id) AS like_count,
            EXISTS(SELECT 1 FROM moderator_character_likes mcl WHERE mcl.character_id = mc.id AND mcl.user_id = $2) AS liked,
            EXISTS(SELECT 1 FROM moderator_character_bookmarks mcb WHERE mcb.character_id = mc.id AND mcb.user_id = $2) AS bookmarked
     FROM moderator_characters mc
     JOIN users u ON u.id = mc.owner_user_id
     WHERE mc.id = $1`,
    [req.params.id, viewerId || 0]
  );
  if (!character) return res.status(404).json({ error: 'Not found.' });
  character.is_mine = viewerId !== null && viewerId === character.owner_user_id;
  res.json({ character });
});

// Every story a character is linked to — backs the "Stories" section on the
// character viewer (small cover-art cards, click through to that story's
// home page).
app.get('/api/characters/:id/stories', async (req, res) => {
  const { viewerId } = await getViewerNsfwAccess(req);
  // A still-drafted story (no published chapter yet) should only ever be
  // clickable/visible to its own owner here -- anyone else browsing a
  // character card would otherwise be able to jump straight into an
  // unpublished book that was only linked for the author's own convenience.
  const { rows } = await pool.query(
    `SELECT ms.id AS site_id, ms.slug, ms.story_path, ms.site_title, ms.cover_url, u.avatar AS author_avatar
     FROM character_story_links csl
     JOIN moderator_sites ms ON ms.id = csl.site_id
     JOIN users u ON u.id = ms.owner_user_id
     WHERE csl.character_id = $1
       AND (
         ms.owner_user_id = $2
         OR EXISTS (
           SELECT 1 FROM moderator_chapters mc
           WHERE mc.site_id = ms.id AND mc.status = 'published' AND length(trim(mc.body)) > 0
         )
       )
     ORDER BY csl.sort_order, ms.id`,
    [req.params.id, viewerId || 0]
  );
  res.json({
    stories: rows.map(r => ({ id: r.site_id, story_path: r.story_path || r.slug, site_title: r.site_title, cover_url: r.cover_url, author_avatar: r.author_avatar })),
  });
});

// Unlink a story from a character — the owner's own call (not the story
// moderator's), since a character's "Link To Story" section can point to
// stories the character's owner doesn't moderate at all.
app.delete('/api/characters/:id/link/:siteId', requireAuth, async (req, res) => {
  const { rows: [character] } = await pool.query(
    'SELECT id FROM moderator_characters WHERE id = $1 AND owner_user_id = $2', [req.params.id, req.user.id]
  );
  if (!character) return res.status(404).json({ error: 'Not found.' });
  await pool.query(
    'DELETE FROM character_story_links WHERE character_id = $1 AND site_id = $2', [character.id, req.params.siteId]
  );
  res.json({ message: 'Unlinked.' });
});

// Standalone creation — no story context at all, lands on the owner's
// profile Characters tab. Requires nothing beyond a regular account (not
// requireModerator — RPers/artists with zero stories should still be able
// to make characters).
app.post('/api/characters', requireAuth, async (req, res) => {
  const { name, ref_image, description, stats, facts, lore, relationships, ref_is_nsfw } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  const cleanStats = await sanitizeCharacterStats(stats || {});
  const { rows: [character] } = await pool.query(
    `INSERT INTO moderator_characters (owner_user_id, name, ref_image, description, stats, facts, lore, relationships, ref_is_nsfw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [req.user.id, name.trim(), ref_image || '/images/defaultchar.jpg', description || '',
     JSON.stringify(cleanStats), JSON.stringify(facts || []), JSON.stringify(lore || []),
     JSON.stringify(relationships || []), !!ref_is_nsfw]
  );
  const { rows: [actor] } = await pool.query('SELECT username FROM users WHERE id = $1', [req.user.id]);
  await notifyFollowers(req.user.id, 'new_character',
    `uploaded a new character: "${character.name}".`,
    `/${actor.username}?char=${character.id}#characters`);
  res.json({ character });
});

// Additive-only linking — used right after standalone character creation to
// attach it to any number of stories picked in the "Link To: Stories"
// section. Never removes existing links, only adds new ones (mirrors
// /api/gallery/:id/link-many).
app.post('/api/characters/:id/link-many', requireAuth, async (req, res) => {
  const { rows: [item] } = await pool.query(
    'SELECT id FROM moderator_characters WHERE id = $1 AND owner_user_id = $2', [req.params.id, req.user.id]
  );
  if (!item) return res.status(404).json({ error: 'Not found.' });
  const siteIds = Array.isArray(req.body.site_ids) ? req.body.site_ids.filter(Number.isFinite) : [];
  await Promise.all(siteIds.map(siteId => pool.query(
    'INSERT INTO character_story_links (character_id, site_id) VALUES ($1, $2) ON CONFLICT (character_id, site_id) DO NOTHING',
    [item.id, siteId]
  )));
  res.json({ message: 'Linked.' });
});

// Permanent delete — the only way a character actually goes away. Cascades
// character_story_links automatically via FK.
app.delete('/api/characters/:id', requireAuth, async (req, res) => {
  const { rows: [existing] } = await pool.query(
    'SELECT id FROM moderator_characters WHERE id = $1 AND owner_user_id = $2', [req.params.id, req.user.id]
  );
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  await pool.query('DELETE FROM moderator_characters WHERE id = $1', [existing.id]);
  // Anyone who featured this character (favorites are cached by ref_id, not
  // an FK — see user_featured_items migration comment) would otherwise be
  // stuck showing a dead entry with no live row to fall back to.
  await pool.query(`DELETE FROM user_featured_items WHERE kind = 'character' AND ref_id = $1`, [String(existing.id)]);
  res.json({ message: 'Deleted.' });
});

// ── Gallery (SFW / Mature / Explicit) ───────────────────────────────────────────
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

// Gallery routes are multipart/form-data (image upload), so tags arrive as
// a JSON-encoded string field rather than a real array — same cleanup rules
// as the story editor's client-side addWorkingTag (lowercase, collapsed
// whitespace, 40 chars, 100 tags, de-duped) applied again here since this
// is the actual trust boundary.
async function parseGalleryTags(raw) {
  if (raw === undefined) return undefined;
  let arr;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return snapToCatalogCasing('tag_catalog', arr, 40, 100);
}

// Instant "create + attach to this story" — mirrors the character flow.
app.post('/api/moderator/gallery', requireAuth, requireModerator, uploadModImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const { category, title, description } = req.body;
  if (!GALLERY_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Category must be sfw, mature, or explicit.' });

  const imageUrl = `/images/moderators/${req.file.filename}`;
  const positionX = clampPosition(req.body.position_x);
  const positionY = clampPosition(req.body.position_y);
  const tags = (await parseGalleryTags(req.body.tags)) || [];
  const { rows: [item] } = await pool.query(
    `INSERT INTO moderator_gallery (owner_user_id, category, image_url, title, description, position_x, position_y, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [req.user.id, category, imageUrl, (title || '').trim(), (description || '').trim(), positionX, positionY, JSON.stringify(tags)]
  );
  const { rows: [{ maxOrder }] } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder" FROM gallery_story_links WHERE site_id = $1', [req.modSite.id]
  );
  await pool.query(
    'INSERT INTO gallery_story_links (gallery_id, site_id, sort_order) VALUES ($1, $2, $3)',
    [item.id, req.modSite.id, maxOrder + 1]
  );
  const { rows: [actor1] } = await pool.query('SELECT username FROM users WHERE id = $1', [req.user.id]);
  await notifyFollowers(req.user.id, 'new_gallery',
    `uploaded new gallery art${item.title ? `: "${item.title}"` : '.'}`,
    `/${actor1.username}?gallery=${item.id}#gallery`);
  res.json({ item });
});

// Same idea as /api/moderator/characters/reorder — persists
// gallery_story_links.sort_order. Must be registered BEFORE the
// PUT /api/moderator/gallery/:id route below, or Express matches "reorder"
// as the :id param and this never gets hit.
app.put('/api/moderator/gallery/reorder', requireAuth, requireModerator, async (req, res) => {
  const order = req.body.order;
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order must be a non-empty array of gallery IDs.' });
  await pool.query('BEGIN');
  try {
    for (let i = 0; i < order.length; i++) {
      await pool.query(
        'UPDATE gallery_story_links SET sort_order = $1 WHERE gallery_id = $2 AND site_id = $3',
        [i, order[i], req.modSite.id]
      );
    }
    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    return res.status(500).json({ error: 'Could not save the new order.' });
  }
  res.json({ message: 'Order saved.' });
});

// Editing/deleting a gallery post is about owning it, same as characters —
// works from any context, story-linked or standalone.
app.put('/api/moderator/gallery/:id', requireAuth, uploadModImage.single('image'), async (req, res) => {
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM moderator_gallery WHERE id = $1 AND owner_user_id = $2', [req.params.id, req.user.id]
  );
  if (!existing) return res.status(404).json({ error: 'Not found.' });

  const { category, title, description } = req.body;
  if (category && !GALLERY_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Category must be sfw, mature, or explicit.' });

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
  const tags = await parseGalleryTags(req.body.tags);

  const { rows: [item] } = await pool.query(
    `UPDATE moderator_gallery SET
       category    = COALESCE($1, category),
       title       = COALESCE($2, title),
       description = COALESCE($3, description),
       image_url   = $4,
       position_x  = $5,
       position_y  = $6,
       tags        = COALESCE($7, tags)
     WHERE id = $8 RETURNING *`,
    [category || null, title != null ? title.trim() : null, description != null ? description.trim() : null, imageUrl, positionX, positionY, tags !== undefined ? JSON.stringify(tags) : null, existing.id]
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
// Public, unscoped gallery-post lookup — backs the standalone edit page.
app.get('/api/gallery/:id', async (req, res) => {
  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }
  const { rows: [item] } = await pool.query(
    `SELECT mg.*, u.username AS owner_username, u.display_name AS owner_display_name, u.avatar AS owner_avatar,
            (SELECT COUNT(*)::int FROM moderator_gallery_likes WHERE gallery_id = mg.id) AS like_count,
            (SELECT COUNT(*)::int FROM content_comments WHERE target_type = 'gallery' AND target_id = mg.id) AS comment_count,
            EXISTS(SELECT 1 FROM moderator_gallery_likes WHERE gallery_id = mg.id AND user_id = $2) AS liked,
            EXISTS(SELECT 1 FROM moderator_gallery_bookmarks WHERE gallery_id = mg.id AND user_id = $2) AS bookmarked
     FROM moderator_gallery mg
     JOIN users u ON u.id = mg.owner_user_id
     WHERE mg.id = $1`,
    [req.params.id, viewerId || 0]
  );
  if (!item) return res.status(404).json({ error: 'Not found.' });
  res.json({ item });
});

// Same naive per-load counter as the story-view bump -- fired once per
// detail-view open, owner's own views excluded so an author checking
// their own post doesn't inflate it.
app.post('/api/gallery/:id/view', async (req, res) => {
  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }
  const { rows: [item] } = await pool.query('SELECT id, owner_user_id FROM moderator_gallery WHERE id = $1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Not found.' });
  if (viewerId !== item.owner_user_id) {
    await pool.query('UPDATE moderator_gallery SET view_count = view_count + 1 WHERE id = $1', [item.id]);
  }
  res.json({ ok: true });
});

// Every story and character a gallery post is linked to — pre-fills the
// "Link To:" section when editing an existing post.
app.get('/api/gallery/:id/links', async (req, res) => {
  const { viewerId, nsfwAllowed } = await getViewerNsfwAccess(req);
  // Same rule as a character's Linked Stories -- a drafted, never-published
  // story only shows up here for its own owner, not every visitor.
  const [{ rows: stories }, { rows: characters }] = await Promise.all([
    pool.query(
      `SELECT ms.id AS site_id, ms.slug, ms.story_path, ms.site_title, ms.cover_url, ms.synopsis, u.avatar AS author_avatar
       FROM gallery_story_links gsl
       JOIN moderator_sites ms ON ms.id = gsl.site_id
       JOIN users u ON u.id = ms.owner_user_id
       WHERE gsl.gallery_id = $1
         AND (
           ms.owner_user_id = $2
           OR EXISTS (
             SELECT 1 FROM moderator_chapters mc
             WHERE mc.site_id = ms.id AND mc.status = 'published' AND length(trim(mc.body)) > 0
           )
         )
       ORDER BY gsl.sort_order, ms.id`,
      [req.params.id, viewerId || 0]
    ),
    pool.query(
      `SELECT mc.id, mc.name, mc.ref_image, mc.ref_is_nsfw, mc.stats,
              u.username AS owner_username, u.display_name AS owner_display_name
       FROM gallery_character_links gcl
       JOIN moderator_characters mc ON mc.id = gcl.character_id
       JOIN users u ON u.id = mc.owner_user_id
       WHERE gcl.gallery_id = $1 ORDER BY mc.id`,
      [req.params.id]
    ),
  ]);
  res.json({
    stories: stories.map(r => ({ id: r.site_id, story_path: r.story_path || r.slug, site_title: r.site_title, cover_url: r.cover_url, synopsis: r.synopsis || '', author_avatar: r.author_avatar })),
    // Same blur-not-hide treatment as Character Spotlight — an NSFW ref
    // stays listed for everyone, but a viewer who can't see NSFW never
    // gets the real image bytes.
    characters: characters.map(c => {
      const locked = c.ref_is_nsfw && !nsfwAllowed;
      return {
        id: c.id, name: c.name, image: locked ? null : c.ref_image, nsfw_locked: !!locked,
        species: (c.stats && c.stats['Species']) || '',
        owner_username: c.owner_username, owner_display_name: c.owner_display_name || c.owner_username,
      };
    }),
  });
});

// Unlink a story/character from a gallery post — the post owner's own call.
app.delete('/api/gallery/:id/link/:siteId', requireAuth, async (req, res) => {
  const { rows: [item] } = await pool.query(
    'SELECT id FROM moderator_gallery WHERE id = $1 AND owner_user_id = $2', [req.params.id, req.user.id]
  );
  if (!item) return res.status(404).json({ error: 'Not found.' });
  await pool.query(
    'DELETE FROM gallery_story_links WHERE gallery_id = $1 AND site_id = $2', [item.id, req.params.siteId]
  );
  res.json({ message: 'Unlinked.' });
});
app.delete('/api/gallery/:id/link-character/:characterId', requireAuth, async (req, res) => {
  const { rows: [item] } = await pool.query(
    'SELECT id FROM moderator_gallery WHERE id = $1 AND owner_user_id = $2', [req.params.id, req.user.id]
  );
  if (!item) return res.status(404).json({ error: 'Not found.' });
  await pool.query(
    'DELETE FROM gallery_character_links WHERE gallery_id = $1 AND character_id = $2', [item.id, req.params.characterId]
  );
  res.json({ message: 'Unlinked.' });
});

app.post('/api/gallery', requireAuth, uploadModImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const { category, title, description } = req.body;
  if (!GALLERY_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Category must be sfw, mature, or explicit.' });
  const imageUrl = `/images/moderators/${req.file.filename}`;
  const positionX = clampPosition(req.body.position_x);
  const positionY = clampPosition(req.body.position_y);
  const tags = (await parseGalleryTags(req.body.tags)) || [];
  const { rows: [item] } = await pool.query(
    `INSERT INTO moderator_gallery (owner_user_id, category, image_url, title, description, position_x, position_y, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [req.user.id, category, imageUrl, (title || '').trim(), (description || '').trim(), positionX, positionY, JSON.stringify(tags)]
  );
  const { rows: [actor2] } = await pool.query('SELECT username FROM users WHERE id = $1', [req.user.id]);
  await notifyFollowers(req.user.id, 'new_gallery',
    `uploaded new gallery art${item.title ? `: "${item.title}"` : '.'}`,
    `/${actor2.username}?gallery=${item.id}#gallery`);
  res.json({ item });
});

// Additive-only linking — used right after creating (or editing) a gallery
// post to attach it to any number of extra stories and/or characters picked
// in the "Link To:" section. Never removes an existing link (e.g. the
// default story link made at creation time), only adds new ones.
app.post('/api/gallery/:id/link-many', requireAuth, async (req, res) => {
  const { rows: [item] } = await pool.query(
    'SELECT id FROM moderator_gallery WHERE id = $1 AND owner_user_id = $2', [req.params.id, req.user.id]
  );
  if (!item) return res.status(404).json({ error: 'Not found.' });

  const siteIds = Array.isArray(req.body.site_ids) ? req.body.site_ids.filter(Number.isFinite) : [];
  const characterIds = Array.isArray(req.body.character_ids) ? req.body.character_ids.filter(Number.isFinite) : [];

  await Promise.all([
    ...siteIds.map(siteId => pool.query(
      'INSERT INTO gallery_story_links (gallery_id, site_id) VALUES ($1, $2) ON CONFLICT (gallery_id, site_id) DO NOTHING',
      [item.id, siteId]
    )),
    ...characterIds.map(characterId => pool.query(
      'INSERT INTO gallery_character_links (gallery_id, character_id) VALUES ($1, $2) ON CONFLICT (gallery_id, character_id) DO NOTHING',
      [item.id, characterId]
    )),
  ]);
  res.json({ message: 'Linked.' });
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
  // Anyone who featured this gallery piece would otherwise be stuck showing
  // a dead entry with no live row to fall back to (see the character delete
  // handler above — same fix, same reason).
  await pool.query(`DELETE FROM user_featured_items WHERE kind = 'gallery' AND ref_id = $1`, [String(item.id)]);
  res.json({ message: 'Deleted.' });
});

// ── Gallery likes — any logged-in user can like any story's gallery post ────
app.post('/api/moderator/gallery/:id/like', async (req, res) => {
  const { rows: [item] } = await pool.query('SELECT id FROM moderator_gallery WHERE id = $1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Not found.' });
  const viewerId = optionalViewerId(req);
  await pool.query(
    'INSERT INTO moderator_gallery_likes (user_id, guest_device_id, gallery_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [viewerId, viewerId ? null : req.guestId, item.id]
  );
  const { rows: [{ count }] } = await pool.query('SELECT count(*) FROM moderator_gallery_likes WHERE gallery_id = $1', [item.id]);
  const info = await commentTargetInfo('gallery', item.id);
  if (info && info.ownerId) {
    await notifyUser(info.ownerId, viewerId, 'gallery_like', `liked your gallery post "${info.title}".`, info.link);
  }
  res.json({ liked: true, like_count: Number(count) });
});

app.delete('/api/moderator/gallery/:id/like', async (req, res) => {
  const viewerId = optionalViewerId(req);
  await pool.query(
    viewerId
      ? 'DELETE FROM moderator_gallery_likes WHERE user_id = $1 AND gallery_id = $2'
      : 'DELETE FROM moderator_gallery_likes WHERE guest_device_id = $1 AND gallery_id = $2',
    [viewerId || req.guestId, req.params.id]
  );
  const { rows: [{ count }] } = await pool.query('SELECT count(*) FROM moderator_gallery_likes WHERE gallery_id = $1', [req.params.id]);
  res.json({ liked: false, like_count: Number(count) });
});

app.post('/api/moderator/gallery/:id/bookmark', requireAuth, async (req, res) => {
  const { rows: [item] } = await pool.query('SELECT id FROM moderator_gallery WHERE id = $1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Not found.' });
  await pool.query(
    'INSERT INTO moderator_gallery_bookmarks (user_id, gallery_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.user.id, item.id]
  );
  const info = await commentTargetInfo('gallery', item.id);
  if (info && info.ownerId) {
    await notifyUser(info.ownerId, req.user.id, 'gallery_bookmark', `bookmarked your gallery post "${info.title}".`, info.link);
  }
  res.json({ bookmarked: true });
});

app.delete('/api/moderator/gallery/:id/bookmark', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM moderator_gallery_bookmarks WHERE user_id = $1 AND gallery_id = $2', [req.user.id, req.params.id]);
  res.json({ bookmarked: false });
});

app.post('/api/moderator/character/:id/like', async (req, res) => {
  const { rows: [item] } = await pool.query('SELECT id FROM moderator_characters WHERE id = $1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Not found.' });
  const viewerId = optionalViewerId(req);
  await pool.query(
    'INSERT INTO moderator_character_likes (user_id, guest_device_id, character_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [viewerId, viewerId ? null : req.guestId, item.id]
  );
  const { rows: [{ count }] } = await pool.query('SELECT count(*) FROM moderator_character_likes WHERE character_id = $1', [item.id]);
  const info = await commentTargetInfo('character', item.id);
  if (info && info.ownerId) {
    await notifyUser(info.ownerId, viewerId, 'character_like', `liked your character "${info.title}".`, info.link);
  }
  res.json({ liked: true, like_count: Number(count) });
});

app.delete('/api/moderator/character/:id/like', async (req, res) => {
  const viewerId = optionalViewerId(req);
  await pool.query(
    viewerId
      ? 'DELETE FROM moderator_character_likes WHERE user_id = $1 AND character_id = $2'
      : 'DELETE FROM moderator_character_likes WHERE guest_device_id = $1 AND character_id = $2',
    [viewerId || req.guestId, req.params.id]
  );
  const { rows: [{ count }] } = await pool.query('SELECT count(*) FROM moderator_character_likes WHERE character_id = $1', [req.params.id]);
  res.json({ liked: false, like_count: Number(count) });
});

app.post('/api/moderator/character/:id/bookmark', requireAuth, async (req, res) => {
  const { rows: [item] } = await pool.query('SELECT id FROM moderator_characters WHERE id = $1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Not found.' });
  await pool.query(
    'INSERT INTO moderator_character_bookmarks (user_id, character_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.user.id, item.id]
  );
  const info = await commentTargetInfo('character', item.id);
  if (info && info.ownerId) {
    await notifyUser(info.ownerId, req.user.id, 'character_bookmark', `bookmarked your character "${info.title}".`, info.link);
  }
  res.json({ bookmarked: true });
});

app.delete('/api/moderator/character/:id/bookmark', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM moderator_character_bookmarks WHERE user_id = $1 AND character_id = $2', [req.user.id, req.params.id]);
  res.json({ bookmarked: false });
});

// Same naive per-load counter as the story/gallery view bumps -- owner's
// own views excluded.
app.post('/api/character/:id/view', async (req, res) => {
  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }
  const { rows: [item] } = await pool.query('SELECT id, owner_user_id FROM moderator_characters WHERE id = $1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Not found.' });
  if (viewerId !== item.owner_user_id) {
    await pool.query('UPDATE moderator_characters SET view_count = view_count + 1 WHERE id = $1', [item.id]);
  }
  res.json({ ok: true });
});

// ── Chapter likes — any logged-in user can like any story's chapter, from
// the Reader view ──────────────────────────────────────────────────────────
app.post('/api/chapters/:id/like', async (req, res) => {
  const { rows: [ch] } = await pool.query('SELECT id FROM moderator_chapters WHERE id = $1', [req.params.id]);
  if (!ch) return res.status(404).json({ error: 'Not found.' });
  const viewerId = optionalViewerId(req);
  await pool.query(
    'INSERT INTO chapter_likes (user_id, guest_device_id, chapter_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [viewerId, viewerId ? null : req.guestId, ch.id]
  );
  const { rows: [{ count }] } = await pool.query('SELECT count(*) FROM chapter_likes WHERE chapter_id = $1', [ch.id]);
  const info = await commentTargetInfo('chapter_paragraph', ch.id);
  if (info && info.ownerId) {
    await notifyUser(info.ownerId, viewerId, 'chapter_like', `liked your chapter "${info.title}".`, info.link);
  }
  res.json({ liked: true, like_count: Number(count) });
});

app.delete('/api/chapters/:id/like', async (req, res) => {
  const viewerId = optionalViewerId(req);
  await pool.query(
    viewerId
      ? 'DELETE FROM chapter_likes WHERE user_id = $1 AND chapter_id = $2'
      : 'DELETE FROM chapter_likes WHERE guest_device_id = $1 AND chapter_id = $2',
    [viewerId || req.guestId, req.params.id]
  );
  const { rows: [{ count }] } = await pool.query('SELECT count(*) FROM chapter_likes WHERE chapter_id = $1', [req.params.id]);
  res.json({ liked: false, like_count: Number(count) });
});

// ── Notifications — generic fan-out helpers used by every real event below
// (follow, like, bookmark, top-level comment, new chapter/character/gallery/
// newspaper post, club join/post). Never notifies someone about their own
// action. ────────────────────────────────────────────────────────────────
async function notifyUser(userId, actorId, type, message, link) {
  if (!userId || userId === actorId) return;
  await pool.query(
    `INSERT INTO notifications (user_id, actor_user_id, type, message, link) VALUES ($1, $2, $3, $4, $5)`,
    [userId, actorId, type, message, link]
  ).catch(e => console.error('notification insert:', e.message));
}

// "Someone you follow did X" — fans a single event out to every follower.
async function notifyFollowers(actorId, type, message, link) {
  const { rows } = await pool.query('SELECT follower_id FROM user_follows WHERE followed_id = $1', [actorId]);
  await Promise.all(rows.map(r => notifyUser(r.follower_id, actorId, type, message, link)));
}

// ── Universal comments — target_type/target_id, reusable for gallery posts
// now and Newspaper/Social posts later. Replies are exactly one level deep:
// a reply's parent_id always points at a ROOT comment, enforced here by
// flattening (replying to a reply re-parents onto that reply's root). ──────

// Resolves a {title, link, ownerId} triple per target type, for notification
// text and direct-owner notifications — add a case here whenever a new
// target_type gets comments wired up. ownerId is null where the content has
// no single user owner (e.g. admin-curated club gallery pages).
async function commentTargetInfo(targetType, targetId) {
  if (targetType === 'gallery') {
    const { rows: [g] } = await pool.query(
      `SELECT mg.title, mg.owner_user_id, u.username AS owner_username
       FROM moderator_gallery mg JOIN users u ON u.id = mg.owner_user_id
       WHERE mg.id = $1`,
      [targetId]
    );
    if (!g) return null;
    return { title: g.title || 'Untitled', link: `/${g.owner_username}?gallery=${targetId}#gallery`, ownerId: g.owner_user_id };
  }
  if (targetType === 'character') {
    const { rows: [c] } = await pool.query(
      `SELECT mc.name, mc.owner_user_id, u.username AS owner_username
       FROM moderator_characters mc JOIN users u ON u.id = mc.owner_user_id
       WHERE mc.id = $1`,
      [targetId]
    );
    if (!c) return null;
    return { title: c.name || 'Unnamed', link: `/${c.owner_username}?char=${targetId}#characters`, ownerId: c.owner_user_id };
  }
  if (targetType === 'chapter_paragraph') {
    const { rows: [c] } = await pool.query(
      `SELECT mc.title, ms.story_path, ms.owner_user_id
       FROM moderator_chapters mc JOIN moderator_sites ms ON ms.id = mc.site_id
       WHERE mc.id = $1`,
      [targetId]
    );
    if (!c) return null;
    return { title: c.title || 'Untitled Chapter', link: `/${c.story_path}/reader?ch=${targetId}`, ownerId: c.owner_user_id };
  }
  if (targetType === 'club_post') {
    const { rows: [p] } = await pool.query(
      `SELECT cp.title, cp.author_user_id, c.slug
       FROM club_posts cp JOIN clubs c ON c.id = cp.club_id
       WHERE cp.id = $1`,
      [targetId]
    );
    if (!p) return null;
    return { title: p.title || 'Untitled', link: `/club?slug=${encodeURIComponent(p.slug)}&post=${targetId}`, ownerId: p.author_user_id };
  }
  if (targetType === 'club_gallery_image') {
    const { rows: [g] } = await pool.query(
      `SELECT g.title, p.slug AS page_slug, c.slug AS club_slug
       FROM club_page_gallery_images g
       JOIN club_pages p ON p.id = g.page_id JOIN clubs c ON c.id = p.club_id
       WHERE g.id = $1`,
      [targetId]
    );
    if (!g) return null;
    // Not independently deep-linkable (the detail view is an in-page swap,
    // not a routed URL) — link back to the gallery page itself instead.
    return { title: g.title || 'Untitled', link: `/club?slug=${encodeURIComponent(g.club_slug)}&page=${encodeURIComponent(g.page_slug)}`, ownerId: null };
  }
  return null;
}

app.get('/api/content-comments', async (req, res) => {
  const targetType = String(req.query.target_type || '');
  const targetId = parseInt(req.query.target_id, 10);
  if (!targetType || !targetId) return res.json({ comments: [] });
  // Reader paragraph comments pass paragraph_index to scope to one paragraph's
  // thread; every other comment type leaves it off and gets everything for
  // the target (paragraph_index is NULL for those rows anyway).
  const hasParagraph = req.query.paragraph_index !== undefined && req.query.paragraph_index !== '';
  const paragraphIndex = hasParagraph ? parseInt(req.query.paragraph_index, 10) : null;
  const { rows } = await pool.query(
    `SELECT cc.id, cc.parent_id, cc.reply_to_username, cc.body, cc.gif_url, cc.paragraph_index, cc.created_at,
            cc.user_id, cc.guest_name, u.username, u.display_name, u.avatar
     FROM content_comments cc LEFT JOIN users u ON u.id = cc.user_id
     WHERE cc.target_type = $1 AND cc.target_id = $2 ${hasParagraph ? 'AND cc.paragraph_index = $3' : ''}
     ORDER BY cc.created_at ASC`,
    hasParagraph ? [targetType, targetId, paragraphIndex] : [targetType, targetId]
  );
  const byId = {};
  const roots = [];
  rows.forEach(r => {
    // Guest-authored rows have no user_id — display_name/avatar fall back to
    // the guest's typed name and the shared default avatar (handled
    // client-side by is_guest, same as ccAvatarHtml already falls back for
    // any missing avatar).
    const c = {
      id: r.id, body: r.body, gif_url: r.gif_url, paragraph_index: r.paragraph_index,
      created_at: r.created_at, reply_to_username: r.reply_to_username,
      user_id: r.user_id, username: r.username,
      display_name: r.user_id ? r.display_name : r.guest_name,
      avatar: r.user_id ? r.avatar : null,
      is_guest: !r.user_id,
      replies: [],
    };
    byId[c.id] = c;
    if (r.parent_id && byId[r.parent_id]) byId[r.parent_id].replies.push(c);
    else if (!r.parent_id) roots.push(c);
  });
  res.json({ comments: roots, count: rows.length });
});

// Comment counts per paragraph for a whole chapter, so the Reader can show
// permanent "N comments" badges without fetching every paragraph's full
// thread up front.
app.get('/api/content-comments/paragraph-counts', async (req, res) => {
  const targetType = String(req.query.target_type || '');
  const targetId = parseInt(req.query.target_id, 10);
  if (!targetType || !targetId) return res.json({ counts: {} });
  const { rows } = await pool.query(
    `SELECT paragraph_index, COUNT(*)::int AS count FROM content_comments
     WHERE target_type = $1 AND target_id = $2 AND paragraph_index IS NOT NULL
     GROUP BY paragraph_index`,
    [targetType, targetId]
  );
  const counts = {};
  rows.forEach(r => { counts[r.paragraph_index] = r.count; });
  res.json({ counts });
});

// No requireAuth here — guests can comment too (everywhere except clubs,
// checked below), identified by the guest_id cookie set on every request.
// A logged-in Bearer token still takes priority when present.
app.post('/api/content-comments', async (req, res) => {
  const targetType = String(req.body.target_type || '');
  const targetId = parseInt(req.body.target_id, 10);
  const text = String(req.body.body || '').trim();
  const gifUrl = req.body.gif_url ? String(req.body.gif_url).slice(0, 500) : null;
  const paragraphIndex = req.body.paragraph_index !== undefined && req.body.paragraph_index !== null && req.body.paragraph_index !== ''
    ? parseInt(req.body.paragraph_index, 10) : null;
  const parentId = req.body.parent_id ? parseInt(req.body.parent_id, 10) : null;
  if (!targetType || !targetId) return res.status(400).json({ error: 'target_type and target_id are required.' });
  if (!text && !gifUrl) return res.status(400).json({ error: 'Comment cannot be empty.' });
  if (text.length > 2000) return res.status(400).json({ error: 'Comment is too long (max 2000 characters).' });

  const viewerId = optionalViewerId(req);
  let guestName = null;
  if (!viewerId) {
    // Clubs are explicitly held back from guest interaction for now.
    if (targetType === 'club_post' || targetType === 'club_gallery_image') {
      return res.status(401).json({ error: 'You need an account to comment in clubs.' });
    }
    guestName = String(req.body.guest_name || '').trim().slice(0, 40);
    if (!guestName) return res.status(400).json({ error: 'Please enter a name.' });
  }

  let rootParentId = null;
  let replyToUsername = null;
  let directParentUserId = null;
  if (parentId) {
    const { rows: [parent] } = await pool.query(
      'SELECT id, parent_id, user_id, guest_name FROM content_comments WHERE id = $1 AND target_type = $2 AND target_id = $3',
      [parentId, targetType, targetId]
    );
    if (!parent) return res.status(404).json({ error: 'Comment not found.' });
    // Flatten to exactly one level — replying to a reply attaches to that reply's root.
    rootParentId = parent.parent_id || parent.id;
    directParentUserId = parent.user_id; // null when replying to a guest — notifyUser no-ops on that
    if (parent.user_id) {
      const { rows: [replyTarget] } = await pool.query('SELECT username FROM users WHERE id = $1', [parent.user_id]);
      replyToUsername = replyTarget ? replyTarget.username : null;
    } else {
      replyToUsername = parent.guest_name;
    }
  }

  let author = null;
  if (viewerId) {
    const { rows: [a] } = await pool.query('SELECT username, display_name, avatar FROM users WHERE id = $1', [viewerId]);
    author = a;
  }
  const { rows: [comment] } = await pool.query(
    `INSERT INTO content_comments (target_type, target_id, user_id, guest_name, guest_device_id, parent_id, reply_to_username, body, gif_url, paragraph_index)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, created_at`,
    [targetType, targetId, viewerId, viewerId ? null : guestName, viewerId ? null : req.guestId, rootParentId, replyToUsername, text, gifUrl, paragraphIndex]
  );

  // Notify: the comment you directly replied to gets "replied to your
  // comment"; everyone else who's posted anywhere in this thread gets a
  // lighter "thread you're in got a new reply" notice. Never notify
  // yourself, and guest participants (user_id null) have no account to
  // notify at all.
  if (rootParentId) {
    const { rows: participants } = await pool.query(
      'SELECT DISTINCT user_id FROM content_comments WHERE id = $1 OR parent_id = $1',
      [rootParentId]
    );
    const info = await commentTargetInfo(targetType, targetId);
    await Promise.all(
      participants
        .map(r => r.user_id)
        .filter(uid => uid && uid !== viewerId)
        .map(uid => {
          const isDirect = uid === directParentUserId;
          const message = isDirect
            ? `replied to your comment${info ? ` on "${info.title}"` : ''}.`
            : `added a new reply in a thread you're part of${info ? ` on "${info.title}"` : ''}.`;
          return notifyUser(uid, viewerId, isDirect ? 'comment_reply' : 'comment_thread_update', message, info ? info.link : null);
        })
    );
  } else {
    // Fresh top-level comment (not a reply) — notify whoever owns the
    // content itself, since the thread-participant fan-out above only
    // covers replies.
    const info = await commentTargetInfo(targetType, targetId);
    if (info && info.ownerId) {
      await notifyUser(info.ownerId, viewerId, 'content_comment', `commented on "${info.title}".`, info.link);
    }
  }

  res.json({
    comment: {
      id: comment.id, body: text, gif_url: gifUrl, paragraph_index: paragraphIndex,
      created_at: comment.created_at, reply_to_username: replyToUsername,
      user_id: viewerId,
      username: viewerId ? author.username : null,
      display_name: viewerId ? author.display_name : guestName,
      avatar: viewerId ? author.avatar : null,
      is_guest: !viewerId,
      parent_id: rootParentId, replies: [],
    },
  });
});

app.delete('/api/content-comments/:id', requireAuth, async (req, res) => {
  const { rows: [comment] } = await pool.query('SELECT * FROM content_comments WHERE id = $1', [req.params.id]);
  if (!comment) return res.status(404).json({ error: 'Not found.' });
  if (comment.user_id !== req.user.id && !await checkAdmin(req)) return res.status(403).json({ error: 'Not your comment.' });
  await pool.query('DELETE FROM content_comments WHERE id = $1', [req.params.id]);
  res.json({ message: 'Deleted.' });
});

// GET /api/library — bookmarked stories + liked gallery art, across every
// story, for the avatar dropdown's "Library" page.
app.get('/api/library', requireAuth, async (req, res) => {
  const [{ rows: stories }, { rows: gallery }, { rows: bookmarkedGallery }, { rows: bookmarkedCharacters }] = await Promise.all([
    pool.query(`
      SELECT ms.slug, ms.story_path, ms.site_title, ms.cover_url, u.username, u.display_name, u.avatar
      FROM moderator_bookmarks mb
      JOIN moderator_sites ms ON ms.id = mb.site_id
      JOIN users u ON u.id = ms.owner_user_id
      WHERE mb.user_id = $1
      ORDER BY mb.created_at DESC
    `, [req.user.id]),
    pool.query(`
      SELECT mg.id, mg.image_url, mg.title, mg.category, ms.slug, ms.story_path, ms.site_title,
        u.username AS owner_username, u.display_name AS owner_display_name
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
    pool.query(`
      SELECT mg.id, mg.image_url, mg.title, mg.category, ms.slug, ms.story_path, ms.site_title,
        u.username AS owner_username, u.display_name AS owner_display_name
      FROM moderator_gallery_bookmarks mgb
      JOIN moderator_gallery mg ON mg.id = mgb.gallery_id
      LEFT JOIN LATERAL (
        SELECT site_id FROM gallery_story_links WHERE gallery_id = mg.id ORDER BY site_id LIMIT 1
      ) gsl ON true
      LEFT JOIN moderator_sites ms ON ms.id = gsl.site_id
      JOIN users u ON u.id = mg.owner_user_id
      WHERE mgb.user_id = $1
      ORDER BY mgb.created_at DESC
    `, [req.user.id]),
    pool.query(`
      SELECT mc.id, mc.name, mc.ref_image, mc.ref_position_x, mc.ref_position_y,
        trim(mc.stats->>'Species') AS species,
        u.username AS owner_username, u.display_name AS owner_display_name
      FROM moderator_character_bookmarks mcb
      JOIN moderator_characters mc ON mc.id = mcb.character_id
      JOIN users u ON u.id = mc.owner_user_id
      WHERE mcb.user_id = $1
      ORDER BY mcb.created_at DESC
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
      owner_username: r.owner_username, owner_display_name: r.owner_display_name || r.owner_username,
    })),
    bookmarked_gallery: bookmarkedGallery.map(r => ({
      id: r.id, image_url: r.image_url, title: r.title, category: r.category,
      story_path: r.story_path || r.slug || null, site_title: r.site_title || null,
      owner_username: r.owner_username, owner_display_name: r.owner_display_name || r.owner_username,
    })),
    characters: bookmarkedCharacters.map(r => ({
      id: r.id, name: r.name, image: r.ref_image || null,
      position_x: r.ref_position_x, position_y: r.ref_position_y, species: r.species || '',
      owner_username: r.owner_username, owner: r.owner_display_name || r.owner_username,
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
  const limit = Math.min(parseInt(req.query.limit, 10) || 12, 100);
  const { nsfwAllowed } = await getViewerNsfwAccess(req);
  const { rows } = await pool.query(
    `SELECT mc.id, mc.name, mc.ref_image, mc.ref_position_x, mc.ref_position_y, mc.ref_is_nsfw,
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
    // NSFW character refs stay IN the rotation for everyone — but a viewer
    // who can't see NSFW never gets the real image bytes, only a locked
    // flag; the frontend swaps in a blurred default silhouette instead.
    characters: rows.map(r => {
      const locked = r.ref_is_nsfw && !nsfwAllowed;
      return {
        id: r.id, name: r.name, image: locked ? null : r.ref_image, nsfw_locked: !!locked,
        position_x: r.ref_position_x, position_y: r.ref_position_y,
        story_path: r.story_path || r.slug || null, site_title: r.site_title || null,
        owner_username: r.owner_username, owner_display_name: r.owner_display_name || r.owner_username,
      };
    }),
  });
});

app.get('/api/spotlight/gallery', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 12, 100);
  const { nsfwAllowed } = await getViewerNsfwAccess(req);
  // Mature/Explicit are IN the rotation now — but only ever queried for
  // viewers allowed to see them; excluded entirely (not blurred) for
  // everyone else.
  const categories = nsfwAllowed ? GALLERY_CATEGORIES : ['sfw'];
  const { rows } = await pool.query(
    `SELECT mg.id, mg.image_url, mg.title, mg.position_x, mg.position_y,
            ms.story_path, ms.slug, ms.site_title, u.username AS owner_username, u.display_name AS owner_display_name
     FROM moderator_gallery mg
     LEFT JOIN LATERAL (
       SELECT site_id FROM gallery_story_links WHERE gallery_id = mg.id ORDER BY site_id LIMIT 1
     ) gsl ON true
     LEFT JOIN moderator_sites ms ON ms.id = gsl.site_id
     JOIN users u ON u.id = mg.owner_user_id
     WHERE mg.category = ANY($2::text[])
     ORDER BY RANDOM() LIMIT $1`,
    [limit, categories]
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
  const limit = Math.min(parseInt(req.query.limit, 10) || 12, 100);
  // Same "actually discoverable" rule as the public browse/search endpoint —
  // a story only counts once it has at least one published chapter with
  // real text, so a story that's still all-drafts never gets spotlighted.
  const { rows } = await pool.query(
    `SELECT ms.slug, ms.story_path, ms.site_title, ms.cover_url, u.username, u.display_name, u.avatar
     FROM moderator_sites ms
     JOIN users u ON u.id = ms.owner_user_id
     WHERE EXISTS (
       SELECT 1 FROM moderator_chapters mc
       WHERE mc.site_id = ms.id AND mc.status = 'published' AND length(trim(mc.body)) > 0
     )
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

app.get('/api/spotlight/clubs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 12, 100);
  // nsfwAllowed defaults to true for guests too (age-gated at the door, not
  // here) -- only an account with SFW Mode on gets NSFW clubs filtered out,
  // same rule the gallery/character spotlights use.
  const { nsfwAllowed } = await getViewerNsfwAccess(req);
  // Any club is eligible -- no custom icon and no posts yet is fine, the
  // frontend falls back to a lettered avatar the same way social.html does.
  const { rows } = await pool.query(
    `SELECT c.slug, c.name, c.icon_url,
            (SELECT COUNT(*)::int FROM club_members cm WHERE cm.club_id = c.id) AS member_count
     FROM clubs c
     WHERE (c.is_nsfw = FALSE OR $2::boolean)
     ORDER BY RANDOM() LIMIT $1`,
    [limit, nsfwAllowed]
  );
  res.json({
    clubs: rows.map(r => ({
      slug: r.slug, name: r.name, icon_url: r.icon_url || null, member_count: r.member_count,
    })),
  });
});

// ── Recent Submissions feed — newest stories/chapters/art/characters across
// every fanpage, newest first. Gallery is filtered to SFW only for viewers
// without NSFW access. ──────────────────────────────────────────────────
app.get('/api/activity-feed', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 24, 40);
  const { nsfwAllowed } = await getViewerNsfwAccess(req);
  // Over-fetch before filtering — Mature/Explicit/NSFW rows get dropped
  // (art) or image-blanked (character) in JS below, so asking the DB for
  // exactly `limit` rows first could leave the feed short after filtering.
  const { rows } = await pool.query(
    `SELECT * FROM (
       -- Story creation itself isn't shown — a story with nothing published
       -- yet isn't news to anyone. Only a chapter actually going live is,
       -- and it's ordered/timestamped by updated_at (when it was published),
       -- not created_at, so an old draft that gets published today shows up
       -- as new today rather than back-dated to whenever the draft started.
       SELECT 'chapter' AS type, mc.id AS item_id, mc.updated_at AS created_at,
              mc.title, ms.cover_url AS image,
              ms.cover_position_x AS position_x, ms.cover_position_y AS position_y,
              ms.story_path, ms.site_title AS site_title,
              u.username, u.display_name, u.avatar,
              NULL::text AS category, false AS ref_is_nsfw
       FROM moderator_chapters mc
       JOIN moderator_sites ms ON ms.id = mc.site_id
       JOIN users u ON u.id = ms.owner_user_id
       WHERE mc.status = 'published' AND length(trim(mc.body)) > 0

       UNION ALL

       SELECT 'art', mg.id, mg.created_at,
              mg.title, mg.image_url,
              mg.position_x, mg.position_y,
              ms.story_path, ms.site_title,
              u.username, u.display_name, u.avatar,
              mg.category, false
       FROM moderator_gallery mg
       LEFT JOIN LATERAL (
         SELECT site_id FROM gallery_story_links WHERE gallery_id = mg.id ORDER BY site_id LIMIT 1
       ) gsl ON true
       LEFT JOIN moderator_sites ms ON ms.id = gsl.site_id
       JOIN users u ON u.id = mg.owner_user_id

       UNION ALL

       SELECT 'character', mch.id, mch.created_at,
              mch.name, mch.ref_image,
              mch.ref_position_x, mch.ref_position_y,
              ms.story_path, ms.site_title,
              u.username, u.display_name, u.avatar,
              NULL::text, mch.ref_is_nsfw
       FROM moderator_characters mch
       LEFT JOIN LATERAL (
         SELECT site_id FROM character_story_links WHERE character_id = mch.id ORDER BY site_id LIMIT 1
       ) csl ON true
       LEFT JOIN moderator_sites ms ON ms.id = csl.site_id
       JOIN users u ON u.id = mch.owner_user_id
     ) feed
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit * 2]
  );
  const items = rows
    // Mature/Explicit gallery posts are excluded entirely for viewers who
    // can't see NSFW — never sent to the client at all, unlike NSFW
    // character refs.
    .filter(r => !(r.type === 'art' && r.category !== 'sfw' && !nsfwAllowed))
    .slice(0, limit)
    .map(r => {
      const charLocked = r.type === 'character' && r.ref_is_nsfw && !nsfwAllowed;
      return {
        type: r.type,
        id: r.item_id,
        created_at: r.created_at,
        title: r.title,
        image: charLocked ? null : (r.image || null),
        nsfw_locked: !!charLocked,
        position_x: r.position_x, position_y: r.position_y,
        story_path: r.story_path,
        site_title: r.site_title,
        author: r.display_name || r.username,
        author_username: r.username,
        author_avatar: r.avatar || null,
      };
    });
  res.json({ items });
});

// Full paginated/searchable version of the union query above, for the
// Submissions tab's full-page feed -- /api/activity-feed stays a small
// fixed-size (40 max, no offset) teaser for the hub's homepage box, this
// is the real listing. Deliberately excludes 'character' -- Submissions is
// gallery posts + chapter postings only, not the character-ref feed.
const SUBMISSIONS_RATING_OPTIONS = ['sfw', 'mature', 'explicit'];
// Values here are fixed literal SQL fragments, never user input directly --
// req.query.sort only ever indexes into this object (falling back to
// 'best_match' on anything unrecognized), so interpolating the looked-up
// string below can't become an injection vector.
const SUBMISSIONS_SORT_ORDER_BY = {
  best_match: 'created_at DESC',
  updated:    'created_at DESC',
  likes:      'like_count DESC, created_at DESC',
  views:      'view_count DESC, created_at DESC',
  popular:    '(view_count + like_count * 3) DESC, created_at DESC',
};
app.get('/api/search/submissions', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 40));
  const offset = (page - 1) * limit;
  const { nsfwAllowed } = await getViewerNsfwAccess(req);
  const sort = SUBMISSIONS_SORT_ORDER_BY[req.query.sort] ? req.query.sort : 'best_match';
  const orderBy = SUBMISSIONS_SORT_ORDER_BY[sort];
  const ratings = String(req.query.ratings || '').split(',').map(s => s.trim()).filter(s => SUBMISSIONS_RATING_OPTIONS.includes(s));
  // Empty/all-unchecked reads as "show nothing" client-side (that's what
  // unchecking every box means), not "no filter" -- an empty array here
  // would make `category = ANY($ratings)` match nothing, which is exactly
  // that. A blank ratings param (no filter UI on this request) instead
  // means "don't filter", which is what an empty JS array on the SQL side
  // would NOT do, so that case passes NULL to skip the clause entirely.
  const ratingsFilter = req.query.ratings === undefined ? null : ratings;
  const exclude = String(req.query.exclude || '').trim();

  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT 'chapter' AS type, mc.id AS item_id, mc.updated_at AS created_at,
              mc.title, ms.cover_url AS image,
              ms.cover_position_x AS position_x, ms.cover_position_y AS position_y,
              ms.story_path, ms.site_title AS site_title,
              u.username, u.display_name, u.avatar,
              ms.rating AS category, '[]'::jsonb AS tags,
              COALESCE(mc.view_count, 0) AS view_count,
              (SELECT COUNT(*)::int FROM chapter_likes WHERE chapter_id = mc.id) AS like_count
       FROM moderator_chapters mc
       JOIN moderator_sites ms ON ms.id = mc.site_id
       JOIN users u ON u.id = ms.owner_user_id
       WHERE mc.status = 'published' AND length(trim(mc.body)) > 0

       UNION ALL

       SELECT 'art', mg.id, mg.created_at,
              mg.title, mg.image_url,
              mg.position_x, mg.position_y,
              ms.story_path, ms.site_title,
              u.username, u.display_name, u.avatar,
              mg.category, mg.tags,
              COALESCE(mg.view_count, 0),
              (SELECT COUNT(*)::int FROM moderator_gallery_likes WHERE gallery_id = mg.id)
       FROM moderator_gallery mg
       LEFT JOIN LATERAL (
         SELECT site_id FROM gallery_story_links WHERE gallery_id = mg.id ORDER BY site_id LIMIT 1
       ) gsl ON true
       LEFT JOIN moderator_sites ms ON ms.id = gsl.site_id
       JOIN users u ON u.id = mg.owner_user_id
     ) feed
     WHERE (category = 'sfw' OR $1)
       AND ($5::text[] IS NULL OR category IS NULL OR category = ANY($5::text[]))
       AND ($2 = '' OR (
         title ILIKE '%' || $2 || '%' OR site_title ILIKE '%' || $2 || '%'
         OR username ILIKE '%' || $2 || '%' OR display_name ILIKE '%' || $2 || '%'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) t WHERE t ILIKE '%' || $2 || '%')
       ))
       AND ($6 = '' OR NOT (
         title ILIKE '%' || $6 || '%' OR site_title ILIKE '%' || $6 || '%'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) t WHERE t ILIKE '%' || $6 || '%')
       ))
     ORDER BY ${orderBy}
     LIMIT $3 OFFSET $4`,
    [nsfwAllowed, q, limit, offset, ratingsFilter, exclude]
  );
  // total_count via COUNT(*) OVER() would double-count across the UNION
  // ALL branches' own window once category/q filtering is applied inline
  // above rather than in the outer WHERE of a single SELECT, so total is
  // fetched as a second lightweight query instead.
  const { rows: [{ count }] } = await pool.query(
    `SELECT count(*) FROM (
       SELECT mc.id, mc.title, ms.site_title, u.username, u.display_name, ms.rating AS category, '[]'::jsonb AS tags
       FROM moderator_chapters mc
       JOIN moderator_sites ms ON ms.id = mc.site_id
       JOIN users u ON u.id = ms.owner_user_id
       WHERE mc.status = 'published' AND length(trim(mc.body)) > 0
       UNION ALL
       SELECT mg.id, mg.title, ms.site_title, u.username, u.display_name, mg.category, mg.tags
       FROM moderator_gallery mg
       LEFT JOIN LATERAL (SELECT site_id FROM gallery_story_links WHERE gallery_id = mg.id ORDER BY site_id LIMIT 1) gsl ON true
       LEFT JOIN moderator_sites ms ON ms.id = gsl.site_id
       JOIN users u ON u.id = mg.owner_user_id
     ) feed
     WHERE (category = 'sfw' OR $1)
       AND ($3::text[] IS NULL OR category IS NULL OR category = ANY($3::text[]))
       AND ($2 = '' OR (
         title ILIKE '%' || $2 || '%' OR site_title ILIKE '%' || $2 || '%'
         OR username ILIKE '%' || $2 || '%' OR display_name ILIKE '%' || $2 || '%'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) t WHERE t ILIKE '%' || $2 || '%')
       ))
       AND ($4 = '' OR NOT (
         title ILIKE '%' || $4 || '%' OR site_title ILIKE '%' || $4 || '%'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) t WHERE t ILIKE '%' || $4 || '%')
       ))`,
    [nsfwAllowed, q, ratingsFilter, exclude]
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
      tags: r.tags || [],
    })),
    total: Number(count), page, limit, sort,
  });
});

// Profiles tab (accounts + characters). "Matches every keyword" means AND,
// not OR -- each space-separated word in q must independently match
// somewhere (username/display name, or character name) for a row to
// qualify, via bool_and() over the unnested word array rather than one
// big ILIKE per word bolted together with a fixed-size query.
app.get('/api/search/profiles', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const words = q.split(/\s+/).filter(Boolean).slice(0, 12);
  const type = req.query.type === 'characters' ? 'characters' : 'accounts';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const offset = (page - 1) * limit;
  const { nsfwAllowed } = await getViewerNsfwAccess(req);

  if (type === 'characters') {
    const { rows } = await pool.query(
      `SELECT mch.id, mch.name, mch.ref_image, mch.ref_position_x, mch.ref_position_y, mch.ref_is_nsfw,
              u.username AS owner_username, u.display_name AS owner_display_name,
              (SELECT COUNT(*)::int FROM character_story_links csl WHERE csl.character_id = mch.id) AS story_count,
              COUNT(*) OVER() AS total_count
       FROM moderator_characters mch
       JOIN users u ON u.id = mch.owner_user_id
       WHERE (cardinality($1::text[]) = 0 OR (
         SELECT bool_and(mch.name ILIKE '%' || w || '%') FROM unnest($1::text[]) AS w
       ))
       ORDER BY mch.created_at DESC
       LIMIT $2 OFFSET $3`,
      [words, limit, offset]
    );
    return res.json({
      type,
      items: rows.map(r => ({
        id: r.id, name: r.name,
        image: (r.ref_is_nsfw && !nsfwAllowed) ? null : (r.ref_image || null),
        nsfw_locked: !!(r.ref_is_nsfw && !nsfwAllowed),
        position_x: r.ref_position_x, position_y: r.ref_position_y,
        owner_username: r.owner_username, owner: r.owner_display_name || r.owner_username,
        story_count: r.story_count,
      })),
      total: rows.length ? Number(rows[0].total_count) : 0, page, limit,
    });
  }

  // Same score as /api/recommended-followers -- follower count weighted
  // heaviest, story count next, a flat bonus for anyone active in the
  // last 30 days -- so "everyone" search ordering matches what gets
  // recommended on the hub instead of the two drifting apart.
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.avatar,
            raw.story_count, raw.reading_list_count, raw.follower_count, raw.following_count, raw.club_count,
            (raw.follower_count * 4 + raw.story_count * 2
             + (CASE WHEN raw.last_chapter_at >= NOW() - INTERVAL '30 days' THEN 6 ELSE 0 END)) AS score,
            COUNT(*) OVER() AS total_count
     FROM users u
     JOIN LATERAL (
       SELECT
         (SELECT COUNT(*)::int FROM moderator_sites ms WHERE ms.owner_user_id = u.id) AS story_count,
         (SELECT COUNT(*)::int FROM moderator_bookmarks mb WHERE mb.user_id = u.id) AS reading_list_count,
         (SELECT COUNT(*)::int FROM user_follows uf WHERE uf.followed_id = u.id) AS follower_count,
         (SELECT COUNT(*)::int FROM user_follows uf2 WHERE uf2.follower_id = u.id) AS following_count,
         (SELECT COUNT(*)::int FROM club_members cm JOIN clubs c ON c.id = cm.club_id WHERE cm.user_id = u.id) AS club_count,
         (SELECT MAX(mc.updated_at) FROM moderator_chapters mc JOIN moderator_sites ms ON ms.id = mc.site_id
          WHERE ms.owner_user_id = u.id AND mc.status = 'published') AS last_chapter_at
     ) raw ON true
     WHERE (cardinality($1::text[]) = 0 OR (
         SELECT bool_and(u.username ILIKE '%' || w || '%' OR COALESCE(u.display_name, '') ILIKE '%' || w || '%')
         FROM unnest($1::text[]) AS w
       ))
     ORDER BY score DESC, u.username ASC
     LIMIT $2 OFFSET $3`,
    [words, Math.min(limit, 100), offset]
  );

  const { viewerId } = await getViewerNsfwAccess(req);
  let alreadyFollowing = new Set();
  if (viewerId && rows.length) {
    const { rows: fRows } = await pool.query(
      'SELECT followed_id FROM user_follows WHERE follower_id = $1 AND followed_id = ANY($2::int[])',
      [viewerId, rows.map(r => r.id)]
    );
    alreadyFollowing = new Set(fRows.map(r => r.followed_id));
  }

  const rawTotal = rows.length ? Number(rows[0].total_count) : 0;
  res.json({
    type,
    items: rows.map(r => ({
      username: r.username, display_name: r.display_name || r.username, avatar: r.avatar || null,
      story_count: r.story_count, reading_list_count: r.reading_list_count, follower_count: r.follower_count,
      following_count: r.following_count, club_count: r.club_count,
      is_self: viewerId === r.id, is_following: alreadyFollowing.has(r.id),
    })),
    // Capped at 100 -- both the reported total and how far pagination can
    // go -- since accounts search has no real use case past that depth.
    total: Math.min(rawTotal, 100), total_capped: rawTotal > 100, page, limit,
  });
});

// Distinct species across every character, straight out of the free-text
// stats->>'Species' field the character editor already saves (no new
// column/migration needed — this is the exact same data, just surfaced
// as a searchable/filterable list instead of sitting invisibly inside
// each character's own stats box). Backs the Characters page's sidebar.
app.get('/api/character-species-catalog', async (req, res) => {
  const { rows } = await pool.query('SELECT name FROM character_species_catalog ORDER BY name ASC');
  res.json({ species: rows.map(r => r.name) });
});

// Characters page — every character site-wide. "Search Keywords" matches
// name, species, and description all at once (species is now folded into
// the keyword search instead of its own picker list). filter=mine/followed/
// liked narrows to the viewer's own/followed/liked characters -- those
// three require a logged-in viewer, and just return empty if there isn't
// one rather than erroring.
const CHARACTER_SORTS = ['best_match', 'updated', 'popular'];

app.get('/api/search/characters', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const filter = String(req.query.filter || '').trim();
  const sortKey = CHARACTER_SORTS.includes(req.query.sort) ? req.query.sort : 'best_match';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const offset = (page - 1) * limit;
  const { nsfwAllowed } = await getViewerNsfwAccess(req);

  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }

  if (['mine', 'followed', 'liked'].includes(filter) && !viewerId) {
    return res.json({ items: [], total: 0, page, limit, sort: sortKey });
  }

  let filterClause = '';
  if (filter === 'mine') filterClause = 'AND mch.owner_user_id = $4';
  else if (filter === 'followed') filterClause = 'AND mch.owner_user_id IN (SELECT followed_id FROM user_follows WHERE follower_id = $4)';
  else if (filter === 'liked') filterClause = `AND (mch.id IN (SELECT character_id FROM moderator_character_likes WHERE user_id = $4)
       OR mch.id IN (SELECT character_id FROM moderator_character_bookmarks WHERE user_id = $4))`;

  // "Best Match" isn't just query relevance -- with no query typed (the
  // common case when just browsing) it still needs to produce a sensible
  // trending order, so it's relevance (when there's a query) PLUS a like
  // count weighting PLUS a recency boost that decays to 0 after 30 days.
  const bestMatchExpr = `(
    ${q ? `(CASE WHEN mch.name ILIKE $1 THEN 50 ELSE 0 END) +
    (CASE WHEN mch.name ILIKE '%' || $1 || '%' THEN 20 ELSE 0 END) +
    (CASE WHEN trim(mch.stats->>'Species') ILIKE '%' || $1 || '%' THEN 15 ELSE 0 END) +
    (CASE WHEN mch.description ILIKE '%' || $1 || '%' THEN 5 ELSE 0 END) +` : ''}
    (SELECT COUNT(*)::int FROM moderator_character_likes mcl3 WHERE mcl3.character_id = mch.id) * 4 +
    GREATEST(0, 30 - EXTRACT(DAY FROM (NOW() - mch.created_at)))
  )`;
  const orderBy = sortKey === 'popular' ? 'like_count DESC, mch.created_at DESC'
    : sortKey === 'updated' ? 'mch.updated_at DESC NULLS LAST, mch.created_at DESC'
    : `${bestMatchExpr} DESC, mch.created_at DESC`;

  const { rows } = await pool.query(
    `SELECT mch.id, mch.name, mch.ref_image, mch.ref_position_x, mch.ref_position_y, mch.ref_is_nsfw,
            trim(mch.stats->>'Species') AS species,
            u.username AS owner_username, u.display_name AS owner_display_name,
            (SELECT COUNT(*)::int FROM character_story_links csl WHERE csl.character_id = mch.id) AS story_count,
            (SELECT COUNT(*)::int FROM moderator_character_likes mcl WHERE mcl.character_id = mch.id) AS like_count,
            ${viewerId ? 'EXISTS(SELECT 1 FROM moderator_character_likes mcl2 WHERE mcl2.character_id = mch.id AND mcl2.user_id = $4)' : 'false'} AS liked,
            COUNT(*) OVER() AS total_count
     FROM moderator_characters mch
     JOIN users u ON u.id = mch.owner_user_id
     WHERE ($1 = '' OR mch.name ILIKE '%' || $1 || '%'
            OR trim(mch.stats->>'Species') ILIKE '%' || $1 || '%'
            OR mch.description ILIKE '%' || $1 || '%')
       ${filterClause}
     ORDER BY ${orderBy}
     LIMIT $2 OFFSET $3`,
    viewerId ? [q, limit, offset, viewerId] : [q, limit, offset]
  );

  res.json({
    items: rows.map(r => ({
      id: r.id, name: r.name,
      image: (r.ref_is_nsfw && !nsfwAllowed) ? null : (r.ref_image || null),
      nsfw_locked: !!(r.ref_is_nsfw && !nsfwAllowed),
      position_x: r.ref_position_x, position_y: r.ref_position_y,
      species: r.species || '',
      owner_username: r.owner_username, owner: r.owner_display_name || r.owner_username,
      story_count: r.story_count, like_count: r.like_count, liked: !!r.liked,
    })),
    total: rows.length ? Number(rows[0].total_count) : 0, page, limit, sort: sortKey,
  });
});

// ── Clubs — the Social page's forum/club system ─────────────────────────────
function slugifyClubName(name) {
  const base = String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return base || 'club';
}
async function uniqueClubSlug(name) {
  const base = slugifyClubName(name);
  let slug = base, n = 2;
  while (true) {
    const { rows } = await pool.query('SELECT 1 FROM clubs WHERE slug = $1', [slug]);
    if (!rows.length) return slug;
    slug = `${base}-${n++}`;
  }
}
async function getClubRole(clubId, userId) {
  if (!userId) return null;
  const { rows: [row] } = await pool.query('SELECT role FROM club_members WHERE club_id = $1 AND user_id = $2', [clubId, userId]);
  return row ? row.role : null;
}

// Shared "does this club exist, and is the requester an owner/admin of it"
// check for the whole club-editor surface (cover/welcome/cards/pages).
// Sends the 404/403 response itself and returns null so callers can just
// `if (!ctx) return;`.
async function requireClubAdmin(req, res) {
  const { rows: [club] } = await pool.query('SELECT * FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) { res.status(404).json({ error: 'Club not found.' }); return null; }
  const role = await getClubRole(club.id, req.user.id);
  if (role !== 'owner' && role !== 'admin') { res.status(403).json({ error: 'Only club owners/admins can edit this club.' }); return null; }
  return { club, role };
}
// Same as requireClubAdmin, plus resolves :pageSlug to a club_pages row —
// used by the General Page template's cover/slideshow/text-field endpoints.
async function requireClubPageAdmin(req, res) {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return null;
  const { rows: [page] } = await pool.query(
    'SELECT * FROM club_pages WHERE club_id = $1 AND slug = $2', [ctx.club.id, req.params.pageSlug]
  );
  if (!page) { res.status(404).json({ error: 'Page not found.' }); return null; }
  return { ...ctx, page };
}
// Club Topics/Types — fixed list (not user-grown like Fandom/Tags), same
// idea as Reddit's community topics. Kept in a random, non-alphabetical
// order on purpose — this is a flat set of options, not a ranked list.
// Every club must pick at least 1 (up to 3) before it can be created.
const CLUB_TYPES_EMOJI = {
  'Music': '🎵', 'Gaming': '🎮', 'Places & Travel': '✈️', 'Sciences': '🔬',
  'Community': '🫂', 'Anime & Cosplay': '🎏', 'Adult Content': '🔞',
  'Home & Garden': '🏡', 'Food & Drinks': '🍔', 'Movies & TV': '🎬', 'Sports': '🏆',
  'Humanities & Law': '⚖️', 'Q&As & Stories': '💬', 'Internet Culture': '🌐',
  'Writing': '✍️', 'Vehicles': '🚗', 'Fashion & Beauty': '💄', 'Pop Culture': '🌟',
  'Wellness': '🧘', 'Technology': '💻', 'Health': '❤️‍🩹', 'Spooky': '👻',
  'Business & Finance': '💼', 'Identity & Relationships': '💞', 'News & Politics': '📰',
  'Art': '🎨', 'Collectibles & Other Hobbies': '🧸', 'Reading & Writing': '📚',
  'Mature Topics': '🔥', 'Nature & Outdoors': '🌲', 'Education & Career': '🎓',
  'Games': '🎲',
};
const CLUB_TYPES = Object.keys(CLUB_TYPES_EMOJI);
function sanitizeClubTypes(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (typeof t !== 'string' || !CLUB_TYPES.includes(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 3) break;
  }
  return out;
}

function clubPublicShape(c, viewerRole) {
  return {
    id: c.id, slug: c.slug, name: c.name, description: c.description,
    banner_url: c.banner_url, banner_position_x: c.banner_position_x, banner_position_y: c.banner_position_y,
    icon_url: c.icon_url, icon_original_url: c.icon_original_url || '', owner_user_id: c.owner_user_id,
    theme: c.theme || 'default', theme_bg_url: c.theme_bg_url || '',
    sidebar_title: c.sidebar_title || '', sidebar_message: c.sidebar_message || '', is_nsfw: !!c.is_nsfw,
    welcome_title: c.welcome_title || '', cover_mode: c.cover_mode || 'static', cover_image_url: c.cover_image_url || '',
    featured_cards_title: c.featured_cards_title || 'Featured Cards',
    club_types: c.club_types || [],
    member_count: Number(c.member_count) || 0,
    post_count: c.post_count !== undefined ? Number(c.post_count) || 0 : undefined,
    created_at: c.created_at,
    viewer_role: viewerRole || null,
  };
}

// GET /api/club-types — public, powers the Create/Edit Club type picker
// and (later) the Explore page's topic filters. Order matches CLUB_TYPES
// (intentionally shuffled, not alphabetical).
app.get('/api/club-types', (req, res) => {
  res.json({ types: CLUB_TYPES.map(name => ({ name, emoji: CLUB_TYPES_EMOJI[name] })) });
});

// GET /api/clubs — browse/search. ?q= filters by name, ?mine=1 restricts to
// clubs the viewer belongs to (requires auth). Optional auth otherwise, so
// viewer_role can be included for logged-in browsers without requiring login.
app.get('/api/clubs', async (req, res) => {
  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }
  const q = `%${String(req.query.q || '').slice(0, 60)}%`;
  const mineOnly = req.query.mine === '1' && viewerId;
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  // Explore page's topic row -- "All" sends no ?type at all, any other
  // click filters to clubs whose club_types array contains that one topic.
  const type = CLUB_TYPES.includes(req.query.type) ? req.query.type : null;

  // Same SFW Mode gate used for spicy gallery/character content — NSFW
  // clubs drop out of public browse only for an account that's turned SFW
  // Mode on; guests (no viewerId) see everything now. mineOnly is exempt:
  // your own clubs (owned or joined) always stay visible in your own list
  // regardless of SFW Mode.
  let nsfwAllowed = true;
  if (viewerId) {
    const { rows: [row] } = await pool.query('SELECT nsfw_enabled FROM users WHERE id = $1', [viewerId]);
    nsfwAllowed = !!(row && row.nsfw_enabled);
  }
  const hideNsfw = !mineOnly && !nsfwAllowed;

  const { rows } = await pool.query(
    `SELECT c.*, COUNT(cm.id)::int AS member_count,
            MAX(CASE WHEN cm.user_id = $1 THEN cm.role END) AS viewer_role
     FROM clubs c
     LEFT JOIN club_members cm ON cm.club_id = c.id
       AND cm.user_id NOT IN (SELECT id FROM users WHERE username IN ('holly_allen', 'holly_chan'))
     WHERE c.name ILIKE $2
       ${mineOnly ? 'AND EXISTS (SELECT 1 FROM club_members m2 WHERE m2.club_id = c.id AND m2.user_id = $1)' : ''}
       ${hideNsfw ? 'AND c.is_nsfw = FALSE' : ''}
       ${type ? 'AND c.club_types @> $4::jsonb' : ''}
     GROUP BY c.id
     ORDER BY member_count DESC, c.created_at DESC
     LIMIT $3`,
    type ? [viewerId, q, limit, JSON.stringify([type])] : [viewerId, q, limit]
  );
  res.json({ clubs: rows.map(r => clubPublicShape(r, r.viewer_role)) });
});

// POST /api/clubs — create a club; creator becomes owner. Description is no
// longer collected at creation (added afterward via the club editor).
app.post('/api/clubs', requireAuth, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const isNsfw = req.body.is_nsfw === true || req.body.is_nsfw === 'true';
  const clubTypes = sanitizeClubTypes(req.body.club_types) || [];
  if (!name) return res.status(400).json({ error: 'A club name is required.' });
  if (!clubTypes.length) return res.status(400).json({ error: 'Pick at least one Topic for your club.' });

  const slug = await uniqueClubSlug(name);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [club] } = await client.query(
      `INSERT INTO clubs (slug, name, owner_user_id, is_nsfw, club_types) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [slug, name, req.user.id, isNsfw, JSON.stringify(clubTypes)]
    );
    await client.query(
      `INSERT INTO club_members (club_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [club.id, req.user.id]
    );
    await client.query('COMMIT');
    res.json({ club: clubPublicShape({ ...club, member_count: 1 }, 'owner') });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// GET /api/clubs/:slug — club detail + member roster.
app.get('/api/clubs/:slug', async (req, res) => {
  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }
  const { rows: [club] } = await pool.query('SELECT * FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });

  const viewerRoleEarly = await getClubRole(club.id, viewerId);
  if (club.is_nsfw && !viewerRoleEarly) {
    // Members always keep access to their own club regardless of SFW Mode —
    // this gate is about hiding NSFW clubs from browsing/direct links for
    // everyone else. Guests (no viewerId) see everything now; only an
    // account with SFW Mode on gets filtered, same as spicy gallery/
    // character content.
    let nsfwAllowed = true;
    if (viewerId) {
      const { rows: [row] } = await pool.query('SELECT nsfw_enabled FROM users WHERE id = $1', [viewerId]);
      nsfwAllowed = !!(row && row.nsfw_enabled);
    }
    if (!nsfwAllowed) {
      return res.status(403).json({ error: 'This club is marked NSFW.', nsfw_locked: true, reason: viewerId ? 'sfw_mode' : 'login' });
    }
  }

  const [{ rows: members }, viewerRole, { rows: [{ postCount }] }] = await Promise.all([
    pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar, cm.role, cm.joined_at
       FROM club_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.club_id = $1 AND u.username NOT IN ('holly_allen', 'holly_chan')
       ORDER BY (cm.role = 'owner') DESC, (cm.role = 'admin') DESC, cm.joined_at ASC`,
      [club.id]
    ),
    getClubRole(club.id, viewerId),
    pool.query('SELECT COUNT(*)::int AS "postCount" FROM club_posts WHERE club_id = $1', [club.id]),
  ]);

  res.json({
    club: clubPublicShape({ ...club, member_count: members.length, post_count: postCount }, viewerRole),
    members: members.map(m => ({
      id: m.id, username: m.username, display_name: m.display_name || m.username,
      avatar: m.avatar || null, role: m.role, joined_at: m.joined_at,
    })),
  });
});

// PUT /api/clubs/:slug — owner/admin only. Optional banner image upload.
app.put('/api/clubs/:slug', requireAuth, uploadModImage.single('banner'), async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT * FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const role = await getClubRole(club.id, req.user.id);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Only club owners/admins can edit this club.' });

  const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 60) || club.name : club.name;
  const description = req.body.description !== undefined ? String(req.body.description).trim().slice(0, 1000) : club.description;
  const welcomeTitle = req.body.welcome_title !== undefined ? String(req.body.welcome_title).trim().slice(0, 100) : club.welcome_title;
  const positionX = req.body.banner_position_x !== undefined ? clampPosition(req.body.banner_position_x) : club.banner_position_x;
  const positionY = req.body.banner_position_y !== undefined ? clampPosition(req.body.banner_position_y) : club.banner_position_y;
  let clubTypes = club.club_types;
  if (req.body.club_types !== undefined) {
    let parsed = req.body.club_types;
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { parsed = []; } }
    clubTypes = sanitizeClubTypes(parsed) ?? club.club_types;
  }

  let bannerUrl = club.banner_url;
  if (req.file) {
    bannerUrl = `/images/moderators/${req.file.filename}`;
    if (club.banner_url.startsWith('/images/moderators/')) {
      const oldPath = path.join('/var/www/btw', club.banner_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }

  const { rows: [updated] } = await pool.query(
    `UPDATE clubs SET name = $1, description = $2, banner_url = $3, banner_position_x = $4, banner_position_y = $5, welcome_title = $6, club_types = $7
     WHERE id = $8 RETURNING *`,
    [name, description, bannerUrl, positionX, positionY, welcomeTitle, JSON.stringify(clubTypes), club.id]
  );
  res.json({ club: clubPublicShape(updated, role) });
});

// PUT /api/clubs/:slug/sidebar-splash — the right sidebar's own title +
// message (separate from the Hub's Welcome Title/Description).
app.put('/api/clubs/:slug/sidebar-splash', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const sidebarTitle = String(req.body.sidebar_title || '').trim().slice(0, 80);
  const sidebarMessage = String(req.body.sidebar_message || '').trim().slice(0, 1000);
  const { rows: [updated] } = await pool.query(
    'UPDATE clubs SET sidebar_title = $1, sidebar_message = $2 WHERE id = $3 RETURNING *',
    [sidebarTitle, sidebarMessage, ctx.club.id]
  );
  res.json({ club: clubPublicShape(updated, ctx.role) });
});

// Club page theme — same default (plain dark) / custom-blurred-background
// pattern as a profile or story page. Owner/admin only.
// PUT /api/clubs/:slug/icon — the club's pfp, cropped 1:1 client-side same
// as everywhere else that uses openCropModal.
app.put('/api/clubs/:slug/icon', requireAuth, uploadModImage.fields([{ name: 'image', maxCount: 1 }, { name: 'image_original', maxCount: 1 }]), async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const iconFile = req.files && req.files.image && req.files.image[0];
  if (!iconFile) return res.status(400).json({ error: 'Image is required.' });
  const iconUrl = `/images/moderators/${iconFile.filename}`;
  if (ctx.club.icon_url.startsWith('/images/moderators/')) {
    const oldPath = path.join('/var/www/btw', ctx.club.icon_url);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  // `image_original` is only sent the first time a NEW source photo is
  // picked -- Recrop re-sends just `image` (a fresh bake) from the
  // existing original, so icon_original_url stays untouched. Same pattern
  // as the story banner/cover fix.
  const originalFile = req.files.image_original && req.files.image_original[0];
  if (originalFile) {
    const originalUrl = `/images/moderators/${originalFile.filename}`;
    await pool.query('UPDATE clubs SET icon_url = $1, icon_original_url = $2 WHERE id = $3', [iconUrl, originalUrl, ctx.club.id]);
  } else {
    await pool.query('UPDATE clubs SET icon_url = $1 WHERE id = $2', [iconUrl, ctx.club.id]);
  }
  const { rows: [club] } = await pool.query('SELECT icon_original_url FROM clubs WHERE id = $1', [ctx.club.id]);
  res.json({ icon_url: iconUrl, icon_original_url: club.icon_original_url });
});

// PUT /api/clubs/:slug/nsfw — { is_nsfw: true|false }, settable either way
// after creation (the "Start a Club" modal only sets the initial value).
app.put('/api/clubs/:slug/nsfw', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const isNsfw = req.body.is_nsfw === true || req.body.is_nsfw === 'true';
  await pool.query('UPDATE clubs SET is_nsfw = $1 WHERE id = $2', [isNsfw, ctx.club.id]);
  res.json({ is_nsfw: isNsfw });
});

app.put('/api/clubs/:slug/theme', requireAuth, async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT * FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const role = await getClubRole(club.id, req.user.id);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Only club owners/admins can edit this club.' });

  const theme = req.body.theme === 'custom' ? 'custom' : 'default';
  const { rows: [updated] } = await pool.query('UPDATE clubs SET theme = $1 WHERE id = $2 RETURNING *', [theme, club.id]);
  res.json({ club: clubPublicShape(updated, role) });
});

app.put('/api/clubs/:slug/theme-bg', requireAuth, uploadModImage.single('image'), async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT * FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const role = await getClubRole(club.id, req.user.id);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Only club owners/admins can edit this club.' });
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });

  const bgUrl = `/images/moderators/${req.file.filename}`;
  const { rows: [updated] } = await pool.query(
    `UPDATE clubs SET theme_bg_url = $1, theme = 'custom' WHERE id = $2 RETURNING *`, [bgUrl, club.id]
  );
  res.json({ club: clubPublicShape(updated, role) });
});

// DELETE /api/clubs/:slug — owner only.
app.delete('/api/clubs/:slug', requireAuth, async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT * FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  if (club.owner_user_id !== req.user.id) return res.status(403).json({ error: 'Only the club owner can delete this club.' });
  if (club.banner_url.startsWith('/images/moderators/')) {
    const filePath = path.join('/var/www/btw', club.banner_url);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  await pool.query('DELETE FROM clubs WHERE id = $1', [club.id]);
  res.json({ message: 'Club deleted.' });
});

// POST /api/clubs/:slug/join
app.post('/api/clubs/:slug/join', requireAuth, async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id, name, slug FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  await pool.query(
    `INSERT INTO club_members (club_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
    [club.id, req.user.id]
  );
  await notifyFollowers(req.user.id, 'club_join',
    `joined the club "${club.name}".`,
    `/club?slug=${encodeURIComponent(club.slug)}`);
  res.json({ message: 'Joined!' });
});

// POST /api/clubs/:slug/visit — stamps "last opened this club" for the
// signed-in viewer. Fire-and-forget from the client on every club page
// load; feeds the Best feed's small recently-visited personalization
// boost (separate from, and smaller than, the membership boost).
app.post('/api/clubs/:slug/visit', requireAuth, async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  await pool.query(
    `INSERT INTO club_visits (user_id, club_id, last_visited_at) VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, club_id) DO UPDATE SET last_visited_at = NOW()`,
    [req.user.id, club.id]
  );
  res.json({ message: 'ok' });
});

// DELETE /api/clubs/:slug/leave — the owner can't leave their own club (must
// delete it, or transfer ownership first — no transfer flow yet).
app.delete('/api/clubs/:slug/leave', requireAuth, async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id, owner_user_id FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  if (club.owner_user_id === req.user.id) return res.status(400).json({ error: "The owner can't leave their own club — delete it instead." });
  await pool.query('DELETE FROM club_members WHERE club_id = $1 AND user_id = $2', [club.id, req.user.id]);
  res.json({ message: 'Left the club.' });
});

// PUT /api/clubs/:slug/members/:userId — owner only; promote/demote admin<->member.
app.put('/api/clubs/:slug/members/:userId', requireAuth, async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id, owner_user_id FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  if (club.owner_user_id !== req.user.id) return res.status(403).json({ error: 'Only the club owner can change member roles.' });
  const targetId = parseInt(req.params.userId, 10);
  if (targetId === req.user.id) return res.status(400).json({ error: "The owner's own role can't be changed here." });
  const role = req.body.role === 'admin' ? 'admin' : 'member';
  const { rowCount } = await pool.query(
    `UPDATE club_members SET role = $1 WHERE club_id = $2 AND user_id = $3 AND role != 'owner'`,
    [role, club.id, targetId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Member not found.' });
  res.json({ message: 'Role updated.' });
});

// DELETE /api/clubs/:slug/members/:userId — remove a member. Owners can
// remove anyone (except themselves); admins can only remove plain members.
app.delete('/api/clubs/:slug/members/:userId', requireAuth, async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id, owner_user_id FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const targetId = parseInt(req.params.userId, 10);
  if (targetId === club.owner_user_id) return res.status(400).json({ error: "The owner can't be removed." });
  const viewerRole = await getClubRole(club.id, req.user.id);
  const targetRole = await getClubRole(club.id, targetId);
  const allowed = viewerRole === 'owner' || (viewerRole === 'admin' && targetRole === 'member');
  if (!allowed) return res.status(403).json({ error: "You don't have permission to remove this member." });
  await pool.query('DELETE FROM club_members WHERE club_id = $1 AND user_id = $2', [club.id, targetId]);
  res.json({ message: 'Member removed.' });
});

// `voteRows` is every club_post_poll_votes row for this post (only ever
// non-empty when the post actually has a poll). Results stay hidden from
// the client's perspective until the viewer has voted — that's enforced
// here, not just in the UI, so opening devtools doesn't reveal them early.
function clubPostPublicShape(p, voteRows, viewerId) {
  let poll = p.poll || null;
  if (poll) {
    const rows = voteRows || [];
    const counts = new Array(poll.options.length).fill(0);
    rows.forEach(r => r.option_indices.forEach(i => { if (counts[i] !== undefined) counts[i]++; }));
    const mine = viewerId ? rows.find(r => r.user_id === viewerId) : null;
    poll = {
      ...poll,
      total_votes: rows.length,
      viewer_voted: !!mine,
      viewer_choice: mine ? mine.option_indices : null,
      results: mine ? counts : null, // masked until the viewer casts a vote
    };
  }
  return {
    id: p.id, title: p.title, body: p.body,
    image_url: p.image_url, image_urls: p.image_urls || [],
    preview_position_x: p.preview_position_x, preview_position_y: p.preview_position_y,
    poll,
    created_at: p.created_at, is_admin_post: p.is_admin_post,
    author: { id: p.author_user_id, username: p.username, display_name: p.display_name || p.username, avatar: p.avatar || null },
    like_count: Number(p.like_count) || 0,
    comment_count: Number(p.comment_count) || 0,
    user_liked: !!p.user_liked,
  };
}
function optionalViewerId(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    try { return jwt.verify(h.slice(7), process.env.JWT_SECRET).id; } catch {}
  }
  return null;
}

// GET /api/clubs/:slug/posts — ?section=admin restricts to posts explicitly
// flagged is_admin_post at creation time (not just "written by an admin" —
// an owner/admin can still post to the general feed).
// ?sort=best|top|new — same Hot-score idea as /api/clubs-feed, just scoped
// to this one club (no membership/visit personalization needed — every
// post here already belongs to the club the viewer's looking at).
app.get('/api/clubs/:slug/posts', async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const adminOnly = req.query.section === 'admin';
  const sort = ['best', 'top', 'new'].includes(req.query.sort) ? req.query.sort : 'best';
  const viewerId = optionalViewerId(req);
  // Postgres won't resolve SELECT-list aliases inside a compound ORDER BY
  // expression (only bare "ORDER BY like_count" works, not "like_count +
  // comment_count") — repeat the underlying subqueries instead of the alias.
  // 'best' gets a small random nudge (±0.15 on a score where a same-day
  // post is worth ~1.5-2 and each extra comment/like is a fraction of
  // that) — enough for near-tied posts to swap on refresh, not enough to
  // bump a clearly-better post down.
  const hotScoreExpr = `LOG(10, GREATEST(
         (SELECT COUNT(*)::int FROM club_post_likes WHERE post_id = cp.id)
         + (SELECT COUNT(*)::int FROM content_comments WHERE target_type = 'club_post' AND target_id = cp.id) * 2,
       1)::numeric) + EXTRACT(EPOCH FROM cp.created_at) / 45000`;
  const orderBy = sort === 'new' ? 'cp.created_at DESC'
    : sort === 'top' ? `(SELECT COUNT(*)::int FROM club_post_likes WHERE post_id = cp.id)
        + (SELECT COUNT(*)::int FROM content_comments WHERE target_type = 'club_post' AND target_id = cp.id) DESC, cp.created_at DESC`
    : `${hotScoreExpr} + (random() - 0.5) * 0.3 DESC`;
  const { rows } = await pool.query(
    `SELECT cp.*, u.username, u.display_name, u.avatar,
       (SELECT COUNT(*)::int FROM club_post_likes WHERE post_id = cp.id) AS like_count,
       (SELECT COUNT(*)::int FROM content_comments WHERE target_type = 'club_post' AND target_id = cp.id) AS comment_count,
       (SELECT COUNT(*) > 0 FROM club_post_likes WHERE post_id = cp.id AND user_id = $2) AS user_liked,
       ${hotScoreExpr} AS hot_score
     FROM club_posts cp JOIN users u ON u.id = cp.author_user_id
     WHERE cp.club_id = $1 ${adminOnly ? 'AND cp.is_admin_post = TRUE' : ''}
     ORDER BY ${orderBy} LIMIT 100`,
    [club.id, viewerId || 0]
  );
  const pollPostIds = rows.filter(p => p.poll).map(p => p.id);
  let votesByPost = new Map();
  if (pollPostIds.length) {
    const { rows: voteRows } = await pool.query(
      'SELECT post_id, user_id, option_indices FROM club_post_poll_votes WHERE post_id = ANY($1)',
      [pollPostIds]
    );
    voteRows.forEach(v => {
      if (!votesByPost.has(v.post_id)) votesByPost.set(v.post_id, []);
      votesByPost.get(v.post_id).push(v);
    });
  }
  res.json({ posts: rows.map(p => clubPostPublicShape(p, votesByPost.get(p.id), viewerId)), sort });
});

// GET /api/clubs/:slug/posts/:postId — a single post, for the post detail
// page (direct load/refresh, not just navigating there client-side).
app.get('/api/clubs/:slug/posts/:postId', async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const viewerId = optionalViewerId(req);
  const { rows: [p] } = await pool.query(
    `SELECT cp.*, u.username, u.display_name, u.avatar,
       (SELECT COUNT(*)::int FROM club_post_likes WHERE post_id = cp.id) AS like_count,
       (SELECT COUNT(*)::int FROM content_comments WHERE target_type = 'club_post' AND target_id = cp.id) AS comment_count,
       (SELECT COUNT(*) > 0 FROM club_post_likes WHERE post_id = cp.id AND user_id = $3) AS user_liked
     FROM club_posts cp JOIN users u ON u.id = cp.author_user_id
     WHERE cp.id = $1 AND cp.club_id = $2`,
    [req.params.postId, club.id, viewerId || 0]
  );
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  let voteRows = [];
  if (p.poll) {
    const { rows } = await pool.query(
      'SELECT post_id, user_id, option_indices FROM club_post_poll_votes WHERE post_id = $1',
      [p.id]
    );
    voteRows = rows;
  }
  res.json({ post: clubPostPublicShape(p, voteRows, viewerId) });
});

// POST /api/clubs/:slug/posts/:postId/poll/vote — once-castable: a second
// attempt gets rejected (409) rather than overwriting the first vote, since
// there's no "change your vote" UI and the results being masked pre-vote
// depends on there being exactly one honest vote per viewer.
app.post('/api/clubs/:slug/posts/:postId/poll/vote', requireAuth, async (req, res) => {
  const { rows: [post] } = await pool.query(
    `SELECT cp.id, cp.poll FROM club_posts cp JOIN clubs c ON c.id = cp.club_id WHERE c.slug = $1 AND cp.id = $2`,
    [req.params.slug, req.params.postId]
  );
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (!post.poll) return res.status(400).json({ error: 'This post has no poll.' });

  const optionIndices = Array.isArray(req.body.option_indices) ? req.body.option_indices.map(Number) : [];
  const optionCount = post.poll.options.length;
  const valid = optionIndices.length > 0
    && optionIndices.every(i => Number.isInteger(i) && i >= 0 && i < optionCount)
    && new Set(optionIndices).size === optionIndices.length
    && (post.poll.type === 'multiple' || optionIndices.length === 1);
  if (!valid) return res.status(400).json({ error: 'Invalid vote.' });

  const { rows: [existing] } = await pool.query(
    'SELECT id FROM club_post_poll_votes WHERE post_id = $1 AND user_id = $2',
    [post.id, req.user.id]
  );
  if (existing) return res.status(409).json({ error: 'You already voted on this poll.' });

  await pool.query(
    'INSERT INTO club_post_poll_votes (post_id, user_id, option_indices) VALUES ($1, $2, $3)',
    [post.id, req.user.id, optionIndices]
  );

  const { rows: voteRows } = await pool.query(
    'SELECT post_id, user_id, option_indices FROM club_post_poll_votes WHERE post_id = $1',
    [post.id]
  );
  const counts = new Array(optionCount).fill(0);
  voteRows.forEach(v => v.option_indices.forEach(i => counts[i]++));
  res.json({
    poll: {
      ...post.poll,
      total_votes: voteRows.length,
      viewer_voted: true,
      viewer_choice: optionIndices,
      results: counts,
    },
  });
});

// Guests can like club posts (unlike joining/commenting/voting, still
// account-only) — no requireAuth here, optionalViewerId + the guest cookie
// stand in for it.
app.post('/api/clubs/:slug/posts/:postId/like', async (req, res) => {
  const { rows: [post] } = await pool.query(
    `SELECT cp.id FROM club_posts cp JOIN clubs c ON c.id = cp.club_id WHERE c.slug = $1 AND cp.id = $2`,
    [req.params.slug, req.params.postId]
  );
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const viewerId = optionalViewerId(req);
  await pool.query(
    'INSERT INTO club_post_likes (post_id, user_id, guest_device_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [post.id, viewerId, viewerId ? null : req.guestId]
  );
  const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int AS count FROM club_post_likes WHERE post_id = $1', [post.id]);
  res.json({ liked: true, like_count: count });
});
app.delete('/api/clubs/:slug/posts/:postId/like', async (req, res) => {
  const { rows: [post] } = await pool.query(
    `SELECT cp.id FROM club_posts cp JOIN clubs c ON c.id = cp.club_id WHERE c.slug = $1 AND cp.id = $2`,
    [req.params.slug, req.params.postId]
  );
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const viewerId = optionalViewerId(req);
  await pool.query(
    viewerId
      ? 'DELETE FROM club_post_likes WHERE post_id = $1 AND user_id = $2'
      : 'DELETE FROM club_post_likes WHERE post_id = $1 AND guest_device_id = $2',
    [post.id, viewerId || req.guestId]
  );
  const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int AS count FROM club_post_likes WHERE post_id = $1', [post.id]);
  res.json({ liked: false, like_count: count });
});

// POST /api/clubs/:slug/posts — members only. is_admin_post is a deliberate
// choice made at posting time (only owners/admins can set it — silently
// ignored otherwise, never trusted from a regular member's request). Every
// post needs a title; body/images/poll are all optional. Images are never
// individually cropped (they're shown click-through, full-size, on the
// post's own page) — only the FEED THUMBNAIL gets a focal-point
// reposition (preview_position_x/y), same idea as the gallery preview crop:
// the source image itself is untouched.
app.post('/api/clubs/:slug/posts', requireAuth, uploadModImage.array('images', 10), async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id, name, slug FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const role = await getClubRole(club.id, req.user.id);
  if (!role) return res.status(403).json({ error: 'Join this club to post in it.' });

  const title = String(req.body.title || '').trim().slice(0, 120);
  const body = String(req.body.body || '').trim().slice(0, 5000);
  if (!title) return res.status(400).json({ error: 'A title is required.' });
  const isAdminPost = !!req.body.is_admin_post && (role === 'owner' || role === 'admin');
  const previewX = req.body.preview_position_x !== undefined ? clampPosition(req.body.preview_position_x) : 50;
  const previewY = req.body.preview_position_y !== undefined ? clampPosition(req.body.preview_position_y) : 50;

  let poll = null;
  if (req.body.poll) {
    try {
      const parsed = JSON.parse(req.body.poll);
      const question = String(parsed.question || '').trim().slice(0, 200);
      const options = (Array.isArray(parsed.options) ? parsed.options : [])
        .map(o => String(o || '').trim().slice(0, 100)).filter(Boolean).slice(0, 4);
      const type = parsed.type === 'multiple' ? 'multiple' : 'single';
      if (question && options.length >= 2) poll = { question, type, options };
    } catch {}
  }

  const imageUrls = (req.files || []).map(f => `/images/moderators/${f.filename}`);

  const { rows: [post] } = await pool.query(
    `INSERT INTO club_posts (club_id, author_user_id, title, body, image_url, image_urls, preview_position_x, preview_position_y, poll, is_admin_post)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [club.id, req.user.id, title, body, imageUrls[0] || '', JSON.stringify(imageUrls), previewX, previewY, poll ? JSON.stringify(poll) : null, isAdminPost]
  );
  const { rows: [author] } = await pool.query('SELECT username, display_name, avatar FROM users WHERE id = $1', [req.user.id]);
  const { rows: members } = await pool.query('SELECT user_id FROM club_members WHERE club_id = $1', [club.id]);
  const postLink = `/club?slug=${encodeURIComponent(club.slug)}&post=${post.id}`;
  await Promise.all(
    members
      .map(m => m.user_id)
      .filter(uid => uid !== req.user.id)
      .map(uid => notifyUser(uid, req.user.id, 'club_post',
        `posted "${title}" in ${club.name}.`, postLink))
  );
  res.json({ post: clubPostPublicShape({ ...post, username: author.username, display_name: author.display_name, avatar: author.avatar }) });
});

// DELETE /api/clubs/:slug/posts/:postId — the post's own author, or a club owner/admin.
app.delete('/api/clubs/:slug/posts/:postId', requireAuth, async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const { rows: [post] } = await pool.query('SELECT * FROM club_posts WHERE id = $1 AND club_id = $2', [req.params.postId, club.id]);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const role = await getClubRole(club.id, req.user.id);
  const allowed = post.author_user_id === req.user.id || role === 'owner' || role === 'admin';
  if (!allowed) return res.status(403).json({ error: "You don't have permission to delete this post." });
  await pool.query('DELETE FROM club_posts WHERE id = $1', [post.id]);
  res.json({ message: 'Post deleted.' });
});

// GET /api/clubs/:slug/featured-cards — freeform spotlight cards (was
// "Meet the Admins"). Not tied to any user account — a club can feature
// whatever it wants (its admin roster, its cast of characters, anything),
// so this is just plain rows off the club, no membership join. Title is
// editable per club.
app.get('/api/clubs/:slug/featured-cards', async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id, featured_cards_title FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const { rows } = await pool.query(
    'SELECT id, name, description, image_url FROM club_featured_cards WHERE club_id = $1 ORDER BY sort_order, created_at',
    [club.id]
  );
  res.json({ title: club.featured_cards_title || 'Featured Cards', cards: rows });
});

// PUT /api/clubs/:slug/featured-cards-title — rename the section itself.
app.put('/api/clubs/:slug/featured-cards-title', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const title = String(req.body.title || '').trim().slice(0, 60) || 'Featured Cards';
  await pool.query('UPDATE clubs SET featured_cards_title = $1 WHERE id = $2', [title, ctx.club.id]);
  res.json({ title });
});

// POST /api/clubs/:slug/featured-cards — create a card. Multipart (image
// optional — falls back to the shared default on the client when empty).
app.post('/api/clubs/:slug/featured-cards', requireAuth, uploadModImage.single('image'), async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const name = String(req.body.name || '').trim().slice(0, 80);
  const description = String(req.body.description || '').trim().slice(0, 1000);
  if (!name) return res.status(400).json({ error: 'A name/title is required.' });
  const imageUrl = req.file ? `/images/moderators/${req.file.filename}` : '/images/defaultchar.jpg';
  const { rows: [{ maxOrder }] } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder" FROM club_featured_cards WHERE club_id = $1', [ctx.club.id]
  );
  const { rows: [card] } = await pool.query(
    `INSERT INTO club_featured_cards (club_id, name, description, image_url, sort_order)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, name, description, image_url`,
    [ctx.club.id, name, description, imageUrl, maxOrder + 1]
  );
  res.json({ card });
});

// PUT /api/clubs/:slug/featured-cards/:cardId — edit a card (image optional).
app.put('/api/clubs/:slug/featured-cards/:cardId', requireAuth, uploadModImage.single('image'), async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM club_featured_cards WHERE id = $1 AND club_id = $2', [req.params.cardId, ctx.club.id]
  );
  if (!existing) return res.status(404).json({ error: 'Card not found.' });

  const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 80) || existing.name : existing.name;
  const description = req.body.description !== undefined ? String(req.body.description).trim().slice(0, 1000) : existing.description;
  let imageUrl = existing.image_url;
  if (req.file) {
    imageUrl = `/images/moderators/${req.file.filename}`;
    if (existing.image_url.startsWith('/images/moderators/')) {
      const oldPath = path.join('/var/www/btw', existing.image_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }
  const { rows: [card] } = await pool.query(
    `UPDATE club_featured_cards SET name = $1, description = $2, image_url = $3, updated_at = NOW()
     WHERE id = $4 RETURNING id, name, description, image_url`,
    [name, description, imageUrl, existing.id]
  );
  res.json({ card });
});

app.delete('/api/clubs/:slug/featured-cards/:cardId', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const { rowCount } = await pool.query(
    'DELETE FROM club_featured_cards WHERE id = $1 AND club_id = $2', [req.params.cardId, ctx.club.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Card not found.' });
  res.json({ message: 'Card deleted.' });
});

// PUT /api/clubs/:slug/featured-cards/reorder — { order: [cardId, ...] }.
app.put('/api/clubs/:slug/featured-cards/reorder', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const order = req.body.order;
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order must be a non-empty array of card IDs.' });
  await pool.query('BEGIN');
  try {
    for (let i = 0; i < order.length; i++) {
      await pool.query(
        'UPDATE club_featured_cards SET sort_order = $1 WHERE id = $2 AND club_id = $3',
        [i, order[i], ctx.club.id]
      );
    }
    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    return res.status(500).json({ error: 'Could not save the new order.' });
  }
  res.json({ message: 'Order saved.' });
});

// ── Home page Cover Image — static single image or a slideshow of several,
// cycling randomly on the club's Hub. ─────────────────────────────────────
app.put('/api/clubs/:slug/cover-mode', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const mode = req.body.cover_mode === 'slideshow' ? 'slideshow' : 'static';
  await pool.query('UPDATE clubs SET cover_mode = $1 WHERE id = $2', [mode, ctx.club.id]);
  res.json({ cover_mode: mode });
});

app.put('/api/clubs/:slug/cover-image', requireAuth, uploadModImage.single('image'), async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const imageUrl = `/images/moderators/${req.file.filename}`;
  if (ctx.club.cover_image_url.startsWith('/images/moderators/')) {
    const oldPath = path.join('/var/www/btw', ctx.club.cover_image_url);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  await pool.query('UPDATE clubs SET cover_image_url = $1 WHERE id = $2', [imageUrl, ctx.club.id]);
  res.json({ cover_image_url: imageUrl });
});

app.get('/api/clubs/:slug/slideshow', async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const { rows } = await pool.query(
    'SELECT id, image_url FROM club_slideshow_images WHERE club_id = $1 ORDER BY sort_order, created_at',
    [club.id]
  );
  res.json({ images: rows });
});

app.post('/api/clubs/:slug/slideshow', requireAuth, uploadModImage.single('image'), async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const imageUrl = `/images/moderators/${req.file.filename}`;
  const { rows: [{ maxOrder }] } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder" FROM club_slideshow_images WHERE club_id = $1', [ctx.club.id]
  );
  const { rows: [image] } = await pool.query(
    'INSERT INTO club_slideshow_images (club_id, image_url, sort_order) VALUES ($1, $2, $3) RETURNING id, image_url',
    [ctx.club.id, imageUrl, maxOrder + 1]
  );
  res.json({ image });
});

app.delete('/api/clubs/:slug/slideshow/:imageId', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM club_slideshow_images WHERE id = $1 AND club_id = $2', [req.params.imageId, ctx.club.id]
  );
  if (!existing) return res.status(404).json({ error: 'Image not found.' });
  if (existing.image_url.startsWith('/images/moderators/')) {
    const oldPath = path.join('/var/www/btw', existing.image_url);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  await pool.query('DELETE FROM club_slideshow_images WHERE id = $1', [existing.id]);
  res.json({ message: 'Image removed.' });
});

app.put('/api/clubs/:slug/slideshow/reorder', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const order = req.body.order;
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order must be a non-empty array of image IDs.' });
  await pool.query('BEGIN');
  try {
    for (let i = 0; i < order.length; i++) {
      await pool.query(
        'UPDATE club_slideshow_images SET sort_order = $1 WHERE id = $2 AND club_id = $3',
        [i, order[i], ctx.club.id]
      );
    }
    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    return res.status(500).json({ error: 'Could not save the new order.' });
  }
  res.json({ message: 'Order saved.' });
});

// GET /api/clubs/:slug/rules — the sidebar rules list (preview + full
// description, expanded on click client-side).
app.get('/api/clubs/:slug/rules', async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const { rows } = await pool.query(
    'SELECT id, title, description FROM club_rules WHERE club_id = $1 ORDER BY sort_order, created_at',
    [club.id]
  );
  res.json({ rules: rows });
});

// POST /api/clubs/:slug/rules — { title, description }. title is the short
// "preview text" shown collapsed; description is the elaborate explanation
// shown on expand.
app.post('/api/clubs/:slug/rules', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const title = String(req.body.title || '').trim().slice(0, 100);
  const description = String(req.body.description || '').trim().slice(0, 1000);
  if (!title) return res.status(400).json({ error: 'A preview text/title is required.' });
  const { rows: [{ maxOrder }] } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder" FROM club_rules WHERE club_id = $1', [ctx.club.id]
  );
  const { rows: [rule] } = await pool.query(
    `INSERT INTO club_rules (club_id, title, description, sort_order)
     VALUES ($1, $2, $3, $4) RETURNING id, title, description`,
    [ctx.club.id, title, description, maxOrder + 1]
  );
  res.json({ rule });
});

app.put('/api/clubs/:slug/rules/:ruleId', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM club_rules WHERE id = $1 AND club_id = $2', [req.params.ruleId, ctx.club.id]
  );
  if (!existing) return res.status(404).json({ error: 'Rule not found.' });
  const title = req.body.title !== undefined ? String(req.body.title).trim().slice(0, 100) || existing.title : existing.title;
  const description = req.body.description !== undefined ? String(req.body.description).trim().slice(0, 1000) : existing.description;
  const { rows: [rule] } = await pool.query(
    'UPDATE club_rules SET title = $1, description = $2 WHERE id = $3 RETURNING id, title, description',
    [title, description, existing.id]
  );
  res.json({ rule });
});

app.delete('/api/clubs/:slug/rules/:ruleId', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const { rowCount } = await pool.query(
    'DELETE FROM club_rules WHERE id = $1 AND club_id = $2', [req.params.ruleId, ctx.club.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Rule not found.' });
  res.json({ message: 'Rule deleted.' });
});

// PUT /api/clubs/:slug/rules/reorder — { order: [ruleId, ...] }.
app.put('/api/clubs/:slug/rules/reorder', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const order = req.body.order;
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order must be a non-empty array of rule IDs.' });
  await pool.query('BEGIN');
  try {
    for (let i = 0; i < order.length; i++) {
      await pool.query('UPDATE club_rules SET sort_order = $1 WHERE id = $2 AND club_id = $3', [i, order[i], ctx.club.id]);
    }
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to reorder rules.' });
  }
  res.json({ message: 'Reordered.' });
});

// GET /api/clubs/:slug/pages — sidebar "More Pages" list (slug + title
// only; Home isn't in here, it's the built-in default page).
app.get('/api/clubs/:slug/pages', async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const { rows } = await pool.query(
    'SELECT slug, title, type FROM club_pages WHERE club_id = $1 ORDER BY sort_order, created_at',
    [club.id]
  );
  res.json({ pages: rows });
});

// GET /api/clubs/:slug/pages/:pageSlug — a single custom page's content.
app.get('/api/clubs/:slug/pages/:pageSlug', async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const { rows: [page] } = await pool.query(
    'SELECT slug, title, type, content, cover_mode, cover_image_url, text_fields FROM club_pages WHERE club_id = $1 AND slug = $2',
    [club.id, req.params.pageSlug]
  );
  if (!page) return res.status(404).json({ error: 'Page not found.' });
  res.json({ page });
});

// POST /api/clubs/:slug/pages — create a page from one of the three
// templates. No dedicated editor for the template content yet (that's
// next); this just reserves the title/type/slug so it shows up in the
// Pages list immediately.
app.post('/api/clubs/:slug/pages', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const title = String(req.body.title || '').trim().slice(0, 60);
  const type = ['general', 'promotion', 'gallery'].includes(req.body.type) ? req.body.type : 'general';
  if (!title) return res.status(400).json({ error: 'A page title is required.' });

  const baseSlug = title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
  let pageSlug = baseSlug;
  let n = 1;
  while (true) {
    const { rows: [existing] } = await pool.query(
      'SELECT id FROM club_pages WHERE club_id = $1 AND slug = $2', [ctx.club.id, pageSlug]
    );
    if (!existing) break;
    n += 1;
    pageSlug = `${baseSlug}-${n}`;
  }

  const { rows: [{ maxOrder }] } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder" FROM club_pages WHERE club_id = $1', [ctx.club.id]
  );
  const { rows: [page] } = await pool.query(
    `INSERT INTO club_pages (club_id, slug, title, type, sort_order) VALUES ($1, $2, $3, $4, $5)
     RETURNING slug, title, type`,
    [ctx.club.id, pageSlug, title, type, maxOrder + 1]
  );
  res.json({ page });
});

// PUT /api/clubs/:slug/pages/reorder — { order: [slug, ...] }. Registered
// before /:pageSlug below (same route-ordering gotcha as the other
// reorder endpoints in this file). Home isn't a club_pages row at all, so
// there's nothing to enforce here — the client just never lets Home be
// dragged out of first place.
app.put('/api/clubs/:slug/pages/reorder', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const order = req.body.order;
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order must be a non-empty array of page slugs.' });
  await pool.query('BEGIN');
  try {
    for (let i = 0; i < order.length; i++) {
      await pool.query('UPDATE club_pages SET sort_order = $1 WHERE club_id = $2 AND slug = $3', [i, ctx.club.id, order[i]]);
    }
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to reorder pages.' });
  }
  res.json({ message: 'Reordered.' });
});

// PUT /api/clubs/:slug/pages/:pageSlug — rename/re-content a page (title
// for now; the type-specific content editors land later).
app.put('/api/clubs/:slug/pages/:pageSlug', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM club_pages WHERE club_id = $1 AND slug = $2', [ctx.club.id, req.params.pageSlug]
  );
  if (!existing) return res.status(404).json({ error: 'Page not found.' });
  const title = req.body.title !== undefined ? String(req.body.title).trim().slice(0, 60) || existing.title : existing.title;
  const content = req.body.content !== undefined ? String(req.body.content).slice(0, 20000) : existing.content;
  const { rows: [page] } = await pool.query(
    'UPDATE club_pages SET title = $1, content = $2 WHERE id = $3 RETURNING slug, title, type, content, cover_mode, cover_image_url, text_fields',
    [title, content, existing.id]
  );
  res.json({ page });
});

// PUT /api/clubs/:slug/pages/:pageSlug/text-fields — General Page template's
// up-to-three named text sections: { fields: [{title, body}, ...] }.
app.put('/api/clubs/:slug/pages/:pageSlug/text-fields', requireAuth, async (req, res) => {
  const ctx = await requireClubPageAdmin(req, res);
  if (!ctx) return;
  const fieldsIn = Array.isArray(req.body.fields) ? req.body.fields.slice(0, 3) : [];
  const fields = fieldsIn.map(f => ({
    title: String((f && f.title) || '').trim().slice(0, 80),
    body: String((f && f.body) || '').trim().slice(0, 5000),
  })).filter(f => f.title || f.body);
  await pool.query('UPDATE club_pages SET text_fields = $1 WHERE id = $2', [JSON.stringify(fields), ctx.page.id]);
  res.json({ text_fields: fields });
});

app.put('/api/clubs/:slug/pages/:pageSlug/cover-mode', requireAuth, async (req, res) => {
  const ctx = await requireClubPageAdmin(req, res);
  if (!ctx) return;
  const mode = req.body.cover_mode === 'slideshow' ? 'slideshow' : 'static';
  await pool.query('UPDATE club_pages SET cover_mode = $1 WHERE id = $2', [mode, ctx.page.id]);
  res.json({ cover_mode: mode });
});

app.put('/api/clubs/:slug/pages/:pageSlug/cover-image', requireAuth, uploadModImage.single('image'), async (req, res) => {
  const ctx = await requireClubPageAdmin(req, res);
  if (!ctx) return;
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const imageUrl = `/images/moderators/${req.file.filename}`;
  if (ctx.page.cover_image_url.startsWith('/images/moderators/')) {
    const oldPath = path.join('/var/www/btw', ctx.page.cover_image_url);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  await pool.query('UPDATE club_pages SET cover_image_url = $1 WHERE id = $2', [imageUrl, ctx.page.id]);
  res.json({ cover_image_url: imageUrl });
});

// DELETE /api/clubs/:slug/pages/:pageSlug/cover-image — "No Image": clears
// the static cover back to the default (no-cover) view.
app.delete('/api/clubs/:slug/pages/:pageSlug/cover-image', requireAuth, async (req, res) => {
  const ctx = await requireClubPageAdmin(req, res);
  if (!ctx) return;
  if (ctx.page.cover_image_url.startsWith('/images/moderators/')) {
    const oldPath = path.join('/var/www/btw', ctx.page.cover_image_url);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  await pool.query("UPDATE club_pages SET cover_image_url = '' WHERE id = $1", [ctx.page.id]);
  res.json({ cover_image_url: '' });
});

app.get('/api/clubs/:slug/pages/:pageSlug/slideshow', async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const { rows: [page] } = await pool.query(
    'SELECT id FROM club_pages WHERE club_id = $1 AND slug = $2', [club.id, req.params.pageSlug]
  );
  if (!page) return res.status(404).json({ error: 'Page not found.' });
  const { rows } = await pool.query(
    'SELECT id, image_url FROM club_page_slideshow_images WHERE page_id = $1 ORDER BY sort_order, created_at',
    [page.id]
  );
  res.json({ images: rows });
});

app.post('/api/clubs/:slug/pages/:pageSlug/slideshow', requireAuth, uploadModImage.single('image'), async (req, res) => {
  const ctx = await requireClubPageAdmin(req, res);
  if (!ctx) return;
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const imageUrl = `/images/moderators/${req.file.filename}`;
  const { rows: [{ maxOrder }] } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder" FROM club_page_slideshow_images WHERE page_id = $1', [ctx.page.id]
  );
  const { rows: [image] } = await pool.query(
    'INSERT INTO club_page_slideshow_images (page_id, image_url, sort_order) VALUES ($1, $2, $3) RETURNING id, image_url',
    [ctx.page.id, imageUrl, maxOrder + 1]
  );
  res.json({ image });
});

app.delete('/api/clubs/:slug/pages/:pageSlug/slideshow/:imageId', requireAuth, async (req, res) => {
  const ctx = await requireClubPageAdmin(req, res);
  if (!ctx) return;
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM club_page_slideshow_images WHERE id = $1 AND page_id = $2', [req.params.imageId, ctx.page.id]
  );
  if (!existing) return res.status(404).json({ error: 'Image not found.' });
  if (existing.image_url.startsWith('/images/moderators/')) {
    const oldPath = path.join('/var/www/btw', existing.image_url);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  await pool.query('DELETE FROM club_page_slideshow_images WHERE id = $1', [existing.id]);
  res.json({ message: 'Image removed.' });
});

app.put('/api/clubs/:slug/pages/:pageSlug/slideshow/reorder', requireAuth, async (req, res) => {
  const ctx = await requireClubPageAdmin(req, res);
  if (!ctx) return;
  const order = req.body.order;
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order must be a non-empty array of image IDs.' });
  await pool.query('BEGIN');
  try {
    for (let i = 0; i < order.length; i++) {
      await pool.query(
        'UPDATE club_page_slideshow_images SET sort_order = $1 WHERE id = $2 AND page_id = $3',
        [i, order[i], ctx.page.id]
      );
    }
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to reorder images.' });
  }
  res.json({ message: 'Reordered.' });
});

// ── Gallery Page template — a simple image collection with an optional
// title/description per image, no forced crop (position_x/position_y is
// only a focal-point for the square preview tile, same idea as the
// Fanpage gallery system's "locked preview crop"). ─────────────────────────
app.get('/api/clubs/:slug/pages/:pageSlug/gallery', async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const { rows: [page] } = await pool.query(
    'SELECT id FROM club_pages WHERE club_id = $1 AND slug = $2', [club.id, req.params.pageSlug]
  );
  if (!page) return res.status(404).json({ error: 'Page not found.' });
  let userId = null;
  try {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) userId = jwt.verify(h.slice(7), process.env.JWT_SECRET).id;
  } catch {}
  const { rows } = await pool.query(
    `SELECT g.id, g.image_url, g.title, g.description, g.position_x, g.position_y,
       (SELECT COUNT(*)::int FROM club_page_gallery_likes WHERE image_id = g.id) AS like_count,
       (SELECT COUNT(*) > 0 FROM club_page_gallery_likes WHERE image_id = g.id AND user_id = $2) AS user_liked
     FROM club_page_gallery_images g WHERE g.page_id = $1 ORDER BY g.sort_order, g.created_at`,
    [page.id, userId || 0]
  );
  res.json({ images: rows });
});

app.post('/api/clubs/:slug/pages/:pageSlug/gallery/:imageId/like', requireAuth, async (req, res) => {
  const { rows: [image] } = await pool.query(
    `SELECT g.id FROM club_page_gallery_images g
     JOIN club_pages p ON p.id = g.page_id JOIN clubs c ON c.id = p.club_id
     WHERE c.slug = $1 AND p.slug = $2 AND g.id = $3`,
    [req.params.slug, req.params.pageSlug, req.params.imageId]
  );
  if (!image) return res.status(404).json({ error: 'Image not found.' });
  await pool.query(
    'INSERT INTO club_page_gallery_likes (image_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [image.id, req.user.id]
  );
  const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int AS count FROM club_page_gallery_likes WHERE image_id = $1', [image.id]);
  res.json({ liked: true, like_count: count });
});

app.delete('/api/clubs/:slug/pages/:pageSlug/gallery/:imageId/like', requireAuth, async (req, res) => {
  const { rows: [image] } = await pool.query(
    `SELECT g.id FROM club_page_gallery_images g
     JOIN club_pages p ON p.id = g.page_id JOIN clubs c ON c.id = p.club_id
     WHERE c.slug = $1 AND p.slug = $2 AND g.id = $3`,
    [req.params.slug, req.params.pageSlug, req.params.imageId]
  );
  if (!image) return res.status(404).json({ error: 'Image not found.' });
  await pool.query('DELETE FROM club_page_gallery_likes WHERE image_id = $1 AND user_id = $2', [image.id, req.user.id]);
  const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int AS count FROM club_page_gallery_likes WHERE image_id = $1', [image.id]);
  res.json({ liked: false, like_count: count });
});

app.post('/api/clubs/:slug/pages/:pageSlug/gallery', requireAuth, uploadModImage.single('image'), async (req, res) => {
  const ctx = await requireClubPageAdmin(req, res);
  if (!ctx) return;
  if (!req.file) return res.status(400).json({ error: 'Image is required.' });
  const imageUrl = `/images/moderators/${req.file.filename}`;
  const title = String(req.body.title || '').trim().slice(0, 80);
  const description = String(req.body.description || '').trim().slice(0, 1000);
  const positionX = clampPosition(req.body.position_x);
  const positionY = clampPosition(req.body.position_y);
  const { rows: [{ maxOrder }] } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder" FROM club_page_gallery_images WHERE page_id = $1', [ctx.page.id]
  );
  const { rows: [image] } = await pool.query(
    `INSERT INTO club_page_gallery_images (page_id, image_url, title, description, position_x, position_y, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, image_url, title, description, position_x, position_y`,
    [ctx.page.id, imageUrl, title, description, positionX, positionY, maxOrder + 1]
  );
  res.json({ image });
});

// Registered BEFORE the /:imageId routes below — otherwise Express matches
// "reorder" as :imageId on this same PUT method and the SQL blows up trying
// to parse it as an integer (this exact class of bug bit the moderator
// characters reorder route earlier; same fix, route order matters here).
app.put('/api/clubs/:slug/pages/:pageSlug/gallery/reorder', requireAuth, async (req, res) => {
  const ctx = await requireClubPageAdmin(req, res);
  if (!ctx) return;
  const order = req.body.order;
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order must be a non-empty array of image IDs.' });
  await pool.query('BEGIN');
  try {
    for (let i = 0; i < order.length; i++) {
      await pool.query(
        'UPDATE club_page_gallery_images SET sort_order = $1 WHERE id = $2 AND page_id = $3',
        [i, order[i], ctx.page.id]
      );
    }
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to reorder images.' });
  }
  res.json({ message: 'Reordered.' });
});

app.put('/api/clubs/:slug/pages/:pageSlug/gallery/:imageId', requireAuth, uploadModImage.single('image'), async (req, res) => {
  const ctx = await requireClubPageAdmin(req, res);
  if (!ctx) return;
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM club_page_gallery_images WHERE id = $1 AND page_id = $2', [req.params.imageId, ctx.page.id]
  );
  if (!existing) return res.status(404).json({ error: 'Image not found.' });

  const title = req.body.title !== undefined ? String(req.body.title).trim().slice(0, 80) : existing.title;
  const description = req.body.description !== undefined ? String(req.body.description).trim().slice(0, 1000) : existing.description;
  const positionX = req.body.position_x !== undefined ? clampPosition(req.body.position_x) : existing.position_x;
  const positionY = req.body.position_y !== undefined ? clampPosition(req.body.position_y) : existing.position_y;
  let imageUrl = existing.image_url;
  if (req.file) {
    imageUrl = `/images/moderators/${req.file.filename}`;
    if (existing.image_url.startsWith('/images/moderators/')) {
      const oldPath = path.join('/var/www/btw', existing.image_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }
  const { rows: [image] } = await pool.query(
    `UPDATE club_page_gallery_images SET image_url = $1, title = $2, description = $3, position_x = $4, position_y = $5
     WHERE id = $6 RETURNING id, image_url, title, description, position_x, position_y`,
    [imageUrl, title, description, positionX, positionY, existing.id]
  );
  res.json({ image });
});

app.delete('/api/clubs/:slug/pages/:pageSlug/gallery/:imageId', requireAuth, async (req, res) => {
  const ctx = await requireClubPageAdmin(req, res);
  if (!ctx) return;
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM club_page_gallery_images WHERE id = $1 AND page_id = $2', [req.params.imageId, ctx.page.id]
  );
  if (!existing) return res.status(404).json({ error: 'Image not found.' });
  if (existing.image_url.startsWith('/images/moderators/')) {
    const oldPath = path.join('/var/www/btw', existing.image_url);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  await pool.query('DELETE FROM club_page_gallery_images WHERE id = $1', [existing.id]);
  res.json({ message: 'Image removed.' });
});

// ── Promotion Page template — a vertical list of link-out cards. Image is
// optional (falls back to /images/noimage.png client-side); everything
// else is required. ─────────────────────────────────────────────────────
app.get('/api/clubs/:slug/pages/:pageSlug/promotion-cards', async (req, res) => {
  const { rows: [club] } = await pool.query('SELECT id FROM clubs WHERE slug = $1', [req.params.slug]);
  if (!club) return res.status(404).json({ error: 'Club not found.' });
  const { rows: [page] } = await pool.query(
    'SELECT id FROM club_pages WHERE club_id = $1 AND slug = $2', [club.id, req.params.pageSlug]
  );
  if (!page) return res.status(404).json({ error: 'Page not found.' });
  const { rows } = await pool.query(
    `SELECT id, image_url, title, description, link_title, link_url
     FROM club_page_promotion_cards WHERE page_id = $1 ORDER BY sort_order, created_at`,
    [page.id]
  );
  res.json({ cards: rows });
});

function normalizeLinkUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

app.post('/api/clubs/:slug/pages/:pageSlug/promotion-cards', requireAuth, uploadModImage.single('image'), async (req, res) => {
  const ctx = await requireClubPageAdmin(req, res);
  if (!ctx) return;
  const title = String(req.body.title || '').trim().slice(0, 80);
  const description = String(req.body.description || '').trim().slice(0, 1000);
  const linkTitle = String(req.body.link_title || '').trim().slice(0, 60);
  const linkUrl = normalizeLinkUrl(req.body.link_url);
  if (!title || !description || !linkTitle || !linkUrl) {
    return res.status(400).json({ error: 'Title, description, link title, and link URL are all required.' });
  }
  const imageUrl = req.file ? `/images/moderators/${req.file.filename}` : '';
  const { rows: [{ maxOrder }] } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS "maxOrder" FROM club_page_promotion_cards WHERE page_id = $1', [ctx.page.id]
  );
  const { rows: [card] } = await pool.query(
    `INSERT INTO club_page_promotion_cards (page_id, image_url, title, description, link_title, link_url, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, image_url, title, description, link_title, link_url`,
    [ctx.page.id, imageUrl, title, description, linkTitle, linkUrl, maxOrder + 1]
  );
  res.json({ card });
});

// Registered BEFORE /:cardId below — same route-ordering gotcha as the
// gallery reorder route (Express would otherwise match "reorder" as
// :cardId on this same PUT method).
app.put('/api/clubs/:slug/pages/:pageSlug/promotion-cards/reorder', requireAuth, async (req, res) => {
  const ctx = await requireClubPageAdmin(req, res);
  if (!ctx) return;
  const order = req.body.order;
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order must be a non-empty array of card IDs.' });
  await pool.query('BEGIN');
  try {
    for (let i = 0; i < order.length; i++) {
      await pool.query(
        'UPDATE club_page_promotion_cards SET sort_order = $1 WHERE id = $2 AND page_id = $3',
        [i, order[i], ctx.page.id]
      );
    }
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to reorder cards.' });
  }
  res.json({ message: 'Reordered.' });
});

app.put('/api/clubs/:slug/pages/:pageSlug/promotion-cards/:cardId', requireAuth, uploadModImage.single('image'), async (req, res) => {
  const ctx = await requireClubPageAdmin(req, res);
  if (!ctx) return;
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM club_page_promotion_cards WHERE id = $1 AND page_id = $2', [req.params.cardId, ctx.page.id]
  );
  if (!existing) return res.status(404).json({ error: 'Card not found.' });

  const title = req.body.title !== undefined ? String(req.body.title).trim().slice(0, 80) : existing.title;
  const description = req.body.description !== undefined ? String(req.body.description).trim().slice(0, 1000) : existing.description;
  const linkTitle = req.body.link_title !== undefined ? String(req.body.link_title).trim().slice(0, 60) : existing.link_title;
  const linkUrl = req.body.link_url !== undefined ? normalizeLinkUrl(req.body.link_url) : existing.link_url;
  if (!title || !description || !linkTitle || !linkUrl) {
    return res.status(400).json({ error: 'Title, description, link title, and link URL are all required.' });
  }
  let imageUrl = existing.image_url;
  if (req.file) {
    imageUrl = `/images/moderators/${req.file.filename}`;
    if (existing.image_url.startsWith('/images/moderators/')) {
      const oldPath = path.join('/var/www/btw', existing.image_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }
  const { rows: [card] } = await pool.query(
    `UPDATE club_page_promotion_cards SET image_url = $1, title = $2, description = $3, link_title = $4, link_url = $5
     WHERE id = $6 RETURNING id, image_url, title, description, link_title, link_url`,
    [imageUrl, title, description, linkTitle, linkUrl, existing.id]
  );
  res.json({ card });
});

app.delete('/api/clubs/:slug/pages/:pageSlug/promotion-cards/:cardId', requireAuth, async (req, res) => {
  const ctx = await requireClubPageAdmin(req, res);
  if (!ctx) return;
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM club_page_promotion_cards WHERE id = $1 AND page_id = $2', [req.params.cardId, ctx.page.id]
  );
  if (!existing) return res.status(404).json({ error: 'Card not found.' });
  if (existing.image_url.startsWith('/images/moderators/')) {
    const oldPath = path.join('/var/www/btw', existing.image_url);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  await pool.query('DELETE FROM club_page_promotion_cards WHERE id = $1', [existing.id]);
  res.json({ message: 'Card removed.' });
});

app.delete('/api/clubs/:slug/pages/:pageSlug', requireAuth, async (req, res) => {
  const ctx = await requireClubAdmin(req, res);
  if (!ctx) return;
  const { rowCount } = await pool.query(
    'DELETE FROM club_pages WHERE club_id = $1 AND slug = $2', [ctx.club.id, req.params.pageSlug]
  );
  if (!rowCount) return res.status(404).json({ error: 'Page not found.' });
  res.json({ message: 'Page deleted.' });
});

// GET /api/clubs-feed — recent posts across every club, for the Social hub.
// GET /api/clubs-feed — the site-wide "Best/Recent/Top" home feed across
// every club. Ranking, in plain terms:
//   Best  — a Reddit-"Hot"-style score: log10(likes + comments*2 + 1), so
//           engagement has diminishing returns (10x the engagement only
//           buys +1), PLUS a clock term that adds ~1 every 12.5h so newer
//           posts don't need as much engagement to compete — then a flat
//           bonus if the viewer is a MEMBER of that post's club (+2, worth
//           roughly 100 extra likes on the log scale) or has VISITED it
//           recently (+0.5, a much gentler nudge).
//   Top   — pure (likes + comments), no time decay, no personalization.
//   New   — plain chronological.
app.get('/api/clubs-feed', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  const sort = ['best', 'top', 'new'].includes(req.query.sort) ? req.query.sort : 'best';
  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }
  let nsfwAllowed = true; // guests see everything now; only SFW Mode filters
  if (viewerId) {
    const { rows: [row] } = await pool.query('SELECT nsfw_enabled FROM users WHERE id = $1', [viewerId]);
    nsfwAllowed = !!(row && row.nsfw_enabled);
  }

  // Same alias-in-ORDER-BY limitation as the per-club posts endpoint above.
  const hotScoreExpr = `LOG(10, GREATEST(
         (SELECT COUNT(*)::int FROM club_post_likes WHERE post_id = cp.id)
         + (SELECT COUNT(*)::int FROM content_comments WHERE target_type = 'club_post' AND target_id = cp.id) * 2,
       1)::numeric)
         + EXTRACT(EPOCH FROM cp.created_at) / 45000
         + CASE WHEN cm.user_id IS NOT NULL THEN 2 ELSE 0 END
         + CASE WHEN cv.user_id IS NOT NULL AND cv.last_visited_at > NOW() - INTERVAL '30 days' THEN 0.5 ELSE 0 END`;
  const orderBy = sort === 'new' ? 'cp.created_at DESC'
    : sort === 'top' ? `(SELECT COUNT(*)::int FROM club_post_likes WHERE post_id = cp.id)
        + (SELECT COUNT(*)::int FROM content_comments WHERE target_type = 'club_post' AND target_id = cp.id) DESC, cp.created_at DESC`
    : `${hotScoreExpr} + (random() - 0.5) * 0.3 DESC`;

  const { rows } = await pool.query(
    `SELECT cp.*, u.username, u.display_name, u.avatar, c.slug AS club_slug, c.name AS club_name, c.icon_url AS club_icon,
       (SELECT COUNT(*)::int FROM club_post_likes WHERE post_id = cp.id) AS like_count,
       (SELECT COUNT(*)::int FROM content_comments WHERE target_type = 'club_post' AND target_id = cp.id) AS comment_count,
       (SELECT COUNT(*) > 0 FROM club_post_likes WHERE post_id = cp.id AND user_id = $2) AS user_liked,
       ${hotScoreExpr} AS hot_score
     FROM club_posts cp
     JOIN users u ON u.id = cp.author_user_id
     JOIN clubs c ON c.id = cp.club_id
     LEFT JOIN club_members cm ON cm.club_id = cp.club_id AND cm.user_id = $2
     LEFT JOIN club_visits cv ON cv.club_id = cp.club_id AND cv.user_id = $2
     ${nsfwAllowed ? '' : 'WHERE c.is_nsfw = FALSE'}
     ORDER BY ${orderBy}
     LIMIT $1`,
    [limit, viewerId || 0]
  );
  res.json({ posts: rows.map(p => ({
    id: p.id, title: p.title, body: p.body, created_at: p.created_at,
    image_url: p.image_url || '', preview_position_x: p.preview_position_x, preview_position_y: p.preview_position_y,
    like_count: Number(p.like_count) || 0, comment_count: Number(p.comment_count) || 0, user_liked: !!p.user_liked,
    author: { id: p.author_user_id, username: p.username, display_name: p.display_name || p.username, avatar: p.avatar || null },
    club: { slug: p.club_slug, name: p.club_name, icon_url: p.club_icon || null },
  })), sort });
});

// GET /api/clubs-recommended — the home page's "Recommended Clubs" panel.
// One post per club (its own best-scoring one, so the panel reads as
// "here's a taste of each place" rather than one club flooding the list).
// Unjoined clubs sort first — clubs they've visited recently but not
// joined take priority over that (the nudge-to-join signal), then Hot
// score. Joined clubs aren't excluded anymore, just deprioritized — if
// someone's already in every club with posts, the panel still has
// something to show instead of going empty.
app.get('/api/clubs-recommended', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 6, 20);
  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }
  let nsfwAllowed = true; // guests see everything now; only SFW Mode filters
  if (viewerId) {
    const { rows: [row] } = await pool.query('SELECT nsfw_enabled FROM users WHERE id = $1', [viewerId]);
    nsfwAllowed = !!(row && row.nsfw_enabled);
  }
  const { rows } = await pool.query(
    `WITH per_club AS (
       SELECT DISTINCT ON (cp.club_id) cp.*, u.username, u.display_name, u.avatar,
         c.slug AS club_slug, c.name AS club_name, c.icon_url AS club_icon,
         (SELECT COUNT(*)::int FROM club_post_likes WHERE post_id = cp.id) AS like_count,
         (SELECT COUNT(*)::int FROM content_comments WHERE target_type = 'club_post' AND target_id = cp.id) AS comment_count,
         (SELECT COUNT(*) > 0 FROM club_post_likes WHERE post_id = cp.id AND user_id = $2) AS user_liked,
         EXISTS(SELECT 1 FROM club_members cm WHERE cm.club_id = cp.club_id AND cm.user_id = $2) AS already_joined,
         (cv.user_id IS NOT NULL AND cv.last_visited_at > NOW() - INTERVAL '30 days') AS recently_visited,
         LOG(10, GREATEST(
           (SELECT COUNT(*)::int FROM club_post_likes WHERE post_id = cp.id)
           + (SELECT COUNT(*)::int FROM content_comments WHERE target_type = 'club_post' AND target_id = cp.id) * 2,
         1)::numeric) + EXTRACT(EPOCH FROM cp.created_at) / 45000 AS hot_score
       FROM club_posts cp
       JOIN users u ON u.id = cp.author_user_id
       JOIN clubs c ON c.id = cp.club_id
       LEFT JOIN club_visits cv ON cv.club_id = cp.club_id AND cv.user_id = $2
       WHERE 1=1 ${nsfwAllowed ? '' : 'AND c.is_nsfw = FALSE'}
       ORDER BY cp.club_id, hot_score DESC
     )
     SELECT * FROM per_club ORDER BY already_joined ASC, recently_visited DESC, hot_score + (random() - 0.5) * 0.3 DESC LIMIT $1`,
    [limit, viewerId || 0]
  );
  res.json({ posts: rows.map(p => ({
    id: p.id, title: p.title, body: p.body, created_at: p.created_at,
    image_url: p.image_url || '', preview_position_x: p.preview_position_x, preview_position_y: p.preview_position_y,
    like_count: Number(p.like_count) || 0, comment_count: Number(p.comment_count) || 0, user_liked: !!p.user_liked,
    already_joined: !!p.already_joined, recently_visited: !!p.recently_visited,
    author: { id: p.author_user_id, username: p.username, display_name: p.display_name || p.username, avatar: p.avatar || null },
    club: { slug: p.club_slug, name: p.club_name, icon_url: p.club_icon || null },
  })) });
});

// GET /api/clubs-explore — the Explore page's "Recommended for you" row plus
// a handful of "More like <club>" rows, Reddit-Explore-style.
//
// Recommended: ranked by how many club_types a candidate club shares with
// the *set* of every club the viewer belongs to (their whole topic
// footprint at once), tie-broken by member_count so popular clubs edge out
// quiet ones on an even topic match. Logged-out viewers (or members of
// zero clubs) just get the site's most-populated clubs -- there's no
// affinity signal to build from yet.
//
// "More like X": one row per club the viewer belongs to (their most
// recently joined, capped at 3 so the page doesn't run on forever), ranked
// by *shared members* with that specific club -- how many people who are in
// X are also in the candidate -- rather than topic overlap, since that's a
// real behavioral signal (people who joined both) instead of a metadata
// coincidence. Falls back to a couple of popularity-based rows when the
// viewer isn't in any club.
app.get('/api/clubs-explore', async (req, res) => {
  let viewerId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { viewerId = jwt.verify(auth.slice(7), process.env.JWT_SECRET).id; } catch {}
  }
  let nsfwAllowed = true; // guests see everything now; only SFW Mode filters
  if (viewerId) {
    const { rows: [row] } = await pool.query('SELECT nsfw_enabled FROM users WHERE id = $1', [viewerId]);
    nsfwAllowed = !!(row && row.nsfw_enabled);
  }
  const nsfwClause = nsfwAllowed ? '' : 'AND c.is_nsfw = FALSE';

  const { rows: myClubs } = viewerId
    ? await pool.query(
        `SELECT c.id, c.slug, c.name FROM club_members cm JOIN clubs c ON c.id = cm.club_id
         WHERE cm.user_id = $1 ORDER BY cm.joined_at DESC LIMIT 3`,
        [viewerId]
      )
    : { rows: [] };

  let recommended;
  if (myClubs.length) {
    const { rows } = await pool.query(
      `WITH my_types AS (
         SELECT DISTINCT jsonb_array_elements_text(club_types) AS t FROM clubs WHERE id = ANY($1::int[])
       )
       SELECT c.*, COUNT(DISTINCT cm.id)::int AS member_count,
              (SELECT COUNT(*)::int FROM my_types mt WHERE c.club_types ? mt.t) AS shared_types
       FROM clubs c
       LEFT JOIN club_members cm ON cm.club_id = c.id
       WHERE c.id != ALL($1::int[])
         AND NOT EXISTS (SELECT 1 FROM club_members m2 WHERE m2.club_id = c.id AND m2.user_id = $2)
         ${nsfwClause}
       GROUP BY c.id
       HAVING (SELECT COUNT(*)::int FROM my_types mt WHERE c.club_types ? mt.t) > 0
       ORDER BY shared_types DESC, member_count DESC
       LIMIT 12`,
      [myClubs.map(c => c.id), viewerId || 0]
    );
    recommended = rows;
  } else {
    const { rows } = await pool.query(
      `SELECT c.*, COUNT(cm.id)::int AS member_count
       FROM clubs c LEFT JOIN club_members cm ON cm.club_id = c.id
       WHERE 1=1 ${nsfwClause}
       GROUP BY c.id ORDER BY member_count DESC, c.created_at DESC LIMIT 12`,
      []
    );
    recommended = rows;
  }

  const sections = [];
  for (const mine of myClubs) {
    const { rows } = await pool.query(
      `SELECT c.*, COUNT(DISTINCT cm.id)::int AS member_count,
              COUNT(DISTINCT shared.user_id)::int AS shared_members
       FROM clubs c
       LEFT JOIN club_members cm ON cm.club_id = c.id
       LEFT JOIN club_members shared ON shared.club_id = c.id
         AND shared.user_id IN (SELECT user_id FROM club_members WHERE club_id = $1)
       WHERE c.id != $1
         AND NOT EXISTS (SELECT 1 FROM club_members m2 WHERE m2.club_id = c.id AND m2.user_id = $2)
         ${nsfwClause}
       GROUP BY c.id
       ORDER BY shared_members DESC, member_count DESC
       LIMIT 8`,
      [mine.id, viewerId || 0]
    );
    if (rows.some(r => r.shared_members > 0)) {
      sections.push({ title: `More like ${mine.name}`, clubs: rows.map(r => clubPublicShape(r, null)) });
    }
  }
  // Logged out, or none of their clubs had any real overlap signal yet --
  // give the page something to show instead of an empty Explore.
  if (!sections.length) {
    const { rows } = await pool.query(
      `SELECT c.*, COUNT(cm.id)::int AS member_count
       FROM clubs c LEFT JOIN club_members cm ON cm.club_id = c.id
       WHERE 1=1 ${nsfwClause}
       GROUP BY c.id ORDER BY c.created_at DESC LIMIT 8`,
      []
    );
    if (rows.length) sections.push({ title: 'New Clubs', clubs: rows.map(r => clubPublicShape(r, null)) });
  }

  res.json({
    recommended: recommended.map(r => clubPublicShape(r, null)),
    sections,
  });
});

// ── Error handler ────────────────────────────────────────────────────────────
// Catches multer errors (oversized file, bad field, etc.) that would
// otherwise bubble up to Express's default handler and come back as a
// non-JSON response — every upload flow's frontend does `res.ok` + a
// generic "upload failed" alert, so at minimum this keeps that response
// actually parseable, and gives a real reason for the most common case.
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'That file is too large (25MB max).' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
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
