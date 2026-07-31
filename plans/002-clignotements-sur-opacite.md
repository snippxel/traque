# 002 — Les clignotements plein écran doivent passer par l'opacité

Commit de référence : `33d8d89`
Sévérité : HIGH · Catégorie : performance

## Problème

Deux animations `infinite` couvrant tout l'écran animent des propriétés de
**peinture**, pas de composition. Règle : n'animer que `transform` et `opacity`.

`public/css/style.css` :

```css
.spot-alert { position: fixed; inset: 0; ... background: rgba(255,46,136,.26);
  animation: magflash .8s steps(2) infinite; }
@keyframes magflash { 0%,100% { background: rgba(255,46,136,.34); } 50% { background: rgba(60,8,32,.42); } }

.zone-frame { position: fixed; inset: 0; ... border: 7px solid var(--red);
  animation: zoneFrame .92s steps(2) infinite; }
@keyframes zoneFrame { 0%,100% { border-color: var(--red); } 50% { border-color: rgba(255,59,31,.22); } }
```

`background` et `border-color` déclenchent un repaint. Sur un élément
`position: fixed; inset: 0`, c'est un repaint plein écran 2 à 2,5 fois par
seconde — pendant que Leaflet redessine ses tuiles, que le GPS pousse des
positions et que le wake-lock empêche le téléphone de lever le pied. `.spot-alert`
tourne 6 s ; `.zone-frame` tourne pendant tout le délai de grâce.

## Correctif

Fond statique, calque animé en opacité.

Remplacer le bloc `.spot-alert` :

```css
.spot-alert { position: fixed; inset: 0; z-index: 82; display: grid; place-items: center; text-align: center; padding: 24px;
  background: rgba(255,46,136,.26); isolation: isolate; }
/* Le clignotement passe par l'opacité d'un calque : animer `background`
   repeignait tout l'écran 2,5 fois par seconde (voir plan 002). */
.spot-alert::before { content: ''; position: absolute; inset: 0; z-index: -1;
  background: rgba(60,8,32,.42); animation: veilPulse .8s steps(2) infinite; }
@keyframes veilPulse { 0%,100% { opacity: 0; } 50% { opacity: 1; } }
```

Remplacer l'animation de `.zone-frame` (l'élément n'a aucun contenu, on peut
animer son opacité entière) :

```css
.zone-frame { position: fixed; inset: 0; z-index: 79; pointer-events: none;
  border: 7px solid var(--red); animation: framePulse .92s steps(2) infinite; }
@keyframes framePulse { 0%,100% { opacity: 1; } 50% { opacity: .28; } }
```

Dans le bloc `@media (prefers-reduced-motion: reduce)`, remplacer
`.zone-frame { border-color: var(--red) !important; }` par
`.zone-frame { opacity: 1 !important; }` — l'alerte doit rester pleinement
visible, seul le clignotement disparaît.

Supprimer les keyframes `magflash` et `zoneFrame` devenus orphelins.

## Limites de portée

Ne pas changer les couleurs, les cadences (`.8s`, `.92s`) ni `steps(2)` : le
rendu doit être identique à l'œil, seul le coût change. Ne pas toucher aux
autres `infinite` (`live`, `pulse`) — ils animent déjà `opacity`/`transform`.

## Vérification

- DevTools → Rendering → « Paint flashing » : plus aucun rectangle plein écran
  qui clignote pendant `.spot-alert` ou `.zone-frame`.
- Performance : enregistrer 5 s pendant l'alerte hors-zone, vérifier l'absence
  de tâches « Paint » récurrentes de la taille du viewport.
- Contrôle visuel : la cadence et les couleurs doivent être indiscernables
  d'avant.
