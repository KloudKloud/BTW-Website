// ── Cross-domain URL base ────────────────────────────────────────────────
// The Fanpage system now also serves directly from btwfics.net's own root
// (no prefix), while btwfanfic.net keeps it under /fanpages/ during the
// transition period. FP_BASE is computed here, at the top of the file
// (NOT inside the topbar IIFE below), so it's set on every page that loads
// this script even if that page has no #fanpages-topbar-root div (e.g.
// hub-builder.html, join.html, _story-template/chapter-editor.html) —
// those pages still have their own /fanpages/-prefixed redirects that need
// it. fpUrl() prepends it to an absolute path; fpFixLinks() retroactively
// rewrites any remaining prefixed links in a given container (call again
// after inserting AJAX-rendered content that contains /fanpages/ links).
window.FP_BASE = /^(www\.)?btwfics\.net$/.test(location.hostname) ? '' : '/fanpages';
window.fpUrl = function (path) {
  return window.FP_BASE + (path || '/');
};
window.fpFixLinks = function (container) {
  container = container || document;
  if (!window.FP_BASE) return; // btwfanfic.net keeps the /fanpages/ prefix as-is
  container.querySelectorAll('a[href^="/fanpages/"]').forEach(a => {
    a.setAttribute('href', a.getAttribute('href').replace(/^\/fanpages\//, '/'));
  });
  container.querySelectorAll('link[rel="canonical"][href^="/fanpages/"]').forEach(l => {
    l.setAttribute('href', l.getAttribute('href').replace(/^\/fanpages\//, '/'));
  });
  container.querySelectorAll('meta[property="og:url"][content^="/fanpages/"]').forEach(m => {
    m.setAttribute('content', m.getAttribute('content').replace(/^\/fanpages\//, '/'));
  });
};

// btwfics.net gets its own favicon so the browser tab visually distinguishes
// it from btwfanfic.net, even though every page's static <link rel="icon">
// markup still points at the shared default (same file serves both domains).
if (!window.FP_BASE) {
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) favicon.href = '/images/gallery/infernoselfie_8.png';
}

// ── Shared persistent top bar for every /fanpages/* page ────────────────────
// Injects into <div id="fanpages-topbar-root">. Handles: Fanpages/Social
// links, search bar (visual only for now), the Upload dropdown (Create
// Story / My Stories — login-gated with a Wattpad-style modal), the green
// BTW Homepage button, and the avatar dropdown (My Profile / Edit Profile).
(function () {
  const root = document.getElementById('fanpages-topbar-root');
  if (!root) return;

  const FP_BASE = window.FP_BASE;
  const fpUrl = window.fpUrl;
  const token = localStorage.getItem('btw_token') || sessionStorage.getItem('btw_token');
  const authHeaders = () => (token ? { Authorization: `Bearer ${token}` } : {});
  const here = window.location.pathname;
  // Already on the "you're leaving Fanpages" confirm screen — send straight
  // through instead of looping back to another confirm screen.
  const homeHref = here === fpUrl('/leaving') ? '/' : fpUrl(`/leaving?from=${encodeURIComponent(here)}`);

  root.innerHTML = `
    <div class="fpnav-bar">
      <a class="fpnav-brand" href="${FP_BASE || '/'}"><img class="fpnav-brand-logo" src="/images/fanpagelogo.png" alt="Fanpages" width="52" height="44" /></a>

      <div class="fpnav-dropdown-wrap">
        <button class="fpnav-link fpnav-trigger-link" id="fpnav-community-btn" type="button">Community <span class="fpnav-caret">▾</span></button>
        <div class="fpnav-dropdown" id="fpnav-community-dropdown" hidden>
          <a href="https://discord.gg/my4bPf2XUm" target="_blank" rel="noopener">Discord</a>
          <a href="https://ko-fi.com/veekitpaws" target="_blank" rel="noopener">Donations</a>
          <a href="${fpUrl('/tos')}">BTW TOS</a>
        </div>
      </div>

      <a class="fpnav-link fpnav-trigger-link${here === fpUrl('/characters') ? ' active' : ''}" href="${fpUrl('/characters')}">Characters</a>

      <div class="fpnav-dropdown-wrap fpnav-left-dropdown-wrap">
        <button class="fpnav-link fpnav-trigger-link${[fpUrl('/search'), fpUrl('/fandoms')].includes(here) ? ' active' : ''}" id="fpnav-browse-btn" type="button">Browse <span class="fpnav-caret">▾</span></button>
        <div class="fpnav-dropdown" id="fpnav-browse-dropdown" hidden>
          <a href="${fpUrl('/search?sort=updated&browse=1')}">Stories</a>
          <a href="${fpUrl('/search?view=submissions&browse=1')}">Posts</a>
          <a href="${fpUrl('/characters')}">Characters</a>
          <a href="${fpUrl('/fandoms')}">Fandoms</a>
        </div>
      </div>

      <div class="fpnav-search">
        <svg class="fpnav-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="search" id="fpnav-search-input" placeholder="Search" />
      </div>
      <div class="fpnav-right">

        <a class="fpnav-link fpnav-link--clubs${here === fpUrl('/social') ? ' active' : ''}" href="${fpUrl('/social')}">Clubs</a>

        <div class="fpnav-dropdown-wrap">
          <button class="fpnav-trigger-btn" id="fpnav-upload-btn" type="button">Create <span class="fpnav-caret">▾</span></button>
          <div class="fpnav-dropdown" id="fpnav-upload-dropdown" hidden>
            <a href="${fpUrl('/editor')}" data-gate="${fpUrl('/editor')}">Creator Hub</a>
            <div class="fpnav-dropdown-divider"></div>
            <a href="${fpUrl('/create')}" data-gate="${fpUrl('/create')}"><span class="fpnav-plus-badge">+</span> Story</a>
            <a href="${fpUrl('/create-character')}" data-gate="${fpUrl('/create-character')}"><span class="fpnav-plus-badge">+</span> Character</a>
            <a href="${fpUrl('/create-gallery')}" data-gate="${fpUrl('/create-gallery')}"><span class="fpnav-plus-badge">+</span> Gallery</a>
          </div>
        </div>

        <a class="fpnav-login-btn" id="fpnav-login-btn" href="${fpUrl(`/login?from=${encodeURIComponent(here)}`)}">Log In / Register</a>

        <div class="fpnav-dropdown-wrap" id="fpnav-avatar-wrap" style="display:none;">
          <button class="fpnav-avatar-btn" id="fpnav-avatar-btn" type="button">
            <span id="fpnav-avatar-img-wrap"></span>
            <span id="fpnav-avatar-name"></span>
          </button>
          <div class="fpnav-dropdown" id="fpnav-avatar-dropdown" hidden>
            <a href="#" id="fpnav-my-profile-link">My Profile</a>
            <div class="fpnav-dropdown-divider"></div>
            <a href="${fpUrl('/library')}" id="fpnav-library-link">Bookmarks</a>
            <a href="${fpUrl('/notifications')}" id="fpnav-notif-link">Updates <span class="fpnav-notif-badge" id="fpnav-notif-badge" hidden></span></a>
            <a href="${fpUrl('/notifications#inbox')}" id="fpnav-updates-link">Inbox</a>
            <div class="fpnav-dropdown-divider"></div>
            <a href="${homeHref}">BTW Homepage</a>
            <a href="#" id="fpnav-edit-profile-link">Account Settings</a>
            <a href="${fpUrl('/admin')}" id="fpnav-admin-link" style="display:none;">Admin</a>
            <a href="#" id="fpnav-logout-link">Logout</a>
          </div>
        </div>

      </div>
    </div>

    <div class="fpnav-modal-overlay" id="fpnav-modal-overlay" hidden>
      <div class="fpnav-modal-card">
        <button class="fpnav-modal-close" id="fpnav-modal-close" type="button">✕</button>
        <p class="fpnav-modal-title">Log in to continue</p>
        <p class="fpnav-modal-text">You'll need a free Between Two Worlds account to create or manage stories on Fanpages.</p>
        <a class="fpnav-modal-cta" id="fpnav-modal-cta" href="${fpUrl('/login')}">Log In / Register</a>
      </div>
    </div>
  `;

  // ── Search ───────────────────────────────────────────────────────────────
  const searchInput = document.getElementById('fpnav-search-input');
  const currentQ = new URLSearchParams(window.location.search).get('q');
  if (here === fpUrl('/search') && currentQ) searchInput.value = currentQ;
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = searchInput.value.trim();
    window.location.href = q ? fpUrl(`/search?q=${encodeURIComponent(q)}`) : fpUrl('/search');
  });

  // ── Dropdown toggling ────────────────────────────────────────────────────
  function wireDropdown(btnId, dropdownId) {
    const btn = document.getElementById(btnId);
    const dd  = document.getElementById(dropdownId);
    if (!btn || !dd) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = dd.hidden;
      document.querySelectorAll('.fpnav-dropdown').forEach(el => { el.hidden = true; });
      dd.hidden = !willOpen;
    });
  }
  wireDropdown('fpnav-upload-btn', 'fpnav-upload-dropdown');
  wireDropdown('fpnav-avatar-btn', 'fpnav-avatar-dropdown');
  wireDropdown('fpnav-browse-btn', 'fpnav-browse-dropdown');
  wireDropdown('fpnav-community-btn', 'fpnav-community-dropdown');
  // Community and Browse also open on hover (not just click), unlike the
  // Create/avatar menus — they're pure navigation with no login-gating to
  // worry about, so there's no downside to making them quicker to get to.
  // Closing is debounced on a short timer (cleared by re-entering either
  // the button or the menu) so crossing the small visual gap between them
  // on the way down doesn't get treated as "left the menu" and slam it shut.
  function wireHoverDropdown(btnId, dropdownId) {
    const btn = document.getElementById(btnId);
    const wrap = btn && btn.closest('.fpnav-dropdown-wrap');
    const dd = document.getElementById(dropdownId);
    if (!wrap || !dd) return;
    let closeTimer = null;
    const open = () => {
      clearTimeout(closeTimer);
      document.querySelectorAll('.fpnav-dropdown').forEach(el => { if (el !== dd) el.hidden = true; });
      dd.hidden = false;
    };
    const scheduleClose = () => {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => { dd.hidden = true; }, 150);
    };
    wrap.addEventListener('mouseenter', open);
    wrap.addEventListener('mouseleave', scheduleClose);
    dd.addEventListener('mouseenter', open);
    dd.addEventListener('mouseleave', scheduleClose);
  }
  wireHoverDropdown('fpnav-browse-btn', 'fpnav-browse-dropdown');
  wireHoverDropdown('fpnav-community-btn', 'fpnav-community-dropdown');
  document.addEventListener('click', () => {
    document.querySelectorAll('.fpnav-dropdown').forEach(el => { el.hidden = true; });
  });

  document.getElementById('fpnav-logout-link').addEventListener('click', (e) => {
    e.preventDefault();
    if (!confirm('Are you sure you want to log out?')) return;
    localStorage.removeItem('btw_token');
    localStorage.removeItem('btw_user');
    sessionStorage.removeItem('btw_token');
    sessionStorage.removeItem('btw_user');
    window.location.href = FP_BASE || '/';
  });

  // ── Login-gated links (Create Story / My Stories) ───────────────────────
  const modalOverlay = document.getElementById('fpnav-modal-overlay');
  const modalCta      = document.getElementById('fpnav-modal-cta');

  function openGateModal(dest) {
    modalCta.href = fpUrl(`/login?from=${encodeURIComponent(dest)}`);
    modalOverlay.hidden = false;
  }
  document.getElementById('fpnav-modal-close').addEventListener('click', () => { modalOverlay.hidden = true; });
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) modalOverlay.hidden = true; });

  root.querySelectorAll('[data-gate]').forEach(link => {
    link.addEventListener('click', (e) => {
      if (!token) {
        e.preventDefault();
        openGateModal(link.dataset.gate);
      }
    });
  });

  // ── Auth state ───────────────────────────────────────────────────────────
  if (!token) return; // login button + gated links already handle the logged-out state

  fetch('/api/auth/me', { headers: authHeaders() })
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      if (!data || !data.user) return;
      const u = data.user;
      const name = u.display_name || u.username;
      const initial = name.charAt(0).toUpperCase();

      document.getElementById('fpnav-login-btn').style.display = 'none';
      document.getElementById('fpnav-avatar-wrap').style.display = '';

      // Updates badge lights up for anything unread across all three:
      // notifications, unread chat messages, AND pending chat requests
      // waiting on you.
      Promise.all([
        fetch('/api/notifications/unread-count', { headers: authHeaders() }).then(r => r.ok ? r.json() : { count: 0 }).catch(() => ({ count: 0 })),
        fetch('/api/dm/unread-count', { headers: authHeaders() }).then(r => r.ok ? r.json() : { count: 0 }).catch(() => ({ count: 0 })),
        fetch('/api/dm/requests', { headers: authHeaders() }).then(r => r.ok ? r.json() : { requests: [] }).catch(() => ({ requests: [] })),
      ]).then(([notifData, dmData, reqData]) => {
        const badge = document.getElementById('fpnav-notif-badge');
        const count = (notifData.count || 0) + (dmData.count || 0) + (reqData.requests || []).length;
        if (count > 0) {
          badge.textContent = count > 99 ? '99+' : count;
          badge.hidden = false;
        } else {
          badge.hidden = true;
        }
      }).catch(() => {});

      document.getElementById('fpnav-avatar-img-wrap').innerHTML = u.avatar
        ? `<img src="${u.avatar}" alt="" />`
        : `<span class="fpnav-avatar-fallback">${initial}</span>`;
      document.getElementById('fpnav-avatar-name').textContent = name;

      document.getElementById('fpnav-my-profile-link').href = fpUrl(`/${u.username}`);
      document.getElementById('fpnav-edit-profile-link').href = fpUrl(`/account-settings?from=${encodeURIComponent(here)}`);

      // Admin link — tucked into the avatar dropdown above Logout, admins only.
      if (u.is_admin) {
        const adminLink = document.getElementById('fpnav-admin-link');
        if (adminLink) adminLink.style.display = '';
      }
    })
    .catch(() => {});
})();

