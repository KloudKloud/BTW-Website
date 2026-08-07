// Shared crop modal — one instance reused across every fanpages page that
// crops an image (profile banner/avatar, story cover, character ref image,
// gallery tile preview, Hub Image Builder). Discord-style: a fixed crop
// viewport (rect or circle), the image pans/zooms underneath it — see
// btw-cropper.js for the actual pan/zoom engine this wraps. Pages just need
// <script src="/fanpages/btw-cropper.js"> + this file, then call
// window.openCropModal({...}).
(function () {
  const style = document.createElement('style');
  style.textContent = `
    .crop-modal-overlay {
      position: fixed; inset: 0; z-index: 500; background: rgba(0,0,0,0.75); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center; padding: 2rem 1rem;
    }
    .crop-modal-box {
      background: #171717; border: 1px solid rgba(255,255,255,0.12); border-radius: 16px;
      padding: 1.5rem; width: 100%; max-width: 640px; box-shadow: 0 24px 70px rgba(0,0,0,0.6);
    }
    .crop-modal-title { font-family: 'Cinzel', Georgia, serif; font-size: 1.15rem; font-weight: 700; color: #f0f0f0; margin: 0 0 1rem; }
    .crop-modal-img-wrap {
      position: relative; width: 100%; max-height: 60vh; background: #0a0a0a; border-radius: 10px;
      overflow: hidden; touch-action: none;
    }
    .crop-modal-img-wrap.crop-modal-img-wrap--round { border-radius: 10px; }
    .crop-modal-img-wrap.crop-modal-img-wrap--round::after {
      content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: 50%;
      box-shadow: 0 0 0 2000px rgba(10,10,10,0.82);
    }
    .crop-modal-img-wrap img {
      position: absolute; top: 0; left: 0; transform-origin: 0 0; max-width: none; user-select: none;
      -webkit-user-drag: none;
    }
    .crop-modal-zoom-row { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.9rem; }
    .crop-modal-zoom-row svg { flex-shrink: 0; color: #999; }
    .crop-modal-zoom-row svg:last-child { width: 18px; height: 18px; }
    .crop-modal-zoom-row svg:first-child { width: 13px; height: 13px; }
    .crop-modal-zoom {
      flex: 1; -webkit-appearance: none; appearance: none; height: 4px; border-radius: 2px;
      background: rgba(255,255,255,0.15); outline: none; cursor: pointer;
    }
    .crop-modal-zoom::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border-radius: 50%;
      background: #7fa8d9; cursor: pointer; border: 2px solid #171717;
    }
    .crop-modal-zoom::-moz-range-thumb {
      width: 16px; height: 16px; border-radius: 50%; background: #7fa8d9; cursor: pointer; border: 2px solid #171717;
    }
    .crop-modal-hint { color: #999; font-size: 0.8rem; margin: 0.85rem 0 0; }
    .crop-modal-actions { display: flex; justify-content: flex-end; gap: 0.6rem; margin-top: 1.25rem; }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.className = 'crop-modal-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="crop-modal-box">
      <p class="crop-modal-title" id="crop-modal-title">Crop Image</p>
      <div class="crop-modal-img-wrap" id="crop-modal-img-wrap"><img id="crop-modal-img" alt="" draggable="false" /></div>
      <div class="crop-modal-zoom-row">
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>
        <input type="range" class="crop-modal-zoom" id="crop-modal-zoom" />
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>
      </div>
      <p class="crop-modal-hint" id="crop-modal-hint">Drag to move, scroll or pinch to zoom.</p>
      <div class="crop-modal-actions">
        <button type="button" class="mod-btn" id="crop-modal-cancel">Cancel</button>
        <button type="button" class="mod-btn" id="crop-modal-save">Save Crop</button>
      </div>
    </div>
  `;
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(overlay));
  if (document.body) document.body.appendChild(overlay);

  let btwCropper = null;
  let onSaveCb = null;

  function close() {
    overlay.hidden = true;
    if (btwCropper) { btwCropper.destroy(); btwCropper = null; }
    onSaveCb = null;
  }
  overlay.querySelector('#crop-modal-cancel').addEventListener('click', close);
  overlay.querySelector('#crop-modal-save').addEventListener('click', async () => {
    if (!btwCropper || !onSaveCb) { console.error('Crop modal Save clicked before the cropper finished initializing.'); return; }
    const btn = overlay.querySelector('#crop-modal-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      // Export at a real resolution, not just the on-screen viewport's CSS
      // pixel size — the viewport is capped to fit the modal, which on a
      // small window would otherwise bake a blurry low-res crop into the
      // upload. 1000px on the long edge is plenty for every use on this
      // site (avatars, covers, banners, cards).
      const wrap = overlay.querySelector('#crop-modal-img-wrap');
      const ratio = wrap.clientWidth / wrap.clientHeight;
      const outW = ratio >= 1 ? 1000 : Math.round(1000 * ratio);
      const outH = ratio >= 1 ? Math.round(1000 / ratio) : 1000;
      const canvas = btwCropper.getCanvas(outW, outH);
      await new Promise((resolve, reject) => {
        canvas.toBlob(async (blob) => {
          if (!blob) { reject(new Error('Could not export the cropped image.')); return; }
          try { await onSaveCb(blob); resolve(); } catch (err) { reject(err); }
        }, 'image/jpeg', 0.92);
      });
      close();
    } catch (err) {
      console.error('Crop save failed:', err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Crop';
    }
  });

  // opts: { title, imageSrc, aspectRatio, round, hint, onSave(blob) }
  window.openCropModal = function (opts) {
    overlay.querySelector('#crop-modal-title').textContent = opts.title || 'Crop Image';
    overlay.querySelector('#crop-modal-hint').textContent = opts.hint || 'Drag to move, scroll or pinch to zoom.';
    const wrap = overlay.querySelector('#crop-modal-img-wrap');
    wrap.classList.toggle('crop-modal-img-wrap--round', !!opts.round);
    const img = overlay.querySelector('#crop-modal-img');
    onSaveCb = opts.onSave;
    overlay.hidden = false;
    if (btwCropper) { btwCropper.destroy(); btwCropper = null; }

    // Size the fixed viewport to the requested aspect ratio, capped to the
    // modal's available width/height (60vh) — recomputed on open since the
    // window may have been resized since last time.
    const ratio = opts.aspectRatio || 1;
    const maxW = wrap.parentElement.clientWidth;
    const maxH = window.innerHeight * 0.6;
    let w = maxW, h = w / ratio;
    if (h > maxH) { h = maxH; w = h * ratio; }
    wrap.style.width = `${Math.round(w)}px`;
    wrap.style.height = `${Math.round(h)}px`;

    // Force a fresh load every time, even if imageSrc happens to match the
    // element's current src (recropping the same image twice in a row) —
    // otherwise "onload" may never fire (browsers can skip it for an
    // unchanged src) and the cropper never (re)initializes.
    img.removeAttribute('src');
    img.onload = () => {
      btwCropper = new BtwCropper(img, wrap);
      btwCropper.setZoomInput(overlay.querySelector('#crop-modal-zoom'));
    };
    img.src = opts.imageSrc;
  };
  window.closeCropModal = close;
})();
