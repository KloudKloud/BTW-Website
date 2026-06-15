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

  await pool.query(`UPDATE community_posts SET tag = 'Art/Fanart' WHERE tag = 'Fanart'`).catch(() => {});

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
  const { rows: [user] } = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
  if (!user) return false;
  const hash = crypto.createHash('sha256').update(user.email.toLowerCase()).digest('hex');
  return hash === process.env.ADMIN_EMAIL_HASH;
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
    const { username, display_name, email, password } = req.body;

    if (!username || !email || !password)
      return res.status(400).json({ error: 'Username, email and password are required.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!/^[a-zA-Z0-9_]+$/.test(username))
      return res.status(400).json({ error: 'Username may only contain letters, numbers and underscores.' });

    const { rows: [existing] } = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [email.toLowerCase(), username.toLowerCase()]
    );
    if (existing)
      return res.status(409).json({ error: 'That username or email is already registered.' });

    const password_hash = await bcrypt.hash(password, 12);
    const verify_token  = crypto.randomBytes(32).toString('hex');
    const dname         = (display_name?.trim() || username).slice(0, 20);

    await pool.query(
      'INSERT INTO users (username, display_name, email, password_hash, verify_token) VALUES ($1, $2, $3, $4, $5)',
      [username.toLowerCase(), dname, email.toLowerCase(), password_hash, verify_token]
    );

    const verifyUrl = `https://${process.env.SITE_HOST}/api/auth/verify?token=${verify_token}`;

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

// GET /api/auth/verify?token=xxx
app.get('/api/auth/verify', async (req, res) => {
  const { token } = req.query;
  const { rows: [user] } = await pool.query('SELECT * FROM users WHERE verify_token = $1', [token]);
  if (!user) {
    return res.status(400).send(`
      <html><body style="background:#f5f5f5;color:#1a1a2e;font-family:Arial;text-align:center;padding:60px 20px;">
        <h2 style="color:#c0392b;">Invalid or expired link</h2>
        <p>This activation link has already been used or is invalid.</p>
        <a href="https://${process.env.SITE_HOST}/login" style="color:#1565c0;">Back to login</a>
      </body></html>
    `);
  }

  await pool.query('UPDATE users SET verified = true, verify_token = NULL WHERE id = $1', [user.id]);

  const autoToken = signToken(user.id);
  const loginUrl  = `https://${process.env.SITE_HOST}/login?autotoken=${autoToken}`;

  try {
    await resend.emails.send({
      from: 'Between Two Worlds <hello@btwfanfic.net>',
      reply_to: 'hello@btwfanfic.net',
      to: user.email,
      subject: 'Welcome to Between Two Worlds!',
      html: emailWelcome(user.display_name || user.username, loginUrl),
      text: `Hi ${user.display_name || user.username},\n\nYour Between Two Worlds account is now active!\n\nClick the link below to log in automatically:\n${loginUrl}\n\nWelcome aboard!\n\n— Between Two Worlds`,
    });
  } catch (err) {
    console.error('Welcome email error:', err.message);
  }

  res.redirect(`https://${process.env.SITE_HOST}/login?autotoken=${autoToken}`);
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password)
      return res.status(400).json({ error: 'Please fill in all fields.' });

    const { rows: [user] } = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR username = $1',
      [identifier.toLowerCase()]
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
    'SELECT id, username, display_name, avatar, email FROM users WHERE id = $1', [req.user.id]
  );
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const hash = crypto.createHash('sha256').update(user.email.toLowerCase()).digest('hex');
  const is_admin = hash === process.env.ADMIN_EMAIL_HASH;
  res.json({ user: { id: user.id, username: user.username, display_name: user.display_name, avatar: user.avatar || null, is_admin } });
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
      'SELECT display_name, username FROM users WHERE id = $1', [req.user.id]
    );

    res.json({
      comment: {
        id:           row.id,
        body:         body.trim(),
        display_name: user.display_name,
        username:     user.username,
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
  if (comment.user_id !== req.user.id) return res.status(403).json({ error: 'Not your comment.' });

  await pool.query('DELETE FROM comments WHERE id = $1', [req.params.id]);
  res.json({ message: 'Deleted.' });
});

// ── Profile ───────────────────────────────────────────────────────────────────

app.put('/api/auth/profile', requireAuth, async (req, res) => {
  try {
    const { display_name, email, current_password } = req.body;
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const updates = {};

    if (display_name !== undefined) {
      const dn = display_name.trim().slice(0, 20);
      if (!dn) return res.status(400).json({ error: 'Display name cannot be empty.' });
      updates.display_name = dn;
    }

    if (email !== undefined && email.toLowerCase() !== user.email) {
      if (!current_password) return res.status(400).json({ error: 'Current password required to change email.' });
      const valid = await bcrypt.compare(current_password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Incorrect password.' });

      const { rows: [exists] } = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2', [email.toLowerCase(), user.id]
      );
      if (exists) return res.status(409).json({ error: 'That email is already in use.' });

      const changeToken = crypto.randomBytes(32).toString('hex');
      await pool.query(
        'UPDATE users SET pending_email = $1, email_change_token = $2 WHERE id = $3',
        [email.toLowerCase(), changeToken, user.id]
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
    await pool.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatarUrl, req.user.id]);
    res.json({ avatar: avatarUrl });
  });
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
    'UPDATE users SET email = $1, pending_email = NULL, email_change_token = NULL WHERE id = $2',
    [user.pending_email, user.id]
  );
  res.redirect(`https://${process.env.SITE_HOST}/profile?email_verified=1`);
});

