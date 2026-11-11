<script lang="ts">
  import type { Board } from './board.svelte';
  import Icon from './Icon.svelte';
  import { toolKey } from './keys';
  import { splitTags, type LinkRec, type ObjRec } from './model';

  let { board }: { board: Board } = $props();

  let filter = $state('');
  let draftLabel = $state('');
  let labelFocused = $state(false);
  let newTag = $state('');

  // `ui.version` is read so these re-derive after every model change.
  const objects = $derived.by<ObjRec[]>(() => {
    void board.ui.version;
    return [...board.model.objects.values()].sort((a, b) =>
      (a.label || '￿').localeCompare(b.label || '￿', 'ru'),
    );
  });

  const shown = $derived.by(() => {
    const t = filter.trim().toLowerCase();
    return t ? objects.filter((o) => `${o.label} ${o.tags}`.toLowerCase().includes(t)) : objects;
  });

  const selected = $derived.by<ObjRec | null>(() => {
    void board.ui.version;
    return board.ui.selected !== null ? (board.model.objects.get(board.ui.selected) ?? null) : null;
  });

  type Ref = { link: LinkRec; other: ObjRec };
  const refs = $derived.by(() => {
    void board.ui.version;
    const outgoing: Ref[] = [];
    const incoming: Ref[] = [];
    if (!selected) return { outgoing, incoming };
    for (const link of board.model.linksOf(selected.id)) {
      const out = link.from_id === selected.id;
      const other = board.model.objects.get(out ? link.to_id : link.from_id);
      if (other) (out ? outgoing : incoming).push({ link, other });
    }
    return { outgoing, incoming };
  });

  const linkCount = (id: number) => board.model.linksOf(id).length;

  // Show the stored label unless the user is typing in the field.
  $effect(() => {
    const label = selected?.label ?? '';
    if (!labelFocused) draftLabel = label;
  });

  function saveLabel() {
    if (selected) board.updateObject(selected.id, draftLabel, selected.tags);
  }

  function addTag() {
    if (!selected || !newTag.trim()) return;
    board.updateObject(selected.id, selected.label, `${selected.tags}, ${newTag}`);
    newTag = '';
  }

  function removeTag(tag: string) {
    if (!selected) return;
    board.updateObject(
      selected.id,
      selected.label,
      splitTags(selected.tags)
        .filter((t) => t !== tag)
        .join(', '),
    );
  }

  function onTagKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    } else if (e.key === 'Backspace' && !newTag && selected) {
      const tags = splitTags(selected.tags);
      if (tags.length) removeTag(tags[tags.length - 1]);
    }
  }
</script>

