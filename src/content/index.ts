// Script de contenu : orchestre extraction, indexation, recherche et affichage.
import type { BackgroundToContent, ContentToBackground, EmbedKind, EmbedResult } from '../shared/messages';
import { buildChunks, collectBlocks, type Chunk } from './extract';
import { Highlighter, OVERLAY_ID } from './highlight';
import { centerVectors, indexPassage, rank, type IndexedPassage, type Scored } from './search';
import { HOST_ID, Panel } from './ui';

const BATCH_SIZE = 16;
const RESULT_LIMIT = 20;
const QUERY_DEBOUNCE_MS = 200;

declare global {
  interface Window {
    __ctrlShiftF?: Controller;
  }
}

function sendToBackground(msg: ContentToBackground): Promise<EmbedResult> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res?: EmbedResult) => {
        const err = chrome.runtime.lastError;
        if (err || !res) resolve({ ok: false, error: err?.message ?? 'Pas de réponse du modèle' });
        else resolve(res);
      });
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

class Controller {
  private readonly panel: Panel;
  private readonly highlighter = new Highlighter();

  private chunks: Chunk[] = [];
  private passages: IndexedPassage[] = [];
  private vectors: Array<number[] | undefined> = [];
  private readonly cache = new Map<string, number[]>();
  private dirty = true;
  private indexing: Promise<void> | null = null;
  private generation = 0;
  private indexed = 0;
  private ready = false;

  private query = '';
  private queryVec: number[] | null = null;
  private queryVecFor = '';
  private queryTimer: ReturnType<typeof setTimeout> | null = null;

  private results: Scored[] = [];
  private exactTotal = 0;
  private current = -1;

  constructor() {
    this.panel = new Panel({
      onQuery: (q) => this.setQuery(q),
      onNext: () => this.move(1),
      onPrev: () => this.move(-1),
      onClose: () => this.close(),
      onSelect: (i) => this.select(i),
    });

    const ours = (n: Node) =>
      n === this.panel.host || (n instanceof Element && (n.id === HOST_ID || n.id === OVERLAY_ID));
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList') {
          const nodes = [...m.addedNodes, ...m.removedNodes];
          if (nodes.length && nodes.every(ours)) continue;
        }
        this.dirty = true;
        break;
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

