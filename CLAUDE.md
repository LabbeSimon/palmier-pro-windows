# Palmier Win — feuille de route

Ce fichier est la source de vérité du reste à faire. Il se lit au début de chaque
session et se met à jour à chaque étape terminée. **Ne pas s'arrêter au milieu
d'un bloc** : un bloc coché est un bloc vérifié à l'écran ou par un test.

## Le projet en une phrase

Un éditeur vidéo Windows qui est **à 90 % un Kdenlive** — mêmes vues, même
vocabulaire, mêmes gestes — **plus un serveur MCP** qui laisse un agent monter
sur la même timeline que l'utilisateur, avec le même historique d'annulation.

## Règles de travail

- Le socle de référence est **Kdenlive**, pas un dashboard sombre générique.
  En cas de doute sur une vue, un raccourci ou un mot : faire comme Kdenlive.
- Aucune ligne de code de Kdenlive ni de palmier-pro n'est reprise. Le projet
  reste en Apache-2.0 parce qu'il est écrit de zéro.
- Toute opération de montage passe par `src/core/ops.ts`. L'UI et les outils MCP
  ne doivent jamais avoir deux implémentations d'une même règle.
- Un test qui casse après un changement de comportement volontaire se met à jour ;
  un test qui casse autrement révèle un bug.
- Vérifier à l'écran avant de dire que c'est fait. Les captures passent par
  `xvfb-run` + `import`, et `xdotool` pour cliquer.

## État actuel

Fait et vérifié :

- Modèle timeline en domaine frame, opérations pures, annulation partagée
- 21 effets, 11 transitions, tous rendus vérifiés au vrai FFmpeg
- Outils sélection / rasoir / espaceur, aimantation, verrouillage de piste
- Import vidéo = image + son en clips liés
- Glisser-déposer depuis l'explorateur
- Double moniteur clip / projet, mixeur audio en dB
- Barre de menus native, 30 outils MCP, bouton de connexion en un clic
- Logo intégré : `.ico` multi-tailles dans l'exe, `.png` Linux
- 137 tests verts ; exe Windows signé non, mais construit et livré

---

## À FAIRE

### Bloc 1 — Interface fidèle à Kdenlive  ✅ (19/09/2026)

- [x] **Typographie** : Noto Sans, la police de KDE, récupérée au build et
      embarquée ; échelle de rôles réglée sur les densités Kdenlive
- [x] **Palette** : Breeze Dark intégrale, clips vidéo bleu-gris et audio verts,
      playhead rouge, sélection en bleu KDE
- [x] **Docks redimensionnables** : trois splitters (gauche, droite, timeline),
      tailles mémorisées entre sessions, pilotables au clavier
- [x] **Barre d'outils principale** à icônes seules, tooltips avec raccourcis
- [x] **En-têtes de piste** : hauteur ajustable, renommage par double-clic
- [x] **Règle temporelle** : graduations mineures + zone de travail in/out,
      exposée aussi en MCP (`set_work_zone`)

Reste ouvert sur ce bloc : les docks sont redimensionnables mais pas encore
**détachables ni réarrangeables** comme les vrais docks Qt.

### Bloc 2 — Lecture temps réel  ✅ (19/09/2026)

Approche retenue : rendre la timeline en **proxy 540p** puis le lire dans un
vrai lecteur vidéo, comme le *timeline preview rendering* de Kdenlive. Rendre
image par image coûtait ~300 ms/frame, soit un diaporama.

- [x] Lecteur play/pause réel, barre d'espace, bouton transport
- [x] Proxy mis en cache, indexé par empreinte de la timeline ; les anciens
      sont purgés au-delà de 4
- [x] Son synchronisé — il est dans le proxy, donc calé par construction
- [x] Indicateur de frames sautées + résolution du proxy affichée
- [x] `Ctrl+Shift+Entrée` construit le proxy, comme dans Kdenlive

Le proxy n'est **jamais** reconstruit automatiquement : encoder à chaque frappe
brûlerait la machine. L'UI dit en clair quand ce qu'on regarde est périmé.

**Deux bugs trouvés en vérifiant, qui rendaient l'app muette sans rien dire :**
la CSP `default-src 'self'` bloquait `font://` et `preview://` — Noto Sans n'a
jamais chargé avant ce correctif — et les schémas déclarés *standard*
normalisent l'hôte en minuscules, donc lire le nom de fichier depuis l'hôte
échouait. Le nom passe désormais par le **chemin**.

### Bloc 3 — Keyframes  ⬜

- [ ] Modèle : courbes par paramètre d'effet et de transformation
- [ ] Éditeur de keyframes sous le moniteur (comme Kdenlive)
- [ ] Interpolations : linéaire, lisse, maintien
- [ ] Rendu FFmpeg des paramètres animés
- [ ] Outils MCP pour poser et lire des keyframes

### Bloc 4 — Panneau agent intégré  ⬜

Le point qui distingue ce logiciel de Kdenlive.

- [ ] Panneau de conversation dans l'app
- [ ] L'agent voit la timeline et agit dessus en direct
- [ ] Journal des actions de l'agent, annulables une par une

### Bloc 5 — Fonctions Kdenlive manquantes  🟡

- [x] **Groupes de clips** — `Ctrl+G` / `Ctrl+Shift+G`, liseré ambre sur les
      clips groupés ; un groupe fusionne au lieu de s'imbriquer
- [x] **Zone de travail** (in/out) et rendu limité à la zone
- [x] **Modes d'édition** : normal, écrasement, insertion, dans la barre
      timeline et en MCP. L'écrasement découpe proprement le clip dessous
- [ ] Trim avancé : ripple, roll, slip, slide
- [ ] Proxy clips pour le montage sur machine modeste
- [ ] Étalonnage : courbes, roues chromatiques
- [ ] Sous-titres : édition, import/export SRT
- [ ] Multicam

### Bloc 6 — Distribution  ⬜

- [ ] **Release GitHub avec les binaires attachés** — bloqué sur `gh auth login`
- [ ] Signature du code (sinon SmartScreen avertit à chaque lancement)
- [ ] CI qui construit l'exe à chaque tag
- [ ] Mise à jour automatique dans l'app

---

## Décisions prises

- **19/09/2026 — Degré de ressemblance : copie fidèle de la disposition.**
  Mêmes docks, mêmes couleurs, mêmes positions de panneaux, mêmes raccourcis.
  Quelqu'un qui connaît Kdenlive doit être immédiatement chez lui. En cas
  d'arbitrage entre « joli » et « comme Kdenlive », c'est Kdenlive qui gagne.
- **Ordre de travail : Bloc 1 (UI) puis Bloc 2 (lecture temps réel).**

## Références Kdenlive

Palette Breeze Dark, les valeurs exactes à utiliser :

| Rôle | Valeur |
|---|---|
| Fond fenêtre | `#31363b` |
| Fond alterné | `#2a2e32` |
| Fond liste / base | `#232629` |
| Texte | `#fcfcfc` |
| Texte atténué | `#a1a9b1` |
| Sélection (bleu KDE) | `#3daee9` |
| Bordure | `#3f4549` |
| Clip vidéo | `#5a7a96` |
| Clip audio | `#6a9a5a` |
| Playhead | `#cc0000` |

Police : **Noto Sans**, la police par défaut de KDE. Récupérée au build par
`scripts/fetch-fonts.mjs` et non versionnée, exactement comme FFmpeg — la
convention « rien de tiers redistribué » reste tenue.
