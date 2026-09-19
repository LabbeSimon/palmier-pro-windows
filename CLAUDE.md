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

### Bloc 2 — Lecture temps réel  ⬜

Aujourd'hui le preview est image par image via FFmpeg. C'est la limite la plus
handicapante à l'usage.

- [ ] Lecteur avec bouton play/pause réel, barre d'espace
- [ ] Pré-rendu en cache des segments visibles
- [ ] Son synchronisé avec l'image
- [ ] Indicateur de frames sautées

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

### Bloc 5 — Fonctions Kdenlive manquantes  ⬜

- [ ] Groupes de clips
- [ ] Zone de travail (in/out) et rendu partiel
- [ ] Modes d'édition : écrasement, insertion
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
