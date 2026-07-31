# Plans d'animation — TRAQUE

Issus d'un audit de motion mené sur le commit `33d8d89`.

Contexte : pile vanilla, aucune bibliothèque de motion, tout en CSS. Trois
tokens d'easing dans `public/css/style.css` — `--hard`
(`cubic-bezier(0.77, 0, 0.175, 1)`, ease-in-out fort), `--out`
(`cubic-bezier(0.23, 1, 0.32, 1)`, ease-out fort) et `--slam`
(`cubic-bezier(0.2, 0.9, 0.26, 1.055)`, léger dépassement réservé à la cascade
de capture). Les deux premiers sont déjà les valeurs canoniques : **aucun plan
ne doit introduire une nouvelle courbe.**

## Ordre d'exécution recommandé

| # | Plan | Sév. | Dépendances | Statut |
|---|------|------|-------------|--------|
| 001 | [Flèche de cap, chemin court](001-fleche-cap-chemin-court.md) | HIGH | aucune | À FAIRE |
| 002 | [Clignotements sur l'opacité](002-clignotements-sur-opacite.md) | HIGH | aucune | À FAIRE |
| 003 | [Entrée des alertes en ease-out](003-entree-des-alertes-en-ease-out.md) | HIGH | aucune | À FAIRE |
| 004 | [Rétrécissement de zone animé](004-retrecissement-de-zone-anime.md) | Occasion | aucune | À FAIRE |
| 005 | [Ouverture de la chasse](005-ouverture-de-la-chasse.md) | Occasion | 003 (partage `--out`) | À FAIRE |

Les trois HIGH sont indépendants et peuvent partir dans n'importe quel ordre.
Faire 003 avant 005 évite d'avoir à repasser sur les durées.

## Ce que l'audit a écarté

Constatés puis rejetés après relecture — ne pas les rouvrir sans élément neuf :

- **`transition: transform .9s linear` sur `.leaflet-marker-icon`** — c'est le
  lissage des sauts GPS, et `linear` est le bon choix pour un mouvement continu.
  La désactivation pendant le zoom (`.leaflet-zoom-anim`) est un soin rare.
- **`:hover`** — déjà correctement isolés derrière
  `@media (hover: hover) and (pointer: fine)`.
- **`--slam` et son dépassement à 1.055** — délice délibéré sur un moment rare
  (la capture). Conforme.
- **Consolidation de tokens** — il n'y a pas de courbes en double à fusionner.

## Constats non retenus dans ce lot

Vus par l'audit, laissés de côté par choix :

- Les toasts entrent en `@keyframes` (redémarrent à zéro) et la pile saute quand
  l'un d'eux est retiré. MEDIUM.
- `pulse` descend à `scale(.72)` / `opacity: .4` : un marqueur est à moitié
  effacé une seconde sur deux, sur un écran lu en deux secondes. MEDIUM.
- Le bloc `prefers-reduced-motion` est un reset `*` à `.001ms !important` : il
  supprime tout au lieu de ne retirer que les déplacements. MEDIUM.
