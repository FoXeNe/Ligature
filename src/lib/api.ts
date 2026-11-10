import { invoke } from '@tauri-apps/api/core';

export type Bbox = [number, number, number, number];

export interface Board {
  id: number;
  title: string;
  created: number;
}

/** Wire format of an object (matches store.rs). */
export interface ObjectRow {
  id: number;
  note_id: number;
  label: string;
  tags: string;
  bbox: Bbox;
  x: number;
  y: number;
}

export interface LinkRow {
  from_id: number;
  to_id: number;
  kind: string;
}

/** A stroke inside a patch: `data` is base64 of packed f32 triples (x, y, pressure). */
export interface StrokeRow {
  id: number;
  note_id: number;
  object_id: number | null;
  data: string;
}

export interface BoardMeta {
  objects: ObjectRow[];
  links: LinkRow[];
}

export interface Ops<T, D> {
  upsert: T[];
  delete: D[];
}

export interface Patch {
  strokes: Ops<StrokeRow, number>;
  objects: Ops<ObjectRow, number>;
  links: Ops<LinkRow, LinkRow>;
}

export interface SearchHit {
  object_id: number;
  note_id: number;
  label: string;
  tags: string;
  board_title: string;
}

export interface GraphNode {
  id: number;
  note_id: number;
  label: string;
}

export interface GraphData {
  boards: Board[];
  nodes: GraphNode[];
  links: LinkRow[];
}

export const api = {
  vaultOpen: () => invoke<string>('vault_open'),
  listBoards: () => invoke<Board[]>('list_boards'),
  createBoard: (title: string) => invoke<Board>('create_board', { title }),
  renameBoard: (id: number, title: string) => invoke<void>('rename_board', { id, title }),
  deleteBoard: (id: number) => invoke<void>('delete_board', { id }),
  loadBoard: (noteId: number) => invoke<BoardMeta>('load_board', { noteId }),
  /** Binary stroke dump, decoded by `decodeStrokes` in model.ts. */
  loadStrokes: (noteId: number) => invoke<ArrayBuffer>('load_strokes', { noteId }),
  commit: (patch: Patch) => invoke<void>('commit', { patch }),
  search: (query: string) => invoke<SearchHit[]>('search', { query }),
  graph: () => invoke<GraphData>('graph'),
};
