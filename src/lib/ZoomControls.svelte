<script lang="ts">
  import type { Board } from './board.svelte';
  import Icon from './Icon.svelte';

  let { board }: { board: Board } = $props();
</script>

<div class="zoom" role="group" aria-label="Масштаб">
  <button class="btn" title="Отдалить  Ctrl+−" aria-label="Отдалить" onclick={() => board.zoomBy(1 / 1.25)}>
    <Icon name="minus" size={16} />
  </button>
  <button class="pct" title="Масштаб 100%  Shift+0" onclick={() => board.zoomReset()}>{board.ui.zoom}%</button>
  <button class="btn" title="Приблизить  Ctrl+=" aria-label="Приблизить" onclick={() => board.zoomBy(1.25)}>
    <Icon name="plus" size={16} />
  </button>
  <span class="sep"></span>
  <button class="btn" title="Показать всё  Shift+1" aria-label="Показать всё" onclick={() => board.fitAll()}>
    <Icon name="fit" size={16} />
  </button>
</div>

<style>
  .zoom {
    position: absolute;
    right: 16px;
    bottom: 16px;
    display: flex;
    align-items: center;
    gap: 1px;
    padding: 4px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: var(--shadow);
    z-index: 5;
  }
  .btn,
  .pct {
    height: 30px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--ink);
    cursor: pointer;
  }
  .btn {
    display: grid;
    place-items: center;
    width: 30px;
  }
  .pct {
    min-width: 52px;
    font: inherit;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .btn:hover,
  .pct:hover {
    background: var(--hover);
  }
  .sep {
    width: 1px;
    height: 18px;
    margin: 0 3px;
    background: var(--line);
  }
</style>
