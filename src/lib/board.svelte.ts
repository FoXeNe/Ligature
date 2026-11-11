import { api, type Bbox } from './api';
import { Camera } from './camera';
import { bboxCenter, distToSegment, fractionInside, inBbox, polyBbox, polylineNear, type Vec } from './geometry';
import {
  applyEntries,
  bboxArea,
  decodeStrokes,
  invert,
  linkKey,
  makeStroke,
  Model,
  newId,
  normalizeTags,
  objectFromStrokes,
  STROKE_SIZE,
  toPatch,
  Tx,
  unionBbox,
  type Entry,
  type LinkRec,
  type ObjRec,
  type StrokeRec,
} from './model';
import { drawActive, frameOf, linkGeometry, objectRegion, StaticLayer, syncTheme, type ActiveView } from './render';

export type Tool = 'pen' | 'lasso' | 'arrow' | 'eraser' | 'select';
export type Cursor = 'draw' | 'erase' | 'crosshair' | 'default' | 'pointer' | 'move' | 'grab' | 'grabbing';

const ERASER_PX = 12;
const LINK_HIT_PX = 6;
const DRAG_START_PX = 4;
const FLY_MS = 420;
const SHARPEN_MS = 140;
const HISTORY_LIMIT = 300;
/** Share of a stroke's points that must be inside the lasso for it to be picked. */
const LASSO_COVERAGE = 0.6;
/** `PointerEvent.button` of a stylus eraser end. */
const PEN_ERASER_BUTTON = 5;

type Gesture =
  | { kind: 'pan'; sx: number; sy: number }
  | { kind: 'press'; sx: number; sy: number }
  | { kind: 'pen'; pts: number[] }
  | { kind: 'lasso'; poly: Vec[] }
  | { kind: 'arrow'; from: number; to: Vec; target: number | null }
  | { kind: 'erase'; tx: Tx; touched: Set<number>; last: Vec }
  | { kind: 'move'; objectId: number; strokeIds: number[]; start: Vec; applied: Vec; tx: Tx; moved: boolean }
  | { kind: 'link'; link: LinkRec; sx: number; sy: number; moved: boolean };

const cameraKey = (noteId: number) => `notes.camera.${noteId}`;

/**
 * One open board: in-memory model, camera, tools and the two canvas layers.
 * Every edit goes through a Tx, which provides undo/redo and autosave.
 */
export class Board {
  readonly noteId: number;
  readonly model: Model;
  readonly cam = new Camera();

  /** Reactive UI state. `version` bumps on every data change so lists re-derive. */
  readonly ui = $state({
    tool: 'pen' as Tool,
    cursor: 'draw' as Cursor,
    selected: null as number | null,
    hover: null as number | null,
    version: 0,
    /** Strokes picked by the lasso and waiting for a name. */
    picking: null as number[] | null,
    /** Screen point under which the naming popover opens. */
    pickAnchor: { x: 0, y: 0 },
    zoom: 100,
    message: '',
    saving: false,
    saveError: '',
    canUndo: false,
    canRedo: false,
  });

  private layer: StaticLayer | null = null;
  private aCtx: CanvasRenderingContext2D | null = null;
  private host: HTMLElement | null = null;
  private rect = { left: 0, top: 0 };
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;

  private dirty: Bbox[] = [];
  private needsSync = true;
  private activeDirty = true;
  private sharpenDue = false;
  private frameId = 0;
  private sharpenTimer: ReturnType<typeof setTimeout> | undefined;
  private flyFrame = 0;
  private msgTimer: ReturnType<typeof setTimeout> | undefined;
  private camSaveTimer: ReturnType<typeof setTimeout> | undefined;

  private gesture: Gesture | null = null;
  private spaceDown = false;
  private pointer: Vec | null = null;
  private hoverLink: LinkRec | null = null;
  private undoStack: Entry[][] = [];
  private redoStack: Entry[][] = [];
  private saveChain: Promise<void> = Promise.resolve();
  private pendingSaves = 0;
  private pendingFocus: number | null = null;
  /** Fingers currently on a touchscreen; two or more means a pinch, not drawing. */
  private touches = new Set<number>();
  private multiTouch = false;
  private needsInitialView: boolean;

  private constructor(noteId: number, model: Model) {
    this.noteId = noteId;
    this.model = model;
    this.needsInitialView = !this.restoreCamera();
  }

