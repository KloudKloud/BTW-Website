// One-shot full demo reseed — replaces scripts/seed-search-demo.js's small
// 3-author/15-story batch with a fuller picture: 10 throwaway accounts (all
// flagged is_test_data = true, same cleanup contract as before — DELETE
// FROM users WHERE is_test_data = true wipes everything below via FK
// cascade), 20 published stories with heavy tagging, inline + general
// comments, 20-30 gallery posts (tagged, reusing real art already in
// images/gallery/), 6 new discoverable clubs with posts, and a fresh batch
// of posts/comments in the BTW Clubhouse club.
//
// Run once from the API server: `node scripts/seed-full-demo.js`
// Cleanup: DELETE /api/admin/test-data (admin-only), or SQL:
//   DELETE FROM users WHERE is_test_data = true;
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host: 'localhost', database: 'btw', user: 'btw_user',
  password: process.env.DB_PASSWORD, port: 5432,
});

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }
function sample(arr, n) { return shuffle(arr).slice(0, Math.min(n, arr.length)); }

const AUTHORS = [
  { username: 'umiumbreon17', display_name: 'UmiUmbreon17' },
  { username: 'bestumbreonxd', display_name: 'BestUmbreonXD' },
  { username: 'shadowumbreon', display_name: 'ShadowUmbreon' },
  { username: 'umbreonmoonchild', display_name: 'UmbreonMoonchild' },
  { username: 'nightfallumbreon', display_name: 'NightfallUmbreon' },
  { username: 'saphgardevoir', display_name: 'SaphGardevoir' },
  { username: 'pixelriolu', display_name: 'PixelRiolu' },
  { username: 'inkblaziken', display_name: 'InkBlaziken' },
  { username: 'duskdelphox', display_name: 'DuskDelphox' },
  { username: 'mossyabsol', display_name: 'MossyAbsol' },
];

const IMAGES = [
  'apolloref_10.png', 'autumnleave_11.png', 'citylightsklaphy_15.jpg', 'close_6.png', 'drowning_3.png',
  'infernoselfie_8.png', 'klaphyicon_16.png', 'klaphyselfie_9.png', 'kloudsaphbedroom_1.png', 'kloudselfie_7.png',
  'pixernbath_13.png', 'pixernicecream_2.png', 'pixiegarden_5.png', 'sciencesaphie_14.png', 'sleepytime_4.png',
  'soluscheese_12.png', 'solusgarnet_17.png',
].map(f => `/images/gallery/${f}`);

const CHAPTER_PARAGRAPHS = [
  'The Floo hadn\'t been the problem. The problem was the six hours of silence after, the kind that settled into a room and refused to leave no matter how many windows got opened.',
  'She hadn\'t meant to overhear. That was the thing about thin walls in an old gym — sound traveled whether you invited it to or not, and some nights it dragged in things nobody wanted to carry.',
  'The berries were ripe early this year, and nobody had a good explanation for why. Some blamed the shifted migration patterns; others just picked faster and asked fewer questions.',
  'He counted the steps to the ridge the way he always did, out of habit more than need. Forty-one. It had been forty-one for three years, and today it still came out forty-one, which felt like it should mean something.',
  'There was a particular kind of quiet that came after a battle — not silence exactly, just the absence of everything that had mattered a minute ago.',
  'Moonlight did strange things to memory. Every ridge looked the same, every shadow felt like it was hiding something it had no business hiding.',
  'Nobody warned her that trust was a muscle. That it atrophied the same way anything else did, quietly, until one day you went to reach for it and found it wasn\'t there.',
];
function chapterBody() {
  return sample(CHAPTER_PARAGRAPHS, 4).map(p => `<p>${p}</p>`).join('');
}

