// Shared data-loading helper for all moderator public pages (index/chapters/
// characters/gallery). Each page fetches with this, then renders into its
// own DOM shape — kept separate so the fetch/auth logic isn't duplicated
// four times.
window.ModeratorSite = {
  async load(slug) {
    const token = localStorage.getItem('btw_token') || sessionStorage.getItem('btw_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    try {
      const res = await fetch(`/api/moderator-sites/${slug}`, { headers });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  },

  // Does the logged-in user own THIS site specifically — not just "are they
  // a moderator somewhere". Keeps Edit Profile from showing up for anyone
  // browsing a page they don't own, including other moderators later on.
  async isOwner(slug) {
    const token = localStorage.getItem('btw_token') || sessionStorage.getItem('btw_token');
    if (!token) return false;
    try {
      const res = await fetch(`/api/moderator-sites/${slug}/is-owner`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return false;
      const data = await res.json();
      return !!data.isOwner;
    } catch { return false; }
  },

  // Puts the moderator's own chosen banner (and its vertical position) onto
  // any page's <div class="site-banner"><img> — same image that shows on
  // their home page, instead of every sub-page keeping the shared default.
  applyBanner(imgEl, site) {
    if (!imgEl || !site) return;
    imgEl.src = site.banner_url || '/images/gallery/pixernbath_13.png';
    imgEl.style.objectFit = 'cover';
    imgEl.style.objectPosition = `center ${site.banner_position != null ? site.banner_position : 50}%`;
  },
};
