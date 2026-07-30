'use strict';
/*
 * qr.js — génération du QR d'identité (cachés) et scan caméra (chasseurs).
 * Génération : lib qrcode (window.qrcode). Scan : getUserMedia + jsQR.
 * Expose window.QR.
 */
window.QR = (function () {
  // Un token serveur fait 24 caractères alphanumériques (game.js randomToken).
  // On le vérifie côté client pour ignorer en silence les QR de la rue —
  // affiches, menus, autocollants — au lieu de les compter comme des scans ratés.
  const TOKEN_RE = /^[A-Za-z0-9]{24}$/;

  // -------------------- Génération --------------------
  // Utilise qrcode-generator (global `qrcode`) et dessine les modules à la main.
  // Retourne false si la lib manque, pour que l'appelant AFFICHE l'échec :
  // un canvas blanc silencieux voulait dire "personne ne peut me capturer".
  function render(canvas, token) {
    if (!canvas) return false;
    if (typeof window.qrcode !== 'function') return false;
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
    return true;
  }

  // -------------------- Chargement différé de jsQR --------------------
  // 257 ko dont seuls les chasseurs ont besoin, et jamais avant d'appuyer sur
  // ÉLIMINER. On ne les fait plus payer à tout le monde au démarrage.
  let libPromise = null;
  function ensureLib() {
    if (window.jsQR) return Promise.resolve(true);
    if (libPromise) return libPromise;
    libPromise = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = '/vendor/jsQR.js';
      s.onload = () => resolve(!!window.jsQR);
      s.onerror = () => { libPromise = null; resolve(false); };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  // -------------------- Scan --------------------
  // `sessionActive` = la caméra tourne. `looping` = la boucle d'analyse tourne.
  // Les deux étaient confondus dans une seule variable : après une détection
  // rejetée par le serveur, tick() sortait sans reprogrammer et sans baisser le
  // drapeau, donc resumeScan() trouvait `scanning === true` et ne relançait
  // rien. La caméra restait allumée, le réticule continuait de s'animer, et
  // plus aucun QR n'était jamais détecté jusqu'à fermeture de la modale.
  let stream = null, rafId = null;
  let sessionActive = false, looping = false;
  let tickFn = null;
  let detectCb = null;

  // `validate` reçoit la donnée brute du QR et retourne la valeur à remonter,
  // ou null pour continuer à scanner. Par défaut : un token d'identité. C'est ce
  // qui permet d'utiliser la même caméra pour deux usages très différents —
  // capturer une cible, ou rejoindre une partie — sans que l'un accepte l'autre.
  async function startScan(video, onDetect, onError, validate) {
    if (sessionActive) { resumeScan(); return; }
    sessionActive = true;
    detectCb = onDetect;
    const check = validate || ((d) => (TOKEN_RE.test(d) ? d : null));

    const hasLib = await ensureLib();
    if (!hasLib) {
      sessionActive = false;
      onError && onError('Module de scan indisponible (réseau). Reconnecte-toi puis réessaie.');
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, audio: false,
      });
    } catch (e) {
      sessionActive = false;
      onError && onError('Caméra inaccessible. Autorise l’accès caméra (HTTPS requis).');
      return;
    }
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    await video.play().catch(() => {});

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    tickFn = () => {
      if (!looping) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code && code.data) {
          const value = check(code.data);
          if (value != null) {
            // On coupe la boucle AVANT de remonter la détection : c'est ce qui
            // permet à resumeScan() de la relancer si le serveur refuse.
            looping = false;
            rafId = null;
            detectCb && detectCb(value);
            return;
          }
          // QR étranger : on continue de scanner sans rien signaler.
        }
      }
      rafId = requestAnimationFrame(tickFn);
    };

    looping = true;
    rafId = requestAnimationFrame(tickFn);
  }

  function stopScan() {
    sessionActive = false;
    looping = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    tickFn = null;
    detectCb = null;
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  // Relance la boucle après une détection rejetée. La caméra est déjà ouverte :
  // on ne repasse pas par getUserMedia (qui reprompterait et perdrait 1 s).
  function resumeScan() {
    if (!sessionActive || looping || !tickFn) return;
    looping = true;
    rafId = requestAnimationFrame(tickFn);
  }

  return { render, startScan, stopScan, resumeScan, ensureLib };
})();
