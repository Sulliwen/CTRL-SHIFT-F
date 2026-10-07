// Barre de recherche injectée dans la page, isolée dans un Shadow DOM.

export interface UiHandlers {
  onQuery(query: string): void;
  onNext(): void;
  onPrev(): void;
  onClose(): void;
  onSelect(index: number): void;
}

export interface ResultView {
  text: string;
  exact: boolean;
  /** Détails exposés en attributs data-* (diagnostic). */
  score: number;
  semantic: number | null;
  overlap: number;
  /** Pertinence sémantique relative, 0..1, ou null si inconnue. */
  bar: number | null;
}

export type PanelState = 'idle' | 'indexing' | 'ready' | 'error';

export const HOST_ID = 'ctrl-shift-f-host';

const STYLE = `
:host { all: initial; }
.panel {
  position: fixed; top: 12px; right: 12px; z-index: 2147483647;
  width: min(460px, calc(100vw - 24px));
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #1b1b1f; background: #fff; border: 1px solid #d0d0d6; border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.18); overflow: hidden; display: flex; flex-direction: column;
}
.panel[hidden] { display: none; }
.row { display: flex; align-items: center; gap: 6px; padding: 8px; }
input {
  flex: 1; min-width: 0; font: inherit; padding: 6px 8px; border: 1px solid #c3c3cb;
  border-radius: 6px; background: #fff; color: inherit; outline: none;
}
input:focus { border-color: #5b6cff; box-shadow: 0 0 0 2px rgba(91,108,255,.25); }
.count { color: #6b6b75; white-space: nowrap; min-width: 3.5em; text-align: right; font-variant-numeric: tabular-nums; }
button {
  font: inherit; font-size: 14px; border: 0; background: transparent; color: #44444c;
  width: 28px; height: 28px; border-radius: 6px; cursor: pointer; display: grid; place-items: center;
}
button:hover { background: #ececf1; }
.status { display: flex; align-items: center; gap: 8px; padding: 0 10px 7px; color: #6b6b75; font-size: 12px; min-height: 16px; }
.status span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar { flex: 0 0 90px; height: 4px; background: #e6e6ec; border-radius: 2px; overflow: hidden; }
.bar[hidden] { display: none; }
.bar i { display: block; height: 100%; background: #5b6cff; width: 0; transition: width .2s; }
ul { list-style: none; margin: 0; padding: 0 0 4px; max-height: min(55vh, 520px); overflow-y: auto; border-top: 1px solid #ececf1; }
ul:empty { display: none; }
li {
  padding: 7px 10px 7px 12px; cursor: pointer; display: grid; grid-template-columns: 1fr auto;
  gap: 4px 10px; align-items: start; border-left: 3px solid transparent;
}
li:hover { background: #f4f4f8; }
li.current { background: #eef0ff; border-left-color: #5b6cff; }
.snippet { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.meta { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; padding-top: 2px; }
.badge { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #0a6b3a; background: #dff5e7; padding: 1px 6px; border-radius: 999px; }
.score { width: 48px; height: 4px; background: #e6e6ec; border-radius: 2px; overflow: hidden; }
.score i { display: block; height: 100%; background: #f0a030; }
@media (prefers-color-scheme: dark) {
  .panel { background: #1f1f24; color: #ececf1; border-color: #3a3a44; }
  input { background: #15151a; border-color: #3a3a44; }
  button { color: #c8c8d2; } button:hover { background: #2c2c35; }
  .count, .status { color: #9a9aa6; }
  ul { border-color: #2c2c35; }
  li:hover { background: #26262e; } li.current { background: #26294a; }
  .bar, .score { background: #33333d; }
  .badge { color: #9be3b8; background: #1e3a2b; }
}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export class Panel {
  readonly host: HTMLElement;
  private readonly panel: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLSpanElement;
  private readonly statusText: HTMLSpanElement;
  private readonly bar: HTMLDivElement;
  private readonly barFill: HTMLElement;
  private readonly list: HTMLUListElement;

  constructor(private readonly handlers: UiHandlers) {
    this.host = el('div');
    this.host.id = HOST_ID;
    const root = this.host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = STYLE;

    this.panel = el('div', 'panel');
    this.panel.hidden = true;
    this.panel.dataset.state = 'idle';

    const row = el('div', 'row');
    this.input = el('input');
    this.input.type = 'text';
    this.input.placeholder = 'Rechercher une idée ou un mot…';
    this.input.setAttribute('aria-label', 'Recherche sémantique dans la page');
    this.count = el('span', 'count', '');
    const prev = el('button', undefined, '↑');
    prev.title = 'Résultat précédent (Shift+Entrée)';
    const next = el('button', undefined, '↓');
    next.title = 'Résultat suivant (Entrée)';
    const close = el('button', undefined, '✕');
    close.title = 'Fermer (Échap)';
    row.append(this.input, this.count, prev, next, close);

    const status = el('div', 'status');
    this.statusText = el('span', undefined, '');
    this.bar = el('div', 'bar');
    this.bar.hidden = true;
    this.barFill = el('i');
    this.bar.append(this.barFill);
    status.append(this.statusText, this.bar);

    this.list = el('ul');
    this.panel.append(row, status, this.list);
    root.append(style, this.panel);

    this.input.addEventListener('input', () => handlers.onQuery(this.input.value));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) handlers.onPrev();
        else handlers.onNext();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        handlers.onNext();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        handlers.onPrev();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handlers.onClose();
      }
    });
    prev.addEventListener('click', () => handlers.onPrev());
    next.addEventListener('click', () => handlers.onNext());
    close.addEventListener('click', () => handlers.onClose());
    this.list.addEventListener('click', (e) => {
      const li = (e.target as Element).closest('li');
      if (li) handlers.onSelect(Number(li.dataset.index));
    });
    // Les raccourcis clavier de la page ne doivent pas réagir à la saisie.
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      this.host.addEventListener(type, (e) => e.stopPropagation());
    }
  }

  mount(): void {
    if (!this.host.isConnected) (document.body ?? document.documentElement).appendChild(this.host);
  }

  get visible(): boolean {
    return this.host.isConnected && !this.panel.hidden;
  }

  show(): void {
    this.mount();
    this.panel.hidden = false;
  }

  hide(): void {
    this.panel.hidden = true;
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  isFocused(): boolean {
    return this.host.shadowRoot?.activeElement === this.input;
  }

  get query(): string {
    return this.input.value;
  }

  setState(state: PanelState): void {
    this.panel.dataset.state = state;
  }

  setSemanticReady(ready: boolean): void {
    this.panel.dataset.semantic = ready ? 'ready' : 'pending';
  }

  setStatus(text: string, progress: number | null = null): void {
    this.statusText.textContent = text;
    this.bar.hidden = progress == null;
    if (progress != null) this.barFill.style.width = `${Math.round(progress * 100)}%`;
  }

  setResults(results: ResultView[], current: number): void {
    this.count.textContent = results.length ? `${current + 1}/${results.length}` : this.query ? '0/0' : '';
    const items = results.map((r, i) => {
      const li = el('li', i === current ? 'current' : '');
      li.dataset.index = String(i);
      li.dataset.score = r.score.toFixed(3);
      li.dataset.overlap = r.overlap.toFixed(2);
      if (r.semantic != null) li.dataset.semantic = r.semantic.toFixed(3);
      const meta = el('div', 'meta');
      if (r.exact) meta.append(el('span', 'badge', 'exact'));
      if (r.bar != null) {
        const score = el('div', 'score');
        const fill = el('i');
        fill.style.width = `${Math.round(r.bar * 100)}%`;
        score.append(fill);
        score.title = 'Pertinence sémantique';
        meta.append(score);
      }
      li.append(el('div', 'snippet', r.text), meta);
      return li;
    });
    this.list.replaceChildren(...items);
    this.list.querySelector('li.current')?.scrollIntoView({ block: 'nearest' });
  }

  setCurrent(current: number): void {
    const items = this.list.children;
    for (let i = 0; i < items.length; i++) items[i].classList.toggle('current', i === current);
    if (items.length) this.count.textContent = `${current + 1}/${items.length}`;
    this.list.querySelector('li.current')?.scrollIntoView({ block: 'nearest' });
  }
}
