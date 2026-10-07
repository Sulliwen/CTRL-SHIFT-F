import { pipeline, env } from '@huggingface/transformers';
// Compare la qualité de classement de plusieurs modèles d'embeddings sur un petit jeu
// de phrases françaises, dans Node (onnxruntime-node). Usage :
//   node scripts/bench-models.mjs "Xenova/multilingual-e5-small:q8,Xenova/paraphrase-multilingual-MiniLM-L12-v2:q8"
if (process.env.HF_CACHE) env.cacheDir = process.env.HF_CACHE;
const passages = [
  "Le matin, la lumière entre doucement par la fenêtre de la cuisine.",
  "Le café coule et l'odeur se répand dans toute la maison.",
  "Pendant ce temps, le chat ronronne, roulé en boule sur le canapé, et dort profondément jusqu'à midi.",
  "La météo annonce de la pluie pour toute la semaine, avec des températures en baisse et un vent soutenu venu de l'ouest.",
  "Pour le dîner, la recette est simple : des pâtes, de l'ail, un filet d'huile d'olive et beaucoup de parmesan râpé.",
  "Payer la facture d'électricité avant la fin du mois.",
  "Appeler le plombier pour la fuite sous l'évier.",
  "Acheter un cadeau d'anniversaire pour Léa.",
  "Le soir, on lit quelques pages d'un roman policier avant d'éteindre la lampe et de laisser la maison s'endormir à son tour.",
  "Dernière mise à jour : 2026 · Mentions légales",
  "AccueilArticlesContact",
  "Chroniques d'une maison ordinaire",
];
const queries = [
  ["animal domestique qui fait la sieste", 2],
  ["prévisions climatiques", 3],
  ["plat à cuisiner ce soir", 4],
  ["choses à faire / tâches ménagères", 5],
  ["lecture avant de dormir", 8],
  ["what does the cat do?", 2],
];
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const models = (process.argv[2] ?? 'Xenova/multilingual-e5-small:q8').split(',');
for (const spec of models) {
  const [id, dtype] = spec.split(':');
  const e5 = /e5/.test(id);
  try {
    const t0 = performance.now();
    const ext = await pipeline('feature-extraction', id, { dtype, device: 'cpu' });
    const tl = performance.now() - t0;
    const t1 = performance.now();
    const P = (await ext(passages.map(p => (e5 ? 'passage: ' : '') + p), { pooling: 'mean', normalize: true })).tolist();
    const te = (performance.now() - t1) / passages.length;
    let good = 0;
    const lines = [];
    for (const [q, expected] of queries) {
      const [Q] = (await ext([(e5 ? 'query: ' : '') + q], { pooling: 'mean', normalize: true })).tolist();
      const scored = P.map((v, i) => [dot(Q, v), i]).sort((a, b) => b[0] - a[0]);
      const rankOfExpected = scored.findIndex(([, i]) => i === expected) + 1;
      if (rankOfExpected === 1) good++;
      lines.push(`   ${rankOfExpected === 1 ? 'OK' : 'KO'} rang ${rankOfExpected} · top=${scored[0][0].toFixed(3)} attendu=${scored.find(([, i]) => i === expected)[0].toFixed(3)} écart min/max=${scored.at(-1)[0].toFixed(3)}/${scored[0][0].toFixed(3)} · ${q}`);
    }
    console.log(`\n${spec}  → ${good}/${queries.length} · chargement ${Math.round(tl)} ms · ${te.toFixed(0)} ms/passage (Node, CPU)`);
    console.log(lines.join('\n'));
  } catch (e) {
    console.log(`\n${spec}  → ERREUR ${e.message.split('\n')[0]}`);
  }
}
