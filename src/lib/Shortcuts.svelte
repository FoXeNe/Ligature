<script lang="ts">
  import { SWAP_KEY, toolKey } from './keys';

  let { onClose }: { onClose: () => void } = $props();

  const groups: { title: string; keys: [string, string][] }[] = [
    {
      title: 'Инструменты',
      keys: [
        [toolKey('pen'), 'Перо'],
        [toolKey('eraser'), 'Ластик (или обратный конец стилуса)'],
        [SWAP_KEY.label, 'Переключить перо ↔ ластик'],
        [toolKey('lasso'), 'Лассо: обвести штрихи → объект'],
        [toolKey('arrow'), 'Стрелка: от объекта к объекту'],
        [toolKey('select'), 'Выбор: двигать объекты'],
      ],
    },
    {
      title: 'Холст',
      keys: [
        ['Колесо', 'Масштаб'],
        ['Пробел + тянуть', 'Перемещение'],
        ['Средняя кнопка', 'Перемещение'],
        ['Shift 1', 'Показать всё'],
        ['Shift 0', 'Масштаб 100%'],
        ['Ctrl + / −', 'Приблизить / отдалить'],
      ],
    },
    {
      title: 'Правка',
      keys: [
        ['Ctrl Z', 'Отменить'],
        ['Ctrl Shift Z', 'Повторить'],
        ['Delete', 'Удалить выбранный объект'],
        ['Esc', 'Отменить действие / снять выбор'],
      ],
    },
    {
      title: 'Навигация',
      keys: [
        ['Ctrl K', 'Быстрый переход'],
        ['Ctrl G', 'Граф ↔ доска'],
        ['Ctrl [', 'Панель досок'],
        ['Ctrl ]', 'Панель объектов'],
        ['?', 'Эта справка'],
      ],
    },
  ];
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onClose()} />

<div class="scrim" role="presentation" onpointerdown={onClose}>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Горячие клавиши" tabindex="-1" onpointerdown={(e) => e.stopPropagation()}>
    <h2>Горячие клавиши</h2>
    <div class="grid">
      {#each groups as g (g.title)}
        <section>
          <h3>{g.title}</h3>
          {#each g.keys as [k, what] (k)}
            <div class="row"><kbd>{k}</kbd><span>{what}</span></div>
          {/each}
        </section>
      {/each}
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    background: var(--scrim);
  }
  .sheet {
    width: min(640px, calc(100% - 32px));
    max-height: calc(100% - 64px);
    overflow-y: auto;
    padding: 20px 22px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 16px;
    box-shadow: var(--shadow-lg);
    outline: none;
  }
  h2 {
    margin: 0 0 14px;
    font-size: 16px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 16px 24px;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .row {
    display: grid;
    grid-template-columns: 120px 1fr;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
    font-size: 13px;
  }
  kbd {
    justify-self: start;
    font-family: inherit;
    font-size: 11px;
    padding: 2px 7px;
    border: 1px solid var(--line);
    border-bottom-width: 2px;
    border-radius: 6px;
    color: var(--ink);
    white-space: nowrap;
  }
</style>
