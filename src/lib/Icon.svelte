<script lang="ts" module>
  // 24×24 outline icons drawn with strokes only, so they take the text color in both themes.
  const ICONS = {
    pen: ['M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z'],
    lasso: ['M12 4c5 0 9 2.7 9 6s-4 6-9 6c-1.3 0-2.6-.2-3.7-.5', 'M5.2 14.4C3.8 13.3 3 11.7 3 10c0-3.3 4-6 9-6', 'M7 15.5c-1.5.6-2.5 1.7-2.5 3a2.5 2.5 0 0 0 5 0c0-1-.6-1.8-1.5-2.4'],
    arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
    eraser: ['M20 20H9', 'M7 20l-4-4a2 2 0 0 1 0-2.8L13.2 3a2 2 0 0 1 2.8 0l5 5a2 2 0 0 1 0 2.8L11 20'],
    cursor: ['M4 4l7 17 2.5-7.5L21 11z'],
    undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
    redo: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'],
    graph: ['M12 5a2 2 0 1 0 0 .01', 'M5 17a2 2 0 1 0 0 .01', 'M19 17a2 2 0 1 0 0 .01', 'M12 7v4l-5.5 4.5', 'M12 11l5.5 4.5'],
    board: ['M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z', 'M8 15c2-4 4 0 8-5'],
    plus: ['M12 5v14', 'M5 12h14'],
    minus: ['M5 12h14'],
    search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4-4'],
    fit: ['M4 9V5a1 1 0 0 1 1-1h4', 'M15 4h4a1 1 0 0 1 1 1v4', 'M20 15v4a1 1 0 0 1-1 1h-4', 'M9 20H5a1 1 0 0 1-1-1v-4'],
    trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'],
    edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
    moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'],
    auto: ['M12 3a9 9 0 1 0 0 18z', 'M12 3a9 9 0 0 1 0 18'],
    sidebar: ['M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z', 'M9 4v16'],
    panel: ['M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z', 'M15 4v16'],
    link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
    keyboard: ['M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z', 'M7 10h.01', 'M11 10h.01', 'M15 10h.01', 'M8 14h8'],
  } as const;

  export type IconName = keyof typeof ICONS;
</script>

<script lang="ts">
  let { name, size = 18 }: { name: IconName; size?: number } = $props();
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#each ICONS[name] as d (d)}<path {d} />{/each}
</svg>

<style>
  .icon {
    flex: none;
    display: block;
  }
</style>
