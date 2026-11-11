<script lang="ts">
  import { api, type Board, type SearchHit } from './api';
  import Icon from './Icon.svelte';

  let {
    boards,
    onOpenObject,
    onOpenBoard,
    onClose,
  }: {
    boards: Board[];
    onOpenObject: (noteId: number, objectId: number) => void;
    onOpenBoard: (noteId: number) => void;
    onClose: () => void;
  } = $props();

  type Item = { kind: 'board'; board: Board } | { kind: 'object'; hit: SearchHit };

  let query = $state('');
  let hits = $state<SearchHit[]>([]);
  let active = $state(0);
  let list: HTMLDivElement;

  const items = $derived.by<Item[]>(() => {
    const t = query.trim().toLowerCase();
    const matchingBoards = boards.filter((b) => !t || b.title.toLowerCase().includes(t));
    return [
      ...hits.map((hit): Item => ({ kind: 'object', hit })),
      ...matchingBoards.map((board): Item => ({ kind: 'board', board })),
    ];
  });

  // Full-text search across every board, debounced.
  $effect(() => {
    const text = query.trim();
    active = 0;
    if (!text) {
      hits = [];
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      api
        .search(text)
        .then((r) => !stale && (hits = r))
        .catch(() => !stale && (hits = []));
    }, 120);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  });

  function choose(item: Item | undefined) {
    if (!item) return;
    if (item.kind === 'object') onOpenObject(item.hit.note_id, item.hit.object_id);
    else onOpenBoard(item.board.id);
    onClose();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      if (n) active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      list?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }
</script>

<div class="scrim" role="presentation" onpointerdown={onClose}>
  <div
    class="palette"
    role="dialog"
    aria-modal="true"
    aria-label="Быстрый переход"
    tabindex="-1"
    onpointerdown={(e) => e.stopPropagation()}
  >
    <div class="search">
      <Icon name="search" size={17} />
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:value={query}
        onkeydown={onKey}
        autofocus
        placeholder="Найти объект или доску…"
        aria-label="Поиск"
      />
      <kbd>Esc</kbd>
    </div>

    <div class="results" bind:this={list} role="listbox">
      {#each items as item, i (item.kind === 'object' ? `o${item.hit.object_id}` : `b${item.board.id}`)}
        <button
          class="item"
          class:active={i === active}
          data-i={i}
          role="option"
          aria-selected={i === active}
          onmouseenter={() => (active = i)}
          onclick={() => choose(item)}
        >
          {#if item.kind === 'object'}
            <Icon name="link" size={15} />
            <span class="name">{item.hit.label || 'Без названия'}</span>
            <span class="meta">{item.hit.tags ? `#${item.hit.tags.split(', ').join(' #')} · ` : ''}{item.hit.board_title}</span>
          {:else}
            <Icon name="board" size={15} />
            <span class="name">{item.board.title}</span>
            <span class="meta">доска</span>
          {/if}
        </button>
      {:else}
        <p class="empty">Ничего не найдено</p>
      {/each}
    </div>

    <footer>
      <span><kbd>↑</kbd><kbd>↓</kbd> выбор</span>
      <span><kbd>↵</kbd> открыть</span>
    </footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    background: var(--scrim);
    animation: fade 0.1s ease-out;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .palette {
    width: min(560px, calc(100% - 32px));
    max-height: 64vh;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 16px;
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    outline: none;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
  }
  .search input {
    flex: 1;
    font: inherit;
    font-size: 16px;
    color: var(--ink);
    background: transparent;
    border: 0;
    outline: none;
  }
  .results {
    overflow-y: auto;
    padding: 6px;
  }
  .item {
    width: 100%;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 14px;
    text-align: left;
    cursor: pointer;
  }
  .item.active {
    background: var(--accent-soft);
  }
  .name {
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 220px;
  }
  .empty {
    margin: 0;
    padding: 18px;
    text-align: center;
    color: var(--muted);
    font-size: 13px;
  }
  footer {
    display: flex;
    gap: 14px;
    padding: 8px 14px;
    border-top: 1px solid var(--line);
    font-size: 11px;
    color: var(--muted);
  }
  kbd {
    font-family: inherit;
    font-size: 10px;
    padding: 1px 5px;
    margin-right: 2px;
    border: 1px solid var(--line);
    border-radius: 5px;
  }
</style>
