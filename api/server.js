require('dotenv').config();
const express  = require('express');
const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { Resend } = require('resend');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');

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

// Allow requests from the BTW website
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'btw.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL,
    display_name  TEXT,
    email         TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    verified      INTEGER DEFAULT 0,
    verify_token  TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Add new columns if they don't exist yet
try { db.exec('ALTER TABLE users ADD COLUMN avatar TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN pending_email TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN email_change_token TEXT'); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    art_id     INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    body       TEXT    NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

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

// ── Email templates ───────────────────────────────────────────────────────────
const emailShell = (body) => `
  <div style="background:#eef2f7;padding:40px 16px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:520px;margin:0 auto;">
      <!-- Header -->
      <div style="background:#1a237e;border-radius:10px 10px 0 0;padding:28px 32px;text-align:center;">
        <h1 style="color:#ffffff;font-family:Georgia,serif;font-size:1.6rem;margin:0 0 4px;letter-spacing:0.02em;">Between Two Worlds</h1>
        <p style="color:rgba(255,255,255,0.55);font-size:0.75rem;margin:0;letter-spacing:0.12em;text-transform:uppercase;">A Pokémon Fan Fiction</p>
      </div>
      <!-- Body -->
      <div style="background:#ffffff;padding:36px 32px;border-left:1px solid #dde3f0;border-right:1px solid #dde3f0;">
        ${body}
      </div>
      <!-- Footer -->
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

    const existing = db.prepare(
      'SELECT id FROM users WHERE email = ? OR username = ?'
    ).get(email.toLowerCase(), username.toLowerCase());
    if (existing)
      return res.status(409).json({ error: 'That username or email is already registered.' });

    const password_hash = await bcrypt.hash(password, 12);
    const verify_token  = crypto.randomBytes(32).toString('hex');
    const dname         = (display_name?.trim() || username).slice(0, 20);

    db.prepare(`
      INSERT INTO users (username, display_name, email, password_hash, verify_token)
      VALUES (?, ?, ?, ?, ?)
    `).run(username.toLowerCase(), dname, email.toLowerCase(), password_hash, verify_token);

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
  const user = db.prepare('SELECT * FROM users WHERE verify_token = ?').get(token);
  if (!user) {
    return res.status(400).send(`
      <html><body style="background:#f5f5f5;color:#1a1a2e;font-family:Arial;text-align:center;padding:60px 20px;">
        <h2 style="color:#c0392b;">Invalid or expired link</h2>
        <p>This activation link has already been used or is invalid.</p>
        <a href="http://${process.env.SITE_HOST}/login.html" style="color:#1565c0;">Back to login</a>
      </body></html>
    `);
  }

  db.prepare('UPDATE users SET verified = 1, verify_token = NULL WHERE id = ?').run(user.id);

  // Generate auto-login token and send welcome email
  const autoToken = signToken(user.id);
  const loginUrl  = `https://${process.env.SITE_HOST}/login.html?autotoken=${autoToken}`;

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

  res.redirect(`https://${process.env.SITE_HOST}/login.html?autotoken=${autoToken}`);
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password)
      return res.status(400).json({ error: 'Please fill in all fields.' });

    const user = db.prepare(
      'SELECT * FROM users WHERE email = ? OR username = ?'
    ).get(identifier.toLowerCase(), identifier.toLowerCase());

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

// GET /api/auth/me — validate token and return user info
app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare(
    'SELECT id, username, display_name, avatar FROM users WHERE id = ?'
  ).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user });
});

// POST /api/auth/logout — client just deletes the token, but this endpoint
// exists for future server-side session invalidation
app.post('/api/auth/logout', requireAuth, (req, res) => {
  res.json({ message: 'Logged out.' });
});

// ── Comments ──────────────────────────────────────────────────────────────

// GET /api/comments?art_id=X
app.get('/api/comments', (req, res) => {
  const art_id = parseInt(req.query.art_id, 10);
  if (!art_id) return res.json({ comments: [] });

  const comments = db.prepare(`
    SELECT c.id, c.body, c.created_at, c.user_id, u.display_name, u.username, u.avatar
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.art_id = ?
    ORDER BY c.created_at ASC
  `).all(art_id);

  res.json({ comments });
});

