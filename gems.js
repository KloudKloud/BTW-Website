// gems.js — the shared gem economy (btwfics.net + the Discord bot).
//
// users.gems is the balance; gem_ledger records every change. ALL balance
// changes go through awardGems() so the balance and the ledger can never
// drift apart, and a spend can never take the balance below zero.
//
//   const gems = require('./gems')(pool);
//   require('./gems').mountSiteRoutes(app, { requireAuth, gems });

const crypto = require('crypto');

// ── Tunables ────────────────────────────────────────────────────────────────
const PRESENCE_REWARD = 10;          // gems per payout while actively on the site
const PRESENCE_MIN_INTERVAL_S = 290; // heartbeats tick every 60s; pay at most once per ~5 min per account
const CHAT_REWARD_MIN = 25;          // Discord chat reward range
const CHAT_REWARD_MAX = 35;
const CHAT_COOLDOWN_S = 60;
const DAILY_COOLDOWN_S = 24 * 3600;  // one claim per 24h...
const DAILY_CHAIN_S = 48 * 3600;     // ...and the streak breaks if more than 48h pass
const DAILY_STREAK_REWARDS = { 1: 150, 2: 300, 3: 500, 4: 600, 5: 750, 6: 900 };
const DAILY_MAX_REWARD = 1200;       // day 7 and beyond

const dailyRewardForStreak = (n) => DAILY_STREAK_REWARDS[n] || DAILY_MAX_REWARD;

