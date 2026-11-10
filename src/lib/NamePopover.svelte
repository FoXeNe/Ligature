<script lang="ts">
  let {
    anchor,
    count,
    onSubmit,
    onCancel,
  }: {
    /** Screen point (relative to the canvas) just below the picked strokes. */
    anchor: { x: number; y: number };
    count: number;
    onSubmit: (label: string, tags: string) => void;
    onCancel: () => void;
  } = $props();

  let label = $state('');
  let tags = $state('');
  let el: HTMLFormElement;
  let pos = $state({ left: 0, top: 0 });

  // Keep the popover inside the canvas even when the selection is near an edge.
  $effect(() => {
    const parent = el.offsetParent as HTMLElement | null;
    const pw = parent?.clientWidth ?? window.innerWidth;
    const ph = parent?.clientHeight ?? window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let top = anchor.y + 12;
    if (top + h > ph - 80) top = Math.max(12, anchor.y - h - 60);
    pos = {
      left: Math.min(Math.max(12, anchor.x - w / 2), pw - w - 12),
      top: Math.min(Math.max(12, top), ph - h - 12),
    };
  });

  function submit(e: SubmitEvent) {
    e.preventDefault();
    onSubmit(label, tags);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    }
  }
</script>

<form
  class="pop"
  bind:this={el}
  style:left="{pos.left}px"
  style:top="{pos.top}px"
  onsubmit={submit}
>
  <p class="hint">Новый объект · штрихов: {count}</p>
  <!-- svelte-ignore a11y_autofocus -->
  <input bind:value={label} autofocus placeholder="Название" aria-label="Название" onkeydown={onKey} />
  <input bind:value={tags} placeholder="Теги через запятую" aria-label="Теги" onkeydown={onKey} />
  <div class="actions">
    <button type="button" class="ghost" onclick={onCancel}>Отмена <kbd>Esc</kbd></button>
    <button type="submit" class="primary">Создать <kbd>↵</kbd></button>
  </div>
</form>

<style>
  .pop {
    position: absolute;
    z-index: 10;
    width: 280px;
    display: grid;
    gap: 8px;
    padding: 12px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow-lg);
    animation: pop-in 0.12s ease-out;
  }
  @keyframes pop-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
  .hint {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
  }
  input {
    font: inherit;
    font-size: 14px;
    color: var(--ink);
    background: var(--field);
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 7px 10px;
    outline: none;
  }
  input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  button {
    font: inherit;
    font-size: 12px;
    padding: 6px 10px;
    border-radius: 8px;
    border: 0;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .ghost {
    background: transparent;
    color: var(--muted);
  }
  .ghost:hover {
    background: var(--hover);
  }
  .primary {
    background: var(--accent);
    color: var(--on-accent);
  }
  kbd {
    font-family: inherit;
    font-size: 10px;
    opacity: 0.7;
  }
</style>
