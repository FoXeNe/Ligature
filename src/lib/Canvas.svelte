<script lang="ts">
  import type { Board } from './board.svelte';
  import { onPinch } from './pinch';

  let { board }: { board: Board } = $props();

  let host: HTMLDivElement;
  let staticEl: HTMLCanvasElement;
  let activeEl: HTMLCanvasElement;

  $effect(() => {
    board.attach(host, staticEl, activeEl);
    board.resize(host.clientWidth, host.clientHeight);

    const ro = new ResizeObserver(() => board.resize(host.clientWidth, host.clientHeight));
    ro.observe(host);

    // Non-passive, so the wheel can zoom without the page scrolling.
    const onWheel = (e: WheelEvent) => board.wheel(e);
    host.addEventListener('wheel', onWheel, { passive: false });

    const offPinch = onPinch((p) => board.pinch(p.x, p.y, p.factor));

    return () => {
      offPinch();
      ro.disconnect();
      host.removeEventListener('wheel', onWheel);
      board.dispose();
    };
  });

  // Pointer log for diagnosing tablet input: localStorage.setItem('penDebug', '1')
  const debug = (() => {
    try {
      return localStorage.getItem('penDebug') === '1';
    } catch {
      return false;
    }
  })();

  function log(name: string, e: PointerEvent) {
    if (!debug) return;
    console.log(
      `[pointer] ${name} type=${e.pointerType} button=${e.button} buttons=${e.buttons} pressure=${e.pressure.toFixed(3)}`,
    );
  }

  function down(e: PointerEvent) {
    log('down', e);
    // The middle button would otherwise start the browser's autoscroll.
    if (e.button === 1) e.preventDefault();
    activeEl.setPointerCapture(e.pointerId);
    board.pointerDown(e);
  }

  function move(e: PointerEvent) {
    board.pointerMove(e);
  }

  // A cancel (e.g. WebKit taking over a stylus) still finishes the stroke drawn so far.
  function up(e: PointerEvent) {
    log(e.type, e);
    board.pointerUp(e);
  }
</script>

<div class="host" data-cursor={board.ui.cursor} bind:this={host}>
  <!-- Static layer: committed frames, strokes, links, labels (cached bitmap). -->
  <canvas bind:this={staticEl} class="layer"></canvas>
  <!-- Active layer: pen draft, lasso, arrow, hover and selection. Receives input. -->
  <canvas
    bind:this={activeEl}
    class="layer"
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onpointerleave={() => board.pointerLeave()}
    oncontextmenu={(e) => e.preventDefault()}
  ></canvas>
</div>

<style>
  .host {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background-color: var(--paper);
    background-image: radial-gradient(circle, var(--grid) 1px, transparent 1.5px);
    background-size: var(--grid-size, 32px) var(--grid-size, 32px);
    background-position: var(--grid-x, 0) var(--grid-y, 0);
  }
  .layer {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
  }
  /* A small round pen cursor reads better than a crosshair for handwriting. */
  .host[data-cursor='draw'] {
    cursor:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12'%3E%3Ccircle cx='6' cy='6' r='2.5' fill='%23888' stroke='white' stroke-width='1'/%3E%3C/svg%3E")
        6 6,
      crosshair;
  }
  .host[data-cursor='erase'] {
    cursor: none;
  }
  .host[data-cursor='pointer'] {
    cursor: pointer;
  }
  .host[data-cursor='move'] {
    cursor: move;
  }
  .host[data-cursor='grab'] {
    cursor: grab;
  }
  .host[data-cursor='grabbing'] {
    cursor: grabbing;
  }
</style>
