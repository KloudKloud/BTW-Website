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

## Feedback / working style

- Deploy and verify live *before* committing, every batch — not just at session end.
- Never `git add -A`; stage specific files.
- When a change is explicitly framed as "let's just see how it looks" / experimental,
  treat it as provisional — be ready to revert cleanly if the user says it looks worse
  (use `git checkout <prior-commit> -- <files>` for a clean revert, not manual re-edits).
- This user runs long multi-item sessions (many numbered requests per message) — track
  them with TodoWrite, work through sequentially, deploy+commit in logical batches
  rather than one giant commit at the end.
