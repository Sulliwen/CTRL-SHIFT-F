import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CENTER_MIN, centerVectors, contentTokens, dot, indexPassage, normalizeText, rank, tokenMatches, tokenize } from '../src/content/search.ts';

test('normalise accents, casse et espaces', () => {
  assert.equal(normalizeText('  Élève   très  Ému '), 'eleve tres emu');
  assert.deepEqual(tokenize(normalizeText("L'été, c'est chaud !")), ['ete', 'est', 'chaud']);
});

test('les mots vides et les mots courts sont ignorés, les préfixes longs acceptés', () => {
  assert.deepEqual(contentTokens(normalizeText('animal domestique qui fait la sieste')), ['animal', 'domestique', 'sieste']);
  assert.ok(tokenMatches('previsions', 'prevision'));
  assert.ok(tokenMatches('chat', 'chat'));
  assert.ok(!tokenMatches('chat', 'chateau'));
  assert.ok(!tokenMatches('la', 'lampe'));
});

test('les correspondances exactes passent devant le sémantique', () => {
  const norms = ['le chat dort sur le canape', 'la meteo est pluvieuse', 'un canape rouge dans le salon'].map(indexPassage);
  const qv = [1, 0];
  const vectors = [[0.5, 0.5], [0.99, 0.1], [0.2, 0.9]];
  const { results, exactTotal } = rank(norms, 'canapé', qv, vectors);
  assert.equal(exactTotal, 2);
  assert.deepEqual(results.map((r) => r.index), [0, 2, 1]);
  assert.ok(results[0].exact && results[1].exact && !results[2].exact);
});

test('sans vecteur de requête, seuls les recouvrements lexicaux sortent', () => {
  const norms = ['le chat dort', 'la pluie tombe', 'chat noir'].map(indexPassage);
  const { results } = rank(norms, 'chat', null, [undefined, undefined, undefined]);
  assert.deepEqual(results.map((r) => r.index), [0, 2]);
});

test('le recouvrement de mots classe sans exiger la suite exacte', () => {
  const norms = ['pomme et poire', 'poire', 'pomme'].map(indexPassage);
  const { results, exactTotal } = rank(norms, 'pomme poire', null, []);
  assert.equal(exactTotal, 0);
  assert.equal(results.length, 3);
  assert.equal(results[0].index, 0);
  assert.ok(!results[0].exact && results[0].overlap === 1);
  assert.ok(results[1].overlap === 0.5 && results[2].overlap === 0.5);
});

test('requête vide : aucun résultat', () => {
  assert.deepEqual(rank([indexPassage('a')], '   ', null, []), { results: [], exactTotal: 0 });
});

test('le centrage retire la composante commune et renormalise', () => {
  // Tous les vecteurs partagent une forte composante sur l'axe 0 ; seul l'axe 1 ou 2 les distingue.
  const base = Array.from({ length: CENTER_MIN }, (_, i) => [0.9, i % 2 ? 0.3 : -0.3, i === 0 ? 0.3 : 0]);
  const query = [0.9, 0.3, 0];
  const raw = base.map((v) => dot(query, v));
  const { vectors, queryVec } = centerVectors(base, query);
  const centered = vectors.map((v) => dot(queryVec, v!));
  for (const v of vectors) assert.ok(Math.abs(Math.hypot(...v!) - 1) < 1e-9);
  // L'écart entre le meilleur et le pire est bien plus grand après centrage.
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  assert.ok(spread(centered) > 3 * spread(raw));
  // Les vecteurs « impairs » (même signe que la requête sur l'axe 1) restent devant.
  assert.ok(centered[1] > centered[0] && centered[1] > centered[2]);
});

test('le centrage est désactivé avec trop peu de vecteurs', () => {
  const vs = [[1, 0], undefined, [0, 1]];
  const { vectors, queryVec } = centerVectors(vs, [1, 0]);
  assert.deepEqual(vectors, [[1, 0], undefined, [0, 1]]);
  assert.deepEqual(queryVec, [1, 0]);
});
