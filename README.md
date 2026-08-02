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
   intervalle de révélation, délai de grâce hors-zone, **nombre de radars par
   chasseur**, mode « dernier survivant ». Une case de sécurité obligatoire
   déverrouille le lancement.
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
   - **Radar** : chaque chasseur dispose de **3 radars par partie**. Le radar révèle
     le caché **le plus proche** (position visible **1 min** côté chasseurs). Le caché
     repéré est **alerté** (son + vibration + interface) et **voit la position du
     chasseur pendant 30 s** — un contre-jeu pour savoir d'où fuir.
   - **Confort** : boussole vers le centre (cachés), Wake Lock, **chat global**
     (texte libre, visible par tous), badge de précision GPS.
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
├── telemetrie.js      Compteurs d'usage et remontée d'erreurs (en RAM, sans BDD)
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

## Exploitation

**`GET /stats`** — le tableau de bord. Des nombres, jamais des personnes :
parties créées, lancées, terminées, durée moyenne, et surtout **`revenus`** =
appareils déjà vus un autre jour. C'est le seul chiffre qui dit si les gens
rejouent, donc le seul qui décide s'il faut investir dans une publication sur
les magasins d'applications. Les 40 dernières erreurs et signalements y figurent
aussi. Définir `ADMIN_KEY` sur l'hébergeur ferme l'accès (`/stats?key=…`).

Tout vit en RAM : **un redéploiement remet les compteurs à zéro.** Un résumé de
la veille est écrit dans les journaux à chaque bascule de jour — les journaux,
eux, survivent au redéploiement.

**`POST /client-error`** — les plantages des téléphones remontent ici et
apparaissent dans les journaux du serveur. Avant, un bug chez un joueur ne se
signalait à personne : il fermait l'application, et c'était tout.

**Modération du chat** — filtrage des insultes à l'émission, signalement d'un
message (visible dans les journaux, jamais notifié à l'auteur) et blocage d'un
joueur. Le blocage est appliqué **à l'émission**, pas à l'affichage : un message
bloqué n'atteint jamais l'appareil, historique de reconnexion compris.

**Fond de carte** — le fond sombre vient des serveurs publics de CARTO, sans
contrat. Au-delà de huit tuiles en échec, le client bascule seul sur
OpenStreetMap (assombri par filtre CSS) : une panne de fournisseur ne doit pas
ressembler à une panne de jeu. Définir `window.TRAQUE_TILES` remplace le
fournisseur principal sans toucher au code.

**Mise en veille** — le service se ping lui-même entre 9 h et 1 h (heure de
Paris), et à toute heure tant qu'une partie tourne. Rester chaud 24 h/24
consommerait 744 des 750 heures gratuites mensuelles ; cette fenêtre en
consomme ~496.

---

## Tests

Quinze suites d'intégration Socket.io pilotent de vraies parties de bout en bout.
Elles ont besoin du serveur démarré dans un autre terminal :

```bash
npm start          # terminal 1 — laisse tourner
npm test           # terminal 2 — enchaîne les quinze suites
```

Chacune se lance aussi seule (`npm run test:radar`, `test:zone`, `test:rooms`…).
Compter environ trois minutes au total : plusieurs suites attendent de vrais
délais de jeu (rétrécissements, fenêtres de grâce), et un test qui raccourcirait
ces attentes ne testerait plus rien.

Deux pièges récurrents, tenus par les suites existantes :

- **Les ticks serveur diffusent l'état toutes les 1,5 s.** Un test qui attend un
  événement à `t+X` doit attendre `X + 1,5 s + marge` : sinon le dernier état
  reçu date d'avant l'événement, et l'assertion mesure une course, pas une règle.
- **Ne jamais assertionner sur un compteur global** (le nombre de salles de
  `/health`, par exemple). Les autres suites laissent des parties en fenêtre de
  grâce qui expirent pendant l'attente : le test mesure alors le bruit des
  voisins. `tests/rooms.test.js` sonde des codes précis pour cette raison.

---

## Contraintes connues (assumées, pas des bugs)

- La géoloc web a une précision réelle ~5–30 m en extérieur, pire en intérieur, et
  souvent très mauvaise sur PC (WiFi, plusieurs centaines de mètres). Pour qu'un
  joueur sur ordinateur ne soit pas un « fantôme » injoignable, le serveur accepte
  les positions imprécises (le badge GPS indique la précision) ; en revanche les
  stats de distance n'accumulent que les lectures fiables (≤ 30 m) et une marge
  d'incertitude évite les fausses conversions hors-zone.
- Les navigateurs mobiles ralentissent le GPS quand l'onglet passe en arrière-plan
  ou que l'écran est verrouillé (surtout iOS Safari) → garder l'app à l'écran (le
  Wake Lock aide).
- **Pas de persistance** : tout est perdu si le serveur redémarre. Pensé pour une
  partie entre amis, pas pour un usage à grande échelle.
- Pas de compte, pas d'auth : un code de partie suffit.

## Licence

MIT.
