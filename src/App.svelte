<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Board as BoardMeta } from './lib/api';
  import { Board, type Tool } from './lib/board.svelte';
  import Canvas from './lib/Canvas.svelte';
  import GraphView from './lib/GraphView.svelte';
  import Icon from './lib/Icon.svelte';
  import NamePopover from './lib/NamePopover.svelte';
  import ObjectPanel from './lib/ObjectPanel.svelte';
  import QuickOpen from './lib/QuickOpen.svelte';
  import Shortcuts from './lib/Shortcuts.svelte';
  import { forwardPinch } from './lib/pinch';
  import { applyThemePref, loadThemePref, onSystemThemeChange, pref, type ThemePref } from './lib/theme';
  import Toolbar from './lib/Toolbar.svelte';
  import ZoomControls from './lib/ZoomControls.svelte';

  const leftPref = pref('leftPanel', true);
  const rightPref = pref('rightPanel', true);
  const lastBoardPref = pref<number | null>('lastBoard', null);

  let boards = $state<BoardMeta[]>([]);
  let current = $state.raw<Board | null>(null);
  let view = $state<'board' | 'graph'>('board');
  let vaultPath = $state('');
  let fatal = $state('');
  let loadingBoard = $state(false);
  let leftOpen = $state(leftPref.get());
  let rightOpen = $state(rightPref.get());
  let quickOpen = $state(false);
  let showHelp = $state(false);
  let themePref = $state<ThemePref>(loadThemePref());
  /** Bumped on theme change so the graph view remounts with new colors. */
  let themeKey = $state(0);
  let renamingId = $state<number | null>(null);
  let renameValue = $state('');
  let confirmDeleteId = $state<number | null>(null);
  let openToken = 0;

  const TOOL_KEYS: Record<string, Tool> = { p: 'pen', l: 'lasso', a: 'arrow', e: 'eraser', v: 'select' };

  const currentMeta = $derived(boards.find((b) => b.id === current?.noteId) ?? null);
  const vaultName = $derived(vaultPath.split('/').slice(-2, -1)[0] ?? '');

  const isEmpty = $derived.by(() => {
    if (!current) return false;
    void current.ui.version;
    return current.model.strokes.size === 0;
  });

  $effect(() => leftPref.set(leftOpen));
  $effect(() => rightPref.set(rightOpen));

  onMount(() => {
    applyThemePref(themePref);
    const stop = onSystemThemeChange(() => themePref === 'auto' && themeChanged());
    const pinch = forwardPinch();
    void init();
    return () => {
      stop();
      void pinch.then((unlisten) => unlisten());
    };
  });

  async function init() {
    try {
      vaultPath = await api.vaultOpen();
      boards = await api.listBoards();
      if (boards.length === 0) boards = [await api.createBoard('Первая доска')];
      const last = lastBoardPref.get();
      await openBoard(boards.some((b) => b.id === last) ? last! : boards[0].id);
    } catch (err) {
      fatal = String(err);
    }
  }

  /** Opens a board (and optionally flies to an object). Later calls win over slower earlier ones. */
  async function openBoard(noteId: number, focusObjectId?: number) {
    const token = ++openToken;
    if (current?.noteId === noteId) {
      view = 'board';
      if (focusObjectId !== undefined) current.focusObject(focusObjectId, true);
      return;
    }
    loadingBoard = true;
    try {
      await current?.flush();
      const next = await Board.open(noteId);
      if (token !== openToken) return;
      current?.dispose();
      current = next;
      view = 'board';
      lastBoardPref.set(noteId);
      if (focusObjectId !== undefined) next.focusObject(focusObjectId, true, false);
    } catch (err) {
      if (token === openToken) current?.say(`Не удалось открыть доску: ${String(err)}`);
    } finally {
      if (token === openToken) loadingBoard = false;
    }
  }

  async function newBoard() {
    const created = await api.createBoard('Новая доска');
    boards = [...boards, created];
    await openBoard(created.id);
    startRename(created);
  }

  function startRename(b: BoardMeta) {
    confirmDeleteId = null;
    renamingId = b.id;
    renameValue = b.title;
  }

  async function finishRename() {
    if (renamingId === null) return;
    const id = renamingId;
    const title = renameValue.trim();
    renamingId = null;
    const old = boards.find((b) => b.id === id);
    if (!title || !old || old.title === title) return;
    boards = boards.map((b) => (b.id === id ? { ...b, title } : b));
    await api.renameBoard(id, title);
  }

  async function deleteBoard(id: number) {
    confirmDeleteId = null;
    if (current?.noteId === id) await current.flush();
    await api.deleteBoard(id);
    try {
      localStorage.removeItem(`notes.camera.${id}`);
    } catch {
      // Nothing to clean up.
    }
    boards = boards.filter((b) => b.id !== id);
    if (current?.noteId === id) {
      current.dispose();
      current = null;
      if (boards.length === 0) boards = [await api.createBoard('Первая доска')];
      await openBoard(boards[0].id);
    }
  }

  function setTheme(p: ThemePref) {
    themePref = p;
    applyThemePref(p);
    themeChanged();
  }

  function themeChanged() {
    current?.refreshTheme();
    themeKey++;
  }

  function toggleGraph() {
    view = view === 'graph' ? 'board' : 'graph';
  }

  function onKeydown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && (key === 'k' || key === 'o')) {
      e.preventDefault();
      quickOpen = !quickOpen;
      return;
    }
    if (quickOpen || showHelp) return;
    if (mod && key === 'g') {
      e.preventDefault();
      toggleGraph();
      return;
    }
    if (mod && e.key === '[') {
      e.preventDefault();
      leftOpen = !leftOpen;
      return;
    }
    if (mod && e.key === ']') {
      e.preventDefault();
      rightOpen = !rightOpen;
      return;
    }

    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === '?') {
      showHelp = true;
      return;
    }
    if (!current || view !== 'board') return;
    const b = current;

    if (e.code === 'Space') {
      e.preventDefault();
      b.setSpace(true);
    } else if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) b.redo();
      else b.undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      b.redo();
    } else if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      b.zoomBy(1.25);
    } else if (mod && e.key === '-') {
      e.preventDefault();
      b.zoomBy(1 / 1.25);
    } else if (e.shiftKey && e.code === 'Digit1') {
      b.fitAll();
    } else if (e.shiftKey && e.code === 'Digit0') {
      b.zoomReset();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      b.deleteSelected();
    } else if (e.key === 'Escape') {
      b.escape();
    } else if (!mod && !e.altKey && TOOL_KEYS[key]) {
      b.setTool(TOOL_KEYS[key]);
    }
  }

  function onKeyup(e: KeyboardEvent) {
    if (e.code === 'Space') current?.setSpace(false);
  }
