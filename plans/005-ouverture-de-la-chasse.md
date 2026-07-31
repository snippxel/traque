# 005 — L'ouverture de la chasse mérite un événement visuel

Commit de référence : `33d8d89`
Sévérité : occasion manquée · Catégorie : moment rare à fort enjeu

## Problème

`public/js/app.js`, dans `updateStartBanner()`, à la fin de la dispersion :

```js
        Sensors.vibrate([120, 80, 120, 80, 350]);
        Sensors.sfx('kickoff');
        toast(state.role === 'hunter' ? 'CHASSE OUVERTE — à toi de jouer !' : ..., ...);
```

Il y a un son et une vibration, mais visuellement le bandeau de départ
**disparaît**, c'est tout. Or l'élimination, elle, reçoit une séquence de
titrage complète (`capWipe` + cinq `capSlam` échelonnés de 380 à 740 ms).

Des deux moments, c'est l'ouverture de la chasse qui change ce que **tous** les
joueurs font dans la seconde qui suit : les chasseurs partent, les cachés
arrêtent de courir. Le budget de délice est mal réparti.

## Correctif

Un bandeau plein cadre, court, non bloquant, dans la grammaire de la capture
mais deux fois plus bref — c'est un départ, pas une conclusion.

Dans `public/index.html`, juste après `<div id="zone-frame" ...>` :

```html
    <!-- Ouverture de la chasse : plan 005. Purement visuel, ne capte jamais le
         toucher — un joueur qui court doit pouvoir agir pendant. -->
    <div id="kickoff" class="kickoff hidden" aria-hidden="true">
      <div class="ko-title" id="ko-title">CHASSE OUVERTE</div>
      <div class="ko-sub" id="ko-sub">À TOI DE JOUER</div>
    </div>
```

Dans `public/css/style.css` :

```css
.kickoff { position: fixed; inset: 0; z-index: 84; display: grid; place-items: center;
  text-align: center; padding: 24px; pointer-events: none; overflow: hidden; }
.kickoff::before { content: ''; position: absolute; inset: 0; background: var(--mag);
  transform-origin: left center; animation: capWipe 300ms var(--hard) both; }
.kickoff.hider::before { background: var(--lime); }
.ko-title { position: relative; font-family: var(--disp); font-weight: 900;
  font-size: clamp(34px, 12vw, 58px); letter-spacing: -0.05em; line-height: .9;
  color: var(--bg); animation: capSlam 380ms var(--slam) 180ms both; }
.ko-sub { position: relative; font-size: 13px; font-weight: 900; letter-spacing: .14em;
  color: var(--bg); margin-top: 10px; animation: capSlam 380ms var(--slam) 270ms both; }
.kickoff.out { animation: koOut 260ms var(--out) both; }
@keyframes koOut { to { opacity: 0; transform: translateY(-8px); } }
```

Dans `public/js/app.js`, remplacer le `toast(...)` du bloc kickoff par un appel à :

```js
  // Le son et la vibration existaient déjà ; il manquait l'image.
  function showKickoff(role) {
    const el = $('kickoff');
    if (!el) return;
    el.classList.toggle('hider', role !== 'hunter');
    $('ko-title').textContent = role === 'hunter' ? 'CHASSE OUVERTE' : 'PLANQUE-TOI';
    $('ko-sub').textContent = role === 'hunter' ? 'TROUVE-LES' : 'ILS ARRIVENT';
    el.classList.remove('hidden', 'out');
    void el.offsetWidth;
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.classList.add('hidden'), 260);
    }, 1200);
  }
```

Appel : `showKickoff(state.role);` à la place du `toast(...)`.

## Limites de portée

- **`pointer-events: none` est obligatoire.** Le voile de capture peut se
  permettre de bloquer, celui-ci non : la chasse vient de s'ouvrir, un joueur
  peut avoir besoin d'appuyer sur quelque chose dans la seconde.
- Durée totale ~1,46 s, contre ~2 s pour la capture. Ne pas allonger : ce n'est
  pas la conclusion de la partie.
- Ne pas ajouter de son ni de vibration : les deux existent déjà et sont calés.
- Réutiliser `capWipe` et `capSlam`. Ne pas créer de nouvelles keyframes
  d'entrée : la cohérence de la direction artistique tient à ce partage.

## Vérification

- Le bandeau ne doit jamais intercepter un toucher :
  `document.elementFromPoint(x, y)` pendant l'affichage doit renvoyer la carte
  ou un bouton, jamais `#kickoff`.
- Contrôle au ressenti : la séquence doit se lire d'un coup d'œil et laisser
  l'écran de jeu net avant 1,5 s.
- Reduced-motion : le reset global fige les animations ; vérifier que le bandeau
  reste lisible et disparaît bien (le `setTimeout` ne dépend pas de l'animation).