const STORIES = [
  { title: 'Moonlit Reckoning', synopsis: 'An Umbreon who trusts no one is forced to trust the one Espeon who never stopped trying.', tags: ['Umbreon', 'Espeon'], relationships: ['Umbreon/Espeon'], categories: ['M/M'], rating: 'Teen & Up', complete: false, cover: true },
  { title: 'Flames We Chose', synopsis: 'A Blaziken washed out of the fighting circuit rebuilds herself one bad decision at a time.', tags: ['Blaziken', 'Drama'], relationships: [], categories: ['Gen'], rating: 'Teen & Up', complete: false, cover: true },
  { title: 'Static Hours', synopsis: 'Two rivals keep getting assigned the same night shift, and neither will admit that\'s not a coincidence anymore.', tags: ['Luxray', 'Slow Burn'], relationships: [], categories: ['M/M'], rating: 'General Audiences', complete: true, cover: false },
  { title: 'The Weight of Quiet Rooms', synopsis: 'A Gardevoir learns that reading minds and understanding people are not the same skill.', tags: ['Gardevoir', 'Psychological Horror'], relationships: [], categories: ['Gen'], rating: 'Mature/Explicit (Adult)', complete: false, cover: true },
  { title: 'Dusk Errand', synopsis: 'An Umbreon courier takes one job too many and finds out who\'s really been paying for them.', tags: ['Umbreon', 'Mystery'], relationships: [], categories: ['Gen'], rating: 'Teen & Up', complete: false, cover: false },
  { title: 'Every Ridge the Same', synopsis: 'A Riolu retraces his mentor\'s old training route, forty-one steps at a time, looking for something he can\'t name.', tags: ['Riolu', 'Lucario', 'Found Family'], relationships: [], categories: ['Gen'], rating: 'General Audiences', complete: true, cover: true },
  { title: 'Ashfall Season', synopsis: 'A Blaziken and a Delphox run the same rescue route every year the wildfires come back.', tags: ['Blaziken', 'Delphox', 'Hurt/Comfort'], relationships: ['Blaziken/Delphox'], categories: ['M/F'], rating: 'Teen & Up', complete: false, cover: true },
  { title: 'Nine Berries, No Explanation', synopsis: 'A slice-of-life drabble collection about a berry farm that keeps producing early for no good reason.', tags: ['Original Characters', 'Slice of Life'], relationships: [], categories: ['Gen'], rating: 'General Audiences', complete: false, cover: false },
  { title: 'Moonchild', synopsis: 'An Umbreon raised entirely underground finally sees the actual moon, and it changes everything she thought she knew.', tags: ['Umbreon', 'Self-Discovery'], relationships: [], categories: ['Gen'], rating: 'General Audiences', complete: true, cover: true },
  { title: 'The Absol Doesn\'t Lie', synopsis: 'A village that ignored every warning finally has to reckon with the Absol who gave them.', tags: ['Absol', 'Angst'], relationships: [], categories: ['Gen'], rating: 'Teen & Up', complete: false, cover: false },
  { title: 'Second Shift, Same Static', synopsis: 'A Jolteon and a Luxray keep the lights on at the region\'s worst-staffed Pokémon Center.', tags: ['Jolteon', 'Luxray', 'Comedy'], relationships: [], categories: ['Gen'], rating: 'General Audiences', complete: true, cover: false },
  { title: 'Blazing Trail Home', synopsis: 'A Blaziken finally goes back to the gym that cut her, and nobody there is ready for it.', tags: ['Blaziken', 'Redemption'], relationships: [], categories: ['Gen'], rating: 'Teen & Up', complete: false, cover: true },
  { title: 'What the Espeon Saw', synopsis: 'An Espeon\'s visions keep showing her a future she refuses to believe, until the Umbreon in it finally shows up.', tags: ['Espeon', 'Umbreon', 'Mystery'], relationships: ['Umbreon/Espeon'], categories: ['M/M'], rating: 'Mature/Explicit (Adult)', complete: false, cover: true },
  { title: 'Gardevoir\'s Ledger', synopsis: 'A Gardevoir accountant discovers her clients have all been lying to her telepathically, badly.', tags: ['Gardevoir', 'Comedy'], relationships: [], categories: ['Gen'], rating: 'General Audiences', complete: true, cover: false },
  { title: 'Nightfall Standing Order', synopsis: 'An Umbreon-led night patrol crew starts finding things that shouldn\'t exist on their route.', tags: ['Umbreon', 'Psychological Horror'], relationships: [], categories: ['Gen'], rating: 'Mature/Explicit (Adult)', complete: false, cover: true },
  { title: 'Delphox and the Long Winter', synopsis: 'A Delphox keeps a whole rescue team fed and warm through the region\'s worst winter in a decade.', tags: ['Delphox', 'Found Family'], relationships: [], categories: ['Gen'], rating: 'General Audiences', complete: true, cover: true },
  { title: 'Rivalry, Unresolved', synopsis: 'A Riolu and a Lucario keep training against each other because neither knows how to stop.', tags: ['Riolu', 'Lucario', 'Enemies to Lovers'], relationships: ['Lucario/Riolu'], categories: ['M/M'], rating: 'Teen & Up', complete: false, cover: false },
  { title: 'The Umbreon Who Counted Stars', synopsis: 'An Umbreon insomniac starts a star-count log and it becomes the only thing keeping her sane.', tags: ['Umbreon', 'Slice of Life'], relationships: [], categories: ['Gen'], rating: 'General Audiences', complete: false, cover: true },
  { title: 'Absol\'s Apprentice', synopsis: 'A young Absol is taught to read disaster before it happens, and hates every second of being right.', tags: ['Absol', 'Coming of Age'], relationships: [], categories: ['Gen'], rating: 'Teen & Up', complete: false, cover: false },
  { title: 'Blaziken, Interrupted', synopsis: 'A retired Blaziken fighter gets pulled back in for one last job she swore she\'d never take.', tags: ['Blaziken', 'Adventure'], relationships: [], categories: ['Gen'], rating: 'Teen & Up', complete: true, cover: true },
];