// ── Shared "Share" button behavior — used by the small share icon buttons
// on story pages, profiles, gallery posts, and character pages. Opens a
// tiny "Copy Link?" popover anchored to the button instead of copying
// immediately, so there's a deliberate confirm step. Global (not inside
// the topbar IIFE above) so any page that loads this script can call it
// directly. ─────────────────────────────────────────────────────────────
function fpShowShareToast(message) {
  let toast = document.getElementById('fp-share-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'fp-share-toast';
    toast.className = 'fp-share-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.remove('fp-share-toast--visible');
  void toast.offsetWidth; // restart the transition even if already visible
  toast.classList.add('fp-share-toast--visible');
  clearTimeout(toast._fpHideTimer);
  toast._fpHideTimer = setTimeout(() => toast.classList.remove('fp-share-toast--visible'), 2200);
}

function fpCopyToClipboard(text, done) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fpShowShareToast("Couldn't copy the link."));
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { fpShowShareToast("Couldn't copy the link."); }
  document.body.removeChild(ta);
}

function fpCloseSharePopover() {
  const pop = document.getElementById('fp-share-popover');
  if (pop) pop.remove();
  document.removeEventListener('click', fpShareOutsideHandler, true);
}
function fpShareOutsideHandler(e) {
  const pop = document.getElementById('fp-share-popover');
  if (pop && !pop.contains(e.target)) fpCloseSharePopover();
}

