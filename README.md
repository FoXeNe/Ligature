# Notes

Handwritten notes with a link graph. Tauri 2 · Rust · Svelte 5 · Canvas 2D · SQLite (FTS5) · sigma.js.

## Run

```sh
npm install
npm run tauri dev        # desktop app
npm test                 # frontend unit tests (Vitest)
npm run test:rust        # storage tests
npm run check            # type check
```

The vault is a plain SQLite file at `~/Documents/notes-vault/vault.sqlite`;
set `NOTES_VAULT=/some/dir` to use another folder. Tablet debugging:
`localStorage.setItem('penDebug', '1')` in the devtools console logs pointer events.

## Layout

| Path | What |
|---|---|
| `src-tauri/src/store.rs` | Schema, patches (one transaction per action), FTS search, binary stroke dump |
| `src-tauri/src/main.rs` | Tauri commands (async, off the UI thread) |
| `src/lib/model.ts` | In-memory board: records, indexes, `Tx` (undo/redo snapshots), patch encoding |
| `src/lib/spatial.ts` | Uniform grid used for culling, eraser, lasso |
| `src/lib/render.ts` | Cached static layer (pan = blit + strips, zoom = preview + sharp re-render, edits = dirty rects) and the active overlay |
| `src/lib/board.svelte.ts` | Tools, gestures, camera, autosave |
| `src/lib/GraphView.svelte` | Global graph: d3-force simulation, draggable nodes |
| `src/App.svelte` | Shell: boards panel, canvas, object panel, quick open (Ctrl K) |

Strokes are stored as packed little-endian f32 triples (x, y, pressure). Object
bboxes are always derived from their strokes. A link is a database row; the line
on the canvas is only its drawing, clipped to the current object frames.
