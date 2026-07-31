# 003 — Les bandeaux d'alerte doivent entrer en ease-out

Commit de référence : `33d8d89`
Sévérité : HIGH · Catégorie : easing & durée

## Problème

`public/css/style.css` applique la même entrée à tous les bandeaux d'alerte :

```css
.hud-shrink, .zone-closing, .spot-banner, .target-banner {
  ...
  animation: thirdIn 420ms var(--hard) both;
}
.start-banner {
  ...
  animation: thirdIn 420ms var(--hard) both;
}
@keyframes thirdIn { from { transform: translateX(-104%); } to { transform: translateX(0); } }
```

Deux défauts cumulés :

1. **`--hard` est `cubic-bezier(0.77, 0, 0.175, 1)`**, un ease-in-**out**. Son
   premier point de contrôle en `(0.77, 0)` aplatit le début de la courbe : le
   bandeau reste quasi immobile pendant ~40 % de la durée, puis surgit d'un coup.
   La règle est : ce qui **entre** doit être en ease-out, qui démarre vite et
   répond immédiatement. L'ease-in-out est réservé à ce qui se **déplace** à
   l'écran d'un point à un autre.
2. **420 ms dépasse le budget** de 300 ms pour une animation d'interface.

Cumulés, `.zone-closing` (« la zone se ferme ») et `.spot-banner` (« un chasseur
t'a localisé ») arrivent avec environ 170 ms d'immobilité au moment précis où le
joueur doit réagir.

## Correctif

Le bon motif existe déjà dans le fichier — `.chat-bubble` fait
`animation: thirdIn 300ms var(--out) both;`. `--out` est
`cubic-bezier(0.23, 1, 0.32, 1)`, l'ease-out fort de référence.

Remplacer les deux occurrences de :

```css
  animation: thirdIn 420ms var(--hard) both;
```

par :

```css
  animation: thirdIn 260ms var(--out) both;
```

Aux lignes concernées : le bloc `.hud-shrink, .zone-closing, .spot-banner,
.target-banner` et le bloc `.start-banner`.

## Limites de portée

- Ne pas toucher aux keyframes `thirdIn` : la translation de `-104%` est juste,
  elle exprime « l'incrustation entre par la gauche » et se mesure sur la
  largeur propre de l'élément, pas en pixels codés en dur.
- Ne pas toucher à `.toast` (traité par le plan 004) ni à `.chat-bubble`, déjà
  correct.
- **Ne pas toucher à `--hard` lui-même.** Le token reste juste pour ce qu'il
  désigne ; c'est son affectation à une entrée qui est fautive. `capWipe` par
  exemple l'utilise à bon escient.

## Vérification

- Contrôle calculé : `getComputedStyle($('zone-closing')).animationDuration`
  doit valoir `0.26s` et `animationTimingFunction` `cubic-bezier(0.23, 1, 0.32, 1)`.
- Contrôle au ressenti, le vrai juge : ralentir l'animation ×10 dans DevTools et
  vérifier que le bandeau part **immédiatement** au lieu de rester en attente.
  Comparer côte à côte avec `.chat-bubble`, qui donne la sensation cible.
