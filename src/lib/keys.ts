import type { Tool } from './board.svelte';

/**
 * Tool hotkeys sit under the left hand, next to Ctrl+Z, so drawing and undoing
 * never need the hand to move. They match the physical key
 * (`KeyboardEvent.code`), so they work in any layout, including Russian.
 */
export const TOOL_KEYS: { tool: Tool; code: string; label: string }[] = [
  { tool: 'pen', code: 'KeyD', label: 'D' },
  { tool: 'eraser', code: 'KeyE', label: 'E' },
  { tool: 'lasso', code: 'KeyS', label: 'S' },
  { tool: 'arrow', code: 'KeyA', label: 'A' },
  { tool: 'select', code: 'KeyV', label: 'V' },
];

/** Flips between the pen and the eraser. */
export const SWAP_KEY = { code: 'KeyX', label: 'X' };

export const toolKey = (t: Tool): string => TOOL_KEYS.find((k) => k.tool === t)?.label ?? '';