// POST /api/comments — requires auth
app.post('/api/comments', requireAuth, (req, res) => {
  try {
    const { art_id, body } = req.body;
    if (!art_id || !body?.trim())
      return res.status(400).json({ error: 'art_id and body are required.' });
    if (body.trim().length > 500)
      return res.status(400).json({ error: 'Comment must be 500 characters or fewer.' });

    const result = db.prepare(
      'INSERT INTO comments (art_id, user_id, body) VALUES (?, ?, ?)'
    ).run(art_id, req.user.id, body.trim());

    const user = db.prepare(
      'SELECT display_name, username FROM users WHERE id = ?'
    ).get(req.user.id);

    res.json({
      comment: {
        id:           result.lastInsertRowid,
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

// PUT /api/comments/:id — edit own comment
app.put('/api/comments/:id', requireAuth, (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Body is required.' });
  if (body.trim().length > 500) return res.status(400).json({ error: 'Max 500 characters.' });

  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.user_id !== req.user.id) return res.status(403).json({ error: 'Not your comment.' });

  db.prepare('UPDATE comments SET body = ? WHERE id = ?').run(body.trim(), req.params.id);
  res.json({ body: body.trim() });
});

// DELETE /api/comments/:id — delete own comment
app.delete('/api/comments/:id', requireAuth, (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.user_id !== req.user.id) return res.status(403).json({ error: 'Not your comment.' });

  db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted.' });
});

// ── Profile ───────────────────────────────────────────────────────────────────

// PUT /api/auth/profile — update display name and/or email
app.put('/api/auth/profile', requireAuth, async (req, res) => {
  try {
    const { display_name, email, current_password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
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

      const exists = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email.toLowerCase(), user.id);
      if (exists) return res.status(409).json({ error: 'That email is already in use.' });

      // Don't update email directly — send a verification link to the new address
      const changeToken = crypto.randomBytes(32).toString('hex');
      db.prepare('UPDATE users SET pending_email = ?, email_change_token = ? WHERE id = ?')
        .run(email.toLowerCase(), changeToken, user.id);

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

      // Save display_name changes before returning early
      if (updates.display_name) {
        db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(updates.display_name, user.id);
      }
      return res.json({ message: `Verification email sent to ${email}. Click the link to confirm your new address.`, emailPending: true });
    }

    if (Object.keys(updates).length === 0)
      return res.json({ message: 'No changes.' });

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE users SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), user.id);

    const updated = db.prepare('SELECT id, username, display_name, email, avatar FROM users WHERE id = ?').get(user.id);
    res.json({ message: 'Profile updated.', user: updated });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// PUT /api/auth/password — change password
app.put('/api/auth/password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password)
      return res.status(400).json({ error: 'Both current and new password are required.' });
    if (new_password.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });

    const hash = await bcrypt.hash(new_password, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    res.json({ message: 'Password changed.' });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/auth/avatar — upload profile picture
app.post('/api/auth/avatar', requireAuth, (req, res, next) => {
  uploadAvatar.single('avatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    // Remove old avatar files with different extensions
    const exts = ['.jpg', '.png', '.webp', '.gif'];
    const newFile = req.file.filename;
    exts.forEach(ext => {
      const old = path.join(AVATARS_DIR, `${req.user.id}${ext}`);
      if (path.basename(old) !== newFile && fs.existsSync(old)) fs.unlinkSync(old);
    });

    const avatarUrl = `/images/avatars/${req.file.filename}`;
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.user.id);
    res.json({ avatar: avatarUrl });
  });
});

// DELETE /api/auth/account — delete account
app.delete('/api/auth/account', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required.' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password.' });

    // Delete avatar file if it exists
    if (user.avatar) {
      const filePath = path.join('/var/www/btw', user.avatar);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    db.prepare('DELETE FROM comments WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

    res.json({ message: 'Account deleted.' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/auth/confirm-email?token=xxx — confirm email change
app.get('/api/auth/confirm-email', (req, res) => {
  const { token } = req.query;
  const user = db.prepare('SELECT * FROM users WHERE email_change_token = ?').get(token);
  if (!user || !user.pending_email) {
    return res.status(400).send(`
      <html><body style="background:#f5f5f5;color:#1a1a2e;font-family:Arial;text-align:center;padding:60px 20px;">
        <h2 style="color:#c0392b;">Invalid or expired link</h2>
        <p>This email confirmation link has already been used or is invalid.</p>
        <a href="https://${process.env.SITE_HOST}/profile.html" style="color:#1565c0;">Back to profile</a>
      </body></html>
    `);
  }
  db.prepare('UPDATE users SET email = ?, pending_email = NULL, email_change_token = NULL WHERE id = ?')
    .run(user.pending_email, user.id);
  res.redirect(`https://${process.env.SITE_HOST}/profile.html?email_verified=1`);
});

// GET /api/auth/profile — get full profile for the profile page
app.get('/api/auth/profile', requireAuth, (req, res) => {
  const user = db.prepare(
    'SELECT id, username, display_name, email, avatar FROM users WHERE id = ?'
  ).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '127.0.0.1', () =>
  console.log(`BTW auth API listening on 127.0.0.1:${PORT}`)
);