  static async open(noteId: number): Promise<Board> {
    const [meta, buf] = await Promise.all([api.loadBoard(noteId), api.loadStrokes(noteId)]);
    return new Board(noteId, Model.load(noteId, meta, decodeStrokes(buf)));
  }

  // ---- canvas lifecycle --------------------------------------------------------

  attach(host: HTMLElement, staticCanvas: HTMLCanvasElement, activeCanvas: HTMLCanvasElement) {
    this.host = host;
    this.layer = new StaticLayer(staticCanvas);
    // desynchronized lets the browser skip compositor sync: lower pen latency.
    this.aCtx = activeCanvas.getContext('2d', { desynchronized: true });
    syncTheme();
  }

  resize(cssW: number, cssH: number) {
    if (cssW === 0 || cssH === 0) return;
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = window.devicePixelRatio || 1;
    this.layer?.resize(cssW, cssH, this.dpr);
    const active = this.aCtx?.canvas;
    if (active) {
      active.width = Math.round(cssW * this.dpr);
      active.height = Math.round(cssH * this.dpr);
    }
    this.refreshRect();

    if (this.needsInitialView) {
      this.needsInitialView = false;
      this.fitAll(false);
    }
    if (this.pendingFocus !== null) {
      const id = this.pendingFocus;
      this.pendingFocus = null;
      this.focusObject(id, true, false);
    }
    this.invalidateAll();
  }

  refreshRect() {
    const r = this.host?.getBoundingClientRect();
    if (r) this.rect = { left: r.left, top: r.top };
  }

  dispose() {
    cancelAnimationFrame(this.frameId);
    cancelAnimationFrame(this.flyFrame);
    clearTimeout(this.sharpenTimer);
    clearTimeout(this.msgTimer);
    clearTimeout(this.camSaveTimer);
    this.saveCamera();
    this.frameId = 0;
  }

  /** Re-reads theme colors and redraws everything. */
  refreshTheme() {
    syncTheme();
    this.invalidateAll();
  }

  // ---- frame scheduling ----------------------------------------------------------

  private invalidateAll() {
    this.layer?.invalidateAll();
    this.needsSync = true;
    this.activeDirty = true;
    this.schedule();
  }

  private invalidateCamera() {
    this.needsSync = true;
    this.activeDirty = true;
    this.scheduleCameraSave();
    this.schedule();
  }

  private invalidateRegions(rects: Bbox[]) {
    if (rects.length === 0) return;
    // Many small rects cost more in clipping than one covering rect.
    if (this.dirty.length + rects.length > 24) {
      this.dirty = [unionBbox([...this.dirty, ...rects])];
    } else {
      this.dirty.push(...rects);
    }
    this.needsSync = true;
    this.schedule();
  }

  private invalidateActive() {
    this.activeDirty = true;
    this.schedule();
  }

  private schedule() {
    if (!this.frameId) this.frameId = requestAnimationFrame(() => this.frame());
  }

  private frame() {
    this.frameId = 0;
    const layer = this.layer;
    if (!layer || this.cssW === 0) return;

    if (this.sharpenDue) {
      this.sharpenDue = false;
      layer.sharpen(this.model, this.cam);
      this.dirty = [];
      this.needsSync = false;
    }
    if (this.needsSync) {
      this.needsSync = false;
      layer.sync(this.model, this.cam, this.dirty);
      this.dirty = [];
      if (layer.blurry) {
        clearTimeout(this.sharpenTimer);
        this.sharpenTimer = setTimeout(() => {
          this.sharpenDue = true;
          this.schedule();
        }, SHARPEN_MS);
      }
      this.updateGrid();
    }
    const zoom = Math.round(this.cam.z * 100);
    if (this.ui.zoom !== zoom) this.ui.zoom = zoom;
    if (this.activeDirty && this.aCtx) {
      this.activeDirty = false;
      drawActive(this.aCtx, this.cam, this.buildView(), this.dpr);
    }
  }

  /** The dot grid is a CSS background on the host: free to draw, follows the camera. */
  private updateGrid() {
    if (!this.host) return;
    let step = 32;
    while (step * this.cam.z < 14) step *= 4;
    while (step * this.cam.z > 120) step /= 4;
    const px = step * this.cam.z;
    const ox = (-this.cam.x * this.cam.z) % px;
    const oy = (-this.cam.y * this.cam.z) % px;
    const st = this.host.style;
    st.setProperty('--grid-size', `${px}px`);
    st.setProperty('--grid-x', `${ox}px`);
    st.setProperty('--grid-y', `${oy}px`);
  }

