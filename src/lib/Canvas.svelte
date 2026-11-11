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

    // Moves and releases are taken from the window: WebKitGTK does not honor
    // pointer capture for a stylus, so a stroke that leaves the canvas would
    // otherwise never receive its pointerup and be lost.
    const onMove = (e: PointerEvent) => {
      if (board.busy || host.contains(e.target as Node)) board.pointerMove(e);
    };
    const onUp = (e: PointerEvent) => {
      log(e.type, e);
      board.pointerUp(e);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);

    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
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

</script>

<div class="host" data-cursor={board.ui.cursor} bind:this={host}>
  <!-- Static layer: committed frames, strokes, links, labels (cached bitmap). -->
  <canvas bind:this={staticEl} class="layer"></canvas>
  <!-- Active layer: pen draft, lasso, arrow, hover and selection. Receives input. -->
  <canvas
    bind:this={activeEl}
    class="layer"
    onpointerdown={down}
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
  /* Always a native cursor: the compositor moves it at the display's full rate,
     while anything drawn by the page trails by a frame. A themed crosshair also
     has a correct hotspot, unlike a custom image cursor under Wayland scaling. */
  .host[data-cursor='draw'],
  .host[data-cursor='erase'],
  .host[data-cursor='crosshair'] {
    cursor: crosshair;
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
