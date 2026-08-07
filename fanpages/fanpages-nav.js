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

// ── Site-wide 18+ age gate ───────────────────────────────────────────────
// Runs before anything else on this script (topbar injection, favicon
// swap, etc.) so there's minimal flash of the underlying page. Every
// unregistered visitor must accept once, no matter which page they land
// on first. Logged-in users skip this — they already agreed to the 18+
// notice at signup. Guests are asked exactly once; remembered in
// localStorage until they clear it themselves (no expiry).
(function () {
  const hasToken = !!(localStorage.getItem('btw_token') || sessionStorage.getItem('btw_token'));
  const confirmed = localStorage.getItem('btw_age_confirmed') === '1';
  const gateUrl = window.fpUrl('/agecheck');
  const onGatePage = location.pathname.replace(/\/$/, '') === gateUrl.replace(/\/$/, '');
  if (hasToken || confirmed || onGatePage) return;
  const from = location.pathname + location.search;
  window.location.replace(`${gateUrl}?from=${encodeURIComponent(from)}`);
})();

// btwfics.net gets its own favicon so the browser tab visually distinguishes
// it from btwfanfic.net, even though every page's static <link rel="icon">
// markup still points at the shared default (same file serves both domains).
if (!window.FP_BASE) {
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) favicon.href = '/images/gallery/infernoselfie_8.png';
}

// ── First-time welcome modal ─────────────────────────────────────────────
// Every new account auto-follows @btwteam server-side at verification
// (see POST /api/auth/verify). login.html sets btw_show_welcome when that
// verification's autotoken link lands there — this is the one-time payoff:
// shown on whichever page the user actually lands on, then never again.
if (localStorage.getItem('btw_show_welcome') === '1') {
  localStorage.removeItem('btw_show_welcome');
  const welcomeToken = localStorage.getItem('btw_token') || sessionStorage.getItem('btw_token');
  const welcomeAuthHeaders = welcomeToken ? { Authorization: `Bearer ${welcomeToken}` } : {};
  fetch('/api/fanpage-profile/btwteam', { headers: welcomeAuthHeaders }).then(r => r.ok ? r.json() : null).then(data => {
    const team = data && data.author;
    let following = !!(data && data.is_following);
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="fpnav-modal-overlay" id="fp-welcome-overlay">
        <div class="fpnav-modal-card fp-welcome-card">
          <p class="fp-welcome-title">Welcome to Between Two Worlds!</p>
          <p class="fpnav-modal-text">You can follow other users, and customize your profile page to sparkle big! &#10024; We've followed ourselves to get you started, and don't be afraid to make new friends!</p>
          <div class="fp-welcome-team-row">
            <img class="fp-welcome-team-avatar" src="${(team && team.avatar) || '/images/gallery/pixiegarden_5.png'}" alt="" />
            <div class="fp-welcome-team-info">
              <span class="fp-welcome-team-name">${(team && (team.display_name || team.username)) || 'BTW Team'}</span>
              <span class="fp-welcome-team-followers">${(data && data.follower_count) || 0} follower${(data && data.follower_count) === 1 ? '' : 's'}</span>
            </div>
            <button type="button" class="fp-welcome-team-follow-btn${following ? ' following' : ''}" id="fp-welcome-follow-btn">
              ${following ? '&#10003; Following' : 'Follow'}
            </button>
          </div>
          <p class="fpnav-modal-text fp-welcome-flavor">May you venture off, traveler, and experience the world beyond~</p>
          <button class="fpnav-modal-cta" id="fp-welcome-next" type="button">Take me to Profile!</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap.firstElementChild);
    const overlay = document.getElementById('fp-welcome-overlay');
    const followBtn = document.getElementById('fp-welcome-follow-btn');
    if (team) {
      followBtn.addEventListener('click', async () => {
        followBtn.disabled = true;
        try {
          const res = await fetch(`/api/follows/${team.username}`, {
            method: following ? 'DELETE' : 'POST', headers: welcomeAuthHeaders,
          });
          if (res.ok) {
            following = !following;
            followBtn.classList.toggle('following', following);
            followBtn.innerHTML = following ? '&#10003; Following' : 'Follow';
          }
        } catch {}
        followBtn.disabled = false;
      });
    }
    document.getElementById('fp-welcome-next').addEventListener('click', () => {
      overlay.remove();
      let me = null;
      try { me = JSON.parse(localStorage.getItem('btw_user') || sessionStorage.getItem('btw_user') || 'null'); } catch {}
      window.location.href = me ? fpUrl(`/${me.username}`) : fpUrl('/');
    });
  }).catch(() => {});
}

