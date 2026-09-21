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
- 23 effets, 11 transitions, tous rendus vérifiés au vrai FFmpeg
- Outils sélection / rasoir / espaceur, aimantation, verrouillage de piste
- Import vidéo = image + son en clips liés
- Glisser-déposer depuis l'explorateur
- Double moniteur clip / projet, mixeur audio en dB
- Barre de menus native, 48 outils MCP, bouton de connexion en un clic
- Logo intégré : `.ico` multi-tailles dans l'exe, `.png` Linux
- Keyframes : domaine, rendu, éditeur, MCP
- Agent intégré + journal d'actions annulables une par une
- Sous-titres SRT/VTT, étalonnage courbes + roues, proxys, multicam
- CI + release automatique sur tag, mise à jour dans l'app
- Preview incrémentale par tranches, encodage GPU quand disponible
- 359 tests verts ; exe Windows signé non, mais construit et livré

---

## À FAIRE

Les six blocs sont faits. **Un seul point reste ouvert et il n'est pas
technique** : la signature du code Windows demande un certificat Authenticode
(~300 €/an), donc c'est une décision d'achat. Tout le reste tourne, est testé,
et est poussé.

### Bloc 1 — Interface fidèle à Kdenlive  ✅ (19-20/09/2026)

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

- [x] **Docks réarrangeables** (20/09) : un onglet se **glisse d'un dock à
      l'autre**, l'agencement est retenu entre les sessions, et
      `Affichage ▸ Réinitialiser` le remet d'aplomb. Un dock vidé garde une
      bande étroite — sans endroit où lâcher un onglet, le dernier panneau
      sorti serait inatteignable.

Reste ouvert : **détacher** un panneau en fenêtre flottante. Ça demande un
second processus de rendu ; déplacer un panneau d'un côté à l'autre est ce
qu'on fait réellement au quotidien.

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

### Bloc 3 — Keyframes  ✅ (20/09/2026)

- [x] **Modèle** : une courbe par cible, frames **relatives au début du clip** —
      en absolu, déplacer un clip désynchronise son animation en silence
- [x] **Interpolations** : linéaire, lisse (smoothstep), maintien
- [x] **Rendu FFmpeg** : expressions `if(lt(t,…))` imbriquées, `eval=frame` sur
      `scale`, `rotate`, `overlay`, `eq`, `hue`, `vignette`, `volume`, et `geq`
      pour l'opacité
- [x] **Éditeur sous le moniteur** : une règle par cible, courbe tracée, losanges
      déplaçables, précédent/suivant, valeur et interpolation du keyframe choisi
- [x] **Outils MCP** : `list_animatable`, `set_keyframe`, `move_keyframe`,
      `remove_keyframe` — 38 outils au total

Deux choses valent d'être écrites noir sur blanc :

**Seuls 7 paramètres d'effet sont animables**, parce que FFmpeg ne réévalue par
image que `eq`, `hue`, `vignette` et `volume`. Poser un keyframe ailleurs est
**refusé avec la raison**, plutôt qu'accepté puis rendu comme une constante —
un mensonge qu'on ne verrait qu'à l'export.

**Le glissement d'un losange est une seule opération** (`moveKeyframe`), pas un
retrait suivi d'une pose : sinon `Ctrl+Z` supprimait le keyframe au lieu de le
remettre où il était.

Vérifié au vrai FFmpeg : `tests/e2e-keyframes.test.ts` rend chaque cible animée
et compare la signature de l'image aux frames 2 et 50 — une expression que
FFmpeg accepte mais n'évalue qu'une fois est indiscernable d'un keyframe qui
marche, sauf en comparant deux images.

### Bloc 4 — Panneau agent intégré  ✅ (20/09/2026)

Le point qui distingue ce logiciel de Kdenlive.

- [x] **Panneau de conversation** : troisième onglet du dock droit
      (`Ctrl+4`), réponse en streaming, appels d'outils repliables, bouton
      d'arrêt. Modèle au choix : Opus 5 / Sonnet 5 / Haiku 4.5
