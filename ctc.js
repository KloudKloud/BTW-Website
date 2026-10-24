// ctc.js — Character Trading Cards: the collecting game (spin, claim, shop, shinies, hunts, trades).
//
// The rules live HERE, on the site, so every spend/earn is atomic with the gem ledger and any client
// (the Discord bot today, the Arcade page later) plays by the same rules. Tune the game in CONFIG.
//
//   const ctc = require('./ctc')(pool, gems);
//   await pool.query(require('./ctc').schemaSql);

const CONFIG = {
  // — prices (gems) —
  SPIN_COST: 300,
  PREMIUM_SPIN_COST: 1000,
  SPIN_DRAW_COUNT: 3,              // cards rolled per spin; the viewer picks one to keep
  DIRECT_BUY_COST: 25000,
  SHINY_UPGRADE_COST: 125000,

  // — shiny odds —
  SHINY_CHANCE: 1 / 400,           // normal spin
  PREMIUM_SHINY_CHANCE: 1 / 100,   // premium spin

  // — shiny hunt: pick one character; it spawns more often and gets better shiny odds as your chain grows —
  HUNT_SPAWN_BOOST: 2,             // the hunted character is 2x as likely to appear
  HUNT_CHAIN_THRESHOLDS: [0, 5, 10, 15],
  HUNT_RATES_NORMAL: [1 / 400, 1 / 200, 1 / 100, 1 / 25],
  HUNT_RATES_PREMIUM: [1 / 100, 1 / 50, 1 / 15, 1 / 5],

  // — refunds and bonuses (gems) —
  DUPE_REFUND: 20,                 // claimed a duplicate normal card
  SHINY_DUPE_REFUND: 4000,         // claimed a shiny you already own
  MILESTONE_INTERVAL: 7,           // every 7 cards collected...
  MILESTONE_BONUS: 300,            // ...pays this much
  CREATOR_BONUS: 50,               // a character's creator earns this whenever someone newly collects it

  // — free spins —
  FREE_SPIN_COOLDOWN_DAYS: 7,

  // — trading —
  TRADE_MIN_AGE_DAYS: 7,           // a card must be held this long before it can be traded away
  TRADE_EXPIRY_MINUTES: 10,
};

const ERRORS = {
  no_user: "That account wasn't found.",
  empty_pool: 'There are no cards in the library to roll yet!',
  insufficient: "You don't have enough gems for that.",
  no_pending: "You don't have a spin waiting to be claimed.",
  bad_index: 'Pick one of the cards.',
  card_gone: 'That character was deleted — pick the other card.',
  no_character: "That character doesn't exist.",
  already_owned: 'You already own this card.',
  not_owned: "You don't own this card yet.",
  already_shiny: 'That card is already shiny! ✨',
  self_trade: "You can't trade with yourself.",
  target_not_found: "That player hasn't linked a btwfics.net account.",
  offer_not_owned: "You don't own the card you're offering.",
  request_not_owned: "They don't own the card you're asking for.",
  offer_locked: "The card you're offering was received in a trade, so it can't be traded again.",
  request_locked: 'The card you asked for was received in a trade, so it can\'t be traded again.',
  offer_too_new: 'You need to hold a card for a while before you can trade it away.',
  target_has_offer: 'They already own the card you offered.',
  you_have_request: 'You already own the card you asked for.',
  trade_not_found: "That trade doesn't exist.",
  trade_not_yours: "That trade isn't for you.",
  trade_closed: 'That trade is no longer open.',
  trade_expired: 'That trade offer expired.',
};

