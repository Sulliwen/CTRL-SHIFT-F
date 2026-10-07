// Surlignage des passages : API CSS Custom Highlight quand elle existe,
// sinon un calque positionné par-dessus le passage courant.

const MATCH = 'cmf-match';
const CURRENT = 'cmf-current';
export const OVERLAY_ID = 'ctrl-shift-f-overlay';

const supported =
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof (globalThis as { Highlight?: unknown }).Highlight === 'function';

export class Highlighter {
  private overlay: HTMLDivElement | null = null;
  private current: Range | null = null;
  private scheduled = false;
  private readonly redraw = () => {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.draw();
    });
  };

  setMatches(ranges: Range[]): void {
    if (!supported) return;
    if (ranges.length) CSS.highlights.set(MATCH, new Highlight(...ranges));
    else CSS.highlights.delete(MATCH);
  }

  setCurrent(range: Range | null): void {
    this.current = range;
    if (supported) {
      if (range) {
        const h = new Highlight(range);
        h.priority = 1;
        CSS.highlights.set(CURRENT, h);
      } else {
        CSS.highlights.delete(CURRENT);
      }
      return;
    }
    this.draw();
    if (range) {
      window.addEventListener('scroll', this.redraw, { passive: true, capture: true });
      window.addEventListener('resize', this.redraw, { passive: true });
    } else {
      window.removeEventListener('scroll', this.redraw, true);
      window.removeEventListener('resize', this.redraw);
    }
  }

  clear(): void {
    this.setMatches([]);
    this.setCurrent(null);
  }

  scrollTo(range: Range): void {
    const anchor = range.startContainer.parentElement;
    let rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      anchor?.scrollIntoView({ block: 'center' });
      return;
    }
    const vh = window.innerHeight;
    if (rect.top < 90 || rect.bottom > vh - 40) {
      // scrollIntoView gère les conteneurs défilants imbriqués ; on recentre ensuite sur le passage lui-même.
      anchor?.scrollIntoView({ block: 'center' });
      rect = range.getBoundingClientRect();
      const delta = rect.top + rect.height / 2 - vh / 2;
      if (Math.abs(delta) > 4) window.scrollBy({ top: delta });
    }
  }

  private draw(): void {
    if (!this.current) {
      this.overlay?.remove();
      this.overlay = null;
      return;
    }
    if (!this.overlay) {
      this.overlay = document.createElement('div');
      this.overlay.id = OVERLAY_ID;
      Object.assign(this.overlay.style, {
        position: 'absolute', top: '0', left: '0', width: '0', height: '0',
        pointerEvents: 'none', zIndex: '2147483646',
      });
      document.documentElement.appendChild(this.overlay);
    }
    this.overlay.replaceChildren();
    for (const r of this.current.getClientRects()) {
      const d = document.createElement('div');
      Object.assign(d.style, {
        position: 'absolute',
        left: `${r.left + window.scrollX}px`,
        top: `${r.top + window.scrollY}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        background: 'rgba(255, 138, 31, 0.45)',
        borderRadius: '2px',
      });
      this.overlay.appendChild(d);
    }
  }
}
