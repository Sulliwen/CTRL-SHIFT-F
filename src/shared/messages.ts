// Messages échangés entre le script de contenu (page) et le background (modèle).

export type EmbedKind = 'query' | 'passage';

export type ContentToBackground =
  | { type: 'embed'; kind: EmbedKind; texts: string[] }
  | { type: 'model-info' };

export type BackgroundToContent =
  | { type: 'toggle' }
  | { type: 'model-progress'; progress: number; status: string };

export type EmbedResult =
  | { ok: true; vectors: number[][]; elapsedMs: number }
  | { ok: false; error: string };

export interface ModelInfo {
  modelId: string;
  ready: boolean;
}