<div class="panel">
  {#if selected}
    <section class="inspector" aria-label="Выбранный объект">
      <div class="head">
        <input
          class="title"
          bind:value={draftLabel}
          placeholder="Без названия"
          aria-label="Название"
          onfocus={() => (labelFocused = true)}
          onblur={() => {
            labelFocused = false;
            saveLabel();
          }}
          onkeydown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              draftLabel = selected?.label ?? '';
              e.currentTarget.blur();
            }
          }}
        />
        <button class="icon-btn" title="Снять выделение  Esc" aria-label="Снять выделение" onclick={() => board.select(null)}>
          <Icon name="close" size={15} />
        </button>
      </div>

      <div class="tags">
        {#each splitTags(selected.tags) as tag (tag)}
          <span class="chip">
            #{tag}
            <button title="Убрать тег" aria-label="Убрать тег {tag}" onclick={() => removeTag(tag)}>
              <Icon name="close" size={11} />
            </button>
          </span>
        {/each}
        <input
          class="tag-input"
          bind:value={newTag}
          onkeydown={onTagKey}
          onblur={addTag}
          placeholder={selected.tags ? '+ тег' : 'Добавить тег'}
          aria-label="Новый тег"
        />
      </div>

      <h4>Ссылается на · {refs.outgoing.length}</h4>
      {#each refs.outgoing as r (r.other.id)}
        {@render refRow(r)}
      {:else}
        <p class="empty">Потяните стрелку от этого объекта к другому</p>
      {/each}

      <h4>Обратные ссылки · {refs.incoming.length}</h4>
      {#each refs.incoming as r (r.other.id)}
        {@render refRow(r)}
      {:else}
        <p class="empty">На этот объект пока никто не ссылается</p>
      {/each}

      <button class="danger" onclick={() => selected && board.deleteObject(selected.id)}>
        <Icon name="trash" size={14} /> Удалить объект
      </button>
    </section>
  {/if}

  <section class="list-section">
    <div class="list-head">
      <h3>Объекты</h3>
      <span class="count">{objects.length}</span>
    </div>
    {#if objects.length > 6}
      <input class="filter" type="search" bind:value={filter} placeholder="Фильтр" aria-label="Фильтр объектов" />
    {/if}
    <div class="list">
      {#each shown as o (o.id)}
        <button
          class="row"
          class:active={board.ui.selected === o.id}
          onclick={() => board.focusObject(o.id, true)}
          onmouseenter={() => board.setHover(o.id)}
          onmouseleave={() => board.setHover(null)}
        >
          <span class="label">{o.label || 'Без названия'}</span>
          {#if linkCount(o.id)}
            <span class="badge" title="Связей"><Icon name="link" size={11} />{linkCount(o.id)}</span>
          {/if}
          {#if o.tags}
            <span class="row-tags">{splitTags(o.tags).map((t) => `#${t}`).join(' ')}</span>
          {/if}
        </button>
      {:else}
        <p class="empty">
          {objects.length ? 'Ничего не подходит' : `Объектов пока нет. Обведите штрихи лассо (${toolKey('lasso')}), чтобы создать объект.`}
        </p>
      {/each}
    </div>
  </section>
</div>

{#snippet refRow(r: Ref)}
  <div class="ref">
    <button
      class="ref-main"
      onclick={() => board.focusObject(r.other.id, true)}
      onmouseenter={() => board.setHover(r.other.id)}
      onmouseleave={() => board.setHover(null)}
    >
      {r.other.label || 'Без названия'}
    </button>
    <button class="icon-btn subtle" title="Удалить связь" aria-label="Удалить связь" onclick={() => board.removeLink(r.link)}>
      <Icon name="close" size={13} />
    </button>
  </div>
{/snippet}

<style>
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
    font-size: 13px;
    color: var(--ink);
  }
  section {
    padding: 14px;
  }
  .inspector {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
    border-bottom: 1px solid var(--line);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .title {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: 16px;
    font-weight: 600;
    color: var(--ink);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    padding: 4px 6px;
    margin-left: -6px;
    outline: none;
  }
  .title:hover {
    background: var(--hover);
  }
  .title:focus {
    background: var(--field);
    border-color: var(--accent);
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px 4px 2px 8px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 12px;
  }
  .chip button {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.6;
  }
  .chip button:hover {
    opacity: 1;
    background: var(--hover);
  }
  .tag-input {
    flex: 1;
    min-width: 80px;
    font: inherit;
    font-size: 12px;
    color: var(--ink);
    background: transparent;
    border: 0;
    padding: 3px 2px;
    outline: none;
  }
  h3,
  h4 {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  h4 {
    margin-top: 10px;
  }
  .ref {
    display: flex;
    align-items: center;
    border-radius: 8px;
  }
  .ref:hover {
    background: var(--hover);
  }
  .ref-main {
    flex: 1;
    min-width: 0;
    text-align: left;
    font: inherit;
    color: var(--ink);
    background: transparent;
    border: 0;
    padding: 6px 8px;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    flex: none;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .icon-btn:hover {
    background: var(--hover);
    color: var(--ink);
  }
  .icon-btn.subtle {
    opacity: 0;
  }
  .ref:hover .icon-btn.subtle,
  .icon-btn.subtle:focus-visible {
    opacity: 1;
  }
  .danger {
    margin-top: 12px;
    justify-self: start;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    font-size: 12px;
    padding: 5px 10px;
    border-radius: 8px;
    border: 0;
    background: transparent;
    color: var(--danger);
    cursor: pointer;
  }
  .danger:hover {
    background: var(--danger-soft);
  }
  .list-section {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
    align-content: start;
  }
  .list-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .count {
    font-size: 11px;
    color: var(--muted);
  }
  .filter {
    font: inherit;
    font-size: 13px;
    color: var(--ink);
    background: var(--field);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 6px 9px;
    outline: none;
  }
  .filter:focus {
    border-color: var(--accent);
  }
  .list {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1px;
    margin: 0 -6px;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 2px 8px;
    text-align: left;
    padding: 6px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .row:hover {
    background: var(--hover);
  }
  .row.active {
    background: var(--accent-soft);
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    color: var(--muted);
  }
  .row-tags {
    grid-column: 1 / -1;
    font-size: 11px;
    color: var(--accent-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    margin: 2px 0;
    padding: 0 6px;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
  }
</style>