// btn: the clicked share button (used to anchor the popover). url: link to
// copy, defaults to the current page.
window.fpShare = function (btn, url) {
  fpCloseSharePopover();
  const shareUrl = url || window.location.href;

  const pop = document.createElement('div');
  pop.className = 'fp-share-popover';
  pop.id = 'fp-share-popover';
  pop.innerHTML = `<button type="button" class="fp-share-popover-item" id="fp-share-copy-item">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l1.86-1.86a5 5 0 0 0-7.07-7.07l-1.07 1.07"/><path d="M14 11a5 5 0 0 0-7.07 0l-1.86 1.86a5 5 0 0 0 7.07 7.07l1.07-1.07"/></svg>
    Copy link
  </button>`;
  document.body.appendChild(pop);

  // Anchored over the button — centered above it, falling back to below
  // if there isn't room. This is a position:fixed element, so its
  // coordinates are viewport-relative already; don't add window.scrollX/Y
  // (that double-counts scroll and is what sent it flying off down the
  // page on a scrolled page before).
  const rect = btn.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - popRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - popRect.width - 8));
  let top = rect.top - popRect.height - 8;
  if (top < 8) top = rect.bottom + 8; // not enough room above — drop below instead
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';

  document.getElementById('fp-share-copy-item').addEventListener('click', () => {
    fpCopyToClipboard(shareUrl, () => { fpShowShareToast('Link copied!'); fpCloseSharePopover(); });
  });
  setTimeout(() => document.addEventListener('click', fpShareOutsideHandler, true), 0);
};

