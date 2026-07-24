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
      <a class="fpnav-link" href="/fanpages/social">Social</a>
      <div class="fpnav-search"><input type="search" placeholder="🔍 Search stories…" /></div>
      <div class="fpnav-right">

        <div class="fpnav-dropdown-wrap">
          <button class="fpnav-trigger-btn" id="fpnav-upload-btn" type="button">Upload <span class="fpnav-caret">▾</span></button>
          <div class="fpnav-dropdown" id="fpnav-upload-dropdown" hidden>
            <a href="/fanpages/create" data-gate="/fanpages/create">Create Story</a>
            <a href="/fanpages/my-stories" data-gate="/fanpages/my-stories">My Stories</a>
          </div>
        </div>

        <a class="fpnav-home-btn" href="${homeHref}">BTW Homepage</a>

        <a class="fpnav-login-btn" id="fpnav-login-btn" href="/login?from=${encodeURIComponent(here)}">Log In / Register</a>

        <div class="fpnav-dropdown-wrap" id="fpnav-avatar-wrap" style="display:none;">
          <button class="fpnav-avatar-btn" id="fpnav-avatar-btn" type="button">
            <span id="fpnav-avatar-img-wrap"></span>
            <span id="fpnav-avatar-name"></span>
          </button>
          <div class="fpnav-dropdown" id="fpnav-avatar-dropdown" hidden>
            <a href="#" id="fpnav-my-profile-link">My Profile</a>
            <a href="#" id="fpnav-edit-profile-link">Account Settings</a>
          </div>
        </div>

      </div>
    </div>

    <div class="fpnav-modal-overlay" id="fpnav-modal-overlay" hidden>
      <div class="fpnav-modal-card">
        <button class="fpnav-modal-close" id="fpnav-modal-close" type="button">✕</button>
        <p class="fpnav-modal-title">Log in to continue</p>
        <p class="fpnav-modal-text">You'll need a free Between Two Worlds account to create or manage stories on Fanpages.</p>
        <a class="fpnav-modal-cta" id="fpnav-modal-cta" href="/login">Log In / Register</a>
      </div>
    </div>
  `;

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
  document.addEventListener('click', () => {
    document.querySelectorAll('.fpnav-dropdown').forEach(el => { el.hidden = true; });
  });

  // ── Login-gated links (Create Story / My Stories) ───────────────────────
  const modalOverlay = document.getElementById('fpnav-modal-overlay');
  const modalCta      = document.getElementById('fpnav-modal-cta');

  function openGateModal(dest) {
    modalCta.href = `/login?from=${encodeURIComponent(dest)}`;
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

      document.getElementById('fpnav-avatar-img-wrap').innerHTML = u.avatar
        ? `<img src="${u.avatar}" alt="" />`
        : `<span class="fpnav-avatar-fallback">${initial}</span>`;
      document.getElementById('fpnav-avatar-name').textContent = name;

      document.getElementById('fpnav-my-profile-link').href = `/fanpages/${u.username}`;
      document.getElementById('fpnav-edit-profile-link').href = `/profile?from=${encodeURIComponent(here)}`;

      // Same admin-only Stats link the root site's nav shows — kept visible
      // here too so the lead dev never loses it while inside Fanpages.
      if (u.is_admin) {
        const dropdown = document.getElementById('fpnav-avatar-dropdown');
        if (dropdown && !document.getElementById('fpnav-stats-link')) {
          const statsLink = document.createElement('a');
          statsLink.id = 'fpnav-stats-link';
          statsLink.href = '/stats';
          statsLink.textContent = 'Stats';
          dropdown.appendChild(statsLink);
        }
      }
    })
    .catch(() => {});
})();
