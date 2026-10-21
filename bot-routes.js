// bot-routes.js — private API for the BTW Discord bot (mounted at /api/bot).
//
// Three layers keep this away from the public:
//   1. nginx returns 404 for /api/bot/ on every public site (the bot talks to 127.0.0.1:3001 directly).
//   2. Anything carrying proxy headers (X-Forwarded-For / X-Real-IP) is rejected here, in case nginx ever misses.
//   3. Every request needs the shared secret BOT_API_KEY (X-Bot-Key header), compared in constant time.
//
// The bot never touches the database directly. It names a user by Discord ID, and the user must have linked
// that Discord account on the Arcade page; everything it does is then done AS that site account, through the
// same code paths the website itself uses.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const sharp = require('sharp');

const RATINGS = ['sfw', 'mature', 'explicit'];
const IMAGE_EXT = { jpeg: '.jpg', png: '.png', webp: '.webp', gif: '.gif' };
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 10000;

const clamp = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const stringList = (v, maxItems, maxLen) =>
  (Array.isArray(v) ? v : []).map(x => clamp(x, maxLen)).filter(Boolean).slice(0, maxItems);

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

module.exports = function mountBotRoutes(app, { pool, gems, createCharacterForUser, isValidHttpUrl, MOD_IMAGES_DIR }) {
  const router = express.Router();

  // Express 4 doesn't catch errors thrown inside async handlers (an unhandled rejection can take the whole
  // process down), so every handler on this router is wrapped: errors are logged and become a clean 500.
  const wrap = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error('bot route error:', req.method, req.path, err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error.' });
    });
  const r = {
    get: (p, ...h) => router.get(p, ...h.map(wrap)),
    post: (p, ...h) => router.post(p, ...h.map(wrap)),
  };

  router.use((req, res, next) => {
    const expected = process.env.BOT_API_KEY || '';
    if (expected.length < 32) return res.status(503).json({ error: 'Bot API is not configured.' });
    if (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) return res.status(403).json({ error: 'Forbidden.' });
    if (!crypto.timingSafeEqual(sha(req.get('x-bot-key') || ''), sha(expected))) return res.status(401).json({ error: 'Unauthorized.' });
    next();
  });

  // Resolve ?discord_id= / body.discord_id to the linked site account.
  async function withUser(req, res, next) {
    const discordId = String((req.body && req.body.discord_id) || req.query.discord_id || '');
    if (!/^\d{15,25}$/.test(discordId)) return res.status(400).json({ error: 'discord_id is required.' });
    const { rows: [u] } = await pool.query('SELECT id, username, display_name FROM users WHERE discord_id = $1', [discordId]);
    if (!u) return res.status(404).json({ error: 'not_linked' });
    req.botUser = u;
    next();
  }

  // ── Gems ──────────────────────────────────────────────────────────────────
  // A Discord message happened. The 60s cooldown and the reward amount are decided here, not by the bot.
  r.post('/gems/chat', withUser, async (req, res) => {
    res.json(await gems.claimChat(req.botUser.id));
  });

  r.get('/gems/daily', withUser, async (req, res) => {
    res.json(await gems.getDailyStatus(req.botUser.id));
  });

  r.post('/gems/daily/claim', withUser, async (req, res) => {
    const result = await gems.claimDaily(req.botUser.id, 'discord');
    if (!result) return res.status(500).json({ error: 'Claim failed.' });
    res.json(result);
  });

  // ── Characters ────────────────────────────────────────────────────────────
  // Upload art for a character. Body is the raw image bytes; we verify it really is an image.
  r.post('/character-image', withUser, express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }), async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Image data is required.' });
    let meta;
    try { meta = await sharp(buf).metadata(); } catch { return res.status(400).json({ error: "That file isn't a valid image." }); }
    const ext = IMAGE_EXT[meta.format];
    if (!ext) return res.status(415).json({ error: 'Images must be JPG, PNG, WebP or GIF.' });
    if (meta.width > MAX_IMAGE_DIMENSION || meta.height > MAX_IMAGE_DIMENSION) return res.status(413).json({ error: 'That image is too large (max 10,000px).' });
    const filename = `${req.botUser.id}_${Date.now()}_image${ext}`;
    await fs.promises.writeFile(path.join(MOD_IMAGES_DIR, filename), buf);
    res.json({ url: `/images/moderators/${filename}` });
  });

  // Create a character for the linked account. Same code path as the website's own create form.
  r.post('/characters', withUser, async (req, res) => {
    const b = req.body || {};
    const name = clamp(b.name, 40);
    if (!name) return res.status(400).json({ error: 'A name is required.' });

    const stats = {};
    const species = clamp(b.species, 60), age = clamp(b.age, 40), interests = clamp(b.interests, 600);
    const song = clamp(b.theme_song, 300);
    if (species) stats.Species = species;
    if (age) stats.Age = age;
    if (interests) stats.Interests = interests;
    if (song) {
      if (!isValidHttpUrl(song)) return res.status(400).json({ error: 'The theme song must be a link.' });
      stats['Theme Song'] = song;
    }

    // Art must be one this same user uploaded through /character-image (never an arbitrary URL or someone else's file).
    let refImage;
    if (b.ref_image) {
      if (typeof b.ref_image !== 'string' || !b.ref_image.startsWith(`/images/moderators/${req.botUser.id}_`) || b.ref_image.includes('..')) {
        return res.status(400).json({ error: 'Invalid image.' });
      }
      refImage = b.ref_image;
    }

    const result = await createCharacterForUser(req.botUser.id, {
      name,
      ref_image: refImage,
      description: clamp(b.description, 5000),
      stats,
      facts: stringList(b.facts, 10, 200),
      lore: stringList(b.lore, 30, 3000),
      relationships: [],
      ref_rating: RATINGS.includes(b.ref_rating) ? b.ref_rating : 'sfw',
      is_official_art: b.is_official_art === undefined ? true : !!b.is_official_art,
    });
    res.json({
      character: { id: result.character.id, name: result.character.name, ref_image: result.character.ref_image },
      owner_username: req.botUser.username,
      levelUp: result.levelUp,
    });
  });

  app.use('/api/bot', router);
};