  private buildView(): ActiveView {
    const v: ActiveView = {};
    const m = this.model;
    const g = this.gesture;
    if (g?.kind === 'pen') v.draft = g.pts;
    if (g?.kind === 'lasso') v.lasso = g.poly;
    if (g?.kind === 'arrow') {
      const from = m.objects.get(g.from);
      if (from) v.arrow = { from, to: g.to, target: g.target !== null ? (m.objects.get(g.target) ?? null) : null };
    }
    const erasing = g?.kind === 'erase' || (!g && this.ui.tool === 'eraser');
    const at = g?.kind === 'erase' ? g.last : this.pointer;
    if (erasing && at) v.eraser = { x: at[0], y: at[1], r: ERASER_PX / this.cam.z };
    if (this.ui.picking) {
      v.picked = this.ui.picking.map((id) => m.strokes.get(id)).filter((s): s is StrokeRec => !!s);
    }
    if (this.ui.hover !== null) v.hover = m.objects.get(this.ui.hover) ?? null;
    if (this.ui.selected !== null) v.selected = m.objects.get(this.ui.selected) ?? null;
    if (this.hoverLink) {
      const a = m.objects.get(this.hoverLink.from_id);
      const b = m.objects.get(this.hoverLink.to_id);
      if (a && b) v.hoverLink = { a, b };
    }
    return v;
  }

  // ---- tools, keys, messages -------------------------------------------------------

  /** Tool to return to when the eraser is swapped back (X). */
  private toolBeforeEraser: Tool = 'pen';

  setTool(t: Tool) {
    if (t === 'eraser' && this.ui.tool !== 'eraser') this.toolBeforeEraser = this.ui.tool;
    this.abortGesture();
    this.ui.picking = null;
    this.ui.tool = t;
    this.hoverLink = null;
    this.updateCursor();
    this.invalidateActive();
  }

  swapPenEraser() {
    this.setTool(this.ui.tool === 'eraser' ? this.toolBeforeEraser : 'eraser');
  }

  setSpace(down: boolean) {
    if (this.spaceDown === down) return;
    this.spaceDown = down;
    this.updateCursor();
  }

  get busy(): boolean {
    return this.gesture !== null;
  }

