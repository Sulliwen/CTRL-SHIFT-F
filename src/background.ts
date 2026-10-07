// Background : héberge le modèle d'embeddings et pilote l'ouverture de la
// recherche dans l'onglet actif. Service worker sous Chrome, page
// d'événements sous Firefox.
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import type { BackgroundToContent, ContentToBackground, EmbedResult, ModelInfo } from './shared/messages';

export const MODEL_ID = 'Xenova/multilingual-e5-small';
const PREFIX = { query: 'query: ', passage: 'passage: ' } as const;

// Service worker (Chrome) : pas de `document`. Page d'événements (Firefox) : il existe.
const isServiceWorker = typeof document === 'undefined';

env.allowLocalModels = false;
env.useBrowserCache = true;
if (env.backends.onnx.wasm) {
  // Un seul thread : pas de SharedArrayBuffer sans isolation cross-origin.
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  if (!isServiceWorker) {
    // Page d'événements (Firefox) : import() dynamique autorisé, on pointe
    // explicitement vers nos fichiers locaux plutôt que vers le CDN.
    env.backends.onnx.wasm.wasmPaths = {
      mjs: chrome.runtime.getURL('ort-wasm-simd-threaded.asyncify.mjs'),
      wasm: chrome.runtime.getURL('ort-wasm-simd-threaded.asyncify.wasm'),
    };
  }
  // Service worker : transformers.js laisse wasmPaths vide et onnxruntime
  // charge le .wasm à côté de background.js (copié par le build).
}

let loading: Promise<FeatureExtractionPipeline> | null = null;
let ready = false;
const watchers = new Set<number>();

function broadcast(msg: BackgroundToContent): void {
  for (const tabId of watchers) {
    chrome.tabs.sendMessage(tabId, msg).catch(() => watchers.delete(tabId));
  }
}

/** Empêche Chrome d'arrêter le service worker pendant un chargement long. */
function keepAlive(): () => void {
  const id = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
  return () => clearInterval(id);
}

interface ProgressEvent {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (loading) return loading;
  const files = new Map<string, { loaded: number; total: number }>();
  const stop = keepAlive();
  loading = pipeline('feature-extraction', MODEL_ID, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: (p: ProgressEvent) => {
      // Seuls les événements « progress » portent des tailles fiables ; les petits
      // fichiers déjà en cache passent directement à « done » et fausseraient le total.
      if (p.status === 'progress' && p.file && p.total) {
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
      } else if (p.status === 'done' && p.file && files.has(p.file)) {
        const f = files.get(p.file)!;
        f.loaded = f.total;
      } else if (p.status !== 'ready') {
        return;
      }
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      // Tant que le gros fichier du modèle n'a pas commencé, le total ne reflète que des fichiers minuscules.
      if (total < 5_000_000 && p.status !== 'ready') return;
      broadcast({ type: 'model-progress', progress: total ? loaded / total : 1, status: p.status });
    },
  })
    .then((p) => {
      ready = true;
      return p;
    })
    .catch((err: unknown) => {
      loading = null;
      throw err;
    })
    .finally(stop);
  return loading;
}

async function embed(kind: keyof typeof PREFIX, texts: string[]): Promise<EmbedResult> {
  const t0 = performance.now();
  if (texts.length === 0) return { ok: true, vectors: [], elapsedMs: 0 };
  const extractor = await getExtractor();
  const out = await extractor(
    texts.map((t) => PREFIX[kind] + t),
    { pooling: 'mean', normalize: true },
  );
  // Arrondi : la sérialisation JSON des messages pèse moins, sans effet mesurable sur le cosinus.
  const vectors = (out.tolist() as number[][]).map((v) => v.map((x) => Math.round(x * 1e4) / 1e4));
  return { ok: true, vectors, elapsedMs: performance.now() - t0 };
}

chrome.runtime.onMessage.addListener(
  (msg: ContentToBackground, sender, sendResponse: (r: EmbedResult | ModelInfo) => void) => {
    if (msg.type === 'embed') {
      if (sender.tab?.id != null) watchers.add(sender.tab.id);
      embed(msg.kind, msg.texts).then(sendResponse, (err: unknown) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      return true;
    }
    if (msg.type === 'model-info') {
      sendResponse({ modelId: MODEL_ID, ready });
    }
    return false;
  },
);

async function toggleInTab(tabId: number): Promise<void> {
  const msg: BackgroundToContent = { type: 'toggle' };
  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return;
  } catch {
    // Pas encore de script de contenu dans cet onglet : on l'injecte.
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['highlight.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    console.warn('Ctrl+Shift+F : impossible de s’exécuter dans cet onglet', err);
    void chrome.action.setBadgeText({ tabId, text: '!' });
    void chrome.action.setTitle({ tabId, title: 'Ctrl+Shift+F ne peut pas s’exécuter sur cette page' });
    setTimeout(() => void chrome.action.setBadgeText({ tabId, text: '' }), 3000);
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-search') return;
  void (async () => {
    const id = tab?.id ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
    if (id != null) await toggleInTab(id);
  })();
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null) void toggleInTab(tab.id);
});

// Points d'entrée pour le test de bout en bout (pas de raccourci clavier simulable).
Object.assign(globalThis, { __cmfToggle: toggleInTab, __cmfEmbed: embed });
