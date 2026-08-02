# Plans d'animation — TRAQUE

Issus d'un audit de motion mené sur le commit `33d8d89`.

Contexte : pile vanilla, aucune bibliothèque de motion, tout en CSS. Trois
tokens d'easing dans `public/css/style.css` — `--hard`
(`cubic-bezier(0.77, 0, 0.175, 1)`, ease-in-out fort), `--out`
(`cubic-bezier(0.23, 1, 0.32, 1)`, ease-out fort) et `--slam`
(`cubic-bezier(0.2, 0.9, 0.26, 1.055)`, léger dépassement réservé à la cascade
de capture). Les deux premiers sont déjà les valeurs canoniques : **aucun plan
ne doit introduire une nouvelle courbe.**

## État

**Les cinq plans sont appliqués**, tous dans le commit `131d5e7` (« Audit de
motion : cinq corrections et ajouts ») — le même qui a versé ce dossier au dépôt.
Le tableau était resté à « À FAIRE » et laissait croire que tout le lot
attendait encore.

| # | Plan | Sév. | Statut | Où c'est |
|---|------|------|--------|----------|
| 001 | [Flèche de cap, chemin court](001-fleche-cap-chemin-court.md) | HIGH | ✅ FAIT | `public/js/app.js` — plus court chemin angulaire dans `updateZoneBearing()` |
| 002 | [Clignotements sur l'opacité](002-clignotements-sur-opacite.md) | HIGH | ✅ FAIT | `public/css/style.css` — `veilPulse` / `framePulse` ; `magflash` et `zoneFrame` supprimés |
| 003 | [Entrée des alertes en ease-out](003-entree-des-alertes-en-ease-out.md) | HIGH | ✅ FAIT | `public/css/style.css` — `thirdIn 260ms var(--out)` sur les deux blocs de bandeaux |
| 004 | [Rétrécissement de zone animé](004-retrecissement-de-zone-anime.md) | Occasion | ✅ FAIT | `public/js/map.js` — interpolation du rayon, contraction seule, ease-out cubique |
| 005 | [Ouverture de la chasse](005-ouverture-de-la-chasse.md) | Occasion | ✅ FAIT | `#kickoff` (`index.html` / `style.css` / `showKickoff()`) |

Les plans restent en place : ils documentent le pourquoi de chaque valeur, et
c'est ce qu'on relit avant de toucher à une durée ou à une courbe.

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

## Second lot — les trois MEDIUM laissés de côté

Repris et appliqués. Ils n'ont pas de fiche de plan : le diagnostic de l'audit
suffisait, et le pourquoi de chaque valeur est écrit à l'endroit du code.

| Constat | Statut | Où c'est |
|---------|--------|----------|
| Les toasts entrent en `@keyframes` (redémarrent à zéro) et la pile saute quand l'un d'eux est retiré | ✅ FAIT | `style.css` (`.toast` en transition, états `.pre`/`.out`) et `app.js` (`dropToast()`, réagencement FLIP) |
| `pulse` descend à `scale(.72)` / `opacity: .4` : un marqueur est à moitié effacé une seconde sur deux | ✅ FAIT | `style.css` — cycle inversé vers le haut (`.92`→`1`, `scale(1)`→`1.22`), cadence alignée sur `live` à 1,4 s |
| `prefers-reduced-motion` est un reset `*` à `.001ms !important` : il supprime tout au lieu des seuls déplacements | ✅ FAIT | `style.css` — bloc du haut réduit, et redéfinition des `@keyframes` **en fin de fichier** |

Trois choses à savoir avant d'y retoucher :

- **Le bloc de mouvement réduit DOIT rester en fin de fichier.** Une `@keyframes`
  est écrasée par la dernière définition de son nom, media query ou non. Placé
  avant les originales, il n'aurait aucun effet — et ça ne se voit pas.
- La règle appliquée est : **on retire les déplacements et les clignotements, on
  garde les fondus.** Chaque animation conserve durée, délai et place dans la
  cascade ; seul son moyen change. Les deux balayages (`koWipe`, `capWipe`)
  gardent leur `transform` d'arrivée, sinon le pavé reste à `scaleX(0)`.
- L'entrée des toasts est passée de `--hard` 340 ms à `--out` 260 ms : c'était le
  dernier bloc encore sur l'ancienne courbe, alors que le plan 003 avait déjà
  tranché pour toute incrustation qui entre.
