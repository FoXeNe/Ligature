<script lang="ts">
  import {
    forceCollide,
    forceLink,
    forceManyBody,
    forceSimulation,
    forceX,
    forceY,
    type Simulation,
    type SimulationLinkDatum,
    type SimulationNodeDatum,
  } from 'd3-force';
  import Graph from 'graphology';
  import Sigma from 'sigma';
  import { onDestroy, onMount } from 'svelte';
  import { api } from './api';
  import Icon from './Icon.svelte';
  import { onPinch } from './pinch';

  let { onOpen }: { onOpen: (noteId: number, objectId: number) => void } = $props();

  interface SimNode extends SimulationNodeDatum {
    id: string;
    noteId: number;
  }

  // Muted tones that read on both the light and the dark theme.
  const PALETTE = ['#7c6cf0', '#3fb68b', '#e0a43c', '#e06c8a', '#4aa3df', '#a17be0', '#d9824a'];

  let host: HTMLDivElement;
  let sigma: Sigma | null = null;
  let sim: Simulation<SimNode, SimulationLinkDatum<SimNode>> | null = null;
  let ro: ResizeObserver | null = null;
  let offPinch: (() => void) | null = null;

  let loading = $state(true);
  let error = $state('');
  let counts = $state({ nodes: 0, edges: 0 });
  let legend = $state<{ id: number; title: string; color: string }[]>([]);
  let hiddenBoards = $state(new Set<number>());
  let showOrphans = $state(true);
  let query = $state('');

  function cssVar(name: string, fallback: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  onMount(async () => {
    try {
      const data = await api.graph();
      const ink = cssVar('--ink', '#222');
      const edge = cssVar('--graph-edge', 'rgba(128,128,128,0.3)');
      const dim = cssVar('--graph-dim', 'rgba(128,128,128,0.25)');
      const accent = cssVar('--accent', '#7c6cf0');
      const panel = cssVar('--panel', '#ffffff');
      const line = cssVar('--line', '#e4e2dc');

      const color = new Map<number, string>();
      data.boards.forEach((b, i) => color.set(b.id, PALETTE[i % PALETTE.length]));
      legend = data.boards.map((b) => ({ id: b.id, title: b.title, color: color.get(b.id)! }));

      const graph = new Graph({ type: 'undirected', multi: false });
      const nodes: SimNode[] = [];
      const byId = new Map<string, SimNode>();
      const r0 = Math.sqrt(data.nodes.length + 1) * 12;
      data.nodes.forEach((n, i) => {
        // Phyllotaxis start: evenly spread, so the simulation settles fast and without bursts.
        const a = i * 2.399963;
        const rad = r0 * Math.sqrt((i + 0.5) / Math.max(1, data.nodes.length));
        const node: SimNode = { id: String(n.id), noteId: n.note_id, x: Math.cos(a) * rad, y: Math.sin(a) * rad };
        nodes.push(node);
        byId.set(node.id, node);
        graph.addNode(node.id, {
          label: n.label || 'Без названия',
          x: node.x,
          y: node.y,
          size: 4,
          color: color.get(n.note_id) ?? dim,
          noteId: n.note_id,
        });
      });

      const links: SimulationLinkDatum<SimNode>[] = [];
      for (const l of data.links) {
        const a = String(l.from_id);
        const b = String(l.to_id);
        if (a === b || !graph.hasNode(a) || !graph.hasNode(b) || graph.hasEdge(a, b)) continue;
        graph.addEdge(a, b, { color: edge, size: 1 });
        links.push({ source: a, target: b });
      }

      // Hubs are a little bigger, like in Obsidian; growth flattens quickly.
      graph.forEachNode((node) => {
        graph.setNodeAttribute(node, 'size', Math.min(10, 3.5 + Math.sqrt(graph.degree(node)) * 1.6));
      });

      sim = forceSimulation(nodes)
        .force('charge', forceManyBody<SimNode>().strength(-220).distanceMax(600))
        .force('link', forceLink<SimNode, SimulationLinkDatum<SimNode>>(links).id((d) => d.id).distance(90).strength(0.5))
        .force('x', forceX<SimNode>(0).strength(0.06))
        .force('y', forceY<SimNode>(0).strength(0.06))
        .force('collide', forceCollide<SimNode>(16))
        .alphaDecay(0.05)
        // Stop once motion is imperceptible: sigma only reports hover over a still graph.
        .alphaMin(0.02)
        .stop();
      // Settle fully before the first frame, so the graph opens still and responsive.
      for (let i = 0; i < 300; i++) sim.tick();

      const syncPositions = () => {
        graph.updateEachNodeAttributes(
          (id, attr) => {
            const n = byId.get(id)!;
            attr.x = n.x;
            attr.y = n.y;
            return attr;
          },
          { attributes: ['x', 'y'] },
        );
      };
      syncPositions();
      sim.on('tick', syncPositions);

      let hovered: string | null = null;
      let dragMoved = false;

      const isHidden = (node: string) => {
        const noteId = graph.getNodeAttribute(node, 'noteId') as number;
        return hiddenBoards.has(noteId) || (!showOrphans && graph.degree(node) === 0);
      };
      const matches = (label: string) => {
        const t = query.trim().toLowerCase();
        return !t || label.toLowerCase().includes(t);
      };

      sigma = new Sigma(graph, host, {
        settings: {
          itemSizesReference: 'screen',
          zoomToSizeRatioFunction: () => 1,
          // 1 graph unit = 1 px around the center: small graphs stay compact, like Obsidian.
          autoRescale: false,
          enableNodeDrag: true,
          dragPositionToAttributes: (pos, node) => {
            const n = byId.get(node);
            if (n) {
              n.fx = pos.x;
              n.fy = pos.y;
            }
            dragMoved = true;
            return { x: pos.x, y: pos.y };
          },
          renderEdgeLabels: false,
          labelRenderedSizeThreshold: 0,
          labelDensity: 0.6,
          labelGridCellSize: 90,
          minCameraRatio: 0.05,
          maxCameraRatio: 10,
        },
        // Hover and neighbor highlighting use sigma's own node/edge state. A manual
        // refresh() here would reset sigma's hover tracking and make hover flicker.
        nodeReducer: (node, data, _attrs, state, graphState) => {
          // sigma sets the container cursor from the hovered node's display data.
          const res = {
            ...data,
            labelColor: ink,
            cursor: state.isDragged ? 'grabbing' : 'grab',
            // The hover label backdrop is white by default; match the theme instead.
            backdropColor: panel,
            backdropBorderColor: line,
            backdropBorderWidth: 1,
            backdropShadowColor: 'rgba(0, 0, 0, 0.25)',
          };
          if (isHidden(node)) return { ...res, hidden: true };
          if (graphState.hasHovered) {
            if (state.isHovered || state.isDragged) {
              res.color = accent;
              res.zIndex = 2;
            } else if (state.isHighlighted) {
              res.zIndex = 1;
            } else {
              res.color = dim;
              res.label = null;
            }
          } else if (!matches(data.label ?? '')) {
            res.color = dim;
            res.label = null;
          }
          return res;
        },
        edgeReducer: (e, data, _attrs, state, graphState) => {
          const [a, b] = graph.extremities(e);
          if (isHidden(a) || isHidden(b)) return { ...data, hidden: true };
          if (!graphState.hasHovered) return data;
          return state.isHighlighted ? { ...data, color: accent, size: 1.6 } : { ...data, color: dim };
        },
      });

      const highlightAround = (node: string, on: boolean) => {
        for (const nb of graph.neighbors(node)) sigma?.setNodeState(nb, { isHighlighted: on });
        for (const e of graph.edges(node)) sigma?.setEdgeState(e, { isHighlighted: on });
      };
      sigma.on('enterNode', ({ node }) => {
        if (hovered) highlightAround(hovered, false);
        hovered = node;
        highlightAround(node, true);
      });
      sigma.on('leaveNode', ({ node }) => {
        highlightAround(node, false);
        if (hovered === node) hovered = null;
      });
      sigma.on('nodeDragStart', () => {
        dragMoved = false;
        // Reheat explicitly: a settled graph has alpha below alphaMin and would stop on the first tick.
        sim?.alpha(Math.max(sim.alpha(), 0.3)).alphaTarget(0.3).restart();
      });
      sigma.on('nodeDragEnd', ({ node }) => {
        const n = byId.get(node);
        if (n) {
          n.fx = null;
          n.fy = null;
        }
        sim?.alphaTarget(0);
      });
      sigma.on('clickNode', ({ node }) => {
        if (dragMoved) return;
        onOpen(Number(graph.getNodeAttribute(node, 'noteId')), Number(node));
      });

      // Zoom out just enough for a large graph to fit on open.
      let ext = 0;
      let exty = 0;
      for (const n of nodes) {
        ext = Math.max(ext, Math.abs(n.x ?? 0));
        exty = Math.max(exty, Math.abs(n.y ?? 0));
      }
      const fit = Math.max(1, (2 * ext + 160) / host.clientWidth, (2 * exty + 160) / host.clientHeight);
      sigma.getCamera().setState({ ratio: fit });

      // Pinch zooms around the fingers: keep that graph point under them.
      offPinch = onPinch(({ factor, x, y }) => {
        if (!sigma || !(factor > 0)) return;
        const cam = sigma.getCamera();
        const r = host.getBoundingClientRect();
        const p = { x: x - r.left, y: y - r.top };
        const before = sigma.viewportToFramedGraph(p);
        const state = cam.getState();
        cam.setState({ ratio: cam.getBoundedRatio(state.ratio / factor) });
        const after = sigma.viewportToFramedGraph(p);
        const s = cam.getState();
        cam.setState({ x: s.x + before.x - after.x, y: s.y + before.y - after.y });
      });

      ro = new ResizeObserver(() => sigma?.resize());
      ro.observe(host);

      counts = { nodes: graph.order, edges: graph.size };
    } catch (err) {
      error = String(err);
    } finally {
      loading = false;
    }
  });

  // Filters live in Svelte state; sigma's reducers read them on the next render.
  $effect(() => {
    void hiddenBoards;
    void showOrphans;
    void query;
    sigma?.refresh({ skipIndexation: true });
  });

  function toggleBoard(id: number) {
    const next = new Set(hiddenBoards);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    hiddenBoards = next;
  }

  onDestroy(() => {
    offPinch?.();
    sim?.stop();
    ro?.disconnect();
    sigma?.kill();
    sigma = null;
  });
</script>

<div class="graph">
  <div class="host" bind:this={host}></div>

  <div class="controls">
    <label class="search">
      <Icon name="search" size={15} />
      <input bind:value={query} placeholder="Подсветить…" aria-label="Подсветить узлы" />
    </label>
    <label class="toggle">
      <input type="checkbox" bind:checked={showOrphans} />
      Без связей
    </label>
  </div>

  {#if loading}
    <p class="center">Загрузка графа…</p>
  {:else if error}
    <p class="center error">Не удалось построить граф: {error}</p>
  {:else if counts.nodes === 0}
    <p class="center">Пока нет объектов. Обведите штрихи лассо на доске, затем соедините объекты стрелкой.</p>
  {/if}

  <div class="footer">
    <span class="stat">{counts.nodes} объектов · {counts.edges} связей</span>
    <div class="legend">
      {#each legend as b (b.id)}
        <button
          class="chip"
          class:off={hiddenBoards.has(b.id)}
          title={hiddenBoards.has(b.id) ? 'Показать доску' : 'Скрыть доску'}
          onclick={() => toggleBoard(b.id)}
        >
          <i style:background={b.color}></i>{b.title}
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .graph {
    position: relative;
    width: 100%;
    height: 100%;
    background: var(--paper);
  }
  .host {
    position: absolute;
    inset: 0;
  }
  .controls {
    position: absolute;
    top: 14px;
    left: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .search,
  .toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: var(--shadow);
    color: var(--muted);
    font-size: 12px;
  }
  .search input {
    width: 170px;
    font: inherit;
    font-size: 13px;
    color: var(--ink);
    background: transparent;
    border: 0;
    outline: none;
  }
  .toggle {
    cursor: pointer;
    user-select: none;
  }
  .toggle input {
    accent-color: var(--accent);
    margin: 0;
  }
  .center {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    max-width: 340px;
    margin: 0;
    text-align: center;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
    pointer-events: none;
  }
  .error {
    color: var(--danger);
  }
  .footer {
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: 14px;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
    pointer-events: none;
  }
  .stat {
    padding: 5px 10px;
    border-radius: 8px;
    background: var(--panel);
    border: 1px solid var(--line);
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }
  .chip {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 9px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--ink);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .chip.off {
    opacity: 0.45;
  }
  .chip.off i {
    background: var(--muted) !important;
  }
  .chip i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
</style>