module.exports = function createGems(pool) {
  // Apply a balance change + ledger row on an existing client/transaction.
  // Returns the new balance, or null if the user doesn't exist or the change
  // would take the balance below zero.
  async function applyChange(client, userId, amount, reason, ref) {
    const { rows: [u] } = await client.query(
      'UPDATE users SET gems = gems + $2 WHERE id = $1 AND gems + $2 >= 0 RETURNING gems',
      [userId, amount]
    );
    if (!u) return null;
    await client.query(
      'INSERT INTO gem_ledger (user_id, amount, reason, ref, balance_after) VALUES ($1, $2, $3, $4, $5)',
      [userId, amount, reason, ref == null ? null : String(ref).slice(0, 100), u.gems]
    );
    return u.gems;
  }

  // Award (positive) or spend (negative) gems atomically. Returns { gems, amount } or null.
  async function awardGems(userId, amount, reason, ref = null) {
    amount = Math.trunc(Number(amount));
    if (!userId || !amount || !reason) return null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const balance = await applyChange(client, userId, amount, reason, ref);
      if (balance === null) { await client.query('ROLLBACK'); return null; }
      await client.query('COMMIT');
      return { gems: balance, amount };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('awardGems failed:', e.message);
      return null;
    } finally {
      client.release();
    }
  }

  // Stamp a per-user timestamp column only if enough time has passed. Doing the
  // check and the stamp in ONE statement is what makes this safe against many
  // tabs / devices / rapid requests all arriving at once.
  async function takeCooldown(userId, column, seconds) {
    const { rowCount } = await pool.query(
      `UPDATE users SET ${column} = NOW()
       WHERE id = $1 AND (${column} IS NULL OR ${column} <= NOW() - make_interval(secs => $2))`,
      [userId, seconds]
    );
    return rowCount > 0;
  }

  // Being actively on the site (called by the page heartbeat).
  async function claimPresence(userId) {
    if (!(await takeCooldown(userId, 'last_presence_at', PRESENCE_MIN_INTERVAL_S))) return { awarded: false };
    const r = await awardGems(userId, PRESENCE_REWARD, 'presence');
    return r ? { awarded: true, amount: PRESENCE_REWARD, gems: r.gems } : { awarded: false };
  }

  // A qualifying Discord chat message (the bot calls this; the cooldown lives here, not in the bot).
  async function claimChat(userId) {
    if (!(await takeCooldown(userId, 'last_chat_reward_at', CHAT_COOLDOWN_S))) return { awarded: false };
    const amount = crypto.randomInt(CHAT_REWARD_MIN, CHAT_REWARD_MAX + 1);
    const r = await awardGems(userId, amount, 'discord_chat');
    return r ? { awarded: true, amount, gems: r.gems } : { awarded: false };
  }

  // What would a claim do right now? Pure read, no changes.
  function dailyState(row) {
    const since = row.since_claim === null ? null : Number(row.since_claim);
    const streak = row.daily_streak || 0;
    if (since === null) {
      return { can_claim: true, streak: 0, next_streak: 1, chain_broken: false, cooldown_seconds: 0, chain_break_seconds: null };
    }
    if (since < DAILY_COOLDOWN_S) {
      return { can_claim: false, streak, next_streak: streak + 1, chain_broken: false,
               cooldown_seconds: Math.ceil(DAILY_COOLDOWN_S - since), chain_break_seconds: Math.ceil(DAILY_CHAIN_S - since) };
    }
    const broken = since >= DAILY_CHAIN_S;
    return { can_claim: true, streak: broken ? 0 : streak, next_streak: broken ? 1 : streak + 1, chain_broken: broken,
             cooldown_seconds: 0, chain_break_seconds: broken ? null : Math.ceil(DAILY_CHAIN_S - since) };
  }

  const dailySelect = `SELECT daily_streak, gems, EXTRACT(EPOCH FROM (NOW() - last_daily_claim_at)) AS since_claim FROM users WHERE id = $1`;

  async function getDailyStatus(userId) {
    const { rows: [row] } = await pool.query(dailySelect, [userId]);
    if (!row) return null;
    const s = dailyState(row);
    return { ...s, next_reward: dailyRewardForStreak(s.next_streak), gems: row.gems };
  }

  // The universal daily: one claim per 24h across the site AND Discord.
  async function claimDaily(userId, source = 'site') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [row] } = await client.query(dailySelect + ' FOR UPDATE', [userId]); // lock: two simultaneous claims can't both pass
      if (!row) { await client.query('ROLLBACK'); return null; }
      const s = dailyState(row);
      if (!s.can_claim) {
        await client.query('ROLLBACK');
        return { claimed: false, ...s, next_reward: dailyRewardForStreak(s.next_streak), gems: row.gems };
      }
      const reward = dailyRewardForStreak(s.next_streak);
      await client.query('UPDATE users SET last_daily_claim_at = NOW(), daily_streak = $2 WHERE id = $1', [userId, s.next_streak]);
      const balance = await applyChange(client, userId, reward, 'daily', `streak:${s.next_streak}:${source}`);
      await client.query('COMMIT');
      return {
        claimed: true, reward, streak: s.next_streak, chain_broken: s.chain_broken, gems: balance,
        can_claim: false, cooldown_seconds: DAILY_COOLDOWN_S, chain_break_seconds: DAILY_CHAIN_S,
        next_streak: s.next_streak + 1, next_reward: dailyRewardForStreak(s.next_streak + 1),
      };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('claimDaily failed:', e.message);
      return null;
    } finally {
      client.release();
    }
  }

  return { awardGems, claimPresence, claimChat, getDailyStatus, claimDaily };
};

// ── Routes for logged-in site users ─────────────────────────────────────────
module.exports.mountSiteRoutes = function mountSiteRoutes(app, { requireAuth, gems }) {
  // Express 4 doesn't catch errors thrown inside async handlers; log them and return a clean 500 instead.
  const wrap = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error('gems route error:', req.method, req.path, err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong.' });
    });
  // Heartbeat from the page script. It's only a signal: the server decides the
  // amount and enforces the interval, so editing the client can't speed it up.
  app.post('/api/gems/presence', requireAuth, wrap(async (req, res) => {
    res.json(await gems.claimPresence(req.user.id));
  }));

  app.get('/api/gems/daily', requireAuth, wrap(async (req, res) => {
    const status = await gems.getDailyStatus(req.user.id);
    if (!status) return res.status(404).json({ error: 'User not found.' });
    res.json(status);
  }));

  app.post('/api/gems/daily/claim', requireAuth, wrap(async (req, res) => {
    const result = await gems.claimDaily(req.user.id, 'site');
    if (!result) return res.status(500).json({ error: "Couldn't claim right now — try again." });
    res.json(result);
  }));
};

module.exports.constants = { PRESENCE_REWARD, CHAT_REWARD_MIN, CHAT_REWARD_MAX, CHAT_COOLDOWN_S, DAILY_STREAK_REWARDS, DAILY_MAX_REWARD };
