// Shared Cropper.js crop modal — one instance reused across every fanpages
// page that crops an image (profile banner/avatar, story cover, character
// ref image, gallery tile preview, Hub Image Builder). Builds its own DOM +
// styles on load so pages just need <script src="/fanpages/vendor/cropper.min.js">
// + this file, then call window.openCropModal({...}).
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
    .crop-modal-img-wrap { width: 100%; max-height: 60vh; background: #0a0a0a; border-radius: 10px; overflow: hidden; }
    .crop-modal-img-wrap img { display: block; max-width: 100%; }
    .crop-modal-img-wrap.crop-modal-img-wrap--round .cropper-view-box,
    .crop-modal-img-wrap.crop-modal-img-wrap--round .cropper-face { border-radius: 50%; }
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
      <div class="crop-modal-img-wrap" id="crop-modal-img-wrap"><img id="crop-modal-img" alt="" /></div>
      <p class="crop-modal-hint" id="crop-modal-hint">Drag to move, scroll or pinch to zoom, drag the corners to resize the crop box.</p>
      <div class="crop-modal-actions">
        <button type="button" class="mod-btn" id="crop-modal-cancel">Cancel</button>
        <button type="button" class="mod-btn" id="crop-modal-save">Save Crop</button>
      </div>
    </div>
  `;
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(overlay));
  if (document.body) document.body.appendChild(overlay);

  let cropper = null;
  let onSaveCb = null;

  function close() {
    overlay.hidden = true;
    if (cropper) { cropper.destroy(); cropper = null; }
    onSaveCb = null;
  }
  overlay.querySelector('#crop-modal-cancel').addEventListener('click', close);
  overlay.querySelector('#crop-modal-save').addEventListener('click', async () => {
    if (!cropper || !onSaveCb) { console.error('Crop modal Save clicked before Cropper finished initializing.'); return; }
    const btn = overlay.querySelector('#crop-modal-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const canvas = cropper.getCroppedCanvas();
      await new Promise((resolve, reject) => {
        canvas.toBlob(async (blob) => {
          if (!blob) { reject(new Error('Could not export the cropped image.')); return; }
          try { await onSaveCb(blob, cropper); resolve(); } catch (err) { reject(err); }
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

  // opts: { title, imageSrc, aspectRatio, round, hint, cropBoxResizable,
  //         onSave(blob, cropperInstance) }
  window.openCropModal = function (opts) {
    overlay.querySelector('#crop-modal-title').textContent = opts.title || 'Crop Image';
    overlay.querySelector('#crop-modal-hint').textContent = opts.hint ||
      'Drag to move, scroll or pinch to zoom, drag the corners to resize the crop box.';
    overlay.querySelector('#crop-modal-img-wrap').classList.toggle('crop-modal-img-wrap--round', !!opts.round);
    const img = overlay.querySelector('#crop-modal-img');
    onSaveCb = opts.onSave;
    overlay.hidden = false;
    if (cropper) { cropper.destroy(); cropper = null; }
    // Force a fresh load every time, even if imageSrc happens to match the
    // element's current src (recropping the same image twice in a row) —
    // otherwise "onload" may never fire (browsers can skip it for an
    // unchanged src), Cropper never initializes, and Save silently does
    // nothing because `cropper` stays null.
    img.removeAttribute('src');
    img.onload = () => {
      cropper = new Cropper(img, {
        aspectRatio: opts.aspectRatio, viewMode: 1, dragMode: 'move', autoCropArea: 1,
        background: false, responsive: true,
        cropBoxResizable: opts.cropBoxResizable !== false,
        cropBoxMovable: true,
        ready() { if (opts.onReady) opts.onReady(cropper); },
      });
    };
    img.src = opts.imageSrc;
  };
  window.closeCropModal = close;
  window.getCropModalCropper = () => cropper;
})();
