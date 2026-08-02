'use strict';

/*
 * telemetrie.js — deux questions, aucune base de données.
 *
 * 1. « Est-ce que ça plante chez les joueurs ? » Jusqu'ici la réponse ne
 *    pouvait venir que d'un joueur qui prend la peine de le dire. Il ne le dit
 *    pas : il ferme l'application. On rapatrie donc les erreurs des téléphones
 *    vers les journaux du serveur, où elles sont visibles.
 *
 * 2. « Est-ce que les gens rejouent ? » C'est la seule question qui décide s'il
 *    faut investir dans une publication sur les magasins d'applications. Elle
 *    se répond en comptant des appareils distincts par jour, pas des parties :
 *    dix parties lancées par le même groupe un samedi ne prouvent rien.
 *
 * Tout vit en RAM, comme le reste du jeu : un redéploiement remet les compteurs
 * à zéro. C'est assumé — un résumé est écrit dans les journaux à chaque bascule
 * de jour, et les journaux, eux, survivent au redéploiement.
 */

// L'heure de Paris, lue via formatToParts : `format()` en fr-FR rend « 09 h »,
// dont Number() ne tire que NaN. Un seul endroit pour ce piège, partagé.
const fmt = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hourCycle: 'h23',
});
function parts(d) {
  const out = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}
function heureParis(d = new Date()) { return Number(parts(d).hour); }
function jourParis(d = new Date()) {
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

// Bornes : ce module ne doit jamais être la raison d'un manque de mémoire.
const JOURS_GARDES = 30;
const APPAREILS_MAX = 20000;
const JOURNAL_MAX = 100;

const journal = []; // erreurs et signalements récents, les plus récents en tête
const jours = new Map(); // 'AAAA-MM-JJ' -> {parties, lancees, terminees, dureeMs, appareils:Set, nouveaux, revenus}
const appareils = new Map(); // deviceId -> premier jour vu (insertion ordonnée = éviction FIFO)
let jourCourant = jourParis();

function ficheDuJour(jour = jourParis()) {
  // Bascule de jour : on résume la veille dans les journaux avant de la laisser
  // partir. C'est la seule trace qui survit à un redéploiement.
  if (jour !== jourCourant) {
    const veille = jours.get(jourCourant);
    if (veille) console.log('[stats] ' + jourCourant + ' — ' + JSON.stringify(resumeJour(jourCourant, veille)));
    jourCourant = jour;
    for (const k of [...jours.keys()].sort().slice(0, -JOURS_GARDES)) jours.delete(k);
  }
  let f = jours.get(jour);
  if (!f) {
    f = { parties: 0, lancees: 0, terminees: 0, dureeMs: 0, appareils: new Set(), nouveaux: 0, revenus: 0 };
    jours.set(jour, f);
  }
  return f;
}

function resumeJour(jour, f) {
  return {
    jour,
    parties: f.parties,
    lancees: f.lancees,
    terminees: f.terminees,
    joueurs: f.appareils.size,
    nouveaux: f.nouveaux,
    revenus: f.revenus,
    dureeMoyenneMin: f.terminees ? +(f.dureeMs / f.terminees / 60000).toFixed(1) : 0,
  };
}

// --- Événements de jeu -------------------------------------------------------

function partieCreee() { ficheDuJour().parties++; }
function partieLancee() { ficheDuJour().lancees++; }
function partieTerminee(dureeMs) {
  const f = ficheDuJour();
  f.terminees++;
  if (Number.isFinite(dureeMs) && dureeMs > 0) f.dureeMs += dureeMs;
}

/**
 * Un appareil s'est manifesté. `deviceId` est un identifiant aléatoire tiré par
 * le téléphone et gardé en local : il ne dit rien de la personne, il sert
 * uniquement à distinguer « dix parties, un groupe » de « dix parties, dix
 * groupes ». Un appareil déjà vu un AUTRE jour est un joueur qui revient —
 * c'est le seul chiffre qui compte vraiment ici.
 */
function appareilVu(deviceId) {
  if (typeof deviceId !== 'string' || deviceId.length < 8 || deviceId.length > 64) return;
  const jour = jourParis();
  const f = ficheDuJour(jour);
  if (f.appareils.has(deviceId)) return; // déjà compté aujourd'hui
  f.appareils.add(deviceId);
  const premier = appareils.get(deviceId);
  if (!premier) {
    appareils.set(deviceId, jour);
    f.nouveaux++;
    if (appareils.size > APPAREILS_MAX) appareils.delete(appareils.keys().next().value);
  } else if (premier !== jour) {
    f.revenus++;
  }
}

// --- Erreurs et signalements -------------------------------------------------

function inscrire(entree) {
  journal.unshift({ at: new Date().toISOString(), ...entree });
  if (journal.length > JOURNAL_MAX) journal.length = JOURNAL_MAX;
}

function noteErreur(e = {}) {
  const entree = {
    type: 'erreur',
    source: String(e.source || 'inconnue').slice(0, 40),
    message: String(e.message || '').slice(0, 300),
    ou: String(e.ou || '').slice(0, 200),
    appareil: String(e.appareil || '').slice(0, 160),
    code: String(e.code || '').slice(0, 8),
  };
  inscrire(entree);
  console.error('[erreur ' + entree.source + ']', entree.message, entree.ou, '|', entree.appareil);
}

/**
 * Signalement d'un message de chat. Apple exige de pouvoir agir sur un
 * signalement sous 24 h (règle 1.2) : encore faut-il le voir passer. Il part
 * donc dans les journaux comme une erreur, pas dans un coin silencieux.
 */
function noteSignalement(s = {}) {
  const entree = {
    type: 'signalement',
    code: String(s.code || '').slice(0, 8),
    auteur: String(s.auteur || '').slice(0, 20),
    texte: String(s.texte || '').slice(0, 220),
    par: String(s.par || '').slice(0, 20),
  };
  inscrire(entree);
  console.warn('[signalement] salle ' + entree.code + ' — « ' + entree.texte + ' » de ' + entree.auteur + ', signalé par ' + entree.par);
}

// --- Lecture -----------------------------------------------------------------

function resume() {
  ficheDuJour(); // force la bascule de jour si l'instance a passé minuit
  const parJour = [...jours.entries()].sort().reverse().map(([j, f]) => resumeJour(j, f));
  const total = parJour.reduce((n, j) => n + j.parties, 0);
  return {
    depuis: demarrage,
    appareilsConnus: appareils.size,
    partiesDepuisLeDemarrage: total,
    jours: parJour,
    journal: journal.slice(0, 40),
  };
}

const demarrage = new Date().toISOString();

module.exports = {
  heureParis, jourParis,
  partieCreee, partieLancee, partieTerminee, appareilVu,
  noteErreur, noteSignalement, resume,
};
