'use strict';
/* Test : géométrie du cap et de la distance affichés par l'alerte hors-zone.
 *
 * Contrairement aux autres tests de ce dossier, celui-ci ne parle pas au
 * serveur : il extrait les deux fonctions de calcul du code client et les
 * exerce directement. Aucun serveur à lancer.
 *
 * Pourquoi il existe : la bannière hors-zone est la seule chose qui dit à un
 * joueur DANS QUELLE DIRECTION courir, et la boussole a été retirée au motif
 * que la carte porte cette information. Une inversion de signe dans bearing()
 * enverrait tout le monde à l'opposé de la zone sans qu'aucun test ne bronche
 * et sans que ça se voie ailleurs dans l'interface.
 */
const fs = require('fs');
const path = require('path');
const JS = path.join(__dirname, '..', 'public', 'js');

// Extrait le source d'une fonction nommée pour l'exercer telle qu'elle est
// réellement écrite, plutôt que d'en recopier une version qui pourrait diverger.
function extract(file, name) {
  const src = fs.readFileSync(path.join(JS, file), 'utf8');
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error(name + ' introuvable dans ' + file);
  let depth = 0, started = false, end = i;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) { end = j + 1; break; } }
  }
  return '(' + src.slice(i, end) + ')';
}

const bearing = eval(extract('map.js', 'bearing'));
const haversine = eval(extract('app.js', 'haversine'));

let failures = 0;
const assert = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failures++; };
// Tolérance angulaire : on vérifie une direction lisible à l'écran, pas une
// précision de navigation. 1° suffit largement pour attraper une inversion.
const cap = (got, want, m) => assert(Math.min(Math.abs(got - want), 360 - Math.abs(got - want)) <= 1, m + ' (' + got.toFixed(1) + '°)');

const P = { lat: 48.8566, lng: 2.3522 };

console.log('# Cap : points cardinaux');
cap(bearing(P, { lat: 49.8566, lng: 2.3522 }), 0, 'Cible plein nord → 0°');
cap(bearing(P, { lat: 48.8566, lng: 3.3522 }), 90, 'Cible plein est → 90°');
cap(bearing(P, { lat: 47.8566, lng: 2.3522 }), 180, 'Cible plein sud → 180°');
cap(bearing(P, { lat: 48.8566, lng: 1.3522 }), 270, 'Cible plein ouest → 270°');

console.log('# Cap : quadrant diagonal');
const centre = { lat: 48.8600, lng: 2.3600 };
const b = bearing({ lat: 48.8560, lng: 2.3540 }, centre);
assert(b > 0 && b < 90, 'Joueur au sud-ouest du centre → cap vers le nord-est (' + b.toFixed(1) + '°)');

console.log('# Cap : domaine de sortie');
let hors = 0;
for (let i = 0; i < 360; i += 7) {
  const a = i * Math.PI / 180;
  const v = bearing(P, { lat: P.lat + 0.01 * Math.cos(a), lng: P.lng + 0.01 * Math.sin(a) });
  if (Number.isNaN(v) || v < 0 || v >= 360) hors++;
}
assert(hors === 0, '52 azimuts testés, tous dans [0,360[');

console.log('# Distance affichée : jusqu’au BORD de la zone, pas au centre');
const zone = { center: P, radius: 300 };
[[500, 200], [300, 0], [250, -50]].forEach(([d, attendu]) => {
  const p = { lat: zone.center.lat + d / 111320, lng: zone.center.lng };
  const bord = Math.round(haversine(p, zone.center) - zone.radius);
  assert(Math.abs(bord - attendu) <= 2, 'À ' + d + ' m du centre (rayon 300) → ' + bord + ' m du bord');
});

console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
process.exit(failures === 0 ? 0 : 1);
