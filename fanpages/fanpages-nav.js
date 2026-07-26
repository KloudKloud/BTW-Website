// ── Shared persistent top bar for every /fanpages/* page ────────────────────
// Injects into <div id="fanpages-topbar-root">. Handles: Fanpages/Social
// links, search bar (visual only for now), the Upload dropdown (Create
// Story / My Stories — login-gated with a Wattpad-style modal), the green
// BTW Homepage button, and the avatar dropdown (My Profile / Edit Profile).
(function () {
  const root = document.getElementById('fanpages-topbar-root');
  if (!root) return;

  const token = localStorage.getItem('btw_token') || sessionStorage.getItem('btw_token');
  const authHeaders = () => (token ? { Authorization: `Bearer ${token}` } : {});
  const here = window.location.pathname;
  // Already on the "you're leaving Fanpages" confirm screen — send straight
  // through instead of looping back to another confirm screen.
  const homeHref = here === '/fanpages/leaving' ? '/' : `/fanpages/leaving?from=${encodeURIComponent(here)}`;

  root.innerHTML = `
    <div class="fpnav-bar">
      <a class="fpnav-brand" href="/fanpages">Fanpages</a>
      <a class="fpnav-link${here === '/fanpages/social' ? ' active' : ''}" href="/fanpages/social">Social</a>

      <a class="fpnav-home-btn" href="${homeHref}">BTW Homepage</a>

      <div class="fpnav-dropdown-wrap" id="fpnav-admin-wrap" style="display:none;">
        <button class="fpnav-trigger-btn fpnav-admin-btn" id="fpnav-admin-btn" type="button">Admin <span class="fpnav-caret">▾</span></button>
        <div class="fpnav-dropdown" id="fpnav-admin-dropdown" hidden>
          <a href="/fanpages/hub-builder">Hub Image Builder</a>
          <a href="/stats">Stats</a>
        </div>
      </div>

      <div class="fpnav-search"><input type="search" id="fpnav-search-input" placeholder="🔍 Search stories…" /></div>
      <div class="fpnav-right">

        <div class="fpnav-dropdown-wrap">
          <button class="fpnav-trigger-btn" id="fpnav-upload-btn" type="button">Create <span class="fpnav-caret">▾</span></button>
          <div class="fpnav-dropdown" id="fpnav-upload-dropdown" hidden>
            <a href="/fanpages/editor" data-gate="/fanpages/editor">Creator Hub</a>
            <div class="fpnav-dropdown-divider"></div>
            <a href="/fanpages/create" data-gate="/fanpages/create"><span class="fpnav-plus-badge">+</span> Story</a>
            <a href="/fanpages/create-character" data-gate="/fanpages/create-character"><span class="fpnav-plus-badge">+</span> Character</a>
            <a href="/fanpages/create-gallery" data-gate="/fanpages/create-gallery"><span class="fpnav-plus-badge">+</span> Gallery</a>
          </div>
        </div>

        <a class="fpnav-login-btn" id="fpnav-login-btn" href="/fanpages/login?from=${encodeURIComponent(here)}">Log In / Register</a>

        <button class="fpnav-icon-btn fpnav-icon-btn--labeled" id="fpnav-notif-btn" type="button" aria-label="Notifications" style="display:none;">
          <span class="fpnav-icon-btn-label">Updates</span>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
          <span class="fpnav-notif-badge" id="fpnav-notif-badge" hidden></span>
        </button>

        <div class="fpnav-dropdown-wrap" id="fpnav-avatar-wrap" style="display:none;">
          <button class="fpnav-avatar-btn" id="fpnav-avatar-btn" type="button">
            <span id="fpnav-avatar-img-wrap"></span>
            <span id="fpnav-avatar-name"></span>
          </button>
          <div class="fpnav-dropdown" id="fpnav-avatar-dropdown" hidden>
            <a href="#" id="fpnav-my-profile-link">My Profile</a>
            <div class="fpnav-dropdown-divider"></div>
            <a href="/fanpages/library" id="fpnav-library-link">Bookmarks</a>
            <a href="/fanpages/notifications#inbox" id="fpnav-updates-link">Inbox</a>
            <div class="fpnav-dropdown-divider"></div>
            <a href="#" id="fpnav-edit-profile-link">Account Settings</a>
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
        <a class="fpnav-modal-cta" id="fpnav-modal-cta" href="/fanpages/login">Log In / Register</a>
      </div>
    </div>
  `;

  // ── Search ───────────────────────────────────────────────────────────────
  const searchInput = document.getElementById('fpnav-search-input');
  const currentQ = new URLSearchParams(window.location.search).get('q');
  if (here === '/fanpages/search' && currentQ) searchInput.value = currentQ;
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = searchInput.value.trim();
    window.location.href = q ? `/fanpages/search?q=${encodeURIComponent(q)}` : '/fanpages/search';
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
  wireDropdown('fpnav-admin-btn', 'fpnav-admin-dropdown');
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
    window.location.href = '/fanpages';
  });

  // ── Login-gated links (Create Story / My Stories) ───────────────────────
  const modalOverlay = document.getElementById('fpnav-modal-overlay');
  const modalCta      = document.getElementById('fpnav-modal-cta');

  function openGateModal(dest) {
    modalCta.href = `/fanpages/login?from=${encodeURIComponent(dest)}`;
    modalOverlay.hidden = false;
  }
  document.getElementById('fpnav-modal-close').addEventListener('click', () => { modalOverlay.hidden = true; });
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) modalOverlay.hidden = true; });

  // ── Notification bell ────────────────────────────────────────────────────
  document.getElementById('fpnav-notif-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    window.location.href = '/fanpages/notifications';
  });

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
      document.getElementById('fpnav-notif-btn').style.display = '';

      // Bell lights up for anything unread across all three: notifications,
      // unread chat messages, AND pending chat requests waiting on you.
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

      document.getElementById('fpnav-my-profile-link').href = `/fanpages/${u.username}`;
      document.getElementById('fpnav-edit-profile-link').href = `/fanpages/account-settings?from=${encodeURIComponent(here)}`;

      // Reveal the standalone Admin pill (Hub Image Builder / Stats) —
      // its own dropdown next to the profile menu rather than buried
      // inside Account Settings.
      if (u.is_admin) {
        const adminWrap = document.getElementById('fpnav-admin-wrap');
        if (adminWrap) adminWrap.style.display = '';
      }
    })
    .catch(() => {});
})();