</script>

<svelte:window onkeydown={onKeydown} onkeyup={onKeyup} onblur={() => current?.setSpace(false)} />

{#if fatal}
  <div class="fatal">
    <h1>Не удалось открыть хранилище</h1>
    <p>{fatal}</p>
    <p class="muted">Путь можно задать переменной окружения <code>NOTES_VAULT</code>.</p>
  </div>
{:else}
  <div class="app">
    {#if leftOpen}
      <aside class="left" aria-label="Доски">
        <div class="brand">
          <span class="logo"><Icon name="pen" size={15} /></span>
          <div class="brand-text">
            <strong>Notes</strong>
            <span title={vaultPath}>{vaultName}</span>
          </div>
        </div>

        <button class="search-btn" onclick={() => (quickOpen = true)}>
          <Icon name="search" size={15} />
          <span>Поиск</span>
          <kbd>Ctrl K</kbd>
        </button>

        <nav class="nav">
          <button class="nav-item" class:active={view === 'graph'} onclick={toggleGraph}>
            <Icon name="graph" size={16} />
            <span>Граф связей</span>
            <kbd>Ctrl G</kbd>
          </button>
        </nav>

        <div class="section-head">
          <span>Доски</span>
          <button class="icon-btn" title="Новая доска" aria-label="Новая доска" onclick={newBoard}>
            <Icon name="plus" size={15} />
          </button>
        </div>

        <ul class="boards">
          {#each boards as b (b.id)}
            <li class="board" class:active={view === 'board' && current?.noteId === b.id}>
              {#if renamingId === b.id}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="rename"
                  bind:value={renameValue}
                  autofocus
                  onfocus={(e) => e.currentTarget.select()}
                  onblur={finishRename}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') renamingId = null;
                  }}
                  aria-label="Название доски"
                />
              {:else if confirmDeleteId === b.id}
                <div class="confirm">
                  <span>Удалить «{b.title}»?</span>
                  <button class="danger-btn" onclick={() => deleteBoard(b.id)}>Удалить</button>
                  <button class="ghost-btn" onclick={() => (confirmDeleteId = null)}>Нет</button>
                </div>
              {:else}
                <button class="board-main" onclick={() => openBoard(b.id)} ondblclick={() => startRename(b)}>
                  <Icon name="board" size={15} />
                  <span class="board-title">{b.title}</span>
                </button>
                <div class="board-actions">
                  <button class="icon-btn" title="Переименовать" aria-label="Переименовать" onclick={() => startRename(b)}>
                    <Icon name="edit" size={14} />
                  </button>
                  <button
                    class="icon-btn"
                    title="Удалить доску"
                    aria-label="Удалить доску"
                    onclick={() => {
                      renamingId = null;
                      confirmDeleteId = b.id;
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              {/if}
            </li>
          {/each}
        </ul>

        <div class="left-foot">
          <div class="theme" role="radiogroup" aria-label="Тема">
            {#each [['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']] as [id, title] (id)}
              <button
                class:active={themePref === id}
                {title}
                aria-label={title}
                role="radio"
                aria-checked={themePref === id}
                onclick={() => setTheme(id as ThemePref)}
              >
                <Icon name={id === 'auto' ? 'auto' : id === 'light' ? 'sun' : 'moon'} size={14} />
              </button>
            {/each}
          </div>
          <button class="icon-btn" title="Горячие клавиши  ?" aria-label="Горячие клавиши" onclick={() => (showHelp = true)}>
            <Icon name="keyboard" size={16} />
          </button>
        </div>
      </aside>
    {/if}

    <main class="center">
      <header class="bar">
        <button
          class="icon-btn"
          class:on={leftOpen}
          title="Панель досок  Ctrl ["
          aria-label="Панель досок"
          onclick={() => (leftOpen = !leftOpen)}
        >
          <Icon name="sidebar" size={17} />
        </button>
        <span class="crumb">{view === 'graph' ? 'Граф связей' : (currentMeta?.title ?? '')}</span>
        {#if view === 'board' && current}
          <span
            class="save"
            class:err={!!current.ui.saveError}
            title={current.ui.saveError || 'Каждое действие сохраняется сразу'}
          >
            {current.ui.saveError ? 'Ошибка сохранения' : current.ui.saving ? 'Сохранение…' : 'Сохранено'}
          </span>
        {/if}
        <span class="spacer"></span>
        {#if view === 'board'}
          <button
            class="icon-btn"
            class:on={rightOpen}
            title="Панель объектов  Ctrl ]"
            aria-label="Панель объектов"
            onclick={() => (rightOpen = !rightOpen)}
          >
            <Icon name="panel" size={17} />
          </button>
        {/if}
      </header>

      <div class="stage">
        {#if view === 'graph'}
          {#key themeKey}
            <GraphView onOpen={(noteId, objectId) => openBoard(noteId, objectId)} />
          {/key}
        {:else if current}
          {#key current}
            <Canvas board={current} />
            <Toolbar board={current} />
            <ZoomControls board={current} />

            {#if isEmpty}
              <div class="empty-hint" aria-hidden="true">
                <p class="hint-title">Чистый лист</p>
                <p>Рисуйте пером <kbd>P</kbd>. Обведите штрихи лассо <kbd>L</kbd> — получится объект.</p>
                <p>Соедините объекты стрелкой <kbd>A</kbd>. Все горячие клавиши — <kbd>?</kbd></p>
              </div>
            {/if}

            {#if current.ui.picking}
              <NamePopover
                anchor={current.ui.pickAnchor}
                count={current.ui.picking.length}
                onSubmit={(label, tags) => current?.createObject(label, tags)}
                onCancel={() => current?.cancelPick()}
              />
            {/if}

            {#if current.ui.message}
              <div class="toast" role="status">{current.ui.message}</div>
            {/if}
          {/key}
        {/if}

        {#if loadingBoard}
          <div class="loading">Загрузка доски…</div>
        {/if}
      </div>
    </main>

    {#if rightOpen && view === 'board' && current}
      <aside class="right" aria-label="Объекты">
        {#key current}
          <ObjectPanel board={current} />
        {/key}
      </aside>
    {/if}
  </div>
{/if}

{#if quickOpen}
  <QuickOpen
    {boards}
    onOpenObject={(noteId, objectId) => openBoard(noteId, objectId)}
    onOpenBoard={(noteId) => openBoard(noteId)}
    onClose={() => (quickOpen = false)}
  />
{/if}

{#if showHelp}
  <Shortcuts onClose={() => (showHelp = false)} />
{/if}

<style>
  .app {
    display: flex;
    height: 100%;
  }

  /* ---- left panel ---- */
  .left {
    width: 236px;
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 10px;
    background: var(--sidebar);
    border-right: 1px solid var(--line);
    min-height: 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 2px 6px 10px;
  }
  .logo {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: var(--accent);
    color: var(--on-accent);
  }
  .brand-text {
    display: grid;
    line-height: 1.2;
    min-width: 0;
  }
  .brand-text strong {
    font-size: 14px;
  }
  .brand-text span {
    font-size: 11px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .search-btn,
  .nav-item,
  .board-main {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .search-btn {
    color: var(--muted);
    background: var(--panel);
    border: 1px solid var(--line);
    margin-bottom: 4px;
  }
  .search-btn span,
  .nav-item span {
    flex: 1;
  }
  .search-btn:hover,
  .nav-item:hover,
  .board-main:hover {
    background: var(--hover);
  }
  .nav-item.active,
  .board.active .board-main {
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-weight: 600;
  }
  kbd {
    font-family: inherit;
    font-size: 10px;
    color: var(--muted);
    padding: 1px 5px;
    border: 1px solid var(--line);
    border-radius: 5px;
    font-weight: 400;
    white-space: nowrap;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 8px 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .boards {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .board {
    position: relative;
    display: flex;
    align-items: center;
  }
  .board-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .board-actions {
    position: absolute;
    right: 4px;
    display: none;
    gap: 1px;
    background: inherit;
  }
  .board:hover .board-actions,
  .board-actions:focus-within {
    display: flex;
  }
  .board:hover .board-title {
    padding-right: 52px;
  }
  .rename {
    width: 100%;
    font: inherit;
    font-size: 13px;
    padding: 6px 8px;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--field);
    color: var(--ink);
    outline: none;
  }
  .confirm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    border-radius: 8px;
    background: var(--danger-soft);
    font-size: 12px;
  }
  .confirm span {
    flex-basis: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .danger-btn,
  .ghost-btn {
    font: inherit;
    font-size: 12px;
    padding: 3px 9px;
    border-radius: 6px;
    border: 0;
    cursor: pointer;
  }
  .danger-btn {
    background: var(--danger);
    color: #fff;
  }
  .ghost-btn {
    background: transparent;
    color: var(--ink);
  }
  .left-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 4px 0;
    border-top: 1px solid var(--line);
  }
  .theme {
    display: flex;
    padding: 2px;
    gap: 2px;
    border-radius: 8px;
    background: var(--hover);
  }
  .theme button {
    display: grid;
    place-items: center;
    width: 28px;
    height: 24px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .theme button.active {
    background: var(--panel);
    color: var(--ink);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  }

  /* ---- center ---- */
  .center {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 44px;
    padding: 0 10px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }
  .crumb {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .save {
    font-size: 11px;
    color: var(--muted);
  }
  .save.err {
    color: var(--danger);
  }
  .spacer {
    flex: 1;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .icon-btn:hover {
    background: var(--hover);
    color: var(--ink);
  }
  .icon-btn.on {
    color: var(--ink);
  }
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .right {
    width: 280px;
    flex: none;
    border-left: 1px solid var(--line);
    background: var(--panel);
    min-height: 0;
  }

  /* ---- overlays ---- */
  .empty-hint {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -60%);
    width: min(440px, calc(100% - 32px));
    text-align: center;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.7;
    pointer-events: none;
    user-select: none;
  }
  .empty-hint p {
    margin: 0;
  }
  .hint-title {
    margin-bottom: 6px !important;
    color: var(--ink);
    font-size: 17px;
    font-weight: 600;
  }
  .toast {
    position: absolute;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    padding: 8px 14px;
    border-radius: 10px;
    background: var(--ink);
    color: var(--paper);
    font-size: 13px;
    box-shadow: var(--shadow);
    pointer-events: none;
    z-index: 20;
    animation: toast-in 0.15s ease-out;
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translate(-50%, -6px);
    }
  }
  .loading {
    position: absolute;
    top: 14px;
    right: 14px;
    padding: 6px 12px;
    border-radius: 8px;
    background: var(--panel);
    border: 1px solid var(--line);
    font-size: 12px;
    color: var(--muted);
    z-index: 20;
  }
  .fatal {
    max-width: 560px;
    margin: 15vh auto 0;
    padding: 24px;
  }
  .fatal h1 {
    font-size: 18px;
  }
  .fatal p {
    color: var(--danger);
    word-break: break-word;
  }
  .fatal .muted {
    color: var(--muted);
  }
</style>
