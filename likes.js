window.LikeButtons = (function () {
  const API = '/api';

  function getToken() {
    return localStorage.getItem('btw_token') || sessionStorage.getItem('btw_token');
  }

  function updateBtn(btn, liked, count) {
    btn.classList.toggle('liked', liked);
    btn.querySelector('.like-icon').textContent = liked ? '♥' : '♡';
    btn.querySelector('.like-count').textContent = count;
  }

  async function getCounts(type) {
    try {
      const r = await fetch(`${API}/likes/counts/${type}`);
      return (await r.json()).counts || {};
    } catch { return {}; }
  }

  async function getMine(type) {
    const token = getToken();
    if (!token) return [];
    try {
      const r = await fetch(`${API}/likes/mine/${type}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return (await r.json()).liked || [];
    } catch { return []; }
  }

  async function toggle(type, id) {
    const token = getToken();
    if (!token) return null;
    try {
      const r = await fetch(`${API}/likes/toggle/${type}/${id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      return await r.json();
    } catch { return null; }
  }

  async function init(type, container) {
    container = container || document;
    const [counts, mine] = await Promise.all([getCounts(type), getMine(type)]);

    container.querySelectorAll(`.like-btn[data-type="${type}"]`).forEach(btn => {
      const id = parseInt(btn.dataset.id, 10);
      updateBtn(btn, mine.includes(id), counts[id] || 0);

      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const wasLiked = btn.classList.contains('liked');
        const cur = parseInt(btn.querySelector('.like-count').textContent, 10) || 0;
        updateBtn(btn, !wasLiked, wasLiked ? Math.max(0, cur - 1) : cur + 1);
        const result = await toggle(type, id);
        if (result !== null) updateBtn(btn, result.liked, result.count);
      });
    });
  }

  return { init };
})();