// Everything the game stores. Run once at startup (all IF NOT EXISTS, so it is safe to repeat).
const schemaSql = `
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_free_spin_at TIMESTAMPTZ;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS respin_tokens INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS ctc_cards (
    user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    character_id  INTEGER     NOT NULL REFERENCES moderator_characters(id) ON DELETE CASCADE,
    is_shiny      BOOLEAN     NOT NULL DEFAULT false,
    claim_count   INTEGER     NOT NULL DEFAULT 1,
    obtained_via  TEXT        NOT NULL DEFAULT 'spin',
    obtained_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    shiny_at      TIMESTAMPTZ,
    trade_locked  BOOLEAN     NOT NULL DEFAULT false,
    PRIMARY KEY (user_id, character_id)
  );
  CREATE INDEX IF NOT EXISTS ctc_cards_character_idx ON ctc_cards (character_id);

  CREATE TABLE IF NOT EXISTS ctc_pending_spins (
    user_id     INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT        NOT NULL,
    cards       JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS ctc_hunt (
    user_id       INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    character_id  INTEGER     NOT NULL REFERENCES moderator_characters(id) ON DELETE CASCADE,
    chain         INTEGER     NOT NULL DEFAULT 0,
    set_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS ctc_milestones (
    user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    milestone   INTEGER     NOT NULL,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, milestone)
  );

  CREATE TABLE IF NOT EXISTS ctc_trades (
    id                     SERIAL      PRIMARY KEY,
    from_user_id           INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id             INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    offer_character_id     INTEGER     NOT NULL REFERENCES moderator_characters(id) ON DELETE CASCADE,
    request_character_id   INTEGER     NOT NULL REFERENCES moderator_characters(id) ON DELETE CASCADE,
    status                 TEXT        NOT NULL DEFAULT 'pending',
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at            TIMESTAMPTZ
  );

  -- Where each owned card sits in the website's Pokemon-box-style Collection
  -- grid (the Discord bot has no concept of this -- site-only UI state).
  -- Newly claimed cards get auto-placed at the lowest free (box_index,
  -- slot_index) by the site; box_index/slot_index aren't constrained to the
  -- "default 6 boxes of 25" the UI starts with, so a collection can grow
  -- past that without the server needing to know about it.
  CREATE TABLE IF NOT EXISTS ctc_card_slots (
    user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    character_id  INTEGER     NOT NULL REFERENCES moderator_characters(id) ON DELETE CASCADE,
    box_index     INTEGER     NOT NULL DEFAULT 0,
    slot_index    INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, character_id)
  );
  CREATE INDEX IF NOT EXISTS ctc_card_slots_box_idx ON ctc_card_slots (user_id, box_index, slot_index);

  CREATE TABLE IF NOT EXISTS ctc_box_titles (
    user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    box_index   INTEGER     NOT NULL,
    title       TEXT        NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, box_index)
  );
`;

// Index of the highest chain threshold reached (0-based).
function huntTier(chain) {
  let tier = 0;
  CONFIG.HUNT_CHAIN_THRESHOLDS.forEach((t, i) => { if (chain >= t) tier = i; });
  return tier;
}

// Everything a client needs to show a hunt chain.
function huntInfo(chain) {
  const tier = huntTier(chain);
  const next = CONFIG.HUNT_CHAIN_THRESHOLDS.find((t) => t > chain);
  return {
    chain, tier, tiers: CONFIG.HUNT_CHAIN_THRESHOLDS.length,
    next_threshold: next === undefined ? null : next,
    rate_normal: CONFIG.HUNT_RATES_NORMAL[tier],
    rate_premium: CONFIG.HUNT_RATES_PREMIUM[tier],
  };
}

