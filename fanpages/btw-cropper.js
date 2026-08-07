// BtwCropper — Discord-style pan/zoom image cropper. Replaces Cropper.js
// site-wide (see crop-modal.js for the shared modal, and the handful of
// pages that mount this directly for an inline "gallery preview crop"
// picker instead of a modal).
//
// Unlike Cropper.js's default UI (a resizable/movable crop box drawn over a
// static image), the crop VIEWPORT here is fixed — sized and shaped
// (rect or circle) by the caller, never resized by the user. The user drags
// and zooms the IMAGE underneath it instead. That's the whole trick behind
// why Discord's cropper feels smoother than a corner-handle crop box: one
// gesture (drag) does the only thing that needs doing (reposition), and a
// slider handles the other (zoom) — no handles to grab, no accidental
// aspect-ratio distortion.
//
// Usage:
//   const c = new BtwCropper(imgEl, viewportEl, {
//     onChange(pos) {},   // fires with {x,y} fractional pan position (0-1) on every change
//   });
//   c.setZoomInput(rangeInputEl);      // optional: two-way bind a <input type=range>
//   c.setPositionFraction({x, y});     // optional: restore a saved pan position
//   const canvas = c.getCanvas(outW, outH);
//   c.destroy();
//
// viewportEl must be a positioned (position:relative or absolute), fixed-
// size, overflow:hidden element. imgEl must be its child, position:absolute,
// top:0, left:0, transform-origin: 0 0 — see .btw-cropper-viewport /
// .btw-cropper-img in crop-modal.js's injected stylesheet, or replicate
// those two rules wherever a page mounts BtwCropper directly.
(function () {
  function BtwCropper(imgEl, viewportEl, opts) {
    opts = opts || {};
    const self = this;
    let natW = 0, natH = 0, vpW = 0, vpH = 0;
    let scale = 1, minScale = 1, maxScale = 1;
    let tx = 0, ty = 0;
    let zoomInput = null;
    let ready = false;
    let destroyed = false;

    function clamp() {
      const w = natW * scale, h = natH * scale;
      const minX = Math.min(0, vpW - w), maxX = 0;
      const minY = Math.min(0, vpH - h), maxY = 0;
      tx = Math.max(minX, Math.min(maxX, tx));
      ty = Math.max(minY, Math.min(maxY, ty));
    }

    function apply(fireChange) {
      if (destroyed) return;
      clamp();
      imgEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      if (zoomInput) zoomInput.value = String(scale);
      if (fireChange !== false && opts.onChange) opts.onChange(self.getPositionFraction());
    }

    function measure() {
      vpW = viewportEl.clientWidth;
      vpH = viewportEl.clientHeight;
      natW = imgEl.naturalWidth || imgEl.width;
      natH = imgEl.naturalHeight || imgEl.height;
    }

    // Centers the image at "cover" zoom (fills the viewport, no gaps) —
    // the same starting point Discord's own cropper opens with.
    function fit() {
      measure();
      if (!vpW || !vpH || !natW || !natH) return;
      minScale = Math.max(vpW / natW, vpH / natH);
      maxScale = opts.zoomable === false ? minScale : minScale * 4;
      scale = minScale;
      tx = (vpW - natW * scale) / 2;
      ty = (vpH - natH * scale) / 2;
      if (zoomInput) {
        zoomInput.min = String(minScale);
        zoomInput.max = String(maxScale);
        zoomInput.step = String((maxScale - minScale) / 200 || 0.001);
        zoomInput.value = String(scale);
      }
      ready = true;
      apply(false);
    }

    // Zooms around a fixed point in viewport coordinates (pointer position,
    // or the viewport center for slider/wheel-without-position input) so
    // the spot under the cursor/pinch-midpoint stays put instead of the
    // whole image jumping.
    function zoomTo(newScale, anchorX, anchorY) {
      newScale = Math.max(minScale, Math.min(maxScale, newScale));
      if (anchorX === undefined) anchorX = vpW / 2;
      if (anchorY === undefined) anchorY = vpH / 2;
      const imgX = (anchorX - tx) / scale;
      const imgY = (anchorY - ty) / scale;
      scale = newScale;
      tx = anchorX - imgX * scale;
      ty = anchorY - imgY * scale;
      apply();
    }

    // ── Drag to pan (mouse + single-finger touch, unified via Pointer Events) ──
    let dragging = false, dragStartX = 0, dragStartY = 0, dragTx0 = 0, dragTy0 = 0;
    const activePointers = new Map();
    let pinchStartDist = 0, pinchStartScale = 1;

    function pointerDistance() {
      const pts = [...activePointers.values()];
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
    function pointerMidpoint() {
      const pts = [...activePointers.values()];
      const rect = viewportEl.getBoundingClientRect();
      return {
        x: (pts[0].x + pts[1].x) / 2 - rect.left,
        y: (pts[0].y + pts[1].y) / 2 - rect.top,
      };
    }

    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      viewportEl.setPointerCapture(e.pointerId);
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activePointers.size === 1) {
        dragging = true;
        dragStartX = e.clientX; dragStartY = e.clientY;
        dragTx0 = tx; dragTy0 = ty;
      } else if (activePointers.size === 2) {
        dragging = false;
        pinchStartDist = pointerDistance();
        pinchStartScale = scale;
      }
    }
    function onPointerMove(e) {
      if (!activePointers.has(e.pointerId)) return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activePointers.size === 2) {
        const dist = pointerDistance();
        if (pinchStartDist > 0) {
          const mid = pointerMidpoint();
          zoomTo(pinchStartScale * (dist / pinchStartDist), mid.x, mid.y);
        }
        return;
      }
      if (dragging) {
        tx = dragTx0 + (e.clientX - dragStartX);
        ty = dragTy0 + (e.clientY - dragStartY);
        apply();
      }
    }
    function onPointerUp(e) {
      activePointers.delete(e.pointerId);
      if (activePointers.size < 2) { pinchStartDist = 0; }
      if (activePointers.size === 0) dragging = false;
      else if (activePointers.size === 1) {
        // Dropped from pinch back to a single finger -- restart drag
        // tracking from here instead of jumping using stale coordinates.
        const [[, p]] = activePointers;
        dragging = true;
        dragStartX = p.x; dragStartY = p.y;
        dragTx0 = tx; dragTy0 = ty;
      }
    }

    function onWheel(e) {
      e.preventDefault();
      const rect = viewportEl.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomTo(scale * factor, e.clientX - rect.left, e.clientY - rect.top);
    }

    viewportEl.style.touchAction = 'none';
    viewportEl.style.cursor = 'grab';
    viewportEl.addEventListener('pointerdown', onPointerDown);
    viewportEl.addEventListener('pointermove', onPointerMove);
    viewportEl.addEventListener('pointerup', onPointerUp);
    viewportEl.addEventListener('pointercancel', onPointerUp);
    viewportEl.addEventListener('wheel', onWheel, { passive: false });

    function onZoomInput() {
      zoomTo(parseFloat(zoomInput.value), vpW / 2, vpH / 2);
    }

    // ── Public API ──────────────────────────────────────────────────────
    this.setZoomInput = function (input) {
      zoomInput = input;
      if (ready) {
        zoomInput.min = String(minScale);
        zoomInput.max = String(maxScale);
        zoomInput.step = String((maxScale - minScale) / 200 || 0.001);
        zoomInput.value = String(scale);
      }
      zoomInput.addEventListener('input', onZoomInput);
    };
    this.getPositionFraction = function () {
      const w = natW * scale, h = natH * scale;
      const maxX = w - vpW, maxY = h - vpH;
      return {
        x: maxX > 0.5 ? (-tx) / maxX : 0.5,
        y: maxY > 0.5 ? (-ty) / maxY : 0.5,
      };
    };
    this.setPositionFraction = function (p) {
      if (!ready || !p) return;
      const w = natW * scale, h = natH * scale;
      const maxX = w - vpW, maxY = h - vpH;
      tx = maxX > 0.5 ? -(p.x * maxX) : (vpW - w) / 2;
      ty = maxY > 0.5 ? -(p.y * maxY) : (vpH - h) / 2;
      apply(false);
    };
    this.getZoom = function () { return scale; };
    this.getMinZoom = function () { return minScale; };
    this.setZoom = function (z) { zoomTo(z, vpW / 2, vpH / 2); };
    this.refit = fit;
    this.disable = function () {
      viewportEl.style.pointerEvents = 'none';
      if (zoomInput) zoomInput.disabled = true;
    };
    this.enable = function () {
      viewportEl.style.pointerEvents = '';
      if (zoomInput) zoomInput.disabled = false;
    };
    this.isReady = function () { return ready; };
    this.getCanvas = function (outW, outH) {
      outW = outW || vpW; outH = outH || vpH;
      const canvas = document.createElement('canvas');
      canvas.width = outW; canvas.height = outH;
      const ctx = canvas.getContext('2d');
      const sx = -tx / scale, sy = -ty / scale, sw = vpW / scale, sh = vpH / scale;
      ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, outW, outH);
      return canvas;
    };
    this.destroy = function () {
      destroyed = true;
      viewportEl.removeEventListener('pointerdown', onPointerDown);
      viewportEl.removeEventListener('pointermove', onPointerMove);
      viewportEl.removeEventListener('pointerup', onPointerUp);
      viewportEl.removeEventListener('pointercancel', onPointerUp);
      viewportEl.removeEventListener('wheel', onWheel);
      if (zoomInput) zoomInput.removeEventListener('input', onZoomInput);
      activePointers.clear();
    };

    // Kick off once the image actually has real pixel dimensions.
    if (imgEl.complete && imgEl.naturalWidth) {
      fit();
    } else {
      imgEl.addEventListener('load', fit, { once: true });
    }
  }

  window.BtwCropper = BtwCropper;
})();
