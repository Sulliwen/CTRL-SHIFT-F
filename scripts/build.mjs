// Construit l'extension dans dist/ (ou dist-e2e/ avec --e2e, qui ajoute les
// permissions d'hôte nécessaires au test automatisé sur localhost).
import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const watch = process.argv.includes('--watch');
const e2e = process.argv.includes('--e2e');
const outdir = e2e ? 'dist-e2e' : 'dist';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// Les binaires WASM d'onnxruntime doivent être à côté de background.js :
// la glue embarquée dans le bundle les résout relativement à l'URL du script.
// (les deux paquets n'exposent pas leur package.json : on résout leur point d'entrée.)
const transformersDir = path.resolve(path.dirname(require.resolve('@huggingface/transformers')), '..');
const ortDist = path.dirname(require.resolve('onnxruntime-web', { paths: [transformersDir, process.cwd()] }));
// Seule la variante « asyncify » est utilisée : par la glue embarquée dans le bundle
// (service worker) et par wasmPaths (page d'événements Firefox).
for (const f of ['ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.mjs']) {
  await cp(path.join(ortDist, f), path.join(outdir, f));
}

const manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
if (e2e) manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
await writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2));
await cp('src/content/highlight.css', path.join(outdir, 'highlight.css'));
await cp('icons', path.join(outdir, 'icons'), { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'browser',
  target: ['chrome120', 'firefox128'],
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};
const configs = [
  { ...common, entryPoints: ['src/background.ts'], outfile: `${outdir}/background.js`, format: 'esm' },
  { ...common, entryPoints: ['src/content/index.ts'], outfile: `${outdir}/content.js`, format: 'iife' },
];

if (watch) {
  for (const c of configs) (await context(c)).watch();
  console.log(`Surveillance active, sortie dans ${outdir}/`);
} else {
  await Promise.all(configs.map((c) => build(c)));
}
