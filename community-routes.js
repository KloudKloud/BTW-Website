
// ── Community ─────────────────────────────────────────────────────────────────

const COMMUNITY_DIR = '/var/www/btw/images/community';
if (!fs.existsSync(COMMUNITY_DIR)) fs.mkdirSync(COMMUNITY_DIR, { recursive: true });

const communityImgStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, COMMUNITY_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, Date.now() + '_' + req.user.id + ext);
  },
});
const uploadCommunityImg = multer({
  storage: communityImgStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','image/gif','image/avif'].includes(file.mimetype);
    cb(null, ok);
  },
});

db.exec(`
  CREATE TABLE IF NOT EXISTS community_posts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    body            TEXT    NOT NULL,
    tag             TEXT    DEFAULT 'General',
    attachment_url  TEXT,
    attachment_name TEXT,
    pinned          INTEGER DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS community_likes (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    UNIQUE(post_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS community_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    body       TEXT    NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const COMMUNITY_TAGS = ['General', 'Fanart', 'Theories & Predictions', 'Discussion', 'Introduce Yourself'];

// GET /api/community/posts
app.get('/api/community/posts', (req, res) => {
  let userId = null;
  try {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) userId = jwt.verify(h.slice(7), process.env.JWT_SECRET).id;
  } catch {}

  const { tag, before } = req.query;
  const where = [];
  const whereParams = [];
  if (tag && COMMUNITY_TAGS.includes(tag)) { where.push('p.tag = ?'); whereParams.push(tag); }
  if (before) { where.push('(p.pinned = 0 AND p.id < ?)'); whereParams.push(parseInt(before)); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const allParams = userId ? [userId, ...whereParams] : whereParams;

  const rows = db.prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar,
      (SELECT COUNT(*) FROM community_likes WHERE post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM community_comments WHERE post_id = p.id) AS comment_count,
      ${userId ? '(SELECT COUNT(*) FROM community_likes WHERE post_id = p.id AND user_id = ?)' : '0'} AS user_liked
    FROM community_posts p
    LEFT JOIN users u ON p.user_id = u.id
    ${whereClause}
    ORDER BY p.pinned DESC, p.created_at DESC
    LIMIT 20
  `).all(allParams);

  res.json({ posts: rows });
});

// POST /api/community/posts
app.post('/api/community/posts', requireAuth, uploadCommunityImg.single('attachment'), (req, res) => {
  const body = (req.body.body || '').trim();
  const tag  = COMMUNITY_TAGS.includes(req.body.tag) ? req.body.tag : 'General';
  if (!body) return res.status(400).json({ error: 'Post cannot be empty.' });
  if (body.length > 2000) return res.status(400).json({ error: 'Post too long (max 2000 chars).' });

  const attachmentUrl  = req.file ? '/images/community/' + req.file.filename : null;
  const attachmentName = req.file ? req.file.originalname : null;
  const pinned = checkAdmin(req) ? 1 : 0;

  const result = db.prepare(
    'INSERT INTO community_posts (user_id, body, tag, attachment_url, attachment_name, pinned) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, body, tag, attachmentUrl, attachmentName, pinned);

  const post = db.prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar, 0 AS like_count, 0 AS comment_count, 0 AS user_liked
    FROM community_posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?
  `).get(result.lastInsertRowid);

  res.json({ post });
});

// POST /api/community/posts/:id/like
app.post('/api/community/posts/:id/like', requireAuth, (req, res) => {
  const postId = parseInt(req.params.id);
  const userId = req.user.id;
  const existing = db.prepare('SELECT id FROM community_likes WHERE post_id = ? AND user_id = ?').get(postId, userId);
  if (existing) {
    db.prepare('DELETE FROM community_likes WHERE post_id = ? AND user_id = ?').run(postId, userId);
  } else {
    db.prepare('INSERT OR IGNORE INTO community_likes (post_id, user_id) VALUES (?, ?)').run(postId, userId);
  }
  const like_count = db.prepare('SELECT COUNT(*) AS c FROM community_likes WHERE post_id = ?').get(postId).c;
  res.json({ liked: !existing, like_count });
});

// GET /api/community/posts/:id/comments
app.get('/api/community/posts/:id/comments', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, u.username, u.display_name, u.avatar
    FROM community_comments c
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.post_id = ? ORDER BY c.created_at ASC LIMIT 100
  `).all(parseInt(req.params.id));
  res.json({ comments: rows });
});

// POST /api/community/posts/:id/comments
app.post('/api/community/posts/:id/comments', requireAuth, (req, res) => {
  const postId = parseInt(req.params.id);
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
  if (body.length > 500) return res.status(400).json({ error: 'Comment too long (max 500 chars).' });

  const result = db.prepare(
    'INSERT INTO community_comments (post_id, user_id, body) VALUES (?, ?, ?)'
  ).run(postId, req.user.id, body);

  const comment = db.prepare(`
    SELECT c.*, u.username, u.display_name, u.avatar
    FROM community_comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.id = ?
  `).get(result.lastInsertRowid);

  res.json({ comment });
});

// DELETE /api/community/posts/:id
app.delete('/api/community/posts/:id', requireAuth, (req, res) => {
  const postId = parseInt(req.params.id);
  const post = db.prepare('SELECT * FROM community_posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (post.user_id !== req.user.id && !checkAdmin(req)) return res.status(403).json({ error: 'Forbidden.' });
  db.prepare('DELETE FROM community_posts WHERE id = ?').run(postId);
  db.prepare('DELETE FROM community_likes WHERE post_id = ?').run(postId);
  db.prepare('DELETE FROM community_comments WHERE post_id = ?').run(postId);
  res.json({ ok: true });
});
