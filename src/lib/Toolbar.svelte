<script lang="ts">
  import type { Board, Tool } from './board.svelte';
  import Icon, { type IconName } from './Icon.svelte';
  import { toolKey } from './keys';

  let { board }: { board: Board } = $props();

  const tools: { id: Tool; label: string; icon: IconName }[] = [
    { id: 'pen', label: 'Перо', icon: 'pen' },
    { id: 'eraser', label: 'Ластик (X — переключить с пером)', icon: 'eraser' },
    { id: 'lasso', label: 'Лассо — обвести штрихи и создать объект', icon: 'lasso' },
    { id: 'arrow', label: 'Стрелка — потянуть от объекта к объекту', icon: 'arrow' },
    { id: 'select', label: 'Выбор — двигать объекты', icon: 'cursor' },
  ];
</script>

<div class="toolbar" role="toolbar" aria-label="Инструменты">
  {#each tools as t (t.id)}
    <button
      class="btn"
      class:active={board.ui.tool === t.id}
      title="{t.label}  {toolKey(t.id)}"
      aria-label={t.label}
      aria-pressed={board.ui.tool === t.id}
      onclick={() => board.setTool(t.id)}
    >
      <Icon name={t.icon} size={19} />
      <span class="key">{toolKey(t.id)}</span>
    </button>
  {/each}

  <span class="sep"></span>

  <button class="btn" disabled={!board.ui.canUndo} title="Отменить  Ctrl+Z" aria-label="Отменить" onclick={() => board.undo()}>
    <Icon name="undo" size={19} />
  </button>
  <button class="btn" disabled={!board.ui.canRedo} title="Повторить  Ctrl+Shift+Z" aria-label="Повторить" onclick={() => board.redo()}>
    <Icon name="redo" size={19} />
  </button>
</div>

<style>
  .toolbar {
    position: absolute;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 5px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow);
    z-index: 5;
    max-width: calc(100% - 24px);
  }
  .btn {
    position: relative;
    display: grid;
    place-items: center;
    width: 40px;
    height: 38px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--ink);
    cursor: pointer;
    transition: background 0.12s;
  }
  .btn:hover:not(:disabled) {
    background: var(--hover);
  }
  .btn.active {
    background: var(--accent);
    color: var(--on-accent);
  }
  .btn:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .key {
    position: absolute;
    right: 4px;
    bottom: 2px;
    font-size: 9px;
    line-height: 1;
    opacity: 0.45;
  }
  .sep {
    width: 1px;
    height: 22px;
    margin: 0 4px;
    background: var(--line);
  }
</style>
