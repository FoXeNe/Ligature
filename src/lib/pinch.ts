import { listen } from '@tauri-apps/api/event';

/** One pinch step: zoom by `factor` around the viewport point (x, y) in CSS pixels. */
export interface PinchStep {
  factor: number;
  x: number;
  y: number;
}

const EVENT = 'notes:pinch';

/**
 * On Linux the backend takes the pinch gesture away from WebKit (which would
 * zoom the whole page) and sends it here as a `pinch` event. It is re-broadcast
 * as a DOM event so the canvas or the graph, whichever is mounted, can use it.
 */
export async function forwardPinch(): Promise<() => void> {
  try {
    return await listen<PinchStep>('pinch', (e) => {
      window.dispatchEvent(new CustomEvent<PinchStep>(EVENT, { detail: e.payload }));
    });
  } catch {
    // Not running inside Tauri (e.g. plain browser): browsers send pinch as ctrl+wheel.
    return () => {};
  }
}

export function onPinch(cb: (step: PinchStep) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<PinchStep>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
