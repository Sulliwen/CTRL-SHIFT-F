# Ctrl+Shift+F — recherche sémantique dans la page

Extension de navigateur (Chrome, Firefox) qui ajoute un raccourci **Ctrl+Shift+F**
ouvrant une barre de recherche comparable à Ctrl+F, mais capable de comprendre
le sens de la requête. Taper « animal domestique qui fait la sieste » trouve la
phrase « le chat ronronne, roulé en boule sur le canapé ». La recherche
syntaxique classique reste incluse : une correspondance exacte passe toujours
en tête, insensible aux accents et à la casse.

Tout tourne en local. Aucun compte, aucune clé d'API, aucune donnée envoyée à
un serveur : le modèle d'embeddings est téléchargé une seule fois depuis
Hugging Face (environ 120 Mo), puis mis en cache dans le navigateur.

## Fonctionnement

1. **Extraction.** Le script de contenu parcourt le DOM visible et regroupe le
   texte par bloc de mise en page (paragraphe, cellule, élément de liste). Les
   éléments masqués, scripts et styles sont ignorés.
2. **Découpage.** Chaque bloc est segmenté en phrases avec `Intl.Segmenter`
   (multilingue). Les phrases courtes sont fusionnées avec la suivante, les
   très longues coupées sur des espaces. Chaque passage garde un `Range` DOM.
3. **Vectorisation.** Les passages sont envoyés par lots au background, qui
   fait tourner `Xenova/multilingual-e5-small` (quantifié int8) via
   [transformers.js](https://github.com/huggingface/transformers.js) et
   onnxruntime en WebAssembly. Les vecteurs sont mis en cache par texte, donc
   rouvrir la barre sur une page déjà vue est instantané.
4. **Classement.** Pour une requête, le score combine trois signaux :
   correspondance exacte (+1), recouvrement des mots porteurs de sens (+0,3 au
   prorata) et similarité cosinus. Les vecteurs sont préalablement centrés sur
   la moyenne de la page, ce qui écarte les textes passe-partout (menus, pieds
   de page) et agrandit les écarts de score.
5. **Affichage.** Les résultats sont listés par pertinence, surlignés dans la
   page via l'API CSS Custom Highlight, et navigables au clavier.

### Raccourcis

| Touche | Action |
| --- | --- |
| Ctrl+Shift+F (Cmd+Shift+F sur Mac) | Ouvrir, redonner le focus, ou fermer si déjà focalisé |
| Entrée / ↓ | Résultat suivant |
| Shift+Entrée / ↑ | Résultat précédent |
| Échap | Fermer |

Le raccourci se modifie dans `chrome://extensions/shortcuts` (Chrome) ou
« Gérer les raccourcis d'extensions » (Firefox).

## Installation pour le développement

```bash
pnpm install
pnpm build          # produit dist/
```

- **Chrome** : `chrome://extensions`, activer le mode développeur, « Charger
  l'extension non empaquetée », choisir `dist/`.
- **Firefox** : `about:debugging#/runtime/this-firefox`, « Charger un module
  temporaire », choisir `dist/manifest.json`.

`pnpm watch` reconstruit à chaque modification (recharger ensuite l'extension
dans le navigateur).

## Scripts

| Commande | Rôle |
| --- | --- |
| `pnpm build` | Build de production dans `dist/` |
| `pnpm typecheck` | Vérification TypeScript |
| `pnpm test` | Tests unitaires (segmentation, classement, centrage) |
| `pnpm e2e` | Test de bout en bout dans Chrome headless : injection, téléchargement du modèle, classement sémantique, surlignage peint à l'écran, navigation clavier. `CHROME=/chemin/chrome` pour un autre binaire, `VERBOSE=1` pour les scores, `SCREENSHOT=capture.png` pour une image |
| `pnpm bench "modèle:dtype,…"` | Compare la qualité de classement de modèles d'embeddings dans Node |
| `pnpm icons` | Régénère les icônes |

## Architecture

```
src/
  manifest.json        Manifest V3 (Chrome et Firefox)
  background.ts        Modèle d'embeddings, injection du script, raccourci
  content/
    index.ts           Contrôleur : indexation, requêtes, navigation
    extract.ts         Parcours du DOM, segmentation en passages avec Range
    search.ts          Normalisation, recouvrement lexical, cosinus, centrage
    highlight.ts       Surlignage (CSS Custom Highlight, repli par calque)
    ui.ts              Barre de recherche en Shadow DOM
  shared/messages.ts   Types des messages contenu ↔ background
scripts/
  build.mjs            esbuild + copie du manifeste, des icônes et du WASM
  e2e.mjs              Test de bout en bout (puppeteer-core + Chrome)
  bench-models.mjs     Banc d'essai de modèles
test/                  Tests unitaires et page de test
```

Le script de contenu n'est injecté qu'à la demande (permission `activeTab`),
jamais au chargement des pages.

## Limites connues

- Les iframes et le Shadow DOM des pages ne sont pas parcourus.
- Le surlignage couvre le passage entier, pas seulement le mot trouvé.
- Firefox antérieur à 140 ne gère pas `::highlight()` : seul le résultat
  courant est marqué, par un calque.
- Le modèle tourne sur un seul thread WebAssembly : compter environ 30 ms par
  passage, soit une dizaine de secondes pour un très long article. La recherche
  exacte fonctionne pendant l'indexation et les résultats sémantiques
  s'affinent au fur et à mesure.
- Les pages `chrome://`, le Web Store et les PDF natifs ne sont pas accessibles
  aux extensions.

## Pistes

- WebGPU (bien plus rapide) en option quand disponible.
- Surlignage du mot exact à l'intérieur du passage.
- Mode « question » avec un petit modèle génératif local pour répondre à partir
  des passages trouvés.
- Réglages : raccourci, modèle, nombre de résultats.

## Licence

MIT.
