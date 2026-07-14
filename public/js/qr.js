'use strict';
/*
 * qr.js — génération du QR d'identité (cachés) et scan caméra (chasseurs).
 * Génération : lib qrcode (window.QRCode). Scan : getUserMedia + jsQR.
 * Expose window.QR.
 */
window.QR = (function () {
  // -------------------- Génération --------------------
  // Utilise qrcode-generator (global `qrcode`) et dessine les modules à la main.
  function render(canvas, token) {
    if (typeof window.qrcode !== 'function' || !canvas) return;
    const qr = window.qrcode(0, 'M'); // type auto, correction moyenne
    qr.addData(token);
    qr.make();
    const count = qr.getModuleCount();
    const ctx = canvas.getContext('2d');
    const size = canvas.width; // 240
    const margin = 2; // en modules
    const cell = Math.floor(size / (count + margin * 2));
    const offset = Math.floor((size - cell * count) / 2);

    ctx.fillStyle = '#e9fff6'; // clair
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#05070a'; // sombre
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect(offset + c * cell, offset + r * cell, cell, cell);
        }
      }
    }
  }

  // -------------------- Scan --------------------
  let stream = null, rafId = null, scanning = false;

  async function startScan(video, onDetect, onError) {
    if (scanning) return;
    scanning = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, audio: false,
      });
    } catch (e) {
      scanning = false;
      onError && onError('Caméra inaccessible. Autorise l’accès caméra (HTTPS requis).');
      return;
    }
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    await video.play().catch(() => {});

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = () => {
      if (!scanning) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR ? window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }) : null;
        if (code && code.data) {
          onDetect(code.data);
          return; // on laisse l'appelant décider d'arrêter
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopScan() {
    scanning = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  function resumeScan(video, onDetect, onError) {
    // relance la boucle après une détection rejetée
    if (!scanning) { startScan(video, onDetect, onError); }
  }

  return { render, startScan, stopScan, resumeScan };
})();
