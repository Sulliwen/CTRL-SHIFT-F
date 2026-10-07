import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentText } from '../src/content/extract.ts';

test('fusionne les phrases courtes et sépare les longues', () => {
  const raw = 'Bonjour. Comment allez-vous ? Je vais bien, merci beaucoup de demander. Voici une autre phrase assez longue pour rester seule.';
  const pieces = segmentText(raw, 'fr');
  assert.deepEqual(
    pieces.map((p) => p.text),
    ['Bonjour. Comment allez-vous ? Je vais bien, merci beaucoup de demander.', 'Voici une autre phrase assez longue pour rester seule.'],
  );
  for (const p of pieces) assert.equal(raw.slice(p.start, p.end).replace(/\s+/g, ' ').trim(), p.text);
});

test('un saut de ligne (<br>) coupe la phrase', () => {
  const pieces = segmentText('Première ligne sans ponctuation finale mais longue\nDeuxième ligne également assez longue pour tenir', 'fr');
  assert.equal(pieces.length, 2);
});

test('découpe les passages trop longs sur des espaces', () => {
  const raw = Array.from({ length: 200 }, (_, i) => `mot${i}`).join(' ');
  const pieces = segmentText(raw, 'fr', { maxChars: 120 });
  assert.ok(pieces.length > 5);
  for (const p of pieces) {
    assert.ok(p.text.length <= 120, `trop long : ${p.text.length}`);
    assert.equal(raw.slice(p.start, p.end), p.text);
    assert.ok(!/^\s|\s$/.test(raw.slice(p.start, p.end)));
  }
  assert.equal(pieces.map((p) => p.text).join(' '), raw);
});

test('ignore les fragments vides ou trop courts', () => {
  assert.deepEqual(segmentText('   \n  ', 'fr'), []);
  assert.deepEqual(segmentText('ok', 'fr'), []);
});
