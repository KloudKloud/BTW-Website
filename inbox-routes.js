
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

db.exec(`
  CREATE TABLE IF NOT EXISTS inbox_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id    INTEGER,
    to_user_id      INTEGER,
    body            TEXT    NOT NULL,
    attachment_url  TEXT,
    attachment_name TEXT,
    is_admin        INTEGER DEFAULT 0,
    read_at         DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const ADMIN_EMAIL = 'shyfy000@gmail.com';
function checkAdmin(req) {
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
  return user && user.email.toLowerCase() === ADMIN_EMAIL;
}

// POST /api/inbox/send
app.post('/api/inbox/send', requireAuth, uploadInbox.single('attachment'), (req, res) => {
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (body.length > 20000) return res.status(400).json({ error: 'Message too long (max 20,000 chars).' });

  const attachmentUrl  = req.file ? '/images/inbox/' + req.file.filename : null;
  const attachmentName = req.file ? req.file.originalname : null;

  const result = db.prepare(
    'INSERT INTO inbox_messages (from_user_id, body, attachment_url, attachment_name, is_admin) VALUES (?, ?, ?, ?, 0)'
  ).run(req.user.id, body, attachmentUrl, attachmentName);

  const msg = db.prepare('SELECT * FROM inbox_messages WHERE id = ?').get(result.lastInsertRowid);

  const sender = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(req.user.id);
  const senderName = (sender && (sender.display_name || sender.username)) || 'Someone';
  const attachHtml = attachmentUrl
    ? `<p style="margin:8px 0 0;font-size:0.85rem;color:#555;">Attachment: <a href="https://btwfanfic.net${attachmentUrl}">${attachmentName}</a></p>`
    : '';
  resend.emails.send({
    from: 'BTW Inbox <noreply@btwfanfic.net>',
    to: ADMIN_EMAIL,
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

  res.json({ message: msg });
});

// GET /api/inbox/sent
app.get('/api/inbox/sent', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM inbox_messages WHERE from_user_id = ? AND is_admin = 0 ORDER BY created_at DESC LIMIT 50'
  ).all(req.user.id);
  res.json({ messages: rows });
});

// GET /api/inbox/received
app.get('/api/inbox/received', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM inbox_messages WHERE to_user_id = ? AND is_admin = 1 ORDER BY created_at DESC LIMIT 50'
  ).all(req.user.id);
  db.prepare(
    'UPDATE inbox_messages SET read_at = CURRENT_TIMESTAMP WHERE to_user_id = ? AND is_admin = 1 AND read_at IS NULL'
  ).run(req.user.id);
  res.json({ messages: rows });
});

// GET /api/inbox/admin/all  (admin only)
app.get('/api/inbox/admin/all', requireAuth, (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ error: 'Forbidden.' });
  const rows = db.prepare(`
    SELECT m.*, u.username, u.display_name
    FROM inbox_messages m
    LEFT JOIN users u ON m.from_user_id = u.id
    WHERE m.is_admin = 0
    ORDER BY m.created_at DESC LIMIT 200
  `).all();
  res.json({ messages: rows });
});

// POST /api/inbox/admin/reply  (admin only)
app.post('/api/inbox/admin/reply', requireAuth, (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ error: 'Forbidden.' });
  const { to_user_id, body } = req.body;
  if (!to_user_id || !(body || '').trim()) return res.status(400).json({ error: 'Missing fields.' });
  const result = db.prepare(
    'INSERT INTO inbox_messages (to_user_id, body, is_admin) VALUES (?, ?, 1)'
  ).run(to_user_id, body.trim());
  const msg = db.prepare('SELECT * FROM inbox_messages WHERE id = ?').get(result.lastInsertRowid);
  res.json({ message: msg });
});