app.get('/api/auth/profile', requireAuth, async (req, res) => {
  const { rows: [user] } = await pool.query(
    'SELECT id, username, display_name, email, avatar FROM users WHERE id = $1', [req.user.id]
  );
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user });
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

app.post('/api/inbox/send', requireAuth, uploadInbox.single('attachment'), async (req, res) => {
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (body.length > 20000) return res.status(400).json({ error: 'Message too long (max 20,000 chars).' });

  const attachmentUrl  = req.file ? '/images/inbox/' + req.file.filename : null;
  const attachmentName = req.file ? req.file.originalname : null;

  const { rows: [row] } = await pool.query(
    'INSERT INTO inbox_messages (from_user_id, body, attachment_url, attachment_name, is_admin) VALUES ($1, $2, $3, $4, false) RETURNING *',
    [req.user.id, body, attachmentUrl, attachmentName]
  );

  const { rows: [sender] } = await pool.query(
    'SELECT username, display_name FROM users WHERE id = $1', [req.user.id]
  );
  const senderName = (sender && (sender.display_name || sender.username)) || 'Someone';
  const attachHtml = attachmentUrl
    ? `<p style="margin:8px 0 0;font-size:0.85rem;color:#555;">Attachment: <a href="https://btwfanfic.net${attachmentUrl}">${attachmentName}</a></p>`
    : '';
  resend.emails.send({
    from: 'BTW Inbox <noreply@btwfanfic.net>',
    to: process.env.ADMIN_EMAIL,
    subject: `New message from ${senderName} — Between Two Worlds`,
    html: emailShell(`
      <h2 style="color:#1a237e;font-size:1.1rem;margin:0 0 12px;">New Inbox Message</h2>
      <p style="color:#424242;font-size:0.9rem;margin:0 0 6px;"><strong>From:</strong> ${senderName}</p>
      <div style="background:#f5f5f5;border-left:3px solid #c2547a;padding:12px 16px;border-radius:4px;margin:12px 0;">
        <p style="color:#212121;font-size:0.95rem;margin:0;white-space:pre-wrap;">${body}</p>
      </div>
      ${attachHtml}
    `),
  }).catch(console.error);

  res.json({ message: row });
});

app.get('/api/inbox/sent', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM inbox_messages WHERE from_user_id = $1 AND is_admin = false ORDER BY created_at DESC LIMIT 50',
    [req.user.id]
  );
  res.json({ messages: rows });
});

app.get('/api/inbox/received', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM inbox_messages WHERE to_user_id = $1 AND is_admin = true ORDER BY created_at DESC LIMIT 50',
    [req.user.id]
  );
  await pool.query(
    'UPDATE inbox_messages SET read_at = NOW() WHERE to_user_id = $1 AND is_admin = true AND read_at IS NULL',
    [req.user.id]
  );
  res.json({ messages: rows });
});

app.get('/api/inbox/admin/all', requireAuth, async (req, res) => {
  if (!await checkAdmin(req)) return res.status(403).json({ error: 'Forbidden.' });
  const { rows } = await pool.query(`
    SELECT m.*, u.username, u.display_name
    FROM inbox_messages m
    LEFT JOIN users u ON m.from_user_id = u.id
    WHERE m.is_admin = false
    ORDER BY m.created_at DESC LIMIT 200
  `);
  res.json({ messages: rows });
});

app.post('/api/inbox/admin/reply', requireAuth, async (req, res) => {
  if (!await checkAdmin(req)) return res.status(403).json({ error: 'Forbidden.' });
  const { to_user_id, body } = req.body;
  if (!to_user_id || !(body || '').trim()) return res.status(400).json({ error: 'Missing fields.' });
  const { rows: [row] } = await pool.query(
    'INSERT INTO inbox_messages (to_user_id, body, is_admin) VALUES ($1, $2, true) RETURNING *',
    [to_user_id, body.trim()]
  );
  res.json({ message: row });
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
    params.push(tag);
    where.push(`p.tag = $${params.length}`);
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
  const tag  = COMMUNITY_TAGS.includes(req.body.tag) ? req.body.tag : 'General';
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
    SELECT c.*, u.username, u.display_name, u.avatar
    FROM community_comments c
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.post_id = $1 ORDER BY c.created_at ASC LIMIT 100
  `, [parseInt(req.params.id)]);
  res.json({ comments: rows });
});

// POST /api/community/posts/:id/comments
app.post('/api/community/posts/:id/comments', requireAuth, async (req, res) => {
  const postId = parseInt(req.params.id);
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
  if (body.length > 500) return res.status(400).json({ error: 'Comment too long (max 500 chars).' });

  const { rows: [row] } = await pool.query(
    'INSERT INTO community_comments (post_id, user_id, body) VALUES ($1, $2, $3) RETURNING id',
    [postId, req.user.id, body]
  );

  const { rows: [comment] } = await pool.query(`
    SELECT c.*, u.username, u.display_name, u.avatar
    FROM community_comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.id = $1
  `, [row.id]);

  res.json({ comment });
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
