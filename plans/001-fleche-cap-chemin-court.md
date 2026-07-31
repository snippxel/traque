# 001 — La flèche de cap doit prendre le chemin court

Commit de référence : `33d8d89`
Sévérité : HIGH · Catégorie : physicalité / correction de bug

## Problème

`public/js/app.js`, fonction `updateZoneBearing()` :

```js
arrow.style.transform = 'rotate(' + Math.round(GameMap.bearing(p, z.center)) + 'deg)';
```

`bearing()` renvoie une valeur bornée dans `[0, 360[`. `public/css/style.css` applique
`transition: transform .45s var(--out)` sur `.za-arrow`. Or `rotate()` s'interpole
numériquement : quand le cap passe de `358deg` à `2deg`, le navigateur tourne de
**−356°**, pas de +4°. La flèche part en toupie à l'envers pendant 450 ms.

Ça se produit chaque fois que la direction de la zone traverse le nord — et ça se
produit pendant l'alerte hors-zone, c'est-à-dire au seul moment où cette flèche
sert à quelque chose.

## Correctif

Accumuler un angle non borné et n'y ajouter que le delta le plus court.

Dans `public/js/app.js`, au-dessus de `updateZoneBearing()`, déclarer :

```js
// Angle cumulé, volontairement NON borné à [0,360[ : voir plan 001.
let arrowAngle = null;
```

Remplacer la ligne de rotation par :

```js
    const target = GameMap.bearing(p, z.center);
    if (reset || arrowAngle === null) {
      // Première pose : on se place sans transition, sinon la flèche
      // balaierait depuis 0° à l'ouverture de l'alerte.
      arrowAngle = target;
      arrow.style.transition = 'none';
      arrow.style.transform = 'rotate(' + target.toFixed(1) + 'deg)';
      void arrow.offsetWidth;
      arrow.style.transition = '';
    } else {
      // rotate() s'interpole numériquement : 358° -> 2° repartirait en arrière
      // sur 356°. On n'ajoute donc que le plus court chemin angulaire.
      const delta = ((target - arrowAngle) % 360 + 540) % 360 - 180;
      arrowAngle += delta;
      arrow.style.transform = 'rotate(' + arrowAngle.toFixed(1) + 'deg)';
    }
```

Changer la signature en `function updateZoneBearing(reset)`.

Dans le handler `socket.on('zone:alert', ...)`, appeler `updateZoneBearing(true)`
au lieu de `updateZoneBearing()`.

## Limites de portée

Ne pas toucher à `bearing()` dans `map.js` : la fonction est juste, et le test
`tests/bearing.test.js` la couvre. Le défaut est entièrement côté affichage.

## Vérification

- `node tests/bearing.test.js` doit continuer à passer (il n'est pas affecté).
- Contrôle calculé : simuler la suite de caps 350 → 358 → 2 → 10 et vérifier que
  la valeur écrite dans `style.transform` progresse de façon monotone
  (350 → 358 → 362 → 370) au lieu de retomber à 2.
- Contrôle au ressenti : ouvrir l'alerte, marcher autour du centre de zone en
  traversant le nord ; la flèche doit glisser sans jamais faire de tour complet.