module.exports = function createCtc(pool, gems, { rng = Math.random } = {}) {
  const C = CONFIG;
  const fail = (error, extra = {}) => ({ error, message: ERRORS[error] || error, ...extra });

  // ── helpers (all take a client so they join the caller's transaction) ────────────────────────────

  async function lockUser(client, userId) {
    const { rows: [u] } = await client.query(
      'SELECT id, gems, last_free_spin_at, respin_tokens FROM users WHERE id = $1 FOR UPDATE', [userId]
    );
    return u || null;
  }

  async function balanceOf(client, userId) {
    const { rows: [u] } = await client.query('SELECT gems FROM users WHERE id = $1', [userId]);
    return u ? u.gems : 0;
  }

  // Every character that can appear in a spin: it has real art (not the placeholder).
  async function rollablePool(client) {
    const { rows } = await client.query(
      `SELECT id, name, owner_user_id FROM moderator_characters
       WHERE ref_image IS NOT NULL AND ref_image <> '' AND ref_image <> '/images/defaultchar.jpg'`
    );
    return rows;
  }

  // Pay out a milestone bonus for every unclaimed multiple of MILESTONE_INTERVAL reached.
  async function grantMilestones(client, userId) {
    const { rows: [{ count }] } = await client.query('SELECT COUNT(*)::int AS count FROM ctc_cards WHERE user_id = $1', [userId]);
    const granted = [];
    for (let n = C.MILESTONE_INTERVAL; n <= count; n += C.MILESTONE_INTERVAL) {
      const { rowCount } = await client.query(
        'INSERT INTO ctc_milestones (user_id, milestone) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, n]
      );
      if (rowCount) {
        await gems.applyChange(client, userId, C.MILESTONE_BONUS, 'ctc_milestone', n);
        granted.push(n);
      }
    }
    return { granted, count };
  }

  // A character's creator earns a little every time someone newly collects it (never for collecting your own).
  async function payCreator(client, ownerUserId, collectorUserId, characterId) {
    if (!ownerUserId || ownerUserId === collectorUserId) return 0;
    const bal = await gems.applyChange(client, ownerUserId, C.CREATOR_BONUS, 'ctc_creator', `char:${characterId}:by:${collectorUserId}`);
    return bal === null ? 0 : C.CREATOR_BONUS;
  }

  async function withTx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      // A returned { error } means "nothing should change" — roll back so a half-done action can never stick.
      if (result && result.error) await client.query('ROLLBACK'); else await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // ── spinning ────────────────────────────────────────────────────────────────────────────────────

  function shinyChance(premium, isHuntTarget, chain) {
    if (isHuntTarget) return (premium ? C.HUNT_RATES_PREMIUM : C.HUNT_RATES_NORMAL)[huntTier(chain)];
    return premium ? C.PREMIUM_SHINY_CHANCE : C.SHINY_CHANCE;
  }

  // `count` DIFFERENT characters, uniformly random — except the hunted one counts extra.
  function pickCards(pool, huntId, count) {
    const candidates = pool.slice();
    const picks = [];
    for (let n = 0; n < count && candidates.length; n++) {
      const weights = candidates.map((c) => (c.id === huntId ? C.HUNT_SPAWN_BOOST : 1));
      let roll = rng() * weights.reduce((a, b) => a + b, 0);
      let i = 0;
      while (i < candidates.length - 1 && roll >= weights[i]) { roll -= weights[i]; i++; }
      picks.push(candidates.splice(i, 1)[0]);
    }
    return picks;
  }

  // What the user is looking at right now, computed from their CURRENT collection (it may have changed since the roll).
  async function describePending(client, userId) {
    const { rows: [p] } = await client.query('SELECT kind, cards, created_at FROM ctc_pending_spins WHERE user_id = $1', [userId]);
    if (!p) return null;
    const ids = p.cards.map((c) => c.character_id);
    const { rows: alive } = await client.query('SELECT id, name, owner_user_id FROM moderator_characters WHERE id = ANY($1::int[])', [ids]);
    const aliveById = new Map(alive.map((r) => [r.id, r]));
    const live = p.cards.filter((c) => aliveById.has(c.character_id));
    if (!live.length) {
      // Every rolled character was deleted: the spin can never be claimed, so give back a free respin and clear it.
      await client.query('DELETE FROM ctc_pending_spins WHERE user_id = $1', [userId]);
      await client.query('UPDATE users SET respin_tokens = respin_tokens + 1 WHERE id = $1', [userId]);
      return { gone: true };
    }
    if (live.length !== p.cards.length) {
      await client.query('UPDATE ctc_pending_spins SET cards = $2 WHERE user_id = $1', [userId, JSON.stringify(live)]);
    }
    const { rows: owned } = await client.query(
      'SELECT character_id, is_shiny FROM ctc_cards WHERE user_id = $1 AND character_id = ANY($2::int[])', [userId, ids]
    );
    const ownedBy = new Map(owned.map((r) => [r.character_id, r.is_shiny]));
    const { rows: [hunt] } = await client.query('SELECT character_id, chain FROM ctc_hunt WHERE user_id = $1', [userId]);
    return {
      kind: p.kind,
      created_at: p.created_at,
      cards: live.map((c) => {
        const owns = ownedBy.has(c.character_id);
        const ownsShiny = ownedBy.get(c.character_id) === true;
        const ch = aliveById.get(c.character_id);
        return {
          character_id: c.character_id, name: ch.name, shiny: c.shiny,
          owns, owns_shiny: ownsShiny,
          dupe: c.shiny ? ownsShiny : owns,       // a shiny on top of an owned normal is an UPGRADE, not a dupe
          upgrade: c.shiny && owns && !ownsShiny,
          hunt: !!hunt && hunt.character_id === c.character_id,
        };
      }),
      hunt: hunt ? huntInfo(hunt.chain) : null,
    };
  }

  // Roll CONFIG.SPIN_DRAW_COUNT cards. mode: 'auto' (free weekly -> respin token -> paid) or 'premium'. One unclaimed spin at a time.
  async function spin(userId, mode = 'auto') {
    return withTx(async (client) => {
      let user = await lockUser(client, userId);
      if (!user) return fail('no_user');

      const existing = await describePending(client, userId);
      if (existing && !existing.gone) return { pending: true, ...existing, gems: user.gems };
      if (existing && existing.gone) user = await lockUser(client, userId); // it just granted a respin token; re-read

      const premium = mode === 'premium';
      const freeReady = !user.last_free_spin_at || (Date.now() - new Date(user.last_free_spin_at).getTime()) >= C.FREE_SPIN_COOLDOWN_DAYS * 86400e3;
      let kind, cost = 0;
      if (premium) { kind = 'premium'; cost = C.PREMIUM_SPIN_COST; }
      else if (freeReady) kind = 'free';
      else if (user.respin_tokens > 0) kind = 'respin';
      else { kind = 'paid'; cost = C.SPIN_COST; }

      const pool_ = await rollablePool(client);
      if (!pool_.length) return fail('empty_pool');

      if (cost > 0) {
        const bal = await gems.applyChange(client, userId, -cost, `ctc_spin_${kind}`);
        if (bal === null) return fail('insufficient', { cost, gems: user.gems });
      }
      if (kind === 'free') await client.query('UPDATE users SET last_free_spin_at = NOW() WHERE id = $1', [userId]);
      if (kind === 'respin') await client.query('UPDATE users SET respin_tokens = respin_tokens - 1 WHERE id = $1', [userId]);

      const { rows: [hunt] } = await client.query('SELECT character_id, chain FROM ctc_hunt WHERE user_id = $1', [userId]);
      const picks = pickCards(pool_, hunt ? hunt.character_id : null, C.SPIN_DRAW_COUNT);
      const rolled = picks.map((c) => {
        const isHunt = !!hunt && hunt.character_id === c.id;
        return { character_id: c.id, shiny: rng() < shinyChance(premium, isHunt, hunt ? hunt.chain : 0) };
      });
      await client.query('INSERT INTO ctc_pending_spins (user_id, kind, cards) VALUES ($1, $2, $3)', [userId, kind, JSON.stringify(rolled)]);

      const described = await describePending(client, userId);
      return { pending: false, kind, cost, ...described, gems: await balanceOf(client, userId) };
    });
  }

  async function getPendingSpin(userId) {
    return withTx(async (client) => {
      const d = await describePending(client, userId);
      if (!d) return fail('no_pending');
      if (d.gone) return { gone: true, message: 'Every character in your spin was deleted, so you were given a free respin.' };
      return d;
    });
  }

  // Keep one of the two rolled cards.
  async function claim(userId, index) {
    return withTx(async (client) => {
      const user = await lockUser(client, userId);
      if (!user) return fail('no_user');
      const d = await describePending(client, userId);
      if (!d) return fail('no_pending');
      if (d.gone) return fail('card_gone', { all_gone: true, message: 'Every character in your spin was deleted — you were given a free respin.' });
      if (!Number.isInteger(index) || index < 0 || index >= d.cards.length) return fail('bad_index');
      const card = d.cards[index];

      const { rows: [ch] } = await client.query('SELECT id, name, owner_user_id FROM moderator_characters WHERE id = $1', [card.character_id]);
      const { rows: [row] } = await client.query('SELECT is_shiny FROM ctc_cards WHERE user_id = $1 AND character_id = $2', [userId, card.character_id]);
      const { rows: [hunt] } = await client.query('SELECT character_id, chain FROM ctc_hunt WHERE user_id = $1', [userId]);

      let result, refund = 0, newCard = false, creatorPaid = 0;
      if (card.shiny) {
        if (row && row.is_shiny) {
          result = 'shiny_dupe';
          refund = C.SHINY_DUPE_REFUND;
          await client.query('UPDATE ctc_cards SET claim_count = claim_count + 1 WHERE user_id = $1 AND character_id = $2', [userId, ch.id]);
        } else if (row) {
          result = 'shiny_upgrade';
          await client.query(
            'UPDATE ctc_cards SET is_shiny = true, shiny_at = NOW(), claim_count = claim_count + 1 WHERE user_id = $1 AND character_id = $2', [userId, ch.id]
          );
          creatorPaid = await payCreator(client, ch.owner_user_id, userId, ch.id);
        } else {
          result = 'shiny_new';
          newCard = true;
          await client.query(
            `INSERT INTO ctc_cards (user_id, character_id, is_shiny, shiny_at, obtained_via) VALUES ($1, $2, true, NOW(), $3)`,
            [userId, ch.id, d.kind === 'free' ? 'free_spin' : 'spin']
          );
          creatorPaid = await payCreator(client, ch.owner_user_id, userId, ch.id);
        }
      } else if (row) {
        result = 'dupe';
        refund = C.DUPE_REFUND;
        await client.query('UPDATE ctc_cards SET claim_count = claim_count + 1 WHERE user_id = $1 AND character_id = $2', [userId, ch.id]);
      } else {
        result = 'new';
        newCard = true;
        await client.query(
          'INSERT INTO ctc_cards (user_id, character_id, obtained_via) VALUES ($1, $2, $3)', [userId, ch.id, d.kind === 'free' ? 'free_spin' : 'spin']
        );
        creatorPaid = await payCreator(client, ch.owner_user_id, userId, ch.id);
      }
      if (refund) await gems.applyChange(client, userId, refund, result === 'shiny_dupe' ? 'ctc_shiny_dupe_refund' : 'ctc_dupe_refund', ch.id);

      const milestones = newCard ? await grantMilestones(client, userId) : { granted: [], count: null };

      // A claim of the hunted character extends the chain.
      let huntResult = null;
      if (hunt && hunt.character_id === ch.id) {
        const { rows: [h] } = await client.query('UPDATE ctc_hunt SET chain = chain + 1 WHERE user_id = $1 RETURNING chain', [userId]);
        huntResult = { hit: true, tier_up: C.HUNT_CHAIN_THRESHOLDS.includes(h.chain) && h.chain > 0, ...huntInfo(h.chain) };
      }

      await client.query('DELETE FROM ctc_pending_spins WHERE user_id = $1', [userId]);
      const { rows: [mine] } = await client.query(
        'SELECT claim_count, is_shiny FROM ctc_cards WHERE user_id = $1 AND character_id = $2', [userId, ch.id]
      );
      return {
        result, refund, new_card: newCard, creator_paid: creatorPaid,
        character: { id: ch.id, name: ch.name, owner_user_id: ch.owner_user_id },
        claim_count: mine.claim_count, is_shiny: mine.is_shiny,
        milestones: milestones.granted, milestone_bonus: C.MILESTONE_BONUS, collection_count: milestones.count,
        hunt: huntResult,
        gems: await balanceOf(client, userId),
      };
    });
  }

  // ── shop & shiny upgrades ────────────────────────────────────────────────────────────────────────

  async function buy(userId, characterId) {
    return withTx(async (client) => {
      const user = await lockUser(client, userId);
      if (!user) return fail('no_user');
      const { rows: [ch] } = await client.query('SELECT id, name, owner_user_id FROM moderator_characters WHERE id = $1', [characterId]);
      if (!ch) return fail('no_character');
      const { rows: [row] } = await client.query('SELECT 1 FROM ctc_cards WHERE user_id = $1 AND character_id = $2', [userId, ch.id]);
      if (row) return fail('already_owned');
      const bal = await gems.applyChange(client, userId, -C.DIRECT_BUY_COST, 'ctc_buy', ch.id);
      if (bal === null) return fail('insufficient', { cost: C.DIRECT_BUY_COST, gems: user.gems });
      await client.query(`INSERT INTO ctc_cards (user_id, character_id, obtained_via) VALUES ($1, $2, 'direct_buy')`, [userId, ch.id]);
      const creatorPaid = await payCreator(client, ch.owner_user_id, userId, ch.id);
      const milestones = await grantMilestones(client, userId);
      return {
        bought: true, cost: C.DIRECT_BUY_COST, character: { id: ch.id, name: ch.name }, creator_paid: creatorPaid,
        milestones: milestones.granted, milestone_bonus: C.MILESTONE_BONUS, collection_count: milestones.count,
        gems: await balanceOf(client, userId),
      };
    });
  }

  async function upgrade(userId, characterId) {
    return withTx(async (client) => {
      const user = await lockUser(client, userId);
      if (!user) return fail('no_user');
      const { rows: [row] } = await client.query(
        'SELECT c.is_shiny, mc.name FROM ctc_cards c JOIN moderator_characters mc ON mc.id = c.character_id WHERE c.user_id = $1 AND c.character_id = $2',
        [userId, characterId]
      );
      if (!row) return fail('not_owned');
      if (row.is_shiny) return fail('already_shiny');
      const bal = await gems.applyChange(client, userId, -C.SHINY_UPGRADE_COST, 'ctc_upgrade', characterId);
      if (bal === null) return fail('insufficient', { cost: C.SHINY_UPGRADE_COST, gems: user.gems });
      await client.query('UPDATE ctc_cards SET is_shiny = true, shiny_at = NOW() WHERE user_id = $1 AND character_id = $2', [userId, characterId]);
      return { upgraded: true, cost: C.SHINY_UPGRADE_COST, character: { id: characterId, name: row.name }, gems: bal };
    });
  }

  // ── shiny hunt ───────────────────────────────────────────────────────────────────────────────────

  async function setHunt(userId, characterId) {
    return withTx(async (client) => {
      const { rows: [ch] } = await client.query('SELECT id, name FROM moderator_characters WHERE id = $1', [characterId]);
      if (!ch) return fail('no_character');
      await client.query(
        `INSERT INTO ctc_hunt (user_id, character_id, chain) VALUES ($1, $2, 0)
         ON CONFLICT (user_id) DO UPDATE SET character_id = EXCLUDED.character_id, chain = 0, set_at = NOW()`,
        [userId, ch.id]
      );
      return { hunting: true, character: ch, ...huntInfo(0) };
    });
  }

  async function clearHunt(userId) {
    await pool.query('DELETE FROM ctc_hunt WHERE user_id = $1', [userId]);
    return { cleared: true };
  }

  // ── trading ──────────────────────────────────────────────────────────────────────────────────────

  const ageOk = (obtainedAt) => (Date.now() - new Date(obtainedAt).getTime()) >= C.TRADE_MIN_AGE_DAYS * 86400e3;

  // Everything that must be true for a trade; checked when it's offered AND again when it's accepted.
  async function tradeProblem(client, fromId, toId, offerId, requestId) {
    if (fromId === toId) return 'self_trade';
    const getCard = async (uid, cid) => (await client.query(
      'SELECT obtained_at, trade_locked FROM ctc_cards WHERE user_id = $1 AND character_id = $2', [uid, cid])).rows[0];
    const offer = await getCard(fromId, offerId);
    if (!offer) return 'offer_not_owned';
    const request = await getCard(toId, requestId);
    if (!request) return 'request_not_owned';
    if (offer.trade_locked) return 'offer_locked';
    if (request.trade_locked) return 'request_locked';
    if (!ageOk(offer.obtained_at)) return 'offer_too_new';
    if (await getCard(toId, offerId)) return 'target_has_offer';
    if (await getCard(fromId, requestId)) return 'you_have_request';
    return null;
  }

  async function offerTrade(fromUserId, toUserId, offerCharacterId, requestCharacterId) {
    return withTx(async (client) => {
      const { rows: [target] } = await client.query('SELECT id FROM users WHERE id = $1', [toUserId]);
      if (!target) return fail('target_not_found');
      const problem = await tradeProblem(client, fromUserId, toUserId, offerCharacterId, requestCharacterId);
      if (problem) return fail(problem);
      // One open offer per person: a new offer replaces the old one.
      await client.query(`UPDATE ctc_trades SET status = 'cancelled', resolved_at = NOW() WHERE from_user_id = $1 AND status = 'pending'`, [fromUserId]);
      const { rows: [t] } = await client.query(
        `INSERT INTO ctc_trades (from_user_id, to_user_id, offer_character_id, request_character_id) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
        [fromUserId, toUserId, offerCharacterId, requestCharacterId]
      );
      return { trade_id: t.id, expires_minutes: C.TRADE_EXPIRY_MINUTES, created_at: t.created_at };
    });
  }

  async function respondTrade(tradeId, userId, accept) {
    return withTx(async (client) => {
      const { rows: [t] } = await client.query('SELECT * FROM ctc_trades WHERE id = $1 FOR UPDATE', [tradeId]);
      if (!t) return fail('trade_not_found');
      if (t.to_user_id !== userId) return fail('trade_not_yours');
      if (t.status !== 'pending') return fail('trade_closed');
      if (Date.now() - new Date(t.created_at).getTime() > C.TRADE_EXPIRY_MINUTES * 60e3) {
        await client.query(`UPDATE ctc_trades SET status = 'expired', resolved_at = NOW() WHERE id = $1`, [tradeId]);
        // Committed on purpose (not an { error } return): the expiry itself must stick.
        return { expired: true, message: ERRORS.trade_expired };
      }
      if (!accept) {
        await client.query(`UPDATE ctc_trades SET status = 'declined', resolved_at = NOW() WHERE id = $1`, [tradeId]);
        return { accepted: false, declined: true };
      }
      // Lock both players in a fixed order so two simultaneous trades can't deadlock.
      for (const id of [t.from_user_id, t.to_user_id].sort((a, b) => a - b)) await lockUser(client, id);
      const problem = await tradeProblem(client, t.from_user_id, t.to_user_id, t.offer_character_id, t.request_character_id);
      if (problem) {
        await client.query(`UPDATE ctc_trades SET status = 'cancelled', resolved_at = NOW() WHERE id = $1`, [tradeId]);
        return { expired: true, message: `This trade can't go through anymore: ${ERRORS[problem]}` };
      }
      const take = async (uid, cid) => (await client.query(
        'DELETE FROM ctc_cards WHERE user_id = $1 AND character_id = $2 RETURNING is_shiny, shiny_at', [uid, cid])).rows[0];
      const offered = await take(t.from_user_id, t.offer_character_id);
      const requested = await take(t.to_user_id, t.request_character_id);
      // The card moves with its shiny status; received cards can't be traded on again.
      const give = (uid, cid, c) => client.query(
        `INSERT INTO ctc_cards (user_id, character_id, is_shiny, shiny_at, obtained_via, trade_locked) VALUES ($1, $2, $3, $4, 'trade', true)`,
        [uid, cid, c.is_shiny, c.shiny_at]);
      await give(t.to_user_id, t.offer_character_id, offered);
      await give(t.from_user_id, t.request_character_id, requested);
      await client.query(`UPDATE ctc_trades SET status = 'accepted', resolved_at = NOW() WHERE id = $1`, [tradeId]);
      const a = await grantMilestones(client, t.from_user_id);
      const b = await grantMilestones(client, t.to_user_id);
      return { accepted: true, milestones: { from: a.granted, to: b.granted }, milestone_bonus: C.MILESTONE_BONUS };
    });
  }

  async function cancelTrade(tradeId, userId) {
    const { rowCount } = await pool.query(
      `UPDATE ctc_trades SET status = 'cancelled', resolved_at = NOW() WHERE id = $1 AND from_user_id = $2 AND status = 'pending'`, [tradeId, userId]);
    return rowCount ? { cancelled: true } : fail('trade_closed');
  }

  // ── status & housekeeping ────────────────────────────────────────────────────────────────────────

  async function status(userId) {
    const { rows: [u] } = await pool.query('SELECT gems, last_free_spin_at, respin_tokens FROM users WHERE id = $1', [userId]);
    if (!u) return fail('no_user');
    const sinceFree = u.last_free_spin_at ? (Date.now() - new Date(u.last_free_spin_at).getTime()) / 1000 : Infinity;
    const cooldown = C.FREE_SPIN_COOLDOWN_DAYS * 86400;
    const { rows: [pending] } = await pool.query('SELECT 1 FROM ctc_pending_spins WHERE user_id = $1', [userId]);
    const { rows: [hunt] } = await pool.query('SELECT character_id, chain FROM ctc_hunt WHERE user_id = $1', [userId]);
    return {
      gems: u.gems, respin_tokens: u.respin_tokens,
      free_spin_ready: sinceFree >= cooldown,
      free_spin_seconds: sinceFree >= cooldown ? 0 : Math.ceil(cooldown - sinceFree),
      has_pending_spin: !!pending,
      hunt: hunt ? { character_id: hunt.character_id, ...huntInfo(hunt.chain) } : null,
    };
  }

  // Deleting a character removes it from every collection; collectors get a free respin to make up for it.
  async function refundCollectors(characterId, exceptUserId = null) {
    const { rowCount } = await pool.query(
      `UPDATE users SET respin_tokens = respin_tokens + 1
       WHERE id IN (SELECT user_id FROM ctc_cards WHERE character_id = $1) AND id IS DISTINCT FROM $2`,
      [characterId, exceptUserId]
    );
    return rowCount;
  }

  return { spin, getPendingSpin, claim, buy, upgrade, setHunt, clearHunt, offerTrade, respondTrade, cancelTrade, status, refundCollectors };
};

module.exports.CONFIG = CONFIG;
module.exports.schemaSql = schemaSql;
module.exports.huntInfo = huntInfo;
module.exports.ERRORS = ERRORS;
