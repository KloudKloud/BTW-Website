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

// ── First-time welcome modal ─────────────────────────────────────────────
// Every new account auto-follows @btwteam server-side at verification
// (see POST /api/auth/verify). login.html sets btw_show_welcome when that
// verification's autotoken link lands there — this is the one-time payoff:
// shown on whichever page the user actually lands on, then never again.
if (localStorage.getItem('btw_show_welcome') === '1') {
  localStorage.removeItem('btw_show_welcome');
  const welcomeToken = localStorage.getItem('btw_token') || sessionStorage.getItem('btw_token');
  const welcomeAuthHeaders = welcomeToken ? { Authorization: `Bearer ${welcomeToken}` } : {};
  Promise.all([
    fetch('/api/fanpage-profile/btwteam', { headers: welcomeAuthHeaders }).then(r => r.ok ? r.json() : null),
    fetch('/api/clubs/btwclub', { headers: welcomeAuthHeaders }).then(r => r.ok ? r.json() : null),
  ]).then(([data, clubData]) => {
    const team = data && data.author;
    let following = !!(data && data.is_following);
    const club = clubData && clubData.club;
    let joined = !!(club && club.viewer_role);
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="fpnav-modal-overlay" id="fp-welcome-overlay">
        <div class="fpnav-modal-card fp-welcome-card">
          <p class="fp-welcome-title">Welcome to Between Two Worlds!</p>
          <p class="fpnav-modal-text fp-welcome-clubs-intro">Connect with your fellow community members about artwork, writing, games, and more by joining some clubs. We've featured you in our club to get started!</p>
          <div class="fp-welcome-club-row">
            <img class="fp-welcome-club-icon" src="${(club && club.icon_url) || '/images/gallery/kloudselfie_7.png'}" alt="" />
            <div class="fp-welcome-club-info">
              <span class="fp-welcome-club-name">${(club && club.name) || 'BTW Clubhouse'}</span>
              <span class="fp-welcome-club-stats">${(club && club.member_count) || 0} member${(club && club.member_count) === 1 ? '' : 's'} &middot; ${(club && club.post_count) || 0} post${(club && club.post_count) === 1 ? '' : 's'}</span>
            </div>
            <button type="button" class="fp-welcome-club-join-btn${joined ? ' joined' : ''}" id="fp-welcome-club-join-btn">
              ${joined ? '&#10003; Joined' : 'Join'}
            </button>
          </div>
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
    const clubJoinBtn = document.getElementById('fp-welcome-club-join-btn');
    if (club) {
      clubJoinBtn.addEventListener('click', async () => {
        clubJoinBtn.disabled = true;
        try {
          const res = await fetch(`/api/clubs/${club.slug}/${joined ? 'leave' : 'join'}`, {
            method: joined ? 'DELETE' : 'POST', headers: welcomeAuthHeaders,
          });
          if (res.ok) {
            joined = !joined;
            clubJoinBtn.classList.toggle('joined', joined);
            clubJoinBtn.innerHTML = joined ? '&#10003; Joined' : 'Join';
          }
        } catch {}
        clubJoinBtn.disabled = false;
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

// ── Sign-in gate (Bet/Sign In) — same cozy box-background-art card and
// two-button layout as window.fpShowAdultGate, for account-only actions
// that deserve a real popup instead of the small closable
// window.fpRequireSignIn notice above (currently just Follow — the
// clearest "you need an account for this one specific thing" moment).
// Bet just closes it and leaves the guest exactly where they were, same
// non-persistent behavior as the adult gate's card-click case; Sign In
// opens the real login modal.
(function () {
  let overlay = null;
  function build() {
    if (overlay) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="fpnav-modal-overlay" id="fp-signingate-overlay" hidden>
        <div class="fpnav-modal-card fp-signingate-card">
          <div class="fp-signingate-icon">🔑</div>
          <p class="fpnav-modal-title fp-signingate-title" id="fp-signingate-title-text"></p>
          <p class="fpnav-modal-text fp-signingate-text">Create a free account or sign in to keep going!</p>
          <div class="fp-leaving-btn-row">
            <button type="button" class="fpnav-modal-cta fpnav-modal-cta--secondary" id="fp-signingate-bet">Bet</button>
            <button type="button" class="fpnav-modal-cta fp-signingate-signin-btn" id="fp-signingate-signin">Sign In</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap.firstElementChild);
    overlay = document.getElementById('fp-signingate-overlay');
    document.getElementById('fp-signingate-bet').addEventListener('click', () => {
      overlay.hidden = true;
      document.body.classList.remove('fpnav-modal-open');
    });
    document.getElementById('fp-signingate-signin').addEventListener('click', () => {
      overlay.hidden = true;
      document.body.classList.remove('fpnav-modal-open');
      window.fpOpenLoginModal();
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) document.getElementById('fp-signingate-bet').click(); });
  }
  window.fpShowSignInGate = function (title) {
    build();
    document.getElementById('fp-signingate-title-text').textContent = title || 'You must sign in to do that';
    overlay.hidden = false;
    document.body.classList.add('fpnav-modal-open');
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
    if (!token) { window.fpShowSignInGate('Must Sign In to Report Content'); return; }
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

  root.innerHTML = `
    <div class="fpnav-bar">
      <button class="fpnav-hamburger-btn" id="fpnav-hamburger-btn" type="button" aria-label="Menu">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
      </button>

      <a class="fpnav-brand" href="${FP_BASE || '/'}"><img class="fpnav-brand-logo" src="/images/logo-fagot.png" alt="Fanpages" width="56" height="50" /></a>

      <div class="fpnav-dropdown-wrap fpnav-left-dropdown-wrap">
        <button class="fpnav-link fpnav-trigger-link${[fpUrl('/search'), fpUrl('/fandoms')].includes(here) ? ' active' : ''}" id="fpnav-browse-btn" type="button">Browse <span class="fpnav-caret">▾</span></button>
        <div class="fpnav-dropdown" id="fpnav-browse-dropdown" hidden>
          <a href="${fpUrl('/search?sort=updated&browse=1')}">Stories</a>
          <a href="${fpUrl('/search?view=submissions&browse=1')}">Posts</a>
          <a href="${fpUrl('/characters')}">Characters</a>
          <a href="${fpUrl('/fandoms')}">Fandoms</a>
        </div>
      </div>

      <!-- Never gets an .active/glow state, even when the current page IS
           /characters — Browse's own "Characters" entry points at the same
           URL, and having both light up this top-level button felt wrong,
           so per request it just never lights up at all. -->
      <a class="fpnav-link fpnav-trigger-link" href="${fpUrl('/characters')}">Characters</a>

      <a class="fpnav-link fpnav-link--clubs${here === fpUrl('/social') ? ' active' : ''}" href="${fpUrl('/social')}">Clubs</a>

      <div class="fpnav-dropdown-wrap fpnav-desktop-only-action">
        <button class="fpnav-trigger-btn" id="fpnav-upload-btn" type="button">Create <span class="fpnav-caret">▾</span></button>
        <div class="fpnav-dropdown" id="fpnav-upload-dropdown" hidden>
          <a href="${fpUrl('/editor')}" data-gate="${fpUrl('/editor')}">Creator Hub</a>
          <div class="fpnav-dropdown-divider"></div>
          <a href="${fpUrl('/upload')}" data-gate="${fpUrl('/upload')}"><span class="fpnav-plus-badge">+</span> Upload</a>
        </div>
      </div>

      <div class="fpnav-search">
        <button class="fpnav-search-icon" id="fpnav-search-icon-btn" type="button" aria-label="Search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></button>
        <input type="search" id="fpnav-search-input" placeholder="Search" />
      </div>
      <div class="fpnav-right">

        <div class="fpnav-level-badge" id="fpnav-level-badge" style="display:none;" title="">
          <div class="fpnav-level-circle" id="fpnav-level-circle"></div>
          <div class="fpnav-level-progress-track">
            <div class="fpnav-level-progress-fill" id="fpnav-level-progress-fill"></div>
          </div>
          <span class="fpnav-level-progress-text" id="fpnav-level-progress-text"></span>
        </div>

        <div class="fpnav-dropdown-wrap">
          <button class="fpnav-link fpnav-trigger-link" id="fpnav-community-btn" type="button">Community <span class="fpnav-caret">▾</span></button>
          <div class="fpnav-dropdown" id="fpnav-community-dropdown" hidden>
            <a href="${fpUrl('/news')}">News Posts</a>
            <div class="fpnav-dropdown-divider"></div>
            <a href="${fpUrl('/donations')}">Donations</a>
            <a href="${fpUrl('/discord')}">Discord</a>
            <a href="${fpUrl('/tos')}">TOS</a>
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
            <a href="${fpUrl('/admin')}" id="fpnav-admin-link" style="display:none;">Admin</a>
            <div class="fpnav-dropdown-divider"></div>
            <a href="${fpUrl('/library')}" id="fpnav-library-link">Bookmarks</a>
            <a href="${fpUrl('/notifications')}" id="fpnav-notif-link">Updates <span class="fpnav-notif-badge" id="fpnav-notif-badge" hidden></span></a>
            <a href="${fpUrl('/notifications#inbox')}" id="fpnav-updates-link">Inbox</a>
            <div class="fpnav-dropdown-divider"></div>
            <a href="#" id="fpnav-edit-profile-link">Settings</a>
            <a href="#" id="fpnav-logout-link">Logout</a>
          </div>
        </div>

      </div>

      <button class="fpnav-mobile-pfp-btn" id="fpnav-mobile-pfp-btn" type="button" aria-label="Profile">
        <span id="fpnav-mobile-pfp-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>
        </span>
      </button>
    </div>

  `;

  // ── Mobile hamburger drawer — an in-flow expanding panel, not a fixed
  // overlay. Inserted right after #fanpages-topbar-root (which reserves the
  // fixed top bar's 76px of space at the top of the document), so it opens
  // directly under the visible bar and pushes the rest of the page's real
  // content down as it grows — no internal scrolling, no backdrop, no fixed
  // height. Closing it collapses back to zero height and the page content
  // slides back up. Height animation is the CSS grid-template-rows 0fr/1fr
  // trick (.fpnav-drawer-grid) rather than a JS-measured max-height, so it
  // always fits exactly what's expanded inside it (e.g. opening Browse AND
  // Settings at once just makes the whole panel taller). Reuses the same
  // links already computed above for the desktop dropdowns. Browse/Create/
  // Community/Settings are collapsible accordion sections (data-drawer-target
  // pairs a toggle button with its #fpnav-drawer-sub-<target> submenu);
  // Search/Clubs/Characters/Bookmarks are flat top-level links.
  let cachedUser = null;
  try { cachedUser = JSON.parse(localStorage.getItem('btw_user') || sessionStorage.getItem('btw_user') || 'null'); } catch {}
  const genericPfpSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>';
  const drawerProfileIconHtml = (token && cachedUser && cachedUser.avatar)
    ? `<img src="${cachedUser.avatar}" alt="" />`
    : (token && cachedUser)
      ? `<span class="fpnav-avatar-fallback">${(cachedUser.display_name || cachedUser.username).charAt(0).toUpperCase()}</span>`
      : genericPfpSvg;
  const drawerProfileNameText = token ? ((cachedUser && (cachedUser.display_name || cachedUser.username)) || 'My Profile') : 'Sign In';

  const drawerWrap = document.createElement('div');
  drawerWrap.innerHTML = `
    <div class="fpnav-drawer-grid" id="fpnav-drawer-grid">
      <div class="fpnav-drawer-clip">
        <div class="fpnav-drawer-panel" id="fpnav-drawer-panel" role="dialog" aria-label="Menu">
          <button class="fpnav-drawer-profile-row" id="fpnav-drawer-profile-row" type="button">
            <span class="fpnav-drawer-profile-icon" id="fpnav-drawer-profile-icon">${drawerProfileIconHtml}</span>
            <span class="fpnav-drawer-profile-name" id="fpnav-drawer-profile-name">${drawerProfileNameText}</span>
          </button>

          <div class="fpnav-drawer-accordion">
            <button class="fpnav-drawer-toggle" data-drawer-target="browse" type="button">Browse <span class="fpnav-caret">&#9662;</span></button>
            <div class="fpnav-drawer-submenu" id="fpnav-drawer-sub-browse" hidden>
              <a href="${fpUrl('/search?sort=updated&browse=1')}">Stories</a>
              <a href="${fpUrl('/search?view=submissions&browse=1')}">Posts</a>
              <a href="${fpUrl('/characters')}">Characters</a>
              <a href="${fpUrl('/fandoms')}">Fandoms</a>
            </div>
          </div>

          <button class="fpnav-drawer-item" id="fpnav-drawer-search-btn" type="button">Search</button>

          <div class="fpnav-drawer-accordion">
            <button class="fpnav-drawer-toggle" data-drawer-target="create" type="button">Create <span class="fpnav-caret">&#9662;</span></button>
            <div class="fpnav-drawer-submenu" id="fpnav-drawer-sub-create" hidden>
              <a href="${fpUrl('/editor')}" data-gate="${fpUrl('/editor')}">Creator Hub</a>
              <a href="${fpUrl('/upload')}" data-gate="${fpUrl('/upload')}"><span class="fpnav-plus-badge">+</span> Upload</a>
            </div>
          </div>

          <a href="${fpUrl('/social')}">Clubs</a>
          <a href="${fpUrl('/characters')}">Characters</a>
          <a href="${fpUrl('/library')}">Bookmarks</a>

          <a href="https://ko-fi.com/veekitpaws" target="_blank" rel="noopener">Donate</a>

          <div class="fpnav-drawer-accordion">
            <button class="fpnav-drawer-toggle" data-drawer-target="community" type="button">Community <span class="fpnav-caret">&#9662;</span></button>
            <div class="fpnav-drawer-submenu" id="fpnav-drawer-sub-community" hidden>
              <a href="${fpUrl('/news')}">News Posts</a>
              <div class="fpnav-dropdown-divider"></div>
              <a href="${fpUrl('/donations')}">Donations</a>
              <a href="${fpUrl('/discord')}">Discord</a>
              <a href="${fpUrl('/tos')}">TOS</a>
            </div>
          </div>

          <div class="fpnav-drawer-accordion">
            <button class="fpnav-drawer-toggle" data-drawer-target="settings" type="button">Settings <span class="fpnav-caret">&#9662;</span></button>
            <div class="fpnav-drawer-submenu" id="fpnav-drawer-sub-settings" hidden>
              <a href="${fpUrl(`/account-settings?from=${encodeURIComponent(here)}`)}">Account Settings</a>
              <a href="/fanpages/notifications#inbox/new/veekitpaws">Feedback</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  // Inserted right after the topbar root (not appended to <body>) so it
  // lands in normal document flow directly under the fixed top bar, instead
  // of floating on top of / independent from the rest of the page.
  root.insertAdjacentElement('afterend', drawerWrap.firstElementChild);
  const drawerGrid = document.getElementById('fpnav-drawer-grid');
  const bar = document.querySelector('.fpnav-bar');
  function openHamburgerDrawer() {
    drawerGrid.classList.add('fpnav-drawer--open');
    bar.classList.add('fpnav-bar--drawer-open');
  }
  function closeHamburgerDrawer() {
    drawerGrid.classList.remove('fpnav-drawer--open');
    bar.classList.remove('fpnav-bar--drawer-open');
  }
  // The hamburger button is the only way in or out now (no separate X) —
  // every other top-bar mobile control (search, pfp) hides itself via the
  // .fpnav-bar--drawer-open class above while it's open.
  document.getElementById('fpnav-hamburger-btn').addEventListener('click', () => {
    if (drawerGrid.classList.contains('fpnav-drawer--open')) closeHamburgerDrawer();
    else openHamburgerDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerGrid.classList.contains('fpnav-drawer--open')) closeHamburgerDrawer();
  });

  document.querySelectorAll('.fpnav-drawer-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sub = document.getElementById(`fpnav-drawer-sub-${btn.dataset.drawerTarget}`);
      if (!sub) return;
      const opening = sub.hidden;
      sub.hidden = !opening;
      btn.classList.toggle('fpnav-drawer-toggle--open', opening);
    });
  });

  // Drawer's flat "Search" entry doesn't navigate anywhere -- it just
  // collapses the drawer back down so the top bar's own search input
  // (already sitting right next to the hamburger on mobile) is visible
  // again, and focuses it, instead of firing off an empty/unscoped search.
  document.getElementById('fpnav-drawer-search-btn').addEventListener('click', () => {
    closeHamburgerDrawer();
    const input = document.getElementById('fpnav-search-input');
    if (input) setTimeout(() => input.focus(), 300);
  });

  document.getElementById('fpnav-drawer-profile-row').addEventListener('click', () => {
    if (!token) { closeHamburgerDrawer(); window.fpOpenLoginModal(); return; }
    let me = null;
    try { me = JSON.parse(localStorage.getItem('btw_user') || sessionStorage.getItem('btw_user') || 'null'); } catch {}
    window.location.href = me ? fpUrl(`/${me.username}`) : fpUrl('/');
  });

  // ── Mobile PFP button (top bar, right side) — logged in: straight to
  // your own profile. Logged out: opens the sign-in modal. No dropdown,
  // unlike the desktop avatar button.
  document.getElementById('fpnav-mobile-pfp-btn').addEventListener('click', () => {
    if (!token) { window.fpOpenLoginModal(); return; }
    let me = null;
    try { me = JSON.parse(localStorage.getItem('btw_user') || sessionStorage.getItem('btw_user') || 'null'); } catch {}
    window.location.href = me ? fpUrl(`/${me.username}`) : fpUrl('/');
  });
  if (token && cachedUser && cachedUser.avatar) {
    const mobilePfpIcon = document.getElementById('fpnav-mobile-pfp-icon');
    if (mobilePfpIcon) mobilePfpIcon.innerHTML = `<img src="${cachedUser.avatar}" alt="" />`;
  } else if (token && cachedUser) {
    const mobilePfpIcon = document.getElementById('fpnav-mobile-pfp-icon');
    if (mobilePfpIcon) mobilePfpIcon.innerHTML = `<span class="fpnav-avatar-fallback">${(cachedUser.display_name || cachedUser.username).charAt(0).toUpperCase()}</span>`;
  }

  // ── Fixed bottom icon bar — Home / Search / Create / Updates / Clubs.
  // Appended straight to <body>, mobile-only via CSS (hidden entirely above
  // 1360px). Create goes straight to the Creator Hub (no more choice sheet);
  // the rest are plain navigation, matching Wattpad's own bottom nav.
  document.body.classList.add('fpnav-has-bottombar');
  // Trailing-slash-insensitive match -- the Home link's own href
  // (FP_BASE || '/') never carries a trailing slash, but here (a real
  // location.pathname) does when you're actually sitting on the home page,
  // so a naive === would never light Home up.
  const norm = (p) => (p || '/').replace(/\/+$/, '') || '/';
  const hereNorm = norm(here);
  const isHomeActive = hereNorm === norm(FP_BASE || '/');
  const isCharsActive = hereNorm === norm(fpUrl('/characters'));
  const isUpdatesActive = hereNorm === norm(fpUrl('/notifications'));
  const bottombarWrap = document.createElement('div');
  bottombarWrap.innerHTML = `
    <nav class="fpnav-bottombar" id="fpnav-bottombar" aria-label="Primary">
      <a class="fpnav-bottombar-item${isHomeActive ? ' active' : ''}" href="${FP_BASE || '/'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>
        <span>Home</span>
      </a>
      <a class="fpnav-bottombar-item${isCharsActive ? ' active' : ''}" href="${fpUrl('/characters')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="16.2" rx="4.6" ry="3.6"/><circle cx="5.6" cy="9.8" r="1.9"/><circle cx="10.2" cy="6.2" r="1.9"/><circle cx="13.8" cy="6.2" r="1.9"/><circle cx="18.4" cy="9.8" r="1.9"/></svg>
        <span>Chars</span>
      </a>
      <button class="fpnav-bottombar-item" id="fpnav-bb-create" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>
        <span>Create</span>
      </button>
      <div class="fpnav-dropdown fpnav-bb-create-sheet" id="fpnav-bb-create-sheet" hidden>
        <a href="${fpUrl('/editor')}" data-gate="${fpUrl('/editor')}">Creator Hub</a>
        <a href="${fpUrl('/upload')}" data-gate="${fpUrl('/upload')}"><span class="fpnav-plus-badge">+</span> Upload</a>
      </div>
      <button class="fpnav-bottombar-item${isUpdatesActive ? ' active' : ''}" id="fpnav-bb-notif" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        <span id="fpnav-bb-notif-badge" class="fpnav-bottombar-badge" hidden></span>
        <span>Updates</span>
      </button>
      <a class="fpnav-bottombar-item${here === fpUrl('/social') ? ' active' : ''}" href="${fpUrl('/social')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="8" r="2.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5"/><path d="M17 13.5c2.7.3 4 1.9 4 4.5"/></svg>
        <span>Clubs</span>
      </a>
    </nav>
  `;
  document.body.appendChild(bottombarWrap.firstElementChild);

  // "+Create" opens a small choice sheet (Creator Hub / +Story / +Character
  // / +Gallery) instead of jumping straight to the Creator Hub -- closes on
  // an outside click/tap, same as every other mobile menu on the site.
  const createSheet = document.getElementById('fpnav-bb-create-sheet');
  const createBtn = document.getElementById('fpnav-bb-create');
  function closeCreateSheet() {
    createSheet.hidden = true;
    createBtn.classList.remove('fpnav-bb-create--open');
  }
  createBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = createSheet.hidden;
    closeCreateSheet();
    if (opening) { createSheet.hidden = false; createBtn.classList.add('fpnav-bb-create--open'); }
  });
  createSheet.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closeCreateSheet);
  document.getElementById('fpnav-bb-notif').addEventListener('click', () => {
    if (!token) { window.fpOpenLoginModal(); return; }
    window.location.href = fpUrl('/notifications');
  });

  // ── Bottom bar: Twitter-style direction-based hide-on-scroll-down/show-on-
  // scroll-up, mobile only — the matchMedia gate means this listener does
  // nothing at all on desktop, not just "the CSS effect doesn't show" — no
  // per-scroll work happens there. The top bar is NOT part of this anymore —
  // it's a normal in-flow element on mobile now (see the mobile override on
  // .fpnav-bar in fanpages-nav.css), not fixed/sticky, so it just scrolls
  // away with the rest of the page like any other box instead of hiding/
  // reappearing. ──
  (function () {
    const bottombar = document.getElementById('fpnav-bottombar');
    const mq = window.matchMedia('(max-width: 1360px)');
    function makeScrollHider(getScrollTop) {
      let lastY = getScrollTop();
      return function onScroll() {
        if (!mq.matches) { bottombar.classList.remove('fpnav-bottombar--hidden'); return; }
        const y = getScrollTop();
        if (Math.abs(y - lastY) < 6) return;
        if (y > lastY && y > 76) bottombar.classList.add('fpnav-bottombar--hidden');
        else bottombar.classList.remove('fpnav-bottombar--hidden');
        lastY = y;
      };
    }
    window.addEventListener('scroll', makeScrollHider(() => window.scrollY), { passive: true });
    // The Inbox tab's Chats/Requests lists (.dm-list, notifications.html
    // only) are fixed-height app panels that scroll internally -- the
    // window itself barely moves there, so the shared window-scroll hider
    // above never engages. Same recipe, keyed to each list's own scrollTop
    // instead. A no-op everywhere else (nothing matches .dm-list on any
    // other page).
    document.querySelectorAll('.dm-list').forEach((list) => {
      list.addEventListener('scroll', makeScrollHider(() => list.scrollTop), { passive: true });
    });
  })();

  // ── Search ───────────────────────────────────────────────────────────────
  const searchInput = document.getElementById('fpnav-search-input');
  const currentQ = new URLSearchParams(window.location.search).get('q');
  if (here === fpUrl('/search') && currentQ) searchInput.value = currentQ;
  const runSearch = () => {
    // A search launched from this global bar is always a brand-new search,
    // same as hitting Enter/"Sort and Filter" inside search.html itself
    // (which calls its own resetCollapseStateForNewSearch for this exact
    // reason) -- mirrors those same two sessionStorage keys here since this
    // bar lives outside search.html's own script and can't call that
    // function directly. Without this, a panel collapsed while paging
    // through an earlier search stayed collapsed on this fresh one too.
    try {
      sessionStorage.removeItem('btw_search_filters_collapsed');
      sessionStorage.removeItem('btw_search_sidebar_collapsed');
    } catch {}
    const q = searchInput.value.trim();
    window.location.href = q ? fpUrl(`/search?q=${encodeURIComponent(q)}`) : fpUrl('/search');
  };
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    runSearch();
  });
  document.getElementById('fpnav-search-icon-btn').addEventListener('click', runSearch);

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
  // document-wide (not root-scoped) since the hamburger drawer's own Create
  // section lives outside #fanpages-topbar-root, appended straight to <body>.
  document.querySelectorAll('[data-gate]').forEach(link => {
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
    .then(r => (r.status === 401 ? { expired: true } : (r.ok ? r.json() : null)))
    .then(data => {
      // A stale/expired token in storage still makes `token` above truthy,
      // which is what the mobile pfp button and hamburger drawer use to
      // optimistically paint themselves as logged in (cached avatar +
      // username) before this fetch ever resolves -- the desktop avatar
      // dropdown doesn't have this problem since it starts hidden and only
      // reveals itself once /api/auth/me actually succeeds (below). Without
      // this branch, a 401 here just fell through the `!data` check right
      // below and left that stale mobile UI in place forever: the user
      // looks "shadow" logged in (own pfp/username showing) but every real
      // authenticated action (Account Settings, Follow) correctly bounces
      // them to sign in, since the server never accepted the dead token.
      // Clearing the dead token out of storage now means `token` is gone on
      // the next page load, so every page (mobile included) renders
      // honestly logged-out from the start instead of needing this repair
      // every time.
      if (data && data.expired) {
        localStorage.removeItem('btw_token'); localStorage.removeItem('btw_user');
        sessionStorage.removeItem('btw_token'); sessionStorage.removeItem('btw_user');
        const loginBtn = document.getElementById('fpnav-login-btn');
        const avatarWrap = document.getElementById('fpnav-avatar-wrap');
        if (loginBtn) loginBtn.style.display = '';
        if (avatarWrap) avatarWrap.style.display = 'none';
        const mobilePfpIcon = document.getElementById('fpnav-mobile-pfp-icon');
        if (mobilePfpIcon) mobilePfpIcon.innerHTML = genericPfpSvg;
        const drawerProfileIcon = document.getElementById('fpnav-drawer-profile-icon');
        if (drawerProfileIcon) drawerProfileIcon.innerHTML = genericPfpSvg;
        const drawerProfileName = document.getElementById('fpnav-drawer-profile-name');
        if (drawerProfileName) drawerProfileName.textContent = 'Sign In';
        return;
      }
      if (!data || !data.user) return;
      const u = data.user;
      // Persist the fresh /api/auth/me payload (includes is_admin) back into
      // the cached btw_user — pages that read CURRENT_USER straight off
      // localStorage at load time (characters.html, club.html, etc.) only
      // see is_admin correctly once this has run at least once this session.
      try {
        const store = localStorage.getItem('btw_token') ? localStorage : sessionStorage;
        const cachedRaw = store.getItem('btw_user');
        const cached = cachedRaw ? JSON.parse(cachedRaw) : {};
        store.setItem('btw_user', JSON.stringify(Object.assign({}, cached, u)));
      } catch {}
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
        const bbBadge = document.getElementById('fpnav-bb-notif-badge');
        const count = (notifData.count || 0) + (dmData.count || 0) + (reqData.requests || []).length;
        [badge, bbBadge].forEach(el => {
          if (!el) return;
          if (count > 0) { el.textContent = count > 99 ? '99+' : count; el.hidden = false; }
          else el.hidden = true;
        });
      }).catch(() => {});

      const levelBadge = document.getElementById('fpnav-level-badge');
      if (levelBadge && u.level) {
        levelBadge.style.display = '';
        levelBadge.title = u.milestone_badge || `Level ${u.level}`;
        levelBadge.onclick = () => { location.href = fpUrl('/levels'); };
        fpnavSetLevelBadge(u.level, u.xp_into_level || 0, u.xp_for_next_level || 1);
      }
      window.fpnavApplyLevelBarTheme(u.level_bar_color);

      // An XP-granting action on the *previous* page (e.g. publishing a
      // chapter, which always redirects away afterward) couldn't show its
      // own flare before navigating — it stashes the levelUp payload here
      // instead, and whichever page loads next (any of them, since this
      // script runs on all of them) picks it up and fires the flare once
      // the badge above has its fresh post-award numbers in place.
      try {
        const pending = sessionStorage.getItem('btw_pending_xp');
        if (pending) {
          sessionStorage.removeItem('btw_pending_xp');
          const pendingLevelUp = JSON.parse(pending);
          setTimeout(() => window.fpnavShowXpGain(pendingLevelUp), 500);
        }
      } catch {}

      document.getElementById('fpnav-avatar-img-wrap').innerHTML = u.avatar
        ? `<img src="${u.avatar}" alt="" />`
        : `<span class="fpnav-avatar-fallback">${initial}</span>`;
      document.getElementById('fpnav-avatar-name').textContent = name;
      const avatarHtml = u.avatar
        ? `<img src="${u.avatar}" alt="" />`
        : `<span class="fpnav-avatar-fallback">${initial}</span>`;
      const mobilePfpIcon = document.getElementById('fpnav-mobile-pfp-icon');
      if (mobilePfpIcon) mobilePfpIcon.innerHTML = avatarHtml;
      const drawerProfileIcon = document.getElementById('fpnav-drawer-profile-icon');
      if (drawerProfileIcon) drawerProfileIcon.innerHTML = avatarHtml;
      const drawerProfileName = document.getElementById('fpnav-drawer-profile-name');
      if (drawerProfileName) drawerProfileName.textContent = name;

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

// ── Live avatar refresh — called by account-settings.html right after a
// successful avatar upload, so the top-right nav icon (desktop dropdown,
// mobile pfp icon, and hamburger drawer icon) updates immediately instead
// of waiting for a full page reload to re-run the /api/auth/me fetch above.
// Global (not inside the topbar IIFE) so it's callable from any page that
// loads this script, same pattern as window.fpShare below. ─────────────
window.fpUpdateNavAvatar = function (avatarUrl) {
  const avatarHtml = `<img src="${avatarUrl}" alt="" />`;
  const imgWrap = document.getElementById('fpnav-avatar-img-wrap');
  if (imgWrap) imgWrap.innerHTML = avatarHtml;
  const mobilePfpIcon = document.getElementById('fpnav-mobile-pfp-icon');
  if (mobilePfpIcon) mobilePfpIcon.innerHTML = avatarHtml;
  const drawerProfileIcon = document.getElementById('fpnav-drawer-profile-icon');
  if (drawerProfileIcon) drawerProfileIcon.innerHTML = avatarHtml;
};

// ── Level bar color theme — swaps the top-nav level circle/bar (and, via
// the same `lb-theme-<key>` body class, the matching bar in the Levels page
// hero) to whichever preset the user picked with the Levels page's pen-color
// picker. Global so the Levels page can call it immediately after saving a
// new pick, without waiting on a reload to re-run /api/auth/me. ───────────
const LEVEL_BAR_THEME_KEYS = ['pink', 'red', 'blue', 'green', 'gold', 'teal', 'sunset', 'galaxy', 'rainbow'];
window.fpnavApplyLevelBarTheme = function (key) {
  LEVEL_BAR_THEME_KEYS.forEach(k => document.body.classList.remove(`lb-theme-${k}`));
  if (LEVEL_BAR_THEME_KEYS.includes(key)) document.body.classList.add(`lb-theme-${key}`);
};

// ── Level badge fill — shared by the one-shot /api/auth/me load above and
// fpnavShowXpGain() below, so both paths render the circle/track the same
// way. ────────────────────────────────────────────────────────────────────
function fpnavSetLevelBadge(level, into, need) {
  const circle = document.getElementById('fpnav-level-circle');
  const text = document.getElementById('fpnav-level-progress-text');
  const fill = document.getElementById('fpnav-level-progress-fill');
  if (circle) circle.textContent = level;
  if (text) text.textContent = `${into}/${need}`;
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, (into / need) * 100))}%`;
}

// ── XP gain flare — call this with the `levelUp` object any XP-granting
// endpoint now returns (see awardXp() in server.js — it always returns
// {amount, leveledUp, oldLevel, newLevel, xp, xp_into_level,
// xp_for_next_level, milestones}, not just on an actual level crossing)
// right after a successful fetch response. Floats a "+N XP" toast from the
// triggering element (or the nav badge itself, if no element is given/
// visible) up into the level bar, animates the bar filling, and — if the
// award crossed a level — follows up with the center-screen level-up card.
// Global so every page's comment/post/chapter/character/gallery submit
// handler can call it without this script exporting anything page-specific.
window.fpnavShowXpGain = function (levelUp, sourceEl) {
  if (!levelUp || !levelUp.amount) return;

  const badge = document.getElementById('fpnav-level-badge');
  const badgeVisible = badge && badge.offsetParent !== null && getComputedStyle(badge).display !== 'none';
  const anchor = (sourceEl && sourceEl.getBoundingClientRect) ? sourceEl : (badgeVisible ? badge : null);

  const toast = document.createElement('div');
  toast.className = 'fpnav-xp-toast';
  toast.textContent = `+${levelUp.amount} XP`;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    toast.style.left = `${rect.left + rect.width / 2}px`;
    toast.style.top = `${rect.top}px`;
  } else {
    // No badge on screen (mobile nav hides it) and no source element given
    // — fall back to a fixed spot near the top of the viewport so the toast
    // still appears somewhere sensible.
    toast.style.left = '50%';
    toast.style.top = '70px';
  }
  document.body.appendChild(toast);
  toast.addEventListener('animationend', () => toast.remove());

  if (badgeVisible) {
    if (levelUp.leveledUp) {
      // Snap empty first so the refill visibly animates from 0 rather than
      // jumping backward (new level's bar starts lower than the old one).
      const fill = document.getElementById('fpnav-level-progress-fill');
      if (fill) {
        fill.style.transition = 'none';
        fill.style.width = '0%';
        void fill.offsetWidth;
        fill.style.transition = '';
      }
    }
    fpnavSetLevelBadge(levelUp.newLevel, levelUp.xp_into_level, levelUp.xp_for_next_level);
  }

  if (levelUp.leveledUp) {
    setTimeout(() => window.fpnavShowLevelUp(levelUp), badgeVisible ? 300 : 0);
  }
};

// ── Stash XP for the next page load — use this instead of fpnavShowXpGain
// when the current action redirects away immediately after succeeding (a
// character/gallery create, a newspaper post, etc. all send the user
// somewhere else right after the fetch resolves), so the flare isn't lost
// mid-navigation. Picked up and fired by the /api/auth/me handler above on
// whichever page loads next.
window.fpnavStashXpGain = function (levelUp) {
  if (!levelUp || !levelUp.amount) return;
  try { sessionStorage.setItem('btw_pending_xp', JSON.stringify(levelUp)); } catch {}
};

// Shows the OLD level (and OLD milestone title, if any) first, holds, then
// does a real 3D flip to the NEW level — and to the NEW milestone title too,
// but only if a milestone boundary was actually crossed this jump, so a
// plain level-up (no milestone change) just keeps the same title in place
// underneath the flipping number the whole time. Timing here must stay in
// sync with the CSS (fpnav-levelup-overlay-fade / -card-pop, both 4.8s).
window.fpnavShowLevelUp = function (levelUp) {
  const oldMilestone = levelUp.oldMilestone || null;
  const newMilestone = levelUp.newMilestone
    || (levelUp.milestones && levelUp.milestones.length ? levelUp.milestones[levelUp.milestones.length - 1] : null);
  const milestoneChanged = !!(newMilestone && (!oldMilestone || oldMilestone.badge !== newMilestone.badge));

  let milestoneHtml = '';
  if (milestoneChanged) {
    milestoneHtml = `
      <div class="fpnav-levelup-flip-wrap fpnav-levelup-flip-wrap--milestone">
        <div class="fpnav-levelup-flip-inner fpnav-levelup-ms-inner">
          <div class="fpnav-levelup-flip-face fpnav-levelup-flip-front fpnav-levelup-milestone">${oldMilestone ? oldMilestone.badge : ''}</div>
          <div class="fpnav-levelup-flip-face fpnav-levelup-flip-back fpnav-levelup-milestone">${newMilestone.badge}</div>
        </div>
      </div>`;
  } else if (newMilestone) {
    milestoneHtml = `<div class="fpnav-levelup-milestone">${newMilestone.badge}</div>`;
  }

  const overlay = document.createElement('div');
  overlay.className = 'fpnav-levelup-overlay';
  overlay.innerHTML = `
    <div class="fpnav-levelup-card">
      <div class="fpnav-levelup-label">Level Up!</div>
      <div class="fpnav-levelup-flip-wrap fpnav-levelup-flip-wrap--number">
        <div class="fpnav-levelup-flip-inner fpnav-levelup-num-inner">
          <div class="fpnav-levelup-flip-face fpnav-levelup-flip-front fpnav-levelup-number">${levelUp.oldLevel}</div>
          <div class="fpnav-levelup-flip-face fpnav-levelup-flip-back fpnav-levelup-number">${levelUp.newLevel}</div>
        </div>
      </div>
      ${milestoneHtml}
    </div>
  `;
  document.body.appendChild(overlay);

  // Hold on the old level for a beat, then flip the number — and the
  // milestone title a touch after, for a small cascading feel instead of
  // both snapping at once.
  setTimeout(() => {
    const numInner = overlay.querySelector('.fpnav-levelup-num-inner');
    if (numInner) numInner.classList.add('fpnav-levelup-flip-inner--go');
  }, 1300);
  if (milestoneChanged) {
    setTimeout(() => {
      const msInner = overlay.querySelector('.fpnav-levelup-ms-inner');
      if (msInner) msInner.classList.add('fpnav-levelup-flip-inner--go');
    }, 1450);
  }

  setTimeout(() => overlay.remove(), 4900);
};

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

// ── "You are leaving BTWFics" interstitial — Discord-style warning before
// following any user-submitted/external link, since URL-format validation
// (isValidHttpUrl etc. elsewhere) can only catch bad schemes, never a
// legitimate-looking link (a Google Drive share, a shortener) that leads to
// something malicious. One delegated, capture-phase document listener
// covers every page that loads this script and every link already using
// the site's own established external-link convention (target="_blank"),
// past and future, without having to tag each individual render site.
// Capture phase so this runs before any per-element click listener already
// on the anchor (e.g. character.html's Spotify-app-deep-link try/fallback)
// -- this intentionally supersedes that kind of per-domain special-casing
// in favor of one consistent warning everywhere.
(function () {
  const TRUSTED_KEY = 'btw_trusted_link_domains';
  function getTrustedDomains() {
    try { return JSON.parse(localStorage.getItem(TRUSTED_KEY) || '[]'); } catch { return []; }
  }
  function trustDomain(host) {
    const list = getTrustedDomains();
    if (!list.includes(host)) { list.push(host); try { localStorage.setItem(TRUSTED_KEY, JSON.stringify(list)); } catch {} }
  }
  function isSameSite(hostname) {
    const norm = (h) => (h || '').replace(/^www\./, '').toLowerCase();
    const here = norm(location.hostname);
    const there = norm(hostname);
    return there === here || there === 'btwfics.net' || there === 'btwfanfic.net';
  }

  let leavingOverlay = null;
  function showLeavingModal(url) {
    if (!leavingOverlay) {
      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <div class="fpnav-modal-overlay" id="fp-leaving-overlay" hidden>
          <div class="fpnav-modal-card fp-leaving-card">
            <div class="fp-leaving-icon">🔗</div>
            <p class="fpnav-modal-title fp-leaving-title">You're Leaving BTWFics <img src="/images/home/decoration-1.png" alt="" /></p>
            <p class="fpnav-modal-text fp-leaving-text">
              This link was posted by another user and goes to
              <strong id="fp-leaving-host"></strong>, a site we don't control.
              Make sure you trust it before continuing.
            </p>
            <p class="fp-leaving-url" id="fp-leaving-url"></p>
            <label class="fp-leaving-trust-row">
              <input type="checkbox" id="fp-leaving-trust-check" />
              Don't ask again for this site
            </label>
            <div class="fp-leaving-btn-row">
              <button type="button" class="fpnav-modal-cta fpnav-modal-cta--secondary" id="fp-leaving-cancel">Go Back</button>
              <button type="button" class="fpnav-modal-cta fp-leaving-continue-btn" id="fp-leaving-continue">Continue</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(wrap.firstElementChild);
      leavingOverlay = document.getElementById('fp-leaving-overlay');
      leavingOverlay.addEventListener('click', (e) => { if (e.target === leavingOverlay) closeLeavingModal(); });
      document.getElementById('fp-leaving-cancel').addEventListener('click', closeLeavingModal);
      document.getElementById('fp-leaving-continue').addEventListener('click', () => {
        const checked = document.getElementById('fp-leaving-trust-check').checked;
        const target = leavingOverlay.dataset.targetUrl;
        const host = leavingOverlay.dataset.targetHost;
        closeLeavingModal();
        if (checked && host) trustDomain(host);
        window.open(target, '_blank', 'noopener');
      });
    }
    const u = new URL(url);
    leavingOverlay.dataset.targetUrl = url;
    leavingOverlay.dataset.targetHost = u.hostname;
    document.getElementById('fp-leaving-host').textContent = u.hostname;
    document.getElementById('fp-leaving-url').textContent = url.length > 80 ? url.slice(0, 77) + '…' : url;
    document.getElementById('fp-leaving-trust-check').checked = false;
    leavingOverlay.hidden = false;
  }
  function closeLeavingModal() { if (leavingOverlay) leavingOverlay.hidden = true; }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[target="_blank"]');
    if (!a || !a.href) return;
    // Explicit, per-link opt-out for a link that already has its own
    // deliberate click behavior this interstitial would otherwise block by
    // capturing the click first (e.g. character pages' Spotify
    // try-the-app-then-fall-back-to-web trick).
    if (a.dataset.skipLeavingWarning) return;
    let url;
    try { url = new URL(a.href, location.href); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (isSameSite(url.hostname)) return;
    if (getTrustedDomains().includes(url.hostname)) return;
    e.preventDefault();
    e.stopPropagation();
    showLeavingModal(url.href);
  }, true);
})();

// ── Adult-content login gate — the popup shown whenever a guest (no
// btw_token) tries to reach mature/explicit content (a story, chapter,
// gallery post, character, or club marked 18+). Logged-in accounts never
// hit this; SFW Mode on a logged-in account is a separate, pre-existing
// gate (inline "Hidden by SFW Mode" messaging), not this one. Every
// detail-page fetch that can return 18+ content checks the response for a
// lock signal and calls window.fpShowAdultGate() instead of rendering
// anything, so a guest never sees so much as a flashed frame of the real
// content before the popup appears.
(function () {
  let overlay = null;
  function build() {
    if (overlay) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="fpnav-modal-overlay" id="fp-adultgate-overlay" hidden>
        <div class="fpnav-modal-card fp-adultgate-card">
          <div class="fp-adultgate-icon">🔒</div>
          <p class="fpnav-modal-title fp-adultgate-title">18+ Content <img src="/images/home/decoration-1.png" alt="" /></p>
          <p class="fpnav-modal-text fp-adultgate-text">You must be logged in to access adult content.</p>
          <div class="fp-leaving-btn-row">
            <button type="button" class="fpnav-modal-cta fpnav-modal-cta--secondary" id="fp-adultgate-bet">Bet</button>
            <button type="button" class="fpnav-modal-cta fp-adultgate-signin-btn" id="fp-adultgate-signin">Sign In</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap.firstElementChild);
    overlay = document.getElementById('fp-adultgate-overlay');
    // "Bet" never navigates anywhere -- it just closes the popup and leaves
    // the guest exactly where they were, so a locked card can be clicked
    // again for the same prompt (a deliberate loop, not a dead end). For a
    // persistent gate (a direct link straight to 18+ content, where the
    // whole page has nothing real to show once the popup's gone), Bet
    // instead closes and immediately reopens the same prompt -- there's no
    // "where they were" to return to short of Sign In actually resolving it.
    document.getElementById('fp-adultgate-bet').addEventListener('click', () => {
      if (overlay.dataset.persistent === '1') {
        overlay.hidden = true;
        document.body.classList.remove('fpnav-modal-open');
        requestAnimationFrame(() => {
          overlay.hidden = false;
          document.body.classList.add('fpnav-modal-open');
        });
        return;
      }
      overlay.hidden = true;
      document.body.classList.remove('fpnav-modal-open');
    });
    document.getElementById('fp-adultgate-signin').addEventListener('click', () => {
      overlay.hidden = true;
      document.body.classList.remove('fpnav-modal-open');
      const token = localStorage.getItem('btw_token') || sessionStorage.getItem('btw_token');
      if (token) {
        window.location.href = window.fpUrl(`/account-settings?from=${encodeURIComponent(window.location.pathname)}`);
      } else {
        window.fpOpenLoginModal();
      }
    });
  }
  // No outside-click/Escape dismissal and no close button — the guest must
  // actively choose Bet or Sign In/Settings, since the page underneath has
  // nothing valid to show them either way.
  // opts.persistent: true for a full-page gate (a direct visit to 18+
  // content with nothing else behind the popup) so Bet loops back to the
  // same prompt instead of leaving a blank page exposed; omitted/false for
  // a gate triggered by clicking a locked card on an otherwise-normal page,
  // where Bet should just close it and return to that page.
  // A logged-in account only ever lands on this gate because their own SFW
  // Mode is hiding the content (guests are the only other case, and they
  // have no account to be logged into) -- so the wording/second button
  // swap to "must enable NSFW access" + "Settings" (straight to Account
  // Settings) instead of the guest-facing "must be logged in" + "Sign In".
  window.fpShowAdultGate = function (opts) {
    build();
    overlay.dataset.persistent = (opts && opts.persistent) ? '1' : '';
    const token = localStorage.getItem('btw_token') || sessionStorage.getItem('btw_token');
    overlay.querySelector('.fp-adultgate-text').textContent = token
      ? 'Must enable NSFW access to see content.'
      : 'You must be logged in to access adult content.';
    overlay.querySelector('.fp-adultgate-signin-btn').textContent = token ? 'Settings' : 'Sign In';
    overlay.hidden = false;
    document.body.classList.add('fpnav-modal-open');
  };
})();

// ── Gems for being on the site ───────────────────────────────────────────────
// A heartbeat that runs on every page this script is on, for logged-in users
// only. It ticks once a minute but only SENDS if the tab is visible AND the
// person did something (mouse, scroll, key, tap) in the last two minutes — so a
// background tab or an idle laptop earns nothing. It's just a signal: the
// server decides the amount and pays at most once every ~5 minutes per account
// (so several tabs/devices don't stack), which means tampering with this file
// can't speed anything up. Payouts show a small "+N 💎" pill and fire a
// 'btw:gems' event so a page showing the balance (the Arcade) can update live.
window.fpnavShowGemGain = function (amount) {
  const toast = document.createElement('div');
  toast.className = 'fpnav-gem-toast';
  toast.textContent = `+${amount} 💎`;
  document.body.appendChild(toast);
  toast.addEventListener('animationend', () => toast.remove());
};

(function () {
  const token = localStorage.getItem('btw_token') || sessionStorage.getItem('btw_token');
  if (!token) return;

  const TICK_MS = 60 * 1000;
  const IDLE_MS = 2 * 60 * 1000;
  let lastActive = Date.now();
  ['mousemove', 'mousedown', 'keydown', 'scroll', 'wheel', 'touchstart'].forEach((ev) =>
    window.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true, capture: true })
  );

  async function beat() {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastActive > IDLE_MS) return;
    try {
      const res = await fetch('/api/gems/presence', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data = await res.json();
      if (data.awarded) {
        window.fpnavShowGemGain(data.amount);
        document.dispatchEvent(new CustomEvent('btw:gems', { detail: { gems: data.gems, amount: data.amount } }));
      }
    } catch { /* offline or logged out — try again next tick */ }
  }
  setInterval(beat, TICK_MS);
})();