// ── Shared "Welcome" login modal — e621-style, available on every page that
// loads this script (not gated behind #fanpages-topbar-root existing, since
// pages like the story reader/editor also need to be able to pop it).
// window.fpOpenLoginModal(opts) shows it:
//   opts.from             — where the "Sign up" link should send the user,
//                            and (in standalone mode) where closing the
//                            modal without logging in should send them too.
//                            Defaults to the current path+search.
//   opts.redirectOnSuccess — where to navigate after a successful login.
//                            Omitted means "just reload the current page"
//                            (the normal case — the user never left it).
//   opts.standalone       — true only for the thin /login landing page,
//                            which has no real content behind it: closing
//                            the modal (X / outside-click / Escape) there
//                            navigates to opts.from instead of just hiding.
(function () {
  const fpUrl = window.fpUrl;
  let modalOverlay = null;
  let standalone = false;
  let navigateTarget = '/';
  let redirectOnSuccess = null;

  function buildModal() {
    if (modalOverlay) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="fpnav-modal-overlay" id="fp-loginmodal-overlay" hidden>
        <div class="fpnav-modal-card fpnav-modal-card--login">
          <button class="fpnav-modal-close" id="fp-loginmodal-close" type="button" aria-label="Close">&#10005;</button>

          <div id="fp-loginmodal-view-login">
            <h2 class="fp-loginmodal-title">Welcome!</h2>
            <div class="fp-loginmodal-alert" id="fp-loginmodal-login-alert" hidden></div>
            <form class="fp-loginmodal-form" id="fp-loginmodal-login-form" novalidate>
              <div class="fp-loginmodal-field">
                <input type="text" id="fp-loginmodal-identifier" placeholder="Username or email" autocomplete="username" required />
              </div>
              <div class="fp-loginmodal-field fp-loginmodal-field--password">
                <input type="password" id="fp-loginmodal-password" placeholder="Password" autocomplete="current-password" required />
                <button type="button" class="fp-loginmodal-eye" data-target="fp-loginmodal-password" aria-label="Toggle password visibility">&#128065;</button>
              </div>
              <label class="fp-loginmodal-remember">
                <span>Remember me</span>
                <span class="fp-loginmodal-toggle">
                  <input type="checkbox" id="fp-loginmodal-remember" checked />
                  <span class="fp-loginmodal-toggle-track"><span class="fp-loginmodal-toggle-thumb"></span></span>
                </span>
              </label>
              <button type="submit" class="fp-loginmodal-btn fp-loginmodal-btn--primary">Sign In</button>
            </form>
            <button type="button" class="fp-loginmodal-link" id="fp-loginmodal-forgot-btn">Forgot your password?</button>
            <div class="fp-loginmodal-divider"></div>
            <p class="fp-loginmodal-signup-row">Don't have an account? <a href="#" id="fp-loginmodal-signup-link">Sign up</a></p>
          </div>

          <div id="fp-loginmodal-view-forgot" hidden>
            <h2 class="fp-loginmodal-title">Reset Password</h2>
            <p class="fp-loginmodal-desc">Enter your username or email and we'll send a reset link to the address on file.</p>
            <div class="fp-loginmodal-alert" id="fp-loginmodal-forgot-alert" hidden></div>
            <form class="fp-loginmodal-form" id="fp-loginmodal-forgot-form" novalidate>
              <div class="fp-loginmodal-field">
                <input type="text" id="fp-loginmodal-forgot-identifier" placeholder="Username or email" autocomplete="username" required />
              </div>
              <button type="submit" class="fp-loginmodal-btn fp-loginmodal-btn--primary">Send Reset Link</button>
            </form>
            <button type="button" class="fp-loginmodal-link" id="fp-loginmodal-back-to-login">&larr; Back to login</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap.firstElementChild);
    modalOverlay = document.getElementById('fp-loginmodal-overlay');
    wireModal();
  }

  function showView(view) {
    document.getElementById('fp-loginmodal-view-login').hidden = view !== 'login';
    document.getElementById('fp-loginmodal-view-forgot').hidden = view !== 'forgot';
  }

  function showAlert(id, message, type) {
    const el = document.getElementById(id);
    el.textContent = message;
    el.className = `fp-loginmodal-alert fp-loginmodal-alert--${type || 'error'}`;
    el.hidden = false;
  }

  function setLoading(btn, loading) {
    btn.disabled = loading;
  }

  function hideModal() {
    modalOverlay.hidden = true;
    document.body.classList.remove('fpnav-modal-open');
  }

  function handleClose() {
    hideModal();
    if (standalone) window.location.href = navigateTarget;
  }

  function handleLoginSuccess() {
    hideModal();
    if (redirectOnSuccess) { window.location.href = redirectOnSuccess; return; }
    if (standalone) { window.location.href = navigateTarget; return; }
    window.location.reload();
  }

  function wireModal() {
    document.getElementById('fp-loginmodal-close').addEventListener('click', handleClose);
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) handleClose(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalOverlay && !modalOverlay.hidden) handleClose();
    });

    document.getElementById('fp-loginmodal-forgot-btn').addEventListener('click', () => showView('forgot'));
    document.getElementById('fp-loginmodal-back-to-login').addEventListener('click', () => showView('login'));

    document.getElementById('fp-loginmodal-signup-link').addEventListener('click', (e) => {
      e.preventDefault();
      // Stashed in sessionStorage rather than a ?from= query param so the
      // /register URL stays clean — register.html reads it back out.
      sessionStorage.setItem('btw_auth_from', navigateTarget);
      window.location.href = fpUrl('/register');
    });

    document.querySelectorAll('#fp-loginmodal-overlay .fp-loginmodal-eye').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        input.type = input.type === 'password' ? 'text' : 'password';
        btn.classList.toggle('fp-loginmodal-eye--visible');
      });
    });

    document.getElementById('fp-loginmodal-login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      const identifier = document.getElementById('fp-loginmodal-identifier').value.trim();
      const password = document.getElementById('fp-loginmodal-password').value;
      const remember = document.getElementById('fp-loginmodal-remember').checked;
      if (!identifier || !password) { showAlert('fp-loginmodal-login-alert', 'Please fill in all fields.'); return; }
      setLoading(btn, true);
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier, password }),
        });
        const data = await res.json();
        if (!res.ok) { showAlert('fp-loginmodal-login-alert', data.error || 'Login failed.'); return; }
        const storage = remember ? localStorage : sessionStorage;
        storage.setItem('btw_token', data.token);
        storage.setItem('btw_user', JSON.stringify(data.user));
        handleLoginSuccess();
      } catch { showAlert('fp-loginmodal-login-alert', 'Network error. Please try again.'); }
      finally { setLoading(btn, false); }
    });

    document.getElementById('fp-loginmodal-forgot-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      const identifier = document.getElementById('fp-loginmodal-forgot-identifier').value.trim();
      if (!identifier) { showAlert('fp-loginmodal-forgot-alert', 'Please enter your username or email.'); return; }
      setLoading(btn, true);
      try {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier }),
        });
        const data = await res.json();
        if (!res.ok) showAlert('fp-loginmodal-forgot-alert', data.error || 'Something went wrong.');
        else showAlert('fp-loginmodal-forgot-alert', data.message, 'success');
      } catch { showAlert('fp-loginmodal-forgot-alert', 'Network error. Please try again.'); }
      finally { setLoading(btn, false); }
    });
  }

  window.fpOpenLoginModal = function (opts) {
    opts = opts || {};
    buildModal();
    showView('login');
    document.getElementById('fp-loginmodal-login-alert').hidden = true;
    document.getElementById('fp-loginmodal-forgot-alert').hidden = true;
    document.getElementById('fp-loginmodal-login-form').reset();
    document.getElementById('fp-loginmodal-remember').checked = true;
    standalone = !!opts.standalone;
    navigateTarget = opts.from || (window.location.pathname + window.location.search);
    redirectOnSuccess = opts.redirectOnSuccess || null;
    modalOverlay.hidden = false;
    document.body.classList.add('fpnav-modal-open');
    setTimeout(() => document.getElementById('fp-loginmodal-identifier').focus(), 30);
  };

  // ── "Sign In First" prompt — the small closable notice shown whenever a
  // guest tries an account-only action (Follow, joining a club, voting in a
  // poll, etc.) instead of yanking them to a different page. Closing it
  // (X, outside-click, Escape) just hides it and leaves them exactly where
  // they were; its two inline links either open the real login modal or
  // send them to registration. window.fpRequireSignIn(message) is the
  // entry point — message defaults to the Follow-specific wording but any
  // caller can override it.
  let signInFirstOverlay = null;
  const DEFAULT_SIGNIN_MESSAGE = 'To do that, you must create an account!';

  function buildSignInFirstModal() {
    if (signInFirstOverlay) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="fpnav-modal-overlay" id="fp-signinfirst-overlay" hidden>
        <div class="fpnav-modal-card">
          <button class="fpnav-modal-close" id="fp-signinfirst-close" type="button" aria-label="Close">&#10005;</button>
          <p class="fpnav-modal-title">Sign In First</p>
          <p class="fpnav-modal-text" id="fp-signinfirst-text"></p>
        </div>
      </div>
    `;
    document.body.appendChild(wrap.firstElementChild);
    signInFirstOverlay = document.getElementById('fp-signinfirst-overlay');

    function hide() { signInFirstOverlay.hidden = true; }
    document.getElementById('fp-signinfirst-close').addEventListener('click', hide);
    signInFirstOverlay.addEventListener('click', (e) => { if (e.target === signInFirstOverlay) hide(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !signInFirstOverlay.hidden) hide();
    });
    document.getElementById('fp-signinfirst-text').addEventListener('click', (e) => {
      const action = e.target.dataset && e.target.dataset.action;
      if (!action) return;
      e.preventDefault();
      hide();
      if (action === 'signin') window.fpOpenLoginModal();
      else if (action === 'register') {
        sessionStorage.setItem('btw_auth_from', window.location.pathname + window.location.search);
        window.location.href = fpUrl('/register');
      }
    });
  }

  // suffix lets a caller phrase the sentence as "<message> Sign In or
  // Create a free account <suffix>" instead of the default "<message> Sign
  // In here or Create a Free Account here." — used where the trailing
  // wording needs to be specific (e.g. poll voting).
  window.fpRequireSignIn = function (message, suffix) {
    buildSignInFirstModal();
    document.getElementById('fp-signinfirst-text').innerHTML = suffix
      ? `${message || DEFAULT_SIGNIN_MESSAGE} <a href="#" data-action="signin">Sign In</a> or ` +
        `<a href="#" data-action="register">Create a free account</a> ${suffix}`
      : `${message || DEFAULT_SIGNIN_MESSAGE} <a href="#" data-action="signin">Sign In</a> here or ` +
        `<a href="#" data-action="register">Create a Free Account</a> here.`;
    signInFirstOverlay.hidden = false;
  };
})();

// ── Report modal — shared by every "🏳️" flag button on the site (comments,
// stories, DMs, user profiles). Named `window.reportContent` (not fp-
// prefixed) so it's a drop-in replacement for the identical function that
// used to be copy-pasted into gallery-post.html, club.html, reader.html and
// profile-template.html — every existing onclick="reportContent(...)" call
// site keeps working untouched once each file's own local copy is deleted.
(function () {
  let overlay = null;

  function build() {
    if (overlay) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="fpnav-modal-overlay" id="fp-report-overlay" hidden>
        <div class="fpnav-modal-card">
          <button class="fpnav-modal-close" id="fp-report-close" type="button" aria-label="Close">&#10005;</button>
          <p class="fpnav-modal-title">Report Content</p>
          <div class="fp-report-alert" id="fp-report-alert" hidden></div>
          <label class="fp-report-label" for="fp-report-textarea">What to Report</label>
          <textarea class="fp-report-textarea" id="fp-report-textarea" maxlength="1000" placeholder="Briefly describe the issue…"></textarea>
          <button class="fpnav-modal-cta" id="fp-report-submit" type="button">Submit Report</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap.firstElementChild);
    overlay = document.getElementById('fp-report-overlay');

    function hide() { overlay.hidden = true; }
    document.getElementById('fp-report-close').addEventListener('click', hide);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hide(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) hide(); });
  }

  window.reportContent = function (targetType, targetId) {
    const token = localStorage.getItem('btw_token') || sessionStorage.getItem('btw_token');
    if (!token) { window.fpRequireSignIn(); return; }
    build();
    const textarea = document.getElementById('fp-report-textarea');
    const alertEl = document.getElementById('fp-report-alert');
    const submitBtn = document.getElementById('fp-report-submit');
    textarea.value = '';
    alertEl.hidden = true;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Report';
    overlay.hidden = false;
    setTimeout(() => textarea.focus(), 30);

    submitBtn.onclick = async () => {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting…';
      try {
        const res = await fetch('/api/reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ target_type: targetType, target_id: targetId, reason: textarea.value.trim() }),
        });
        if (res.ok) {
          alertEl.textContent = 'Report submitted. Thank you for helping keep the community safe.';
          alertEl.className = 'fp-report-alert fp-report-alert--success';
          alertEl.hidden = false;
          submitBtn.textContent = 'Submitted';
          setTimeout(() => { overlay.hidden = true; }, 1600);
        } else {
          alertEl.textContent = 'Something went wrong submitting the report.';
          alertEl.className = 'fp-report-alert fp-report-alert--error';
          alertEl.hidden = false;
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit Report';
        }
      } catch {
        alertEl.textContent = 'Network error. Please try again.';
        alertEl.className = 'fp-report-alert fp-report-alert--error';
        alertEl.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Report';
      }
    };
  };
})();

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
  // Already on the "BTW Homepage" confirm screen — clicking the nav item
  // again should just reload this same page (keeping whatever `from` it
  // already had), not jump straight to this site's own home page.
  const homeHref = here === fpUrl('/leaving') ? window.location.href : fpUrl(`/leaving?from=${encodeURIComponent(here)}`);

  root.innerHTML = `
    <div class="fpnav-bar">
      <a class="fpnav-brand" href="${FP_BASE || '/'}"><img class="fpnav-brand-logo" src="/images/fanpagelogo.png" alt="Fanpages" width="52" height="44" /></a>

      <div class="fpnav-dropdown-wrap">
        <button class="fpnav-link fpnav-trigger-link" id="fpnav-community-btn" type="button">Community <span class="fpnav-caret">▾</span></button>
        <div class="fpnav-dropdown" id="fpnav-community-dropdown" hidden>
          <a href="${fpUrl('/discord')}">Discord</a>
          <a href="https://ko-fi.com/veekitpaws" target="_blank" rel="noopener">Donations</a>
          <div class="fpnav-dropdown-divider"></div>
          <a href="${homeHref}">BTW Homepage</a>
          <a href="${fpUrl('/tos')}">BTW Tos</a>
        </div>
      </div>

      <!-- Never gets an .active/glow state, even when the current page IS
           /characters — Browse's own "Characters" entry points at the same
           URL, and having both light up this top-level button felt wrong,
           so per request it just never lights up at all. -->
      <a class="fpnav-link fpnav-trigger-link" href="${fpUrl('/characters')}">Characters</a>

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

        <button class="fpnav-login-btn" id="fpnav-login-btn" type="button">Sign In</button>

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
            <a href="#" id="fpnav-edit-profile-link">Account Settings</a>
            <a href="${fpUrl('/admin')}" id="fpnav-admin-link" style="display:none;">Admin</a>
            <a href="#" id="fpnav-logout-link">Logout</a>
          </div>
        </div>

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
  // "Pinned" (via the fpnav-pinned class) means a menu was explicitly
  // clicked open — it should ignore the hover-driven auto-close below and
  // stay open until something else opens or a genuine click-elsewhere-on-
  // the-page closes it, no matter how many times it's re-clicked or how far
  // the mouse wanders off it in the meantime.
  function closeAllDropdowns() {
    document.querySelectorAll('.fpnav-dropdown').forEach(el => { el.hidden = true; el.classList.remove('fpnav-pinned'); });
  }
  function wireDropdown(btnId, dropdownId) {
    const btn = document.getElementById(btnId);
    const dd  = document.getElementById(dropdownId);
    if (!btn || !dd) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = dd.hidden;
      closeAllDropdowns();
      dd.hidden = !willOpen;
      dd.classList.toggle('fpnav-pinned', willOpen);
    });
  }
  wireDropdown('fpnav-upload-btn', 'fpnav-upload-dropdown');
  wireDropdown('fpnav-avatar-btn', 'fpnav-avatar-dropdown');
  // Community and Browse also open on hover (not just click), unlike the
  // Create/avatar menus — they're pure navigation with no login-gating to
  // worry about, so there's no downside to making them quicker to get to.
  // Closing is debounced on a short timer (cleared by re-entering either
  // the button or the menu) so crossing the small visual gap between them
  // on the way down doesn't get treated as "left the menu" and slam it shut.
  // Clicking the button (as opposed to just hovering it) pins it open, so
  // hover's debounced auto-close leaves it alone even if the mouse wanders
  // off it — it stays open until either it's clicked again (closes it,
  // same as a normal toggle button) or a genuine click elsewhere on the
  // page (the document listener below) does.
  function wireHoverDropdown(btnId, dropdownId) {
    const btn = document.getElementById(btnId);
    const wrap = btn && btn.closest('.fpnav-dropdown-wrap');
    const dd = document.getElementById(dropdownId);
    if (!wrap || !dd) return;
    let closeTimer = null;
    const open = () => {
      clearTimeout(closeTimer);
      document.querySelectorAll('.fpnav-dropdown').forEach(el => { if (el !== dd) { el.hidden = true; el.classList.remove('fpnav-pinned'); } });
      dd.hidden = false;
    };
    const scheduleClose = () => {
      if (dd.classList.contains('fpnav-pinned')) return;
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => { dd.hidden = true; }, 150);
    };
    wrap.addEventListener('mouseenter', open);
    wrap.addEventListener('mouseleave', scheduleClose);
    dd.addEventListener('mouseenter', open);
    dd.addEventListener('mouseleave', scheduleClose);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!dd.hidden) {
        clearTimeout(closeTimer);
        dd.hidden = true;
        dd.classList.remove('fpnav-pinned');
        return;
      }
      open();
      dd.classList.add('fpnav-pinned');
    });
  }
  wireHoverDropdown('fpnav-browse-btn', 'fpnav-browse-dropdown');
  wireHoverDropdown('fpnav-community-btn', 'fpnav-community-dropdown');
  document.addEventListener('click', (e) => {
    if (e.target.closest('.fpnav-dropdown-wrap')) return;
    closeAllDropdowns();
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

  // ── Top-right login button — opens the shared Welcome modal in place ────
  document.getElementById('fpnav-login-btn').addEventListener('click', () => window.fpOpenLoginModal());

  // ── Login-gated links (Creator Hub / +Story / +Character / +Gallery) ────
  // No intermediate "Log in to continue" message anymore — clicking any of
  // these while logged out opens the real sign-in modal immediately.
  root.querySelectorAll('[data-gate]').forEach(link => {
    link.addEventListener('click', (e) => {
      if (!token) {
        e.preventDefault();
        const dest = link.dataset.gate;
        window.fpOpenLoginModal({ from: dest, redirectOnSuccess: dest });
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
