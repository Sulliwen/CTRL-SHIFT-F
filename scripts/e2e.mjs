// Test de bout en bout : charge l'extension dans Chrome headless, ouvre la
// recherche sur une page locale, vérifie le classement sémantique et le
// surlignage effectivement peint. Nécessite `pnpm build:e2e` (fait par `pnpm e2e`).
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const root = process.cwd();
const ext = path.join(root, 'dist-e2e');
const chromePath = process.env.CHROME ?? '/usr/bin/google-chrome';
const HOST = 'ctrl-shift-f-host';

const server = http.createServer(async (req, res) => {
  const file = path.join(root, 'test/fixtures', req.url === '/' ? 'page.html' : req.url);
  try {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = process.env.E2E_PROFILE ?? mkdtempSync(path.join(os.tmpdir(), 'ctrl-shift-f-e2e-'));
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  // Profil neuf par défaut : Chrome ne recharge pas le service worker d'une extension non
  // empaquetée dans un profil existant. E2E_PROFILE=chemin pour en réutiliser un (modèle en cache).
  userDataDir: profile,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-sandbox', '--window-size=1200,900'],
  defaultViewport: { width: 1200, height: 900 },
});

const failures = [];
const check = (cond, label) => {
  console.log(`${cond ? 'OK ' : 'KO '} ${label}`);
  if (!cond) failures.push(label);
};

// Décodeur PNG minimal (RGBA ou RGB 8 bits, non entrelacé) pour inspecter les pixels.
function decodePng(buf) {
  let pos = 8;
  const idat = [];
  let w = 0, h = 0, colorType = 6;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = line[x * bpp]; out[(y * w + x) * 4 + 1] = line[x * bpp + 1];
      out[(y * w + x) * 4 + 2] = line[x * bpp + 2]; out[(y * w + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { w, h, data: out };
}

try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() !== 'debug' || process.env.VERBOSE) console.log('[page]', m.text()); });
  await page.goto(url, { waitUntil: 'load' });

  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 20000 });
  // Évaluation dans le service worker via CDP brut (WebWorker.evaluate de puppeteer reste bloqué ici).
  const session = await swTarget.createCDPSession();
  session.on('Runtime.consoleAPICalled', (e) => console.log('[sw]', e.type, e.args.map((a) => a.value ?? a.description).join(' ')));
  session.on('Runtime.exceptionThrown', (e) => console.log('[sw] exception', e.exceptionDetails.exception?.description ?? e.exceptionDetails.text));
  await session.send('Runtime.enable');
  const sw = {
    evaluate: async (fn, ...args) => {
      const r = await session.send('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
  };
  // Le service worker vient de démarrer : on attend que ses API et notre point d'entrée existent.
  for (let i = 0; i < 40; i++) {
    const ok = await sw.evaluate(() => typeof chrome?.tabs?.query === 'function' && typeof self.__cmfToggle === 'function').catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const toggle = () => sw.evaluate(async (u) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u));
    await self.__cmfToggle(tab.id);
  }, url);
  await toggle();

  const inShadow = (sel) => `document.getElementById('${HOST}')?.shadowRoot?.querySelector('${sel}')`;
  await page.waitForFunction(`${inShadow('input')}`, { timeout: 10000 });
  check(true, 'barre de recherche injectée');

  const state = () => page.evaluate(`${inShadow('.panel')}?.dataset.state`);
  const status = () => page.evaluate(`${inShadow('.status')}?.textContent`);
  const t0 = Date.now();
  let lastStatus = '';
  const interval = setInterval(async () => { const s = await status().catch(() => ''); if (s && s !== lastStatus) { lastStatus = s; console.log('   statut :', s); } }, 1000);
  await page.waitForFunction(`['ready','error'].includes(${inShadow('.panel')}?.dataset.state)`, { timeout: 900000, polling: 500 })
    .catch(() => {});
  clearInterval(interval);
  const finalState = await state();
  console.log(`   état final : ${finalState} après ${((Date.now() - t0) / 1000).toFixed(1)} s · ${await status()}`);
  check(finalState === 'ready', 'indexation terminée');

  const type = (q) => page.evaluate((host, q) => {
    const input = document.getElementById(host).shadowRoot.querySelector('input');
    input.value = q;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, HOST, q);
  const waitSemantic = () => page.waitForFunction(`${inShadow('.panel')}?.dataset.semantic === 'ready'`, { timeout: 60000 });
  const snippets = async () => {
    const rows = await page.evaluate((host) => [...document.getElementById(host).shadowRoot.querySelectorAll('li')].map((li) => ({ text: li.querySelector('.snippet').textContent, ...li.dataset })), HOST);
    if (process.env.VERBOSE) for (const r of rows) console.log(`      ${r.score} sem=${r.semantic ?? '-'} ovl=${r.overlap} ${r.text.slice(0, 70)}`);
    return rows.map((r) => r.text);
  };
  const badges = () => page.evaluate((host) => [...document.getElementById(host).shadowRoot.querySelectorAll('li')].map((li) => !!li.querySelector('.badge')), HOST);

  // 1. Requête purement sémantique : aucun mot commun avec la phrase attendue.
  await type('animal domestique qui fait la sieste');
  await waitSemantic();
  let list = await snippets();
  console.log('   top 3 :', list.slice(0, 3));
  check(list[0]?.includes('chat ronronne'), 'sémantique : le passage sur le chat arrive en tête');
  check(!list.some((s) => s.includes('caché')), 'le paragraphe display:none est ignoré');

  // 2. Requête sémantique vers un autre sujet.
  await type('prévisions climatiques');
  await waitSemantic();
  list = await snippets();
  console.log('   top 3 :', list.slice(0, 3));
  check(list[0]?.includes('météo'), 'sémantique : le passage météo arrive en tête');

  // 3. Correspondance exacte, insensible aux accents, devant le sémantique.
  await type('canape');
  await waitSemantic();
  list = await snippets();
  const b = await badges();
  check(list[0]?.includes('canapé') && b[0] === true, 'exact : « canape » trouve « canapé » avec le badge');

  // 4. Le surlignage est bien peint sur la page (API CSS Custom Highlight à travers le monde isolé).
  const rect = await page.evaluate(() => { const r = document.getElementById('cat').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const png = decodePng(await page.screenshot({ type: 'png' }));
  let orange = 0;
  for (let y = Math.max(0, rect.y | 0); y < Math.min(png.h, (rect.y + rect.h) | 0); y++) {
    for (let x = Math.max(0, rect.x | 0); x < Math.min(png.w, (rect.x + rect.w) | 0); x++) {
      const i = (y * png.w + x) * 4;
      const [r, g, bl] = [png.data[i], png.data[i + 1], png.data[i + 2]];
      if (r > 220 && g > 110 && g < 170 && bl < 80) orange++;
    }
  }
  console.log(`   pixels orange dans le paragraphe : ${orange}`);
  check(orange > 200, 'surlignage du résultat courant visible à l’écran');

  // 5. Navigation clavier.
  await page.evaluate((host) => document.getElementById(host).shadowRoot.querySelector('input').focus(), HOST);
  await page.keyboard.press('Enter');
  const count = await page.evaluate(`${inShadow('.count')}.textContent`);
  check(count.startsWith('2/'), `Entrée passe au résultat suivant (${count})`);
  await page.keyboard.press('Escape');
  const hidden = await page.evaluate(`${inShadow('.panel')}.hidden`);
  check(hidden === true, 'Échap ferme la barre');

  if (process.env.SCREENSHOT) {
    await toggle();
    await type('animal domestique qui fait la sieste');
    await waitSemantic();
    await page.screenshot({ path: process.env.SCREENSHOT });
    console.log('   capture :', process.env.SCREENSHOT);
  }
} catch (err) {
  console.error(err);
  failures.push(String(err));
} finally {
  await browser.close();
  server.close();
  if (!process.env.E2E_PROFILE) rmSync(profile, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} échec(s)` : '\nTout est vert.');
process.exit(failures.length ? 1 : 0);
