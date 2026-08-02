// One-shot seed script for trying out the tag search / algorithm work.
// Creates 3 throwaway "author" accounts (flagged is_test_data = true) and
// 15 stories under them, each tagged from the real tag/relationship/fandom
// catalogs and carrying one published chapter so they show up in search.
//
// Run once from the API server: `node scripts/seed-search-demo.js`
// Cleanup: DELETE /api/admin/test-data (admin-only) — deletes every
// is_test_data user, which cascades to their stories/chapters/etc via FK,
// without touching any real account.
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host: 'localhost', database: 'btw', user: 'btw_user',
  password: process.env.DB_PASSWORD, port: 5432,
});

const AUTHORS = [
  { username: 'testauthor_kip', display_name: 'Kip Wildwood', email: 'seed-kip@__testdata.invalid' },
  { username: 'testauthor_mira', display_name: 'Mira Ashgrove', email: 'seed-mira@__testdata.invalid' },
  { username: 'testauthor_dex', display_name: 'Dex Ferro', email: 'seed-dex@__testdata.invalid' },
];

const COVERS = [
  '/images/gallery/apolloref_10.png', '/images/gallery/autumnleave_11.png',
  '/images/gallery/drowning_3.png', '/images/gallery/infernoselfie_8.png',
  '/images/gallery/klaphyicon_16.png', '/images/gallery/kloudsaphbedroom_1.png',
  '/images/gallery/pixernicecream_2.png', '/images/gallery/pixiegarden_5.png',
];

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

const CHAPTER_PARAGRAPHS = [
  'The Floo hadn\'t been the problem. The problem was the six hours of silence after, the kind that settled into a room and refused to leave no matter how many windows got opened.',
  'She hadn\'t meant to overhear. That was the thing about thin walls in an old gym — sound traveled whether you invited it to or not, and some nights it dragged in things nobody wanted to carry.',
  'The berries were ripe early this year, and nobody had a good explanation for why. Some blamed the shifted migration patterns; others just picked faster and asked fewer questions.',
  'He counted the steps to the ridge the way he always did, out of habit more than need. Forty-one. It had been forty-one for three years, and today it still came out forty-one, which felt like it should mean something.',
  'There was a particular kind of quiet that came after a battle — not silence exactly, just the absence of everything that had mattered a minute ago.',
];

function chapterBody() {
  const paras = [...CHAPTER_PARAGRAPHS].sort(() => Math.random() - 0.5).slice(0, 4);
  return paras.map(p => `<p>${p}</p>`).join('');
}

