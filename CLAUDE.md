# btwfanfic.net — Project Notes

Pokémon fan-fiction platform ("Between Two Worlds" / BTW). User is **VeekitPaws**
(shyfy000@gmail.com), sole admin/dev, working alongside collaborator **Blue**.

## Deploy workflow (always follow this exactly)

1. **Validate locally before touching the server:**
   - HTML files: check `<div>`/`</div>` balance, run every `<script>` block through
     `new Function()` to catch syntax errors, check `<style>` brace balance.
   - `server.js`: `node -c server.js`.
2. **Deploy:**
   - Static files: `scp <local path> root@87.99.143.27:/var/www/btw/<same relative path>`
   - Backend: `scp server.js root@87.99.143.27:/var/www/btw-api/server.js`
3. **Verify the copy:** compare `md5sum` local vs remote for every file deployed.
4. **If `server.js` changed:** `ssh root@87.99.143.27 "systemctl restart btw-api"`, then
   check `journalctl -u btw-api -n 20 --no-pager` for migration errors before moving on.
5. **Verify live:** curl/grep the deployed page or API to confirm the change actually
   took effect (curl to this host intermittently returns `HTTP 000` — a harmless
   TLS-renegotiation quirk of this environment, not a real failure; retry or drop
   `-o /dev/null` before concluding something's broken).
6. **Commit:** stage the *specific* files touched (never `git add -A`), write a
   multi-paragraph commit message explaining the *why*, end it with
   `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
7. **Push:** `git push origin master`.

The user expects this validate→deploy→verify-live→commit→push cycle for every batch of
changes, not just at the end of a session — deploy and verify BEFORE committing.

## Server layout

- Static fanpages: `/var/www/btw/fanpages/*.html` — nginx `location /fanpages/` does
  `try_files $uri $uri.html $uri/index.html @fanpage_profile`, so a brand-new
  `fanpages/whatever.html` is reachable at `/fanpages/whatever` with **no nginx config
  changes needed**.
- Backend: `/var/www/btw-api/server.js`, systemd service `btw-api`, listens on
  `127.0.0.1:3001` behind nginx.
- DB: Postgres, reachable via `ssh root@87.99.143.27 "sudo -u postgres psql -d btw -c \"...\""`.
- Per-story pages live in `fanpages/_story-template/*.html` and are nginx-rewritten per
  story (`/fanpages/<owner>/<story>/(characters|gallery|chapters|panel|edit|chapter-editor|reader)`
  → `_story-template/<page>.html`; the bare `/fanpages/<owner>/<story>` → `_story-template/index.html`).
- Single-segment `/fanpages/<username>` not matching a real file → `profile-template.html`.

## Site structure — what's built

Every page is built **except the ToS page** (has a skeleton with only the
"Ratings & Tags" section written; Overview/Content Guidelines/Account Terms tabs are
still empty). That's the only structurally-missing piece as of this writing.

Key pages: `index.html` (Fanpage Hub), `search.html` (Story/Posts/Profiles search),
`social.html` (Clubs home feed), `clubs-recent.html` / `clubs-explore.html` (new this
session), `club.html` (single club, huge file ~260KB), `profile-template.html`,
`create.html` / `_story-template/edit.html` (story create/edit), `create-character.html`
/ `_story-template/characters.html`, `create-gallery.html` / `gallery-post.html` /
`_story-template/gallery.html`.

## Conventions established this session

- **Rating system**: stories and gallery posts both use the exact same 3-tier scale —
  internal DB values `sfw` / `mature` / `explicit`, displayed as **General / Mature /
  Explicit** (not "SFW" — that label was explicitly renamed everywhere in gallery/story
  rating context, but the *separate* account-wide "SFW Mode" NSFW-visibility toggle
  keeps its own name, don't confuse the two).
- **Tag-wrangling pattern**: typed text that case-insensitively matches a catalog entry
  snaps to the catalog's canonical casing (both client-side on Enter/suggestion-click,
  and server-side again as the real trust boundary) — see `snapToCatalogCasing()` in
  server.js and `addWorkingTag()`-style functions in the editors.
- **Card/Compact view toggle**: shared `localStorage` key `btw_feed_view_mode` across
  the Home feed, Clubs Recent, and every club's Social tab. Compact is default. Card
  mode currently uses a fixed 16:9 box + `object-fit: cover` (crops) for images — the
  user flagged this as **not quite right yet** ("fix it up a bit later") after a
  `contain`-based attempt looked worse; this needs revisiting with fresh eyes, ideally
  by actually looking at a live rendered example before changing the CSS again.
  Title/author now render in a header block *above* the image (matches Reddit), that
  part is settled — only the image sizing/crop itself is still an open question.
- **Suggest dropdowns** (tag/fandom/species typeahead): use the body-appended,
  fixed-position pattern (`positionSuggestDropdown`/`renderSuggestDropdown` in
  `_story-template/edit.html` and `create.html`) — never `position:absolute` scoped to
  a parent, that breaks inside modals/scrolling containers.
- **Duplication over shared components**: this codebase has no shared-component system
  — topbar/nav injection is the only shared JS (`fanpages-nav.js`); everything else
  (sidebars, modals, card renderers) is copy-pasted per page deliberately, matching the
  established pattern. Don't introduce a new abstraction/shared module unasked.

## Homepage remodel (fanpages/index.html) — visual language

The Fanpage Hub homepage got a full visual overhaul this session (was a flat dark page,
now a video-backed, decorated design). These conventions should carry forward to other
pages as they get redesigned:

- **Bubbly font rule**: `'Fredoka', 'Lato', cursive` is now the site's "friendly/fun"
  display font for card/section titles, live billboard captions, admin bulletin caption
  inputs, dropdown modal titles — anywhere text previously used Cinzel serif for a
  *casual* heading (not everywhere Cinzel appears; Cinzel remains the base site serif for
  more formal contexts). Loaded via the existing Google Fonts `@import` in
  `fanpages-nav.css` (already had Fredoka for the nav brand), no new font load needed.
- **Video backgrounds**: `<video autoplay muted loop playsinline>` full-bleed sections
  (`.fp-video-area` pattern) use `position:absolute; inset:0; object-fit:cover` **scoped
  per-section**, not one giant page-length video — `object-fit:cover` zooms in harder the
  taller its container gets, so a single video spanning a very tall page reads as
  cropped/zoomed. Split content across multiple shorter `.fp-video-area` sections instead,
  each with its own looping clip, and blend the seam with a `::after` bottom gradient
  fade (`.fp-video-area--seam`) rather than an abrupt cut. Assets uploaded so far:
  `/images/home/main-background.mp4` (+`-2`/`-3`/`-4` variants, `-2` currently live for
  section 2, `-3`/`-4` uploaded but unused — ask before reusing, this got A/B tested
  a few times), `top-background.webm` (hero banner).
- **Box background system**: `/images/home/box-background.png` (starry gradient, used on
  spotlight cards, cropped differently per card via `background-position`),
  `box-background-2.png` (night-sky stars, Recent Submissions box + Recommended
  Followers panel), `box-background-3.png` (moonlit clouds, hero Donations/Feedback side
  panels — went back and forth between -2/-3 for the hero panels a few times, currently
  -3). Always layer a dark gradient scrim under the image
  (`linear-gradient(160deg, rgba(...), rgba(...)), url(...)`) so text stays legible over
  busy art.
- **Decoration sprites** (`/images/home/decoration-1.png` through `-8.png`, small
  transparent sparkle/moon PNGs): user's favorites are **1, 2, and 8** — those are the
  ones actually in use (1 = four-point sparkle, 2 = two-point sparkle, 8 = crescent
  moon). Used inline after titles (`.fp-title-deco`) and as small corner accents on
  cards (`.fp-card-deco`).
- **Guest-blur pattern gotcha**: the shared `.fp-guest-blur-overlay` class in
  `fanpages-nav.css` needs `:not([hidden])` on its selector — an unconditional `display`
  property on a class beats the browser's default `[hidden]{display:none}` at equal
  specificity. Fine for pages that build the guest markup fresh via JS only when logged
  out (index.html, club.html), but broke `characters.html`, which leaves the overlay
  permanently in the DOM and toggles `hidden` based on login state. If a new "locked
  content" overlay is added anywhere, check whether it's the freshly-built-via-JS pattern
  or the toggle-hidden-attribute pattern before assuming the shared CSS handles it.
- **Nav dropdown click vs. hover**: Browse/Community open on hover *and* click; clicking
  pins the dropdown open (`fpnav-pinned` class) so hover's 150ms auto-close-on-mouseleave
  leaves it alone, but re-clicking the same button (or a genuine click elsewhere on the
  page) closes it again — a real toggle, just one hover can't undo out from under a click.
  Create/avatar dropdowns stay click-only (`wireDropdown`), no hover, unaffected.
- **Row carousels**: `mountRowScroller()` in index.html wraps any `.fp-row-scroll`
  (horizontal card row) in Wattpad-style prev/next arrows that only show when there's
  actually more content in that direction — reusable for any future horizontal story/
  card row, not index.html-specific.
- **Billboard (bulletin) behavior**: the pinned "intro" slide (sort_order 0) only leads
  the rotation on a visitor's *true first-ever* page load in this browser
  (`localStorage['btw_billboard_intro_seen']`) — every load after that is a fresh shuffle
  including that slide, so navigating back to the hub mid-session doesn't reset it. VIP
  slides (`is_vip` column, checkbox in Admin → Bulletin) get force-inserted into every
  4th slot of the shuffled sequence via `insertVipEveryFourth()`, while remaining
  eligible for the normal shuffle everywhere else too (independent random pick per slot,
  not round-robin).

## Browse/Search page redesign (this session) — visual language

After the homepage remodel, the same "box-background art instead of flat dark fill"
language got carried into `search.html` (Stories/Posts/Profiles tabs), `characters.html`,
and `fandoms.html`. This is an **ongoing pattern, not a one-off** — expect to keep
applying it to whatever page comes next (Gallery browse, club pages, etc.), so the
conventions below should be the default starting point rather than something to
re-derive each time.

- **Per-tab identity via background + card system** — each major browse/search context
  now has its own paired (background, card) treatment rather than one shared look:
  - **Stories** (`search.html`, both Browse's own feed and a filtered tag/keyword
    search): flat, unblurred `box-background-5.png` page background (locked, doesn't
    scroll). Cards are the `fp-bcard-*` family — cover at its natural 2:3 ratio sized off
    a *fixed* card height (never cropped/zoomed), Rating + Ongoing/Complete badges (green/
    yellow/red traffic-light for rating, green/blue for status — deliberately different
    from the rating colors used elsewhere on the site), a 3-tile stat panel (Reads/❤
    Likes/Words), description, then a character-teaser row that always renders
    *something* (real chips or a non-clickable "No Linked Characters" placeholder) so the
    slot's height never depends on whether a story has characters linked. Browse's own
    feed is 3-per-row (`fp-bcard-grid`, no side filter panel eating width); a filtered
    search is 2-per-row (`fp-bcard-grid--narrow`, side panel present).
  - **Posts** (Browse and filtered search alike): `potential-box-background.png`,
    lightly blurred (`blur(4px)`, not the old heavy `blur(18px)` wallpaper), and — since
    Posts is a fixed-length grid rather than something that paginates in place — the
    background is allowed to **scroll with the page** instead of staying pinned. Exactly
    5 per row, 30 per page.
  - **Profiles**: the actual `main-background-4.mp4` video, genuinely locked in place.
    Achieved by making *only* the results column scroll (`position:sticky` +
    `overflow-y:auto`, same self-contained-scroll trick the side panel already used) so
    the page itself never scrolls, meaning the video never needs the "scrolls with
    content" treatment Posts has. Cards are boxed (`box-background-4.jpg`, one fixed crop
    for every card) and clickable anywhere, not just the username link.
  - **Characters** (`characters.html`, same page for both the top-nav "Characters" link
    and Browse → Characters): same Posts-style scrolling `potential-box-background.png`
    wallpaper. 5-per-row grid, 25 per page. Card info-box background needed a *fixed
    height* (not just padding-driven) to crop consistently — a variable-height box against
    a big background image crops a different slice per instance even with identical
    `background-position`, which reads as "randomly cropped" even though the CSS is
    deterministic.
  - **Fandoms** (`fandoms.html`): `main-background.mp4`, `object-fit:cover` (an earlier
    `contain` attempt left visible letterbox bars down the sides — cover-with-slight-crop
    reads better than a fully-uncropped-but-bordered video), anchored `object-position:
    center bottom` so the crop trims the top (hidden under the topbar anyway) rather than
    the bottom. Page/category titles switched to the bubbly Fredoka font with decoration
    sprites next to them, matching the homepage's heading convention.
  - Side/filter panels across all of these (Story search's "Sort and Filter", Posts'
    filter panel, Characters' sidebar, Profiles' side nav) get `box-background-3.png` +
    scrim instead of a flat `#14121a` fill, with `decoration-1`/`decoration-8` corner
    sparkles (negative `z-index` on the sticky/positioned ancestor so they sit above the
    art but below the real controls, never blocking a click).
- **"Scrolls with the page" implementation** — a background that should move with content
  (Posts, Characters) can't just be `position:fixed` (that stays pinned) or use percentage/
  `inset:0` sizing under `position:absolute` (percentage heights don't resolve against a
  body whose own height is just "however tall its content is"). The working pattern:
  `position:absolute; top:0; height:<js-set-px>`, with a small `syncBgHeight()`-style
  helper that sets `el.style.height = document.documentElement.scrollHeight + 'px'`,
  re-run after the grid renders, after each thumbnail's `load` event (images loading in
  can grow the page after the initial measurement), and on `resize`.
- **"Starts after the side panel" implementation** — when a background shouldn't run
  full-bleed *underneath* a sidebar (Profiles' video, Characters' wallpaper), offset it
  with `left: calc(<column-width>px + 2.5rem)` — the extra `2.5rem` accounts for the
  sidebar's own `margin-left: -2.5rem` trick (pulls it flush against the page edge,
  canceling `.fp-layout`'s padding), so the sidebar's actual rendered width is wider than just
  its grid-column width. Needs a mobile override resetting to `left:0; width:100%` once
  the layout collapses to one column and the sidebar stops occupying a fixed column.
- **Whole-card clickability** — any card meant to be clickable anywhere (not just its
  title link) needs: `cursor:pointer` + `data-href` on the card, and the single delegated
  `document.addEventListener('click', ...)` handler (shared across `.fp-result`,
  `.fp-bcard`, `.fp-profile-card`) bails via `e.target.closest('a, button')` — easy to
  forget the `button` half and end up with a Follow/Expand/etc. button also triggering
  navigation underneath it.
- **"· <Tab Name>" page label**: every tab's top "X found — sorted by Y" line
  (`pageLabelHtml()` in search.html) ends with a small gold `· Stories`/`· Posts`/
  `· Profiles` tag, so which section you're on is unambiguous without checking the side
  nav — extend this to any new tab/view added to that page.
- **Active-nav-item glow**: the "you are here" indicator (search.html's left nav,
  characters.html's filter menu) is a gold border + glow layered over the same
  box-background art every item shares, not a flat solid-color fill swap — the fill is
  art now, not a color, so "active" has to be communicated via border/shadow instead.

## Characters/Gallery card-grid redesign — the current direction, keep extending it

Three pages — `fanpages/characters.html` (Fanpage Hub browse), the profile's
Characters/Gallery tabs (`fanpages/profile-template.html`), and a story's own
Characters/Gallery pages (`fanpages/_story-template/characters.html` /
`gallery.html`) — got rebuilt this session onto one shared visual/interaction
pattern. **This is not a one-off: the plan is to keep carrying the same bubbly-
font + box-background-art treatment into whatever page comes next**, the same
way the homepage/Browse redesigns spread earlier. Default to this pattern
first before inventing a new one.

- **Card grid + in-page detail view, not a separate page load.** Clicking a
  character/post card swaps the grid out for a single-item detail view in the
  same DOM (`#…-grid-view` / `#…-detail-view` sibling divs, one `hidden` at a
  time) instead of navigating away — a "Back" button returns to the grid.
  `?char=ID`/`?post=ID` stays in the URL via `history.pushState` so it's still
  a real deep link, but no full reload happens switching between the two.
- **Universal card styling, not page-scoped.** `.char-name`/`.char-box-title`
  (glowy blue #cfe0f5, Fredoka, same treatment as the homepage's Spotlight
  titles) live in `fanpages/fanpages.css` (this is the file that actually wins
  the cascade — it's loaded *after* `style.css`, which has its own now-
  legacy-but-still-present copies of the same two selectors; keep both in sync
  if you touch either) — and `.char-bio-box`/`.char-box`/`.char-lore-box`
  (box-background-2 art fill) live in `style.css`. `.cc-compose > textarea`
  (PotentialBoxBackground, rounded, Fredoka placeholder) in `fanpages.css` is
  the universal comment-box look — direct-child combinator so it never touches
  gallery-post.html's differently-structured nested `.cc-compose-box textarea`
  variant. Changing any of these changes it everywhere at once; that's
  intentional now — don't re-scope back to page-local overrides.
- **Back button**: golden glowing pill (`.fp-char-back-btn`), chevron SVG
  copied from the chapter editor's own Back button
  (`<path d="M15 18l-6-6 6-6"/>`), label just "Back". Keep the glow *tight* —
  `box-shadow: 0 0 8px rgba(240,192,96,0.22)` — a wider one (the original
  `0 0 20px/0.35`) reads as a hazy rectangle behind the pill against these
  pages' busy blurred wallpapers, not a clean ambient glow. Position:
  `position: absolute;` against a `position: relative` ancestor sized to the
  *whole column* (not the narrower centered detail card) — sits right next
  to the sidebar (Fanpage Hub Characters page) or the page's own left
  padding edge (profile tab, no sidebar there), on the same horizontal line
  as the top of the reference image, which no longer gets pushed down by a
  button row above it. **Gotcha**: an absolutely positioned child is offset
  from its containing block's *padding* edge, not its outer/border edge —
  if that ancestor has its own padding (e.g. `.fp-tab-view`'s `2rem`), both
  `top` and `left` need to explicitly match that padding value (`top: 2rem;
  left: 2rem;`) to land where normal in-flow content actually starts;
  `top: 0` alone lands flush against whatever's *outside* the padding (the
  tabs row above, in the profile tab's case) even though `left` might
  already be correctly compensated. When the ancestor has zero padding of
  its own (e.g. the Fanpage Hub Characters page's plain `#fp-char-main-col`
  wrapper), add a small explicit `padding-top`/matching button `top` (this
  session settled on `1.25rem`) instead of `0`, purely so the image/button
  aren't flush against the very top of the viewport.
- **A profile's/story's custom "theme" is a Home-tab-only thing now**, not an
  account-wide background — this was an explicit direction change this
  session. Characters and Gallery (profile tabs *and* story pages) always
  force the same scrolling "Browse > Posts" wallpaper
  (`/images/home/potential-box-background.png`, `blur(4px)`, position:absolute
  with JS-measured height so it scrolls *with* the page — see `syncBgHeight`/
  `syncScrollBgHeight` in each file) regardless of what background was picked
  for Home. `profile-template.html`'s `updateTabBackground(tab)` is the single
  place that decides which of the two background layers (real theme vs.
  forced Posts wallpaper) is visible; story pages hardcode the forced call
  directly since Home/Chapters/Gallery/Characters are separate page loads
  there, not JS tab-switches. Stories/Newspapers tabs get neither (plain
  default) — extend this same three-way split to any new profile tab.
- **Pagination**: reuse the exact `fpGalleryPaginationHtml`/`.fp-page-btn`
  e621-style numbered-pager markup already in `fanpages.css` — don't invent a
  new pager.
- Sprite decorations (decoration-1 star / decoration-8 moon) got *removed*
  from the Search/Browse side filter panels and the Posts wallpaper's top-left
  corner this session (they read as clutter once the page had enough going
  on) — don't re-add them there without being asked; they're still fine/in-use
  elsewhere (card corners, section headings).
- **Next up**: the plan going into the next session is to keep applying this
  same bubbly-font/box-background-art/Home-tab-only-theme treatment to the
  *rest* of the profile tabs (Stories, Newspapers) and other story pages that
  haven't been touched yet — not a new pattern, just carrying the one above
  further. Check this section first before redesigning anything else.

## Between Two Worlds — manually migrated from btwfanfic.net (this session)

VeekitPaws' own book got manually inserted into the `moderator_sites`/`moderator_characters`
/`moderator_gallery` tables (id 133 / owner_user_id 104) by transforming data scraped from
btwfanfic.net — assets for this were already sitting locally under `images/characters/`,
`images/gallery/`, `images/sketches/`, `images/spicy/`, `images/layout/cover.png`; no
re-scraping needed if this ever has to be redone or extended. Notable gotcha: both the
profile Characters/Gallery tabs (`/api/fanpage-profile/:username/all-*`) and a story's own
roster (`character_story_links`/`gallery_story_links`) each have independent ordering —
the profile tabs sort by `created_at DESC`, the roster by `sort_order ASC` — so matching a
specific desired display order on *both* at once means setting `created_at` explicitly per
row (not relying on literal insertion sequence) while independently setting `sort_order`,
rather than trying to get one single insertion order to satisfy both.

## Feedback / working style

- Deploy and verify live *before* committing, every batch — not just at session end.
- Never `git add -A`; stage specific files.
- When a change is explicitly framed as "let's just see how it looks" / experimental,
  treat it as provisional — be ready to revert cleanly if the user says it looks worse
  (use `git checkout <prior-commit> -- <files>` for a clean revert, not manual re-edits).
- This user runs long multi-item sessions (many numbered requests per message) — track
  them with TodoWrite, work through sequentially, deploy+commit in logical batches
  rather than one giant commit at the end.
- When a message references "the [X] icon/symbol" without specifying exactly which
  glyph, grep the codebase for where that icon already exists (e.g. an SVG button
  elsewhere) instead of picking an emoji that seems thematically close — got corrected
  once this session for using 🔖 where the site already has a specific bookmark ribbon
  SVG in use elsewhere (`_story-template/reader.html`'s `#rd-bookmark-btn`).