const CLUBS = [
  { name: 'Moonlit Umbreon Society', desc: 'A club for anyone who thinks Umbreon is the best Eeveelution and will not be argued with about it.' },
  { name: 'Blaziken Fight Club', desc: 'Talk training arcs, redemption fics, and everything Blaziken.' },
  { name: 'The Slow Burn Book Club', desc: 'For readers who think a good slow burn is worth the wait every single time.' },
  { name: 'Rescue Team Regulars', desc: 'Mystery Dungeon fans, rescue team AUs, and cozy found-family fic.' },
  { name: 'Night Shift Writers', desc: 'A writing accountability club for anyone drafting at 2am.' },
  { name: 'Gardevoir & Friends', desc: 'Psychic-type character studies, headcanons, and fan art.' },
];

async function ensureUser(a) {
  const { rows: [existing] } = await pool.query('SELECT id FROM users WHERE username = $1', [a.username]);
  if (existing) return existing.id;
  const hash = await bcrypt.hash('not-a-real-password-' + Math.random(), 10);
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (username, display_name, email, password_hash, verified, is_test_data)
     VALUES ($1, $2, $3, $4, true, true) RETURNING id`,
    [a.username, a.display_name, `seed-${a.username}@__testdata.invalid`, hash]
  );
  return u.id;
}

(async () => {
  console.log('Seeding full demo dataset…');

  const { rows: catalogRows } = await pool.query('SELECT name FROM tag_catalog');
  const ALL_TAGS = catalogRows.map(r => r.name);

  // ── Authors ──────────────────────────────────────────────────────────
  const authorIds = [];
  for (const a of AUTHORS) {
    const id = await ensureUser(a);
    authorIds.push(id);
    console.log(`  author ${a.username} (id ${id})`);
  }

  // ── Stories + chapters + tags ────────────────────────────────────────
  const chapterIds = [];
  let coverIdx = 0;
  for (let i = 0; i < STORIES.length; i++) {
    const s = STORIES[i];
    const ownerIdx = i % authorIds.length;
    const ownerId = authorIds[ownerIdx];
    const ownerUsername = AUTHORS[ownerIdx].username;
    const slug = `${ownerUsername}-${slugify(s.title)}`;
    const storyPath = `${ownerUsername}/${slugify(s.title)}`;
    const cover = s.cover ? IMAGES[coverIdx++ % IMAGES.length] : '';

    const { rows: [existing] } = await pool.query('SELECT id FROM moderator_sites WHERE slug = $1', [slug]);
    if (existing) { console.log(`  story "${s.title}" already exists, skipping`); continue; }

    // At least 20 tags per story: the story's own thematic tags, padded
    // with a random sample from the real catalog up to 22-26.
    const extra = sample(ALL_TAGS.filter(t => !s.tags.includes(t)), 20 + Math.floor(Math.random() * 5));
    const tags = [...new Set([...s.tags, ...extra])];

    const { rows: [site] } = await pool.query(
      `INSERT INTO moderator_sites
         (slug, owner_user_id, site_title, story_path, synopsis, cover_url, tags, fandoms, categories, relationships, rating, is_complete)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [slug, ownerId, s.title, storyPath, s.synopsis, cover,
       JSON.stringify(tags), JSON.stringify(['Pokemon']), JSON.stringify(s.categories), JSON.stringify(s.relationships),
       s.rating, s.complete]
    );

    const { rows: [chapter] } = await pool.query(
      `INSERT INTO moderator_chapters (site_id, title, sort_order, status, body, updated_at)
       VALUES ($1, $2, 0, 'published', $3, NOW() - ($4 || ' hours')::interval) RETURNING id`,
      [site.id, i % 3 === 0 ? 'Prologue' : 'Chapter 1', chapterBody(), Math.floor(Math.random() * 200)]
    );
    chapterIds.push({ id: chapter.id, siteId: site.id, storyPath });

    console.log(`  created story "${s.title}" (${storyPath}) [${tags.length} tags]${cover ? ' [cover]' : ''}`);
  }

  // ── Comments — 50+, mixed general + inline, from random dummy authors
  // on random dummy stories. ──────────────────────────────────────────
  const GENERAL_COMMENTS = [
    'this hit way harder than I expected, wow', 'okay the pacing on this chapter is so good',
    'I NEED the next update immediately', 'the dialogue in this feels so natural', 'crying over this one honestly',
    'the way you write tension is unreal', 'reread this three times already', 'this is criminally underrated',
    'the worldbuilding here is so quietly good', 'I did not expect to feel this much about a Pokémon fic today',
    'the last line absolutely wrecked me', 'this deserves so much more attention',
  ];
  const INLINE_COMMENTS = [
    'this line lives in my head now', 'oh no. oh no no no', 'the FORESHADOWING',
    'wait wait wait', 'I felt this in my chest', 'screaming', 'this paragraph is doing so much work',
  ];
  let commentCount = 0;
  const targetComments = 55;
  while (commentCount < targetComments && chapterIds.length) {
    const target = pick(chapterIds);
    const commenter = pick(authorIds);
    const inline = Math.random() < 0.4;
    if (inline) {
      await pool.query(
        `INSERT INTO content_comments (target_type, target_id, user_id, body, paragraph_index, created_at)
         VALUES ('chapter_paragraph', $1, $2, $3, $4, NOW() - ($5 || ' hours')::interval)`,
        [target.id, commenter, pick(INLINE_COMMENTS), Math.floor(Math.random() * 4), Math.floor(Math.random() * 150)]
      );
    } else {
      await pool.query(
        `INSERT INTO content_comments (target_type, target_id, user_id, body, created_at)
         VALUES ('chapter', $1, $2, $3, NOW() - ($4 || ' hours')::interval)`,
        [target.id, commenter, pick(GENERAL_COMMENTS), Math.floor(Math.random() * 150)]
      );
    }
    commentCount++;
  }
  console.log(`  posted ${commentCount} comments across ${chapterIds.length} chapters`);

  // ── Gallery posts — 20-30, tagged, reusing real existing art. Umbreon/
  // Espeon/Blaziken are each force-included on at least one post. ──────
  const GALLERY_TITLES = [
    'Moonlit sketch', 'Quick warmup doodle', 'Commission piece', 'Character study', 'Just vibes',
    'Redraw of an old piece', 'Palette swap experiment', 'Late night art', 'Reference sheet WIP',
    'Fanart for a fic I love', 'Practicing lighting', 'Self-indulgent piece', 'Gift art', 'Storm study',
    'Something soft', 'Battle pose practice', 'Cozy scene', 'Portrait study', 'Environment practice',
    'Old art revisited', 'Trade piece', 'Style experiment', 'Cover art draft', 'Quick color study',
  ];
  const GALLERY_COUNT = 24;
  const forcedTags = ['Umbreon', 'Espeon', 'Blaziken'];
  let galleryPosted = 0;
  for (let i = 0; i < GALLERY_COUNT; i++) {
    const ownerId = authorIds[i % authorIds.length];
    const image = IMAGES[i % IMAGES.length];
    const title = GALLERY_TITLES[i % GALLERY_TITLES.length];
    const category = Math.random() < 0.15 ? 'sketches' : 'sfw';
    const extra = sample(ALL_TAGS, 20 + Math.floor(Math.random() * 6));
    const tags = i < forcedTags.length ? [...new Set([forcedTags[i], ...extra])] : extra;

    await pool.query(
      `INSERT INTO moderator_gallery (owner_user_id, category, image_url, title, description, position_x, position_y, tags, created_at)
       VALUES ($1, $2, $3, $4, $5, 50, 50, $6, NOW() - ($7 || ' hours')::interval)`,
      [ownerId, category, image, title, '', JSON.stringify(tags), Math.floor(Math.random() * 300)]
    );
    galleryPosted++;
  }
  console.log(`  posted ${galleryPosted} gallery posts (Umbreon/Espeon/Blaziken each tagged at least once)`);

  // ── 6 new discoverable clubs, each with a couple posts ──────────────
  const CLUB_POST_BODIES = [
    'Welcome to the club! Introduce yourself below :3', 'What are you all working on this week?',
    'Sharing a WIP snippet, feedback welcome!', 'Anyone else obsessed with this lately?',
    'New member intro thread, say hi!', 'Weekly check-in — how\'s everyone doing?',
  ];
  for (const c of CLUBS) {
    const slug = slugify(c.name);
    const { rows: [existing] } = await pool.query('SELECT id FROM clubs WHERE slug = $1', [slug]);
    if (existing) { console.log(`  club "${c.name}" already exists, skipping`); continue; }
    const ownerId = pick(authorIds);
    const { rows: [club] } = await pool.query(
      `INSERT INTO clubs (slug, name, description, owner_user_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [slug, c.name, c.desc, ownerId]
    );
    await pool.query(
      `INSERT INTO club_members (club_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
      [club.id, ownerId]
    );
    const postCount = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < postCount; i++) {
      await pool.query(
        `INSERT INTO club_posts (club_id, author_user_id, title, body, created_at)
         VALUES ($1, $2, $3, $4, NOW() - ($5 || ' hours')::interval)`,
        [club.id, pick(authorIds), '', pick(CLUB_POST_BODIES), Math.floor(Math.random() * 100)]
      );
    }
    console.log(`  created club "${c.name}" (${postCount} posts)`);
  }

  // ── Fresh activity in the BTW Clubhouse (club slug 'btwclub') ────────
  const { rows: [clubhouse] } = await pool.query("SELECT id FROM clubs WHERE slug = 'btwclub'");
  if (clubhouse) {
    const CLUBHOUSE_POSTS = [
      'made a little doodle tonight, nothing serious',
      'does anyone else think we need more Umbreon content on this site',
      'PSA: remember to tag your spoilers please',
      'reminder that this club is a safe space to infodump about your OCs',
      'anyone want to do a collab piece sometime?',
      'finally caught up on everything, no thoughts just vibes',
      'messy warmup doodle, felt cute might delete later',
      'does anyone know a good program for digital sketching on a budget',
      'unpopular opinion time: slow burns are always worth it',
      'ok genuinely who else caught that detail in the last update',
    ];
    let clubhousePosted = 0;
    for (const body of sample(CLUBHOUSE_POSTS, 8)) {
      await pool.query(
        `INSERT INTO club_posts (club_id, author_user_id, title, body, created_at)
         VALUES ($1, $2, '', $3, NOW() - ($4 || ' hours')::interval) RETURNING id`,
        [clubhouse.id, pick(authorIds), body, Math.floor(Math.random() * 72)]
      );
      clubhousePosted++;
    }
    console.log(`  posted ${clubhousePosted} fresh posts in BTW Clubhouse`);
  } else {
    console.log('  BTW Clubhouse club not found, skipping');
  }

  console.log('Done. Cleanup: DELETE /api/admin/test-data (admin-only), or SQL: DELETE FROM users WHERE is_test_data = true;');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