    chrome.runtime.onMessage.addListener((msg: BackgroundToContent) => {
      if (msg.type === 'toggle') this.toggle();
      else if (msg.type === 'model-progress') this.onModelProgress(msg.progress, msg.status);
    });
  }

  toggle(): void {
    if (!this.panel.visible) this.open();
    else if (this.panel.isFocused()) this.close();
    else this.panel.focus();
  }

  open(): void {
    this.panel.show();
    this.panel.focus();
    void this.ensureIndex();
    if (this.query) this.refresh(true);
  }

  close(): void {
    this.panel.hide();
    this.highlighter.clear();
  }

  private ensureIndex(): Promise<void> {
    if (this.indexing) return this.indexing;
    if (!this.dirty) return Promise.resolve();
    this.indexing = this.buildIndex().finally(() => {
      this.indexing = null;
    });
    return this.indexing;
  }

  private async buildIndex(): Promise<void> {
    const gen = ++this.generation;
    this.dirty = false;
    this.ready = false;
    this.panel.setState('indexing');
    this.panel.setStatus('Analyse de la page…');
    await nextFrame();

    const t0 = performance.now();
    const blocks = collectBlocks(document, (el) => el.id === HOST_ID || el.id === OVERLAY_ID);
    const chunks = buildChunks(blocks, document.documentElement.lang || undefined);
    this.chunks = chunks;
    this.passages = chunks.map((c) => indexPassage(c.text));
    this.vectors = chunks.map((c) => this.cache.get(c.text));
    this.indexed = this.vectors.filter(Boolean).length;
    this.refresh(false);

    // Passages à vectoriser, triés par longueur pour limiter le padding des lots.
    const pending = chunks.map((_, i) => i).filter((i) => !this.vectors[i]);
    pending.sort((a, b) => chunks[a].text.length - chunks[b].text.length);
    const total = chunks.length;
    this.panel.setStatus(`Indexation ${this.indexed}/${total} passages…`, total ? this.indexed / total : 1);

    for (let off = 0; off < pending.length; off += BATCH_SIZE) {
      const idx = pending.slice(off, off + BATCH_SIZE);
      const res = await sendToBackground({ type: 'embed', kind: 'passage', texts: idx.map((i) => chunks[i].text) });
      if (gen !== this.generation) return;
      if (!res.ok) {
        this.panel.setState('error');
        this.panel.setStatus(`Modèle indisponible : ${res.error}`);
        return;
      }
      idx.forEach((i, k) => {
        this.vectors[i] = res.vectors[k];
        this.cache.set(chunks[i].text, res.vectors[k]);
      });
      this.indexed += idx.length;
      this.panel.setStatus(`Indexation ${this.indexed}/${total} passages…`, this.indexed / total);
      this.refresh(false);
    }

    console.debug(`[Ctrl+Shift+F] ${total} passages indexés en ${Math.round(performance.now() - t0)} ms`);
    this.ready = true;
    this.panel.setState('ready');
    this.updateReadyStatus();
  }

  private updateReadyStatus(): void {
    if (!this.ready) return;
    const parts = [`${this.chunks.length} passages`];
    if (this.query) parts.push(this.exactTotal ? `${this.exactTotal} correspondance${this.exactTotal > 1 ? 's' : ''} exacte${this.exactTotal > 1 ? 's' : ''}` : 'aucune correspondance exacte');
    this.panel.setStatus(parts.join(' · '));
  }

  private onModelProgress(progress: number, status: string): void {
    if (!this.indexing) return;
    if (status === 'progress' || status === 'download') {
      this.panel.setStatus(`Téléchargement du modèle (une seule fois)… ${Math.round(progress * 100)} %`, progress);
    }
  }

  private setQuery(q: string): void {
    this.query = q;
    this.panel.setSemanticReady(false);
    if (this.queryTimer) clearTimeout(this.queryTimer);
    if (!q.trim()) {
      this.results = [];
      this.exactTotal = 0;
      this.current = -1;
      this.render(false);
      this.updateReadyStatus();
      return;
    }
    this.refresh(true);
    this.queryTimer = setTimeout(() => void this.embedQuery(q), QUERY_DEBOUNCE_MS);
  }

  private async embedQuery(q: string): Promise<void> {
    const res = await sendToBackground({ type: 'embed', kind: 'query' as EmbedKind, texts: [q] });
    if (this.query !== q || !res.ok) return;
    this.queryVec = res.vectors[0];
    this.queryVecFor = q;
    this.refresh(true);
    this.panel.setSemanticReady(true);
  }

  /** Reclasse les passages ; `scroll` déclenche le défilement vers le résultat courant s'il change. */
  private refresh(scroll: boolean): void {
    if (!this.query.trim()) return;
    const rawQuery = this.queryVecFor === this.query ? this.queryVec : null;
    const { vectors, queryVec } = rawQuery
      ? centerVectors(this.vectors, rawQuery)
      : { vectors: this.vectors, queryVec: null };
    const previous = this.results[this.current]?.index;
    const { results, exactTotal } = rank(this.passages, this.query, queryVec, vectors, RESULT_LIMIT);
    this.results = results;
    this.exactTotal = exactTotal;
    let cur = results.findIndex((r) => r.index === previous);
    if (cur < 0) cur = results.length ? 0 : -1;
    const changed = cur !== this.current || results[cur]?.index !== previous;
    this.current = cur;
    this.render(scroll && changed);
    this.updateReadyStatus();
  }

  private render(scroll: boolean): void {
    const sems = this.results.map((r) => r.semantic).filter((s): s is number => s != null);
    const min = Math.min(...sems);
    const max = Math.max(...sems);
    this.panel.setResults(
      this.results.map((r) => ({
        text: this.chunks[r.index].text,
        exact: r.exact,
        score: r.score,
        semantic: r.semantic,
        overlap: r.overlap,
        bar: r.semantic == null ? null : max > min ? 0.15 + 0.85 * ((r.semantic - min) / (max - min)) : 1,
      })),
      this.current,
    );
    this.highlighter.setMatches(this.results.map((r) => this.chunks[r.index].range));
    const range = this.current >= 0 ? this.chunks[this.results[this.current].index].range : null;
    this.highlighter.setCurrent(range);
    if (scroll && range) this.highlighter.scrollTo(range);
  }

  private move(delta: number): void {
    if (!this.results.length) return;
    this.select((this.current + delta + this.results.length) % this.results.length);
  }

  private select(i: number): void {
    if (i < 0 || i >= this.results.length) return;
    this.current = i;
    this.panel.setCurrent(i);
    const range = this.chunks[this.results[i].index].range;
    this.highlighter.setCurrent(range);
    this.highlighter.scrollTo(range);
  }
}

if (!window.__ctrlShiftF) {
  window.__ctrlShiftF = new Controller();
}
