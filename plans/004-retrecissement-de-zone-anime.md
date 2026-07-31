# 004 — Le rétrécissement de zone ne doit pas se téléporter

Commit de référence : `33d8d89`
Sévérité : occasion manquée (la principale) · Catégorie : changement d'état brutal

## Problème

`public/js/map.js`, `setZone()` :

```js
      zoneCircle.setLatLng(c); zoneCircle.setRadius(zone.radius);
```

Le rayon saute d'une valeur à l'autre. Le rétrécissement par paliers est le
mécanisme central du jeu — c'est lui qui force les rencontres — et il est
annoncé par un bandeau et un son, mais l'objet qui rétrécit, lui, se téléporte.
Le voile extérieur (`outsideVeil`) saute avec lui.

## Correctif

Interpoler le rayon en `requestAnimationFrame` sur 700 ms en ease-out cubique,
et redessiner le cercle **et** le voile à chaque image pour qu'ils ne se
désynchronisent jamais.

Dans `public/js/map.js`, ajouter près des autres variables de module :

```js
  let radiusAnim = null;     // handle rAF de l'animation de rayon
  let shownRadius = null;    // rayon réellement affiché (≠ rayon logique pendant l'animation)
```

Extraire le rendu à un rayon donné, puisque cercle et voile doivent bouger
ensemble :

```js
  function paintZone(center, radius) {
    // 64 points au lieu de 96 pendant l'animation : le voile est recalculé à
    // chaque image, et l'écart n'est pas perceptible à cette échelle.
    outsideVeil.setLatLngs([WORLD, ringPoints(center, radius, 64, true)]);
    zoneCircle.setRadius(radius);
    shownRadius = radius;
  }
```

Dans `setZone()`, remplacer la mise à jour directe par :

```js
      zoneCircle.setLatLng(c);
      const cible = zone.radius;
      const depuis = shownRadius === null ? cible : shownRadius;
      const reduit = cible < depuis - 1;
      const sobre = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduit || sobre) {
        if (radiusAnim) { cancelAnimationFrame(radiusAnim); radiusAnim = null; }
        paintZone(zone.center, cible);
      } else {
        if (radiusAnim) cancelAnimationFrame(radiusAnim);
        const t0 = performance.now(), duree = 700;
        // Ease-out cubique : la contraction part vite puis se pose, on lit
        // « ça se referme » sans avoir besoin de regarder le début.
        const pas = (now) => {
          const t = Math.min(1, (now - t0) / duree);
          const e = 1 - Math.pow(1 - t, 3);
          paintZone(zone.center, depuis + (cible - depuis) * e);
          radiusAnim = t < 1 ? requestAnimationFrame(pas) : null;
        };
        radiusAnim = requestAnimationFrame(pas);
      }
```

Le premier bloc `if (!zoneCircle)` continue de créer le cercle et doit ensuite
appeler `paintZone(zone.center, zone.radius)` pour initialiser `shownRadius`.

Dans `reset()`, ajouter :

```js
    if (radiusAnim) { cancelAnimationFrame(radiusAnim); radiusAnim = null; }
    shownRadius = null;
```

## Limites de portée

- **Uniquement quand le rayon diminue.** Un agrandissement (nouvelle partie,
  resynchronisation après reconnexion) doit rester instantané, sinon un joueur
  qui revient voit la zone gonfler sans raison.
- Ne pas animer le cercle de zone suivante (`nextZoneCircle`) : il désigne une
  cible, pas un événement.
- Ne pas toucher à `previewUpdate()` — c'est la carte du salon.

## Vérification

- Contrôle mesuré : instrumenter `paintZone` et vérifier que le rayon décroît
  sur ~700 ms au lieu d'un saut unique, et que `outsideVeil` et `zoneCircle`
  portent la même valeur à chaque image.
- Performance, **à contrôler sur un vrai téléphone milieu de gamme** : le voile
  est un polygone reprojeté à chaque image. Si l'animation saccade, réduire
  `ringPoints` à 48, puis la durée à 500 ms. Ne pas laisser une animation qui
  fait tomber la carte sous 50 fps : mieux vaut le saut.
- Reduced-motion : avec le réglage actif, le rayon doit sauter, sans rAF.