  say(msg: string) {
    this.ui.message = msg;
    clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => (this.ui.message = ''), 2600);
  }

  /** Escape: drop the naming popover, then an unfinished gesture, then the selection. */
  escape() {
    if (this.ui.picking) {
      this.cancelPick();
    } else if (this.gesture) {
      this.abortGesture();
    } else if (this.ui.selected !== null) {
      this.ui.selected = null;
      this.invalidateActive();
    }
  }

  private updateCursor() {
    const g = this.gesture;
    let c: Cursor;
    if (g?.kind === 'pan') c = 'grabbing';
    else if (this.spaceDown) c = 'grab';
    else if (g?.kind === 'move') c = 'move';
    else if (this.ui.tool === 'pen') c = 'draw';
    else if (this.ui.tool === 'eraser') c = 'erase';
    else if (this.ui.tool === 'lasso') c = 'crosshair';
    else if (this.hoverLink || this.ui.hover !== null) c = this.ui.tool === 'select' && !this.hoverLink ? 'move' : 'pointer';
    else c = this.ui.tool === 'select' ? 'grab' : 'default';
    if (this.ui.cursor !== c) this.ui.cursor = c;
  }

  // ---- pointer input -------------------------------------------------------------

  private local(e: { clientX: number; clientY: number }): Vec {
    return [e.clientX - this.rect.left, e.clientY - this.rect.top];
  }

  private pressure(e: PointerEvent): number {
    return e.pointerType === 'mouse' || !e.pressure ? 0.5 : e.pressure;
  }

  pointerDown(e: PointerEvent) {
    if (e.pointerType === 'touch') {
      this.touches.add(e.pointerId);
      if (this.touches.size > 1) {
        // A second finger turns the touch into a pinch: drop what the first one started.
        this.multiTouch = true;
        this.abortGesture();
        return;
      }
    }
    this.refreshRect();
    this.cancelFly();
    const [sx, sy] = this.local(e);
    const [wx, wy] = this.cam.toWorld(sx, sy);
    const penEraser = e.pointerType === 'pen' && e.button === PEN_ERASER_BUTTON;

    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      this.gesture = { kind: 'pan', sx, sy };
    } else if (e.button === 0 || penEraser) {
      if (this.ui.picking) this.cancelPick();
      const tool: Tool = penEraser ? 'eraser' : this.ui.tool;
      this.gesture = this.startGesture(tool, sx, sy, wx, wy, e);
    }
    this.updateCursor();
    this.invalidateActive();
  }

  private startGesture(tool: Tool, sx: number, sy: number, wx: number, wy: number, e: PointerEvent): Gesture {
    switch (tool) {
      case 'pen':
        return { kind: 'pen', pts: [wx, wy, this.pressure(e)] };
      case 'lasso':
        return { kind: 'lasso', poly: [[wx, wy]] };
      case 'eraser': {
        const g: Gesture = { kind: 'erase', tx: new Tx(this.model), touched: new Set(), last: [wx, wy] };
        this.eraseAt(g, wx, wy);
        return g;
      }
      case 'arrow': {
        const from = this.hitObject(wx, wy);
        if (from !== null) return { kind: 'arrow', from, to: [wx, wy], target: null };
        const link = this.hitLink(sx, sy);
        if (link) return { kind: 'link', link, sx, sy, moved: false };
        return { kind: 'press', sx, sy };
      }
      case 'select': {
        const id = this.hitObject(wx, wy);
        if (id !== null) {
          this.ui.selected = id;
          return {
            kind: 'move',
            objectId: id,
            strokeIds: this.model.strokesOf(id).map((s) => s.id),
            start: [wx, wy],
            applied: [0, 0],
            tx: new Tx(this.model),
            moved: false,
          };
        }
        const link = this.hitLink(sx, sy);
        if (link) return { kind: 'link', link, sx, sy, moved: false };
        return { kind: 'press', sx, sy };
      }
    }
  }

  pointerMove(e: PointerEvent) {
    if (this.multiTouch && e.pointerType === 'touch') return;
    const [sx, sy] = this.local(e);
    const [wx, wy] = this.cam.toWorld(sx, sy);
    this.pointer = [wx, wy];
    const g = this.gesture;

    if (!g) {
      this.updateHover(sx, sy, wx, wy);
      if (this.ui.tool === 'eraser') this.invalidateActive();
      return;
    }

    // Coalesced events keep pen input complete even when frames are dropped.
    const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    if (samples.length === 0) samples.push(e);

    switch (g.kind) {
      case 'pan':
        this.cam.panBy(sx - g.sx, sy - g.sy);
        g.sx = sx;
        g.sy = sy;
        this.invalidateCamera();
        return;
      case 'press':
        if (Math.hypot(sx - g.sx, sy - g.sy) > DRAG_START_PX) {
          this.gesture = { kind: 'pan', sx: g.sx, sy: g.sy };
          this.updateCursor();
          this.pointerMove(e);
        }
        return;
      case 'pen':
        for (const s of samples) {
          const [px, py] = this.local(s);
          const [qx, qy] = this.cam.toWorld(px, py);
          g.pts.push(qx, qy, this.pressure(s));
        }
        break;
      case 'lasso': {
        const last = g.poly[g.poly.length - 1];
        if (Math.hypot(wx - last[0], wy - last[1]) * this.cam.z > 2) g.poly.push([wx, wy]);
        break;
      }
      case 'arrow': {
        g.to = [wx, wy];
        const t = this.hitObject(wx, wy);
        g.target = t !== g.from ? t : null;
        break;
      }
      case 'erase':
        for (const s of samples) {
          const [px, py] = this.local(s);
          const [qx, qy] = this.cam.toWorld(px, py);
          this.eraseAlong(g, qx, qy);
        }
        break;
      case 'move': {
        const dx = wx - g.start[0];
        const dy = wy - g.start[1];
        if (!g.moved && Math.hypot(dx, dy) * this.cam.z < DRAG_START_PX) break;
        g.moved = true;
        this.shiftObject(g, dx - g.applied[0], dy - g.applied[1]);
        g.applied = [dx, dy];
        break;
      }
      case 'link':
        if (Math.hypot(sx - g.sx, sy - g.sy) > DRAG_START_PX) g.moved = true;
        break;
    }
    this.invalidateActive();
  }

  pointerUp(e: PointerEvent) {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.multiTouch) {
        if (this.touches.size === 0) this.multiTouch = false;
        return;
      }
    }
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;

    switch (g.kind) {
      case 'pen':
        this.finishPen(g.pts);
        break;
      case 'lasso':
        this.finishLasso(g.poly);
        break;
      case 'arrow':
        this.finishArrow(g);
        break;
      case 'erase':
        this.finishErase(g);
        break;
      case 'move':
        if (g.moved) this.commitTx(g.tx, false);
        break;
      case 'link':
        if (!g.moved) this.focusObject(g.link.to_id, true);
        break;
      case 'press':
        this.ui.selected = null;
        break;
    }
    this.updateCursor();
    this.invalidateActive();
  }

  pointerLeave() {
    this.pointer = null;
    if (!this.gesture) {
      this.setHover(null);
      this.hoverLink = null;
      this.invalidateActive();
    }
  }

  wheel(e: WheelEvent) {
    e.preventDefault();
    this.cancelFly();
    const [sx, sy] = this.local(e);
    // Trackpads send pixel deltas, mice send lines; normalize to pixels.
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    // Browsers report a pinch as ctrl+wheel with small deltas; scale it up to feel 1:1.
    const k = e.ctrlKey ? 0.01 : 0.0018;
    this.cam.zoomAt(sx, sy, Math.exp(-delta * k));
    this.invalidateCamera();
  }

  /** Pinch step from the backend, at a viewport point in CSS pixels. */
  pinch(clientX: number, clientY: number, factor: number) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.refreshRect();
    this.cancelFly();
    const [sx, sy] = this.local({ clientX, clientY });
    this.cam.zoomAt(sx, sy, factor);
    this.invalidateCamera();
  }

  /** Undoes the live effects of an unfinished gesture (Escape mid-drag). */
  private abortGesture() {
    const g = this.gesture;
    this.gesture = null;
    if (g && (g.kind === 'move' || g.kind === 'erase')) {
      const entries = g.tx.changes();
      this.invalidateRegions(this.regionsFor(entries, true));
      applyEntries(this.model, invert(entries));
      this.invalidateRegions(this.regionsFor(entries, true));
    }
    this.updateCursor();
    this.invalidateActive();
  }

  // ---- hover & hit testing ----------------------------------------------------------

  private updateHover(sx: number, sy: number, wx: number, wy: number) {
    const tool = this.ui.tool;
    const interactive = tool === 'select' || tool === 'arrow';
    const obj = interactive ? this.hitObject(wx, wy) : null;
    const link = interactive && obj === null ? this.hitLink(sx, sy) : null;
    if (obj !== this.ui.hover || link !== this.hoverLink) {
      this.ui.hover = obj;
      this.hoverLink = link;
      this.updateCursor();
      this.invalidateActive();
    }
  }

  /** Highlights an object's frame; used when hovering rows in the side panel. */
  setHover(id: number | null) {
    if (this.ui.hover === id) return;
    this.ui.hover = id;
    this.invalidateActive();
  }

  /** Smallest-area object whose frame contains the point (the spec's tie-break). */
  hitObject(wx: number, wy: number): number | null {
    let best: number | null = null;
    let bestArea = Infinity;
    for (const o of this.model.objects.values()) {
      if (!inBbox(frameOf(o, this.cam.z), wx, wy)) continue;
      const area = bboxArea(o.bbox);
      if (area < bestArea) {
        bestArea = area;
        best = o.id;
      }
    }
    return best;
  }

  private hitLink(sx: number, sy: number): LinkRec | null {
    let best: LinkRec | null = null;
    let bestD = LINK_HIT_PX;
    for (const l of this.model.links.values()) {
      const a = this.model.objects.get(l.from_id);
      const b = this.model.objects.get(l.to_id);
      if (!a || !b) continue;
      const [p1, p2] = linkGeometry(a, b, this.cam.z);
      const [x1, y1] = this.cam.toScreen(p1[0], p1[1]);
      const [x2, y2] = this.cam.toScreen(p2[0], p2[1]);
      const d = distToSegment(sx, sy, x1, y1, x2, y2);
      if (d <= bestD) {
        bestD = d;
        best = l;
      }
    }
    return best;
  }

  // ---- gestures ----------------------------------------------------------------------

  private finishPen(pts: number[]) {
    const tx = new Tx(this.model);
    tx.putStroke(makeStroke(newId((id) => this.model.taken(id)), null, Float32Array.from(pts)));
    this.commitTx(tx);
  }

  private finishLasso(poly: Vec[]) {
    if (poly.length < 3) return;
    const picked: StrokeRec[] = [];
    let inObjects = 0;
    for (const s of this.model.strokesIn(polyBbox(poly))) {
      if (fractionInside(s.pts, poly) < LASSO_COVERAGE) continue;
      if (s.object_id === null) picked.push(s);
      else inObjects++;
    }
    if (picked.length === 0) {
      this.say(inObjects ? 'Эти штрихи уже входят в объект' : 'Обведите штрихи, чтобы создать объект');
      return;
    }
    const b = unionBbox(picked.map((s) => s.bbox));
    const [ax, ay] = this.cam.toScreen((b[0] + b[2]) / 2, b[3]);
    this.ui.pickAnchor = { x: ax, y: ay };
    this.ui.picking = picked.map((s) => s.id);
    this.invalidateActive();
  }

  /** Called by the naming popover: turns the lasso selection into an object. */
  createObject(label: string, tags: string) {
    const ids = this.ui.picking;
    this.ui.picking = null;
    if (!ids) return;
    const strokes = ids
      .map((id) => this.model.strokes.get(id))
      .filter((s): s is StrokeRec => !!s && s.object_id === null);
    if (strokes.length === 0) return;

    const tx = new Tx(this.model);
    const id = newId((x) => this.model.taken(x));
    for (const s of strokes) tx.putStroke({ ...s, object_id: id });
    tx.putObject(objectFromStrokes({ id, label: label.trim(), tags: normalizeTags(tags) }, strokes));
    this.ui.selected = id;
    this.commitTx(tx);
  }

  cancelPick() {
    this.ui.picking = null;
    this.invalidateActive();
  }

  private finishArrow(g: Extract<Gesture, { kind: 'arrow' }>) {
    const to = g.target;
    if (to === null) {
      const from = this.model.objects.get(g.from);
      const moved = from && !inBbox(frameOf(from, this.cam.z), g.to[0], g.to[1]);
      if (moved) this.say('Отпустите стрелку на другом объекте');
      return;
    }
    if (this.model.links.has(linkKey(g.from, to, 'ref'))) {
      this.say('Эта связь уже есть');
      return;
    }
    const tx = new Tx(this.model);
    tx.putLink({ from_id: g.from, to_id: to, kind: 'ref' });
    this.commitTx(tx);
  }

  /** Erases along the segment from the last sample, so fast strokes leave no gaps. */
  private eraseAlong(g: Extract<Gesture, { kind: 'erase' }>, x: number, y: number) {
    const [lx, ly] = g.last;
    const r = ERASER_PX / this.cam.z;
    const steps = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / (r / 2)));
    for (let i = 1; i <= steps; i++) {
      this.eraseAt(g, lx + ((x - lx) * i) / steps, ly + ((y - ly) * i) / steps);
    }
    g.last = [x, y];
  }

  private eraseAt(g: Extract<Gesture, { kind: 'erase' }>, x: number, y: number) {
    const r = ERASER_PX / this.cam.z;
    const reach = r + STROKE_SIZE / 2;
    const gone: Bbox[] = [];
    for (const s of this.model.strokesIn([x - r, y - r, x + r, y + r])) {
      if (!polylineNear(s.pts, x, y, reach)) continue;
      g.tx.deleteStroke(s.id);
      gone.push(s.bbox);
      if (s.object_id !== null) g.touched.add(s.object_id);
    }
    this.invalidateRegions(gone);
  }

  private finishErase(g: Extract<Gesture, { kind: 'erase' }>) {
    // An object with no strokes left is removed together with its links.
    for (const oid of g.touched) {
      if (this.model.objects.has(oid) && this.model.strokesOf(oid).length === 0) {
        g.tx.deleteObjectCascade(oid);
      }
    }
    this.commitTx(g.tx, 'objects');
  }

  /** Moves an object's strokes; its bbox is recomputed from the moved strokes. */
  private shiftObject(g: Extract<Gesture, { kind: 'move' }>, dx: number, dy: number) {
    if (dx === 0 && dy === 0) return;
    const o = this.model.objects.get(g.objectId);
    if (!o) return;
    const before = this.objectArea(o);
    const moved: StrokeRec[] = [];
    for (const sid of g.strokeIds) {
      const s = this.model.strokes.get(sid);
      if (!s) continue;
      const pts = new Float32Array(s.pts);
      for (let i = 0; i < pts.length; i += 3) {
        pts[i] += dx;
        pts[i + 1] += dy;
      }
      const next = makeStroke(s.id, s.object_id, pts);
      g.tx.putStroke(next);
      moved.push(next);
    }
    const next = objectFromStrokes(o, moved);
    g.tx.putObject(next);
    this.invalidateRegions([...before, ...this.objectArea(next)]);
  }

  /** World rects covering an object's frame, label and every link line touching it. */
  private objectArea(o: ObjRec, lookup = (id: number) => this.model.objects.get(id)): Bbox[] {
    const z = this.cam.z;
    const own = objectRegion(o, z);
    const out = [own];
    for (const l of this.model.linksOf(o.id)) {
      const other = lookup(l.from_id === o.id ? l.to_id : l.from_id);
      if (other) out.push(unionBbox([own, objectRegion(other, z)]));
    }
    return out;
  }

  /** World rects to redraw after `entries`, before and after states both included. */
  private regionsFor(entries: Entry[], includeStrokes: boolean): Bbox[] {
    const z = this.cam.z;
    const touched = new Map<number, ObjRec>();
    for (const e of entries) {
      if (e.kind !== 'o') continue;
      for (const rec of [e.before, e.after]) if (rec) touched.set((rec as ObjRec).id, rec as ObjRec);
    }
    const lookup = (id: number) => this.model.objects.get(id) ?? touched.get(id);

    const out: Bbox[] = [];
    for (const e of entries) {
      for (const rec of [e.before, e.after]) {
        if (!rec) continue;
        if (e.kind === 's') {
          if (includeStrokes) out.push((rec as StrokeRec).bbox);
        } else if (e.kind === 'o') {
          out.push(...this.objectArea(rec as ObjRec, lookup));
        } else {
          const l = rec as LinkRec;
          const a = lookup(l.from_id);
          const b = lookup(l.to_id);
          if (a && b) out.push(unionBbox([objectRegion(a, z), objectRegion(b, z)]));
        }
      }
    }
    return out;
  }

  // ---- edits from the side panel ------------------------------------------------------

  updateObject(id: number, label: string, tags: string) {
    const o = this.model.objects.get(id);
    if (!o) return;
    const next = { ...o, label: label.trim(), tags: normalizeTags(tags) };
    if (next.label === o.label && next.tags === o.tags) return;
    const tx = new Tx(this.model);
    tx.putObject(next);
    this.commitTx(tx);
  }

  deleteObject(id: number) {
    if (!this.model.objects.has(id)) return;
    const tx = new Tx(this.model);
    tx.deleteObjectCascade(id);
    this.commitTx(tx);
    this.say('Объект удалён. Ctrl+Z вернёт его');
  }

  deleteSelected() {
    if (this.ui.selected !== null) this.deleteObject(this.ui.selected);
  }

  removeLink(l: LinkRec) {
    const tx = new Tx(this.model);
    tx.deleteLink(l);
    this.commitTx(tx);
  }

  select(id: number | null) {
    this.ui.selected = id;
    this.invalidateActive();
  }

  // ---- camera ----------------------------------------------------------------------

  private cancelFly() {
    cancelAnimationFrame(this.flyFrame);
    this.flyFrame = 0;
  }

  private flyTo(target: Camera, animate = true) {
    this.cancelFly();
    if (!animate) {
      this.cam.x = target.x;
      this.cam.y = target.y;
      this.cam.z = target.z;
      this.invalidateCamera();
      return;
    }
    // Interpolate the world-space center, not the corner, so the path looks straight.
    const from = { cx: this.cam.x + this.cssW / (2 * this.cam.z), cy: this.cam.y + this.cssH / (2 * this.cam.z), z: this.cam.z };
    const to = { cx: target.x + this.cssW / (2 * target.z), cy: target.y + this.cssH / (2 * target.z), z: target.z };
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / FLY_MS);
      const e = 1 - Math.pow(1 - t, 3);
      const z = from.z * Math.pow(to.z / from.z, e);
      this.cam.centerOn(from.cx + (to.cx - from.cx) * e, from.cy + (to.cy - from.cy) * e, this.cssW, this.cssH, z);
      this.invalidateCamera();
      this.flyFrame = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.flyFrame = requestAnimationFrame(step);
  }

  /** Flies to an object, zooming out only as far as needed for it to fit. */
  focusObject(id: number, select: boolean, animate = true) {
    const o = this.model.objects.get(id);
    if (!o) return;
    if (this.cssW === 0) {
      this.pendingFocus = id;
      return;
    }
    if (select) this.ui.selected = id;
    const frame = objectRegion(o, this.cam.z);
    const z = Math.min(Camera.fitZoom(frame, this.cssW, this.cssH, Camera.MAX_Z, 0.7), Math.max(this.cam.z, 1));
    const target = new Camera();
    const [cx, cy] = bboxCenter(frame);
    target.centerOn(cx, cy, this.cssW, this.cssH, z);
    this.flyTo(target, animate);
    this.invalidateActive();
  }

  fitAll(animate = true) {
    const b = this.model.contentBbox();
    const target = new Camera();
    if (!b) {
      target.centerOn(0, 0, this.cssW, this.cssH, 1);
    } else {
      const [cx, cy] = bboxCenter(b);
      target.centerOn(cx, cy, this.cssW, this.cssH, Camera.fitZoom(b, this.cssW, this.cssH, 1.5, 0.85));
    }
    this.flyTo(target, animate);
  }

  zoomBy(factor: number) {
    const target = this.cam.clone();
    target.zoomAt(this.cssW / 2, this.cssH / 2, factor);
    this.flyTo(target);
  }

  zoomReset() {
    const target = this.cam.clone();
    target.zoomAt(this.cssW / 2, this.cssH / 2, 1 / this.cam.z);
    this.flyTo(target);
  }

  private restoreCamera(): boolean {
    try {
      const raw = localStorage.getItem(cameraKey(this.noteId));
      if (!raw) return false;
      const { x, y, z } = JSON.parse(raw);
      if (![x, y, z].every(Number.isFinite)) return false;
      Object.assign(this.cam, { x, y, z });
      return true;
    } catch {
      return false;
    }
  }

  private scheduleCameraSave() {
    clearTimeout(this.camSaveTimer);
    this.camSaveTimer = setTimeout(() => this.saveCamera(), 500);
  }

  private saveCamera() {
    try {
      localStorage.setItem(cameraKey(this.noteId), JSON.stringify({ x: this.cam.x, y: this.cam.y, z: this.cam.z }));
    } catch {
      // Storage can be unavailable; the camera simply is not remembered then.
    }
  }

  // ---- undo / redo / persistence ---------------------------------------------------

  /**
   * Records and saves one action. `redraw` says which parts still need repainting:
   * gestures that already repainted live (move, erase) skip what they drew.
   */
  private commitTx(tx: Tx, redraw: 'all' | 'objects' | false = 'all') {
    const entries = tx.changes();
    if (entries.length === 0) return;
    if (redraw) this.invalidateRegions(this.regionsFor(entries, redraw === 'all'));
    this.undoStack.push(entries);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.persist(entries);
    this.afterChange();
  }

  undo() {
    if (this.gesture) return;
    const entries = this.undoStack.pop();
    if (!entries) return;
    this.replay(invert(entries));
    this.redoStack.push(entries);
    this.afterChange();
  }

  redo() {
    if (this.gesture) return;
    const entries = this.redoStack.pop();
    if (!entries) return;
    this.replay(entries);
    this.undoStack.push(entries);
    this.afterChange();
  }

  private replay(entries: Entry[]) {
    this.invalidateRegions(this.regionsFor(entries, true));
    applyEntries(this.model, entries);
    this.invalidateRegions(this.regionsFor(entries, true));
    this.persist(entries);
  }

  private persist(entries: Entry[]) {
    const patch = toPatch(this.noteId, entries);
    this.pendingSaves++;
    this.ui.saving = true;
    // Chained so the database applies actions in the order they happened.
    this.saveChain = this.saveChain
      .then(() => api.commit(patch))
      .then(() => {
        this.ui.saveError = '';
      })
      .catch((err) => {
        this.ui.saveError = String(err);
        this.say(`Не удалось сохранить: ${String(err)}`);
      })
      .finally(() => {
        this.pendingSaves--;
        if (this.pendingSaves === 0) this.ui.saving = false;
      });
  }

  /** Resolves once every queued write has reached the database. */
  flush(): Promise<void> {
    return this.saveChain;
  }

  private afterChange() {
    if (this.ui.selected !== null && !this.model.objects.has(this.ui.selected)) this.ui.selected = null;
    if (this.ui.hover !== null && !this.model.objects.has(this.ui.hover)) this.ui.hover = null;
    if (this.hoverLink && !this.model.links.has(linkKey(this.hoverLink.from_id, this.hoverLink.to_id, this.hoverLink.kind))) {
      this.hoverLink = null;
    }
    this.ui.version++;
    this.ui.canUndo = this.undoStack.length > 0;
    this.ui.canRedo = this.redoStack.length > 0;
    this.invalidateActive();
  }
}
