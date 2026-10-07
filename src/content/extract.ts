// Extraction du texte visible de la page en « passages » (phrases ou groupes
// de phrases courtes), chacun relié à un Range DOM pour le surlignage.

export interface Piece {
  /** Décalages dans le texte brut du bloc. */
  start: number;
  end: number;
  /** Texte normalisé (espaces compactés). */
  text: string;
}

export interface Segment {
  node: Text;
  start: number;
  end: number;
}

export interface Block {
  raw: string;
  segments: Segment[];
}

export interface Chunk {
  text: string;
  range: Range;
}

export interface SegmentOptions {
  /** En dessous de cette longueur, une phrase est fusionnée avec la suivante. */
  minChars?: number;
  /** Au-dessus, le passage est découpé sur des espaces. */
  maxChars?: number;
  /** Fragments plus courts : ignorés. */
  minKeep?: number;
}

const DEFAULTS: Required<SegmentOptions> = { minChars: 40, maxChars: 500, minKeep: 3 };

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'math', 'canvas', 'iframe',
  'object', 'embed', 'video', 'audio', 'head', 'title', 'meta', 'link', 'textarea', 'select',
]);

export const normalizeWhitespace = (s: string): string => s.replace(/\s+/g, ' ').trim();

const isSpace = (c: string): boolean => /\s/.test(c);

function sentenceBounds(raw: string, locale?: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const push = (s: number, e: number) => {
    while (s < e && isSpace(raw[s])) s++;
    while (e > s && isSpace(raw[e - 1])) e--;
    if (e > s) out.push({ start: s, end: e });
  };
  let segmenter: Intl.Segmenter | null = null;
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    try {
      segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
    } catch {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    }
  }
  if (segmenter) {
    for (const { index, segment } of segmenter.segment(raw)) push(index, index + segment.length);
  } else {
    const re = /[^.!?\n]+[.!?]*\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) push(m.index, m.index + m[0].length);
  }
  return out;
}

/** Découpe un texte brut en passages. Fonction pure, testable hors navigateur. */
export function segmentText(raw: string, locale?: string, options: SegmentOptions = {}): Piece[] {
  const { minChars, maxChars, minKeep } = { ...DEFAULTS, ...options };
  const pieces: Piece[] = [];

  const pushPiece = (start: number, end: number) => {
    while (start < end && isSpace(raw[start])) start++;
    while (end > start && isSpace(raw[end - 1])) end--;
    const text = normalizeWhitespace(raw.slice(start, end));
    if (text.length < minKeep) return;
    if (text.length <= maxChars) {
      pieces.push({ start, end, text });
      return;
    }
    // Passage trop long : coupe sur un espace, le plus loin possible sans dépasser maxChars.
    let s = start;
    while (s < end) {
      let e = Math.min(end, s + maxChars);
      if (e < end) {
        let cut = e;
        while (cut > s + maxChars / 2 && !isSpace(raw[cut])) cut--;
        if (cut > s + maxChars / 2) e = cut;
      }
      let ps = s;
      let pe = e;
      while (ps < pe && isSpace(raw[ps])) ps++;
      while (pe > ps && isSpace(raw[pe - 1])) pe--;
      const t = normalizeWhitespace(raw.slice(ps, pe));
      if (t.length >= minKeep) pieces.push({ start: ps, end: pe, text: t });
      s = e;
    }
  };

  let acc: { start: number; end: number } | null = null;
  for (const sentence of sentenceBounds(raw, locale)) {
    if (!acc) acc = { ...sentence };
    else acc.end = sentence.end;
    if (normalizeWhitespace(raw.slice(acc.start, acc.end)).length >= minChars) {
      pushPiece(acc.start, acc.end);
      acc = null;
    }
  }
  if (acc) pushPiece(acc.start, acc.end);
  return pieces;
}

/**
 * Parcourt le DOM et regroupe les nœuds texte visibles par bloc de mise en
 * page (paragraphe, cellule, élément de liste…). Un <br> vaut un saut de ligne.
 */
export function collectBlocks(root: Document, exclude: (el: Element) => boolean): Block[] {
  const styleCache = new WeakMap<Element, CSSStyleDeclaration>();
  const styleOf = (el: Element): CSSStyleDeclaration => {
    let s = styleCache.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styleCache.set(el, s);
    }
    return s;
  };
  const isBoundary = (el: Element): boolean => {
    const d = styleOf(el).display;
    return d !== 'inline' && d !== 'contents' && !d.startsWith('ruby');
  };
  const blockCache = new WeakMap<Element, Element>();
  const blockOf = (el: Element): Element => {
    const path: Element[] = [];
    let cur: Element | null = el;
    let found: Element = root.documentElement;
    while (cur) {
      const cached = blockCache.get(cur);
      if (cached) {
        found = cached;
        break;
      }
      if (isBoundary(cur)) {
        found = cur;
        break;
      }
      path.push(cur);
      cur = cur.parentElement;
    }
    for (const p of path) blockCache.set(p, found);
    return found;
  };

  const walker = root.createTreeWalker(root.body ?? root.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n: Node): number {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as Element;
        if (SKIP_TAGS.has(el.localName) || exclude(el)) return NodeFilter.FILTER_REJECT;
        if (styleOf(el).display === 'none') return NodeFilter.FILTER_REJECT;
        return el.localName === 'br' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const blocks: Block[] = [];
  let current: Block | null = null;
  let currentEl: Element | null = null;
  const flush = () => {
    if (current && /\S/.test(current.raw)) blocks.push(current);
    current = null;
    currentEl = null;
  };

  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      if (current) current.raw += '\n';
      continue;
    }
    const text = n as Text;
    const parent = text.parentElement;
    if (!parent || styleOf(parent).visibility === 'hidden') continue;
    const block = blockOf(parent);
    if (block !== currentEl) {
      flush();
      currentEl = block;
      current = { raw: '', segments: [] };
    }
    const start = current!.raw.length;
    current!.raw += text.data;
    current!.segments.push({ node: text, start, end: start + text.data.length });
  }
  flush();
  return blocks;
}

function positionIn(block: Block, offset: number, side: 'start' | 'end'): { node: Text; offset: number } | null {
  for (const seg of block.segments) {
    const inside = side === 'start' ? offset >= seg.start && offset < seg.end : offset > seg.start && offset <= seg.end;
    if (inside) return { node: seg.node, offset: offset - seg.start };
  }
  return null;
}

/** Transforme les blocs en passages munis d'un Range DOM. */
export function buildChunks(blocks: Block[], locale?: string, options?: SegmentOptions): Chunk[] {
  const chunks: Chunk[] = [];
  for (const block of blocks) {
    for (const piece of segmentText(block.raw, locale, options)) {
      const s = positionIn(block, piece.start, 'start');
      const e = positionIn(block, piece.end, 'end');
      if (!s || !e) continue;
      const range = new Range();
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
      chunks.push({ text: piece.text, range });
    }
  }
  return chunks;
}