// ── Shared "generated cover" — the real default for a story with no cover
// set. Instead of one static stock image on every uncovered story, this
// fakes a cover out of a blurred, zoomed-in crop of the author's own avatar
// with the story title lettered over it (originally built for search.html's
// card grid; now the shared version every page should use). Only the very
// first onboarding screen — picking a cover while the story doesn't exist
// yet — keeps the plain "Add a cover" placeholder instead of this.
function fpEscapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Returns an HTML string — for template-literal / innerHTML contexts.
window.wikiGeneratedCoverHtml = function (site, opts) {
  opts = opts || {};
  const cls = opts.imgClass || '';
  const styleAttr = opts.style ? ` style="${opts.style}"` : '';
  const alt = opts.alt != null ? opts.alt : `${site.site_title || 'Untitled Story'} cover`;
  if (site.cover_url) {
    return `<img class="${cls}" src="${site.cover_url}" alt="${fpEscapeHtml(alt)}" loading="lazy"${styleAttr} />`;
  }
  const bgStyle = site.author_avatar ? ` style="background-image:url(${site.author_avatar})"` : '';
  const titleHtml = opts.small ? '' : `<span class="wiki-generated-cover-title">${fpEscapeHtml(site.site_title || 'Untitled Story')}</span>`;
  return `<div class="wiki-generated-cover${opts.small ? ' wiki-generated-cover--sm' : ''}${cls ? ' ' + cls : ''}"${styleAttr}>
    <div class="wiki-generated-cover-bg"${bgStyle}></div>
    ${titleHtml}
  </div>`;
};
// Returns a DOM node — for appendChild contexts.
window.wikiBuildGeneratedCover = function (site, opts) {
  const wrap = document.createElement('div');
  wrap.innerHTML = window.wikiGeneratedCoverHtml(site, opts).trim();
  return wrap.firstElementChild;
};
// Replaces an existing cover element in place — for pages that already have
// a fixed <img id="..."> (or a previously-generated <div id="...">, e.g.
// after a cover gets removed and re-added without a page reload) and just
// need it set to whatever the current site data says. Keeps the same id so
// nothing else referencing that id needs to change, except the caller
// should use the RETURNED element afterward — the original may have been
// swapped out for a different tag (img <-> div) and is no longer in the DOM.
window.wikiSetCoverSlot = function (el, site, opts) {
  if (site.cover_url && el.tagName === 'IMG') {
    el.src = site.cover_url;
    el.style.display = '';
    return el;
  }
  const baseClass = (el.dataset.wikiCoverBaseClass || el.className);
  const replacement = window.wikiBuildGeneratedCover(site, Object.assign({}, opts, { imgClass: [baseClass, opts && opts.imgClass].filter(Boolean).join(' ') }));
  replacement.id = el.id;
  replacement.dataset.wikiCoverBaseClass = baseClass;
  el.replaceWith(replacement);
  return replacement;
};
