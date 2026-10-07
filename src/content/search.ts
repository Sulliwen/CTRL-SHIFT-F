// Classement des passages : correspondance exacte, recouvrement de mots et
// similarité sémantique (cosinus entre vecteurs normalisés). Fonctions pures.

export interface Scored {
  index: number;
  score: number;
  semantic: number | null;
  exact: boolean;
  overlap: number;
}

export interface Ranking {
  results: Scored[];
  /** Nombre total de passages contenant la requête telle quelle. */
  exactTotal: number;
}

/** Minuscules, sans accents, espaces compactés. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Mots vides fréquents (français, anglais) ignorés dans le recouvrement de mots. */
const STOPWORDS = new Set(
  (
    'le la les un une des du de d l au aux et ou mais donc or ni car que qui quoi dont ou ce cet cette ces ' +
    'il elle ils elles on nous vous je tu me te se mon ma mes ton ta tes son sa ses leur leurs notre votre nos vos ' +
    'ne pas plus moins tres tout tous toute toutes dans sur sous avec sans pour par en y a est sont ete etre avoir ' +
    'fait faire fais comme quand si aussi puis cela ca ceci ici la ' +
    'the a an and or but of to in on at for with by from as is are was were be been being this that these those ' +
    'it its he she they we you i my your his her their our not no do does did have has had will would can could should'
  ).split(' '),
);

export function tokenize(norm: string): string[] {
  return norm.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
}

/** Mots porteurs de sens : au moins trois caractères et hors mots vides. */
export function contentTokens(norm: string): string[] {
  return tokenize(norm).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Un mot de la requête « couvre » un mot du passage s'ils sont égaux ou si l'un prolonge l'autre (≥ 5 caractères communs). */
export function tokenMatches(queryToken: string, passageToken: string): boolean {
  if (queryToken === passageToken) return true;
  const shorter = Math.min(queryToken.length, passageToken.length);
  return shorter >= 5 && (passageToken.startsWith(queryToken) || queryToken.startsWith(passageToken));
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export const WEIGHTS = { exact: 1, overlap: 0.3 } as const;

/** En dessous de ce nombre de vecteurs, le centrage est trop instable : on garde les vecteurs bruts. */
export const CENTER_MIN = 8;

function normalizeVec(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/**
 * Soustrait le vecteur moyen de la page puis renormalise. Les modèles e5 placent
 * tous les textes dans un cône étroit (cosinus 0,75-0,9) : retirer la composante
 * commune écarte les passages passe-partout et agrandit les écarts de score.
 */
export function centerVectors(
  vectors: ReadonlyArray<ArrayLike<number> | undefined>,
  queryVec: ArrayLike<number>,
): { vectors: Array<number[] | undefined>; queryVec: number[] } {
  const present = vectors.filter((v): v is ArrayLike<number> => v != null);
  if (present.length < CENTER_MIN) {
    return { vectors: vectors.map((v) => (v ? Array.from(v) : undefined)), queryVec: Array.from(queryVec) };
  }
  const dims = present[0].length;
  const centroid = new Array<number>(dims).fill(0);
  for (const v of present) for (let j = 0; j < dims; j++) centroid[j] += v[j];
  for (let j = 0; j < dims; j++) centroid[j] /= present.length;
  const center = (v: ArrayLike<number>) => {
    const out = new Array<number>(dims);
    for (let j = 0; j < dims; j++) out[j] = v[j] - centroid[j];
    return normalizeVec(out);
  };
  return { vectors: vectors.map((v) => (v ? center(v) : undefined)), queryVec: center(queryVec) };
}

export interface IndexedPassage {
  /** Texte normalisé. */
  norm: string;
  /** Mots porteurs de sens du passage. */
  tokens: string[];
}

export function indexPassage(text: string): IndexedPassage {
  const norm = normalizeText(text);
  return { norm, tokens: contentTokens(norm) };
}

/**
 * @param passages  Passages indexés (texte normalisé et mots).
 * @param query     Requête brute.
 * @param queryVec  Vecteur de la requête, ou null si pas encore disponible.
 * @param vectors   Vecteur de chaque passage (undefined si pas encore indexé).
 */
export function rank(
  passages: readonly IndexedPassage[],
  query: string,
  queryVec: ArrayLike<number> | null,
  vectors: ReadonlyArray<ArrayLike<number> | undefined>,
  limit = 20,
): Ranking {
  const qn = normalizeText(query);
  if (!qn) return { results: [], exactTotal: 0 };
  const qt = contentTokens(qn);
  const results: Scored[] = [];
  let exactTotal = 0;
  for (let i = 0; i < passages.length; i++) {
    const { norm: n, tokens } = passages[i];
    const exact = n.includes(qn);
    if (exact) exactTotal++;
    let hits = 0;
    for (const t of qt) if (tokens.some((pt) => tokenMatches(t, pt))) hits++;
    const overlap = qt.length ? hits / qt.length : 0;
    const v = vectors[i];
    const semantic = queryVec && v ? dot(queryVec, v) : null;
    const score = (exact ? WEIGHTS.exact : 0) + WEIGHTS.overlap * overlap + (semantic ?? 0);
    if (score <= 0) continue;
    results.push({ index: i, score, semantic, exact, overlap });
  }
  results.sort((a, b) => b.score - a.score || a.index - b.index);
  return { results: results.slice(0, limit), exactTotal };
}