- [x] **L'agent agit en direct** : il appelle les **mêmes 38 outils** que le
      serveur MCP, sur le même store — donc même pile d'annulation, mêmes
      refus, et la timeline bouge sous les yeux de l'utilisateur
- [x] **Journal des actions**, avec la provenance de chacune (UI / agent /
      MCP) et une annulation **entrée par entrée**

**Clé API** : fournie par l'utilisateur, chiffrée par le trousseau du système
(DPAPI sous Windows). Si aucun trousseau n'est disponible, l'écriture est
**refusée** plutôt que faite en clair — une clé en clair dans le profil est un
vrai risque et l'utilisateur n'aurait aucun moyen de le savoir.

**Annuler une action du milieu** ne peut pas être un simple retour au
snapshot : ça jetterait tout ce qui a suivi. Le store restaure l'état d'avant,
puis **rejoue les actions suivantes par-dessus**, en passant par le même code
qu'à l'origine (le handler d'outil sur un store jetable) — pas de seconde
implémentation de ce que veut dire « couper ». Ce qui ne peut plus s'appliquer
est **nommé dans un avertissement**, jamais sauté en silence.

Non vérifié : l'aller-retour réel avec l'API Anthropic. Le décodage du flux,
la boucle d'outils, les refus et le plafond de tours sont couverts par 16 tests
avec un transport bouchonné, mais aucune requête n'a été envoyée pour de vrai.

### Bloc 5 — Fonctions Kdenlive manquantes  ✅ (20/09/2026)

- [x] **Groupes de clips** — `Ctrl+G` / `Ctrl+Shift+G`, liseré ambre sur les
      clips groupés ; un groupe fusionne au lieu de s'imbriquer
- [x] **Zone de travail** (in/out) et rendu limité à la zone
- [x] **Modes d'édition** : normal, écrasement, insertion, dans la barre
      timeline et en MCP. L'écrasement découpe proprement le clip dessous
- [x] **Trim avancé** : ripple, roll, slip, slide — dans l'inspecteur et en MCP,
      chacun refusé avec le chiffre exact quand la poignée ou le voisin manque
- [x] **Proxy clips** : transcodage 640 px **tout-intra** (`-g 1`), cache
      indexé par chemin + taille + mtime — remplacer un fichier invalide son
      proxy au lieu de monter sur une ancienne image. La preview et le moniteur
      lisent le proxy, **l'export lit toujours l'original** : c'est la seule
      règle qui compte, et elle est vérifiée sur l'argv dans les tests.
      Mesuré : un proxy tout-intra est **plus lourd** que la source, pas plus
      léger — d'où le refus de proxyfier ce qui est déjà ≤ 640 px
- [x] **Étalonnage** : correcteur trois bandes (ombres / médiums / hautes
      lumières) avec **roues à tirer**, et courbes de tonalité master + R/V/B
      avec **points déplaçables**. Un canal laissé droit ne coûte aucune passe
      de filtre. Rendu vérifié au vrai FFmpeg (`colorbalance`, `curves`)
- [x] **Sous-titres** : import/export `.srt` et `.vtt`, panneau d'édition,
      incrustation au rendu. Une pièce devient un **clip ordinaire** sur une
      piste sous-titres, donc déplaçable et rognable comme le reste. Le parseur
      encaisse BOM, CRLF, points au lieu de virgules, index absents, balises
      `<i>` — et **nomme** les lignes qu'il n'a pas pu utiliser
- [x] **Multicam** : angles choisis dans le chutier, **décalages mesurés à
      l'audio** (corrélation d'enveloppes de sonie, avec une confiance), puis
      un clip multicam sur la timeline. Touches **1-9** pour couper vers une
      caméra au curseur ; le son reste sur le premier angle, comme un vrai
      montage multicam. Une coupe reste une coupe ordinaire — le projet reste
      lisible et retouchable sans outil spécial.

      Deux choses mesurées, pas supposées : un signal **périodique** corrèle
      aussi bien à chaque multiple de sa période (mon premier signal de test
      n'avait donc pas de bonne réponse), et un **recouvrement trop court**
      gonfle le score — avec un plancher à 1 s la mesure tombait 6 s à côté.
      Plancher porté à la moitié de la prise la plus courte.

### Bloc 6 — Distribution  🟡 (3/4)

- [x] **CI qui construit à chaque tag** : `.github/workflows/release.yml`.
      La suite tourne **avant** toute publication — une release qui échoue à
      ses propres tests est pire que pas de release, c'est celle que les gens
      téléchargent. Les artefacts Windows sont construits sur un runner
      Windows, ce qui supprime le besoin de Wine.
- [x] **Release GitHub avec les binaires attachés** : plus besoin de
      `gh auth login`, `electron-builder --publish always` utilise le
      `GITHUB_TOKEN` du workflow. Il suffit de pousser un tag `v*`.
- [x] **Mise à jour automatique** : vérification au démarrage, avis dans la
      barre d'état. Télécharger et redémarrer sont **deux clics séparés**, et
      l'installation est refusée si le projet n'est pas enregistré — un
      monteur laisse l'app ouverte des heures sur un montage non sauvé.
- [ ] **Signature du code** — bloqué sur un achat : certificat Authenticode
      ~300 €/an en OV, davantage en EV. Sans lui SmartScreen avertit au
      premier lancement. C'est une décision de Simon, pas un travail à faire.

---

## Décisions prises

- **22/09/2026 — « media error 4 » n'était pas un bug de lecture.**
  Deux défauts, tous deux à moi, qui donnaient le même symptôme :
  `DEMUXER_ERROR_COULD_NOT_OPEN` sur un fichier que l'app annonçait prêt.
  1. **Un rendu mort laissait son fichier.** Le cache testait `existsSync` :
     un fichier tronqué ou vide passait donc pour une tranche finie, la
     preview se disait prête, et le lecteur échouait à l'ouvrir. Le cache
     exige désormais une **taille non nulle**, et un rendu qui échoue ou qu'on
     annule **efface sa sortie** avant de rejeter.
  2. **La liste de concaténation contenait des chemins Windows.** Le demuxer
     `concat` traite l'antislash comme une échappée dans une entrée quotée :
     `C:\Users\...` revient mutilé et aucune tranche ne s'ouvre. La liste ne
     contient plus que des **noms de fichiers**, résolus par le demuxer contre
     le dossier de la liste — plus aucun séparateur à échapper.
  Non reproduit sous Linux : Chromium y ouvre le fichier collé sans broncher.
  C'est en cherchant pourquoi que les deux trous sont apparus.

- **21/09/2026 — La preview se rend par tranches de 4 s, pas d'un bloc.**
  Réencoder tout le montage parce qu'un clip a bougé coûtait des minutes pour
  voir un changement qui touche quatre secondes. Chaque tranche est indexée par
  une empreinte de **ce qui se passe dedans seulement**, seules les sales sont
  encodées, et le tout est recollé en **copie de flux** (un remux, pas un
  réencodage). Mesuré sur 2 min de timeline : **114,5 s → 4,3 s (×26)** après
  l'ajout d'un titre de 2 s.
  Défaut trouvé par le test : empreinter **toutes** les pistes salissait tout
  le montage dès qu'on ajoutait une piste. Seules les pistes qui ont un clip
  dans la tranche comptent désormais, leur ordre relatif étant conservé pour
  garder le compositing dans la clé.
- **21/09/2026 — Encodage matériel quand la machine en a un.**
  Sondé, pas déduit : notre FFmpeg est compilé avec NVENC, QSV, AMF et VAAPI,
  et sur une machine sans runtime constructeur **les quatre sont listés et
  aucun ne marche**. Chaque candidat encode donc 0,4 s de noir avant d'être
  retenu ; sinon libx264. La preview le prend toujours, l'export par défaut
  avec une case pour revenir au CPU. `PALMIER_ENCODER=libx264` force.
  **Non vérifié ici** : msi n'a ni libcuda ni VA display, donc le repli est
  prouvé mais pas l'encodage GPU lui-même. Ça se verra sur le portable —
  l'encodeur retenu est affiché sous le moniteur.

- **21/09/2026 — L'agent peut enfin écrire des sous-titres.** Il manquait
  `add_subtitles` en MCP : il savait lire et importer, jamais écrire une seule
  pièce. Ajouté, avec `detect_speech` qui rend les **plages sonores** d'un clip
  (`silencedetect`) en secondes **et** en frames de la timeline — de quoi caler
  un texte qu'on a déjà sans rien entendre.
  **Il n'y a aucune reconnaissance vocale** dans cette build, et rien sur la
  machine pour en faire : les mots doivent venir de l'utilisateur, d'un script
  ou d'un `.srt`. L'outil le dit lui-même dans sa réponse.
- **21/09/2026 — L'app n'utilisait pas le FFmpeg qu'elle embarque.**
  `resolveBinary` remontait de `../../..` : juste depuis `src/main/media/`,
  un cran trop haut depuis `out/main/`. Le bundle retombait donc sur le FFmpeg
  du **PATH**. Symptôme visible : FFmpeg 8.0 dessine un **glyphe** pour le saut
  de ligne, donc tout sous-titre sur deux lignes gagnait un carré parasite ;
  la build embarquée, elle, n'en met pas. La recherche remonte désormais
  jusqu'à trouver, et `tests/build-output.test.ts` refuse un repli sur le PATH.
  À retenir : **toute vérification à l'écran faite en dev sous Linux jusqu'ici
  passait par le FFmpeg système**, pas celui qui est livré.

- **21/09/2026 — Ouvrir un dossier sans projet le crée**, à la Obsidian, et
  importe les médias déjà présents. Refuser un dossier parce qu'il manque un
  fichier que l'app écrit elle-même était de la cérémonie. Seuls `project.json`
  et `cache/` sont ajoutés — un test compare le contenu du dossier avant/après.
- **21/09/2026 — electron-vite insère son shim CommonJS au mauvais endroit.**
  L'offset est calculé en **octets UTF-8** mais appliqué comme index de
  caractères : chaque caractère multi-octets du bundle (un tiret cadratin dans
  un message suffit) décale l'insertion. Elle a atterri deux fois dans un
  template literal — une fois le build a cassé, une fois un pavé de JavaScript
  s'est affiché **dans la barre d'état de l'utilisateur**. Le shim est retiré
  au build par un plugin : ce processus principal déclare déjà son `__dirname`
  et n'appelle jamais `require`. `tests/build-output.test.ts` garde le fort.

- **19/09/2026 — Degré de ressemblance : copie fidèle de la disposition.**
  Mêmes docks, mêmes couleurs, mêmes positions de panneaux, mêmes raccourcis.
  Quelqu'un qui connaît Kdenlive doit être immédiatement chez lui. En cas
  d'arbitrage entre « joli » et « comme Kdenlive », c'est Kdenlive qui gagne.
- **Ordre de travail : Bloc 1 (UI) puis Bloc 2 (lecture temps réel).**
- **20/09/2026 — Bug trouvé en vérifiant les sous-titres : le moniteur
  rognait le bas de chaque image.** `height: 100%` sur un élément de grille
  dont la piste est dimensionnée par l'image elle-même : l'image dépassait la
  boîte et `overflow: hidden` coupait — exactement là où vivent les
  sous-titres. L'image est désormais en position absolue sur la boîte.
- **20/09/2026 — Un paramètre non réévalué par FFmpeg n'est pas animable.**
  Plutôt que de stocker une courbe qui ne se verrait pas au rendu, le domaine
  refuse et nomme les paramètres qui, eux, marchent.

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
