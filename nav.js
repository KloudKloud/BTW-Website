(function () {
  // ── Hamburger menu (always injected) ─────────────────────────────────────
  const nav     = document.querySelector('nav');
  const navList = document.querySelector('.nav-links');

  if (nav && navList) {
    const ham = document.createElement('button');
    ham.className = 'nav-hamburger';
    ham.setAttribute('aria-label', 'Toggle navigation');
    ham.innerHTML = '&#9776;';
    nav.appendChild(ham);

    const closeMenu = () => {
      navList.classList.remove('nav-open');
      ham.innerHTML = '&#9776;';
    };

    ham.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = !navList.classList.contains('nav-open');
      navList.classList.toggle('nav-open');
      ham.innerHTML = opening ? '&#10005;' : '&#9776;';
    });

    document.addEventListener('click', closeMenu);
    navList.addEventListener('click', (e) => { if (e.target.tagName === 'A') closeMenu(); });
  }

  // ── Auth state — swap login link for display name + dropdown ─────────────
  const token = localStorage.getItem('btw_token') || sessionStorage.getItem('btw_token');
  const raw   = localStorage.getItem('btw_user')  || sessionStorage.getItem('btw_user');
  if (!token || !raw) return;

  let user;
  try { user = JSON.parse(raw); } catch { return; }

  const loginLink = document.querySelector('a.nav-login');
  if (!loginLink) return;

  const brandLink = document.querySelector('.nav-brand');
  const homeHref  = brandLink ? brandLink.getAttribute('href') : '/';

  function clearAuth() {
    localStorage.removeItem('btw_token');
    localStorage.removeItem('btw_user');
    sessionStorage.removeItem('btw_token');
    sessionStorage.removeItem('btw_user');
  }

  function renderUserNav(u) {
    const name = (u.display_name || u.username || 'Account').slice(0, 20);
    const li = loginLink.parentElement;
    li.innerHTML = `
      <div class="nav-user">
        <button class="nav-user-btn" id="nav-user-btn" aria-haspopup="true" aria-expanded="false">
          ${u.avatar ? `<img src="${u.avatar}" class="nav-user-avatar" alt="" />` : ''}${name} <span class="nav-user-caret">&#9662;</span>
        </button>
        <div class="nav-user-dropdown" id="nav-user-dropdown" hidden>
          <a href="/profile" id="nav-profile">Edit Profile</a>
          <a href="#" id="nav-logout">Logout</a>
        </div>
      </div>
    `;

    const btn      = document.getElementById('nav-user-btn');
    const dropdown = document.getElementById('nav-user-dropdown');

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !dropdown.hidden;
      dropdown.hidden = open;
      btn.setAttribute('aria-expanded', String(!open));
    });

    document.addEventListener('click', () => {
      dropdown.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    });

    document.getElementById('nav-logout').addEventListener('click', (e) => {
      e.preventDefault();
      clearAuth();
      window.location.href = homeHref;
    });
  }

  // Verify token is still valid before rendering the user nav
  fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
    .then(r => {
      if (!r.ok) throw new Error('invalid');
      return r.json();
    })
    .then(data => {
      // Update stored user with fresh data from server
      const storage = localStorage.getItem('btw_token') ? localStorage : sessionStorage;
      storage.setItem('btw_user', JSON.stringify(data.user));
      renderUserNav(data.user);
    })
    .catch(() => {
      // Token is invalid or expired — clear everything and show login link
      clearAuth();
    });
})();
