# TRAQUE // OPS — Cache-cache géolocalisé IRL

Application web mobile (PWA) de cache-cache en vrai, géolocalisée. Deux équipes :
**chasseurs** et **cachés**. Les chasseurs doivent attraper tous les cachés avant
la fin du temps imparti (ou jusqu'au dernier survivant). La zone de jeu rétrécit
progressivement, façon *battle royale*, pour forcer les rencontres.

Direction artistique **Tactical HUD** : console de surveillance, vert phosphore &
ambre, monospace, balayage radar.

---

## Stack

- **Backend** : Node.js + Express + Socket.io. État de jeu **100 % en mémoire**
  (une partie = un objet en RAM, supprimé quand la salle se vide). Aucune base de données.
- **Frontend** : HTML/CSS/JS **vanilla** (pas de framework, pas de build step).
  Carte via **Leaflet.js** + tuiles **CartoDB Dark** (gratuit, sans clé API).
- **Hébergement** : Render.com (tier gratuit), déployé depuis un dépôt GitHub.

Aucune dépendance de build : les libs front (Leaflet, jsQR, qrcode) sont chargées
par CDN, le client Socket.io est servi par le serveur.

---

## Lancer en local

Prérequis : Node.js ≥ 18.

```bash
npm install
npm start
# → http://localhost:3000
```

> ⚠️ La **caméra** (scan QR) et la **géolocalisation haute précision** exigent un
> contexte sécurisé : `localhost` fonctionne, sinon il faut du **HTTPS** (Render
> en fournit un automatiquement). Pour tester le GPS/caméra sur un vrai téléphone
> depuis ton PC, passe par un tunnel HTTPS (ex. `ngrok http 3000`) ou déploie.

---

## Déployer sur Render

1. Pousse ce dossier sur un dépôt **GitHub**.
2. Sur [render.com](https://render.com) → **New** → **Blueprint**, sélectionne le
   dépôt : le fichier [`render.yaml`](render.yaml) configure tout automatiquement.
   *(Sinon : New → Web Service, Build = `npm install`, Start = `node server.js`.)*
3. Render construit, déploie et fournit une URL HTTPS. Ouvre-la sur ton téléphone.

Le tier gratuit s'endort après inactivité : le premier chargement peut prendre
~30 s, ensuite c'est instantané.

---

## Comment jouer

1. **Lobby** — un hôte crée une partie et partage le code à 5 caractères. Les autres
   rejoignent. Seul l'hôte voit la configuration et le bouton de lancement (vérifié
   côté serveur). Il répartit les rôles (aléatoire ~25 % de chasseurs, ou manuel).
2. **Config** — rayon de départ/final de la zone, durée, nombre de paliers,
   intervalle de révélation, délai de grâce hors-zone, mode « dernier survivant ».
   Une case de sécurité obligatoire déverrouille le lancement.
3. **En jeu**
   - **Visibilité asymétrique** : un chasseur voit ses coéquipiers en temps réel et
     la *dernière position révélée* des cachés (signal gris, mis à jour toutes les X
     min). Un caché voit les autres cachés en temps réel, **jamais** un chasseur.
   - **Élimination** : le caché montre son **QR** (« Mon code »), le chasseur le
     **scanne** (« Éliminer ») → conversion immédiate, validée côté serveur.
   - **Zone** : rétrécit par paliers. La prochaine zone est visible (cercle rouge
     pointillé) avec minuteur. Un caché hors-zone déclenche une **alerte plein
     écran** (son + vibration + compte à rebours) ; s'il ne revient pas → conversion.
     Les chasseurs reçoivent un **flash** avec sa position exacte.
   - **Radar** : chaque chasseur a **une** utilisation pour révéler un caché au hasard.
   - **Confort** : boussole vers le centre (cachés), Wake Lock, chat d'équipe (4
     messages pré-écrits, visibles par l'équipe seulement), badge de précision GPS.
4. **Reconnexion** — refresh ou coupure réseau : le joueur reprend sa place exacte
   (fenêtre de grâce serveur de 90 s).
5. **Fin** — victoire chasseurs (tous attrapés) ou cachés (temps écoulé). Tableau de
   stats : survie, distance parcourue, captures.

---

## Architecture des fichiers

```
traque/
├── server.js          Express + Socket.io, boucle de jeu (tick 1.5 s)
├── game.js            Moteur : Room, rôles, zone battle royale, visibilité asymétrique
├── package.json
├── render.yaml        Blueprint de déploiement Render
├── tests/
│   ├── flow.test.js   Flux complet : lobby → rôles → capture QR → fin + stats
│   └── zone.test.js   Sortie de zone → alerte → conversion forcée
└── public/
    ├── index.html     Les 4 écrans (accueil / lobby / jeu / fin) + modales
    ├── css/style.css  Direction artistique "Tactical HUD"
    ├── js/
    │   ├── app.js     Orchestrateur (socket, sessions, écrans, GPS throttlé)
    │   ├── map.js     Leaflet (marqueurs, zones, boussole)
    │   ├── qr.js      Génération + scan QR
    │   └── sensors.js GPS, orientation, Wake Lock, vibration, alarme audio
    ├── manifest.webmanifest
    ├── sw.js          Service worker (coquille PWA, jamais la logique de partie)
    └── icons/
```

---

## Tests

Deux suites d'intégration Socket.io pilotent de vraies parties de bout en bout.
Elles ont besoin du serveur démarré dans un autre terminal :

```bash
npm start          # terminal 1 — laisse tourner
npm test           # terminal 2 — lance les deux suites
```

---

## Contraintes connues (assumées, pas des bugs)

- La géoloc web a une précision réelle ~5–30 m en extérieur, pire en intérieur.
- Les navigateurs mobiles ralentissent le GPS quand l'onglet passe en arrière-plan
  ou que l'écran est verrouillé (surtout iOS Safari) → garder l'app à l'écran (le
  Wake Lock aide).
- **Pas de persistance** : tout est perdu si le serveur redémarre. Pensé pour une
  partie entre amis, pas pour un usage à grande échelle.
- Pas de compte, pas d'auth : un code de partie suffit.

## Licence

MIT.