const STORIES = [
  { title: 'Dusk and Static', synopsis: 'An Umbreon who stopped trusting the dark, and an Espeon determined to change that.', tags: ['Umbreon', 'Espeon', 'Slow Burn', 'Hurt/Comfort'], fandoms: ['Pokemon'], relationships: ['Umbreon/Espeon'], categories: ['M/M'], rating: 'Teen & Up', complete: true, cover: true },
  { title: 'The Long Way Home', synopsis: 'A journey fic about two rivals who keep ending up on the same road.', tags: ['Riolu', 'Lucario', 'Friends to Lovers', 'Adventure'], fandoms: ['Pokemon'], relationships: ['Lucario/Riolu'], categories: ['Gen'], rating: 'General Audiences', complete: false, cover: true },
  { title: 'Static Cling', synopsis: 'Jolteon has never been good at sitting still, and Vaporeon has never minded.', tags: ['Vaporeon', 'Jolteon', 'Fluff', 'Romance'], fandoms: ['Pokemon'], relationships: [], categories: ['F/F'], rating: 'General Audiences', complete: true, cover: false },
  { title: 'What the Ashes Remember', synopsis: 'A Braixen carries a script she never agreed to, and a fanbase that never asked.', tags: ['Braixen', 'Psychological Horror', 'Drama'], fandoms: ['Pokemon'], relationships: [], categories: ['Gen'], rating: 'Mature/Explicit (Adult)', complete: false, cover: true },
  { title: 'Mystery Dungeon: Echo Chamber', synopsis: 'A rescue team drabble collection, one chapter per dungeon.', tags: ['PMD', 'Adventure', 'A little bit of everything'], fandoms: ['Pokemon Mystery Dungeon'], relationships: [], categories: ['Gen'], rating: 'General Audiences', complete: false, cover: false },
  { title: 'Between Storms', synopsis: 'A Lopunny and a Zoroark, stuck at the same gym for a season neither of them wanted.', tags: ['Zoroark', 'Angst', 'Enemies to Lovers', 'Slow Burn'], fandoms: ['Pokemon'], relationships: ['Zoroark/Lopunny'], categories: ['M/F'], rating: 'Teen & Up', complete: false, cover: true },
  { title: 'Original Recipe', synopsis: 'An original-character slice-of-life about running a berry stand in a town that\'s seen better days.', tags: ['Original Characters', 'Slice of Life', 'Found Family'], fandoms: ['Pokemon'], relationships: [], categories: ['Gen'], rating: 'General Audiences', complete: true, cover: false },
  { title: 'Knotted Roots', synopsis: 'A found-family fic about three Eeveelutions who were never supposed to end up related.', tags: ['Eeveelutions', 'Family', 'Fluff and Angst'], fandoms: ['Pokemon'], relationships: [], categories: ['Gen'], rating: 'General Audiences', complete: true, cover: true },
  { title: 'The Gym Leader\'s Daughter', synopsis: 'She never wanted the badge. She wanted out. A coming-of-age fic.', tags: ['Original Female Character(s)', 'Self Confidence Issues', 'Pokemon Gym Leader(s)'], fandoms: ['Pokemon'], relationships: [], categories: ['Gen'], rating: 'Teen & Up', complete: false, cover: false },
  { title: 'Ember and Undertow', synopsis: 'A Delphox who burns too hot and a Primarina who runs too cold, forced into the same rescue mission.', tags: ['Delphox', 'Primarina', 'Enemies to Lovers', 'Romantic Comedy'], fandoms: ['Pokemon'], relationships: ['Delphox/Primarina'], categories: ['M/F'], rating: 'Teen & Up', complete: false, cover: true },
  { title: 'Nine Lives, One Regret', synopsis: 'A Delcatty looks back on every choice that led her here.', tags: ['Delcatty', 'Angst', 'Loss of Parent(s)'], fandoms: ['Pokemon'], relationships: [], categories: ['Gen'], rating: 'General Audiences', complete: true, cover: false },
  { title: 'Sirens of Sylva', synopsis: 'A multi-pairing epic following four trainers across one very long summer.', tags: ['Adventure', 'Slow Romance', 'A little bit of everything', 'Original Characters'], fandoms: ['Pokemon'], relationships: ['Lucario/Riolu', 'Umbreon/Espeon'], categories: ['Multi'], rating: 'Teen & Up', complete: false, cover: true },
  { title: 'Static in the Signal', synopsis: 'A Luxray radio operator picks up something that shouldn\'t be broadcasting anymore.', tags: ['Luxray', 'Mystery', 'Psychological Horror'], fandoms: ['Pokemon'], relationships: [], categories: ['Gen'], rating: 'Mature/Explicit (Adult)', complete: false, cover: false },
  { title: 'A Softer Kind of Loud', synopsis: 'An Absol who was never good with words falls for a Gardevoir who reads them anyway.', tags: ['Absol', 'Gardevoir', 'Telepathic Bond', 'Romance'], fandoms: ['Pokemon'], relationships: ['Absol/Gardevoir'], categories: ['M/F'], rating: 'General Audiences', complete: true, cover: true },
  { title: 'Blacky\'s Ledger', synopsis: 'A Zoroark accountant, a debt that was never really about money, and a very reluctant partnership.', tags: ['Zoroark', 'Comedy', 'Bad Decisions'], fandoms: ['Pokemon'], relationships: [], categories: ['Gen'], rating: 'General Audiences', complete: false, cover: false },
];

(async () => {
  console.log('Seeding search-demo data…');

  const authorIds = [];
  for (const a of AUTHORS) {
    const hash = await bcrypt.hash('not-a-real-password-' + Math.random(), 10);
    const { rows: [existing] } = await pool.query('SELECT id FROM users WHERE username = $1', [a.username]);
    if (existing) { authorIds.push(existing.id); console.log(`  author ${a.username} already exists (id ${existing.id})`); continue; }
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, display_name, email, password_hash, verified, is_test_data)
       VALUES ($1, $2, $3, $4, true, true) RETURNING id`,
      [a.username, a.display_name, a.email, hash]
    );
    authorIds.push(u.id);
    console.log(`  created author ${a.username} (id ${u.id})`);
  }

  let coverIdx = 0;
  for (let i = 0; i < STORIES.length; i++) {
    const s = STORIES[i];
    const ownerId = authorIds[i % authorIds.length];
    const ownerUsername = AUTHORS[i % AUTHORS.length].username;
    const slug = `${ownerUsername}-${slugify(s.title)}`;
    const storyPath = `${ownerUsername}/${slugify(s.title)}`;
    const cover = s.cover ? COVERS[coverIdx++ % COVERS.length] : '';

    const { rows: [existing] } = await pool.query('SELECT id FROM moderator_sites WHERE slug = $1', [slug]);
    if (existing) { console.log(`  story "${s.title}" already exists, skipping`); continue; }

    const { rows: [site] } = await pool.query(
      `INSERT INTO moderator_sites
         (slug, owner_user_id, site_title, story_path, synopsis, cover_url, tags, fandoms, categories, relationships, rating, is_complete)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [slug, ownerId, s.title, storyPath, s.synopsis, cover,
       JSON.stringify(s.tags), JSON.stringify(s.fandoms), JSON.stringify(s.categories), JSON.stringify(s.relationships),
       s.rating, s.complete]
    );

    await pool.query(
      `INSERT INTO moderator_chapters (site_id, title, sort_order, status, body, updated_at)
       VALUES ($1, $2, 0, 'published', $3, NOW())`,
      [site.id, i % 3 === 0 ? 'Prologue' : 'Chapter 1', chapterBody()]
    );

    console.log(`  created story "${s.title}" (${storyPath})${cover ? ' [cover]' : ''}`);
  }

  console.log('Done. Cleanup: DELETE /api/admin/test-data (admin-only), or SQL: DELETE FROM users WHERE is_test_data = true;');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
