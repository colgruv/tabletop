// Everything Three.js lives in this folder, so API churn between releases stays local.
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TABLE_HALF_SIZE, type TableState, type Token } from "@tabletop/shared";

const MAX_TOKENS = 256;
const TOKEN_RADIUS = 0.45;
const TOKEN_HEIGHT = 0.3;
const GLIDE_MS = 250;

export interface SceneCallbacks {
  /** User dropped a token. Resolve with the seq that will contain the move, or null if it was rejected. */
  onMove(id: string, x: number, z: number): Promise<number | null>;
  onSelect(id: string | null): void;
}

interface Glide {
  fromX: number;
  fromZ: number;
  start: number;
}

/** A drag that has been dropped but whose event hasn't come back from the log yet. */
interface Pending {
  x: number;
  z: number;
  /** null while the POST is still in flight. */
  seq: number | null;
}

export class TableScene {
  readonly backend: "WebGPU" | "WebGL2";

  private renderer: THREE.WebGPURenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  private controls: OrbitControls;
  private tokens: THREE.InstancedMesh;
  private ring: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private matrix = new THREE.Matrix4();
  private hit = new THREE.Vector3();
  private color = new THREE.Color();

  private state: TableState | null = null;
  private ids: string[] = [];
  private shown = new Map<string, { x: number; z: number }>();
  private glides = new Map<string, Glide>();
  private pending = new Map<string, Pending>();
  private drag: { id: string; pointerId: number; moved: boolean } | null = null;
  private selected: string | null = null;
  private labels = new Map<string, HTMLDivElement>();

  private frameRequested = false;

  private constructor(
    private canvas: HTMLCanvasElement,
    private labelLayer: HTMLElement,
    private cb: SceneCallbacks,
    renderer: THREE.WebGPURenderer,
  ) {
    this.renderer = renderer;
    this.backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? "WebGPU" : "WebGL2";
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene.background = new THREE.Color(0x1d2126);
    this.camera.position.set(0, 16, 16);

    // Simple, cheap lighting. No shadows on the low-end budget.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(6, 12, 4);
    this.scene.add(sun);

    const size = TABLE_HALF_SIZE * 2;
    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x3b5d46, roughness: 0.95 }),
    );
    this.scene.add(table);
    const grid = new THREE.GridHelper(size, size, 0x6f8f78, 0x557560);
    grid.position.y = 0.002;
    this.scene.add(grid);

    this.tokens = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(TOKEN_RADIUS, TOKEN_RADIUS, TOKEN_HEIGHT, 32),
      new THREE.MeshStandardMaterial({ roughness: 0.5 }),
      MAX_TOKENS,
    );
    this.tokens.count = 0;
    this.tokens.setColorAt(0, this.color); // allocate the per-instance color buffer
    this.scene.add(this.tokens);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(TOKEN_RADIUS + 0.08, TOKEN_RADIUS + 0.18, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd166 }),
    );
    this.ring.position.y = 0.01;
    this.ring.visible = false;
    this.scene.add(this.ring);

    // Register before OrbitControls so we can claim pointerdown on a token first.
    canvas.addEventListener("pointerdown", this.onPointerDown, { capture: true });
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 45;
    this.controls.addEventListener("change", this.requestRender);

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  static async create(canvas: HTMLCanvasElement, labelLayer: HTMLElement, cb: SceneCallbacks): Promise<TableScene> {
    // Uses WebGPU when available and falls back to WebGL2 automatically. ?webgl forces the fallback for testing.
    const forceWebGL = new URLSearchParams(location.search).has("webgl");
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
    await renderer.init();
    return new TableScene(canvas, labelLayer, cb, renderer);
  }

  /** Show a new table state. Cheap to call; only redraws if needed. */
  sync(state: TableState): void {
    const prev = this.state;
    this.state = state;
    const now = performance.now();

    for (const [id, p] of this.pending) {
      if (!state.tokens[id] || (p.seq !== null && p.seq <= state.seq)) this.pending.delete(id);
    }

    this.ids = Object.keys(state.tokens);
    for (const id of this.ids) {
      const t = state.tokens[id]!;
      const before = prev?.tokens[id];
      const from = this.shown.get(id);
      // Animate moves made by others; snap anything we just dragged ourselves.
      if (before && from && (before.x !== t.x || before.z !== t.z) && !this.pending.has(id)) {
        this.glides.set(id, { fromX: from.x, fromZ: from.z, start: now });
      }
    }
    for (const id of [...this.shown.keys()]) {
      if (!state.tokens[id]) {
        this.shown.delete(id);
        this.glides.delete(id);
        this.labels.get(id)?.remove();
        this.labels.delete(id);
      }
    }
    if (this.selected && !state.tokens[this.selected]) this.select(null);

    this.requestRender();
  }

  select(id: string | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.cb.onSelect(id);
    this.requestRender();
  }

  requestRender = (): void => {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(this.frame);
  };

  private frame = (now: number): void => {
    this.frameRequested = false;
    const dampingActive = this.controls.update();
    const animating = this.layoutTokens(now);
    this.renderer.render(this.scene, this.camera);
    this.layoutLabels();
    if (dampingActive || animating) this.requestRender();
  };

  /** Write instance matrices and colors. Returns true while any glide is still running. */
  private layoutTokens(now: number): boolean {
    if (!this.state) return false;
    let animating = false;

    this.ids.forEach((id, i) => {
      const t = this.state!.tokens[id]!;
      let x = t.x;
      let z = t.z;
      const p = this.pending.get(id);
      const g = this.glides.get(id);
      if (p) {
        x = p.x;
        z = p.z;
      } else if (g) {
        const k = Math.min(1, (now - g.start) / GLIDE_MS);
        const e = 1 - (1 - k) ** 3;
        x = g.fromX + (t.x - g.fromX) * e;
        z = g.fromZ + (t.z - g.fromZ) * e;
        if (k < 1) animating = true;
        else this.glides.delete(id);
      }
      const lifted = this.drag?.id === id ? 0.25 : 0;
      this.shown.set(id, { x, z });
      this.matrix.makeTranslation(x, TOKEN_HEIGHT / 2 + lifted, z);
      this.tokens.setMatrixAt(i, this.matrix);
      this.tokens.setColorAt(i, this.color.set(t.color));
      if (id === this.selected) this.ring.position.set(x, 0.01, z);
    });

    this.tokens.count = this.ids.length;
    this.tokens.instanceMatrix.needsUpdate = true;
    if (this.tokens.instanceColor) this.tokens.instanceColor.needsUpdate = true;
    this.tokens.computeBoundingSphere();
    this.ring.visible = this.selected !== null && this.shown.has(this.selected);
    return animating;
  }

  /** HTML name labels positioned over each token. */
  private layoutLabels(): void {
    if (!this.state) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const v = new THREE.Vector3();
    for (const id of this.ids) {
      const t: Token = this.state.tokens[id]!;
      const pos = this.shown.get(id)!;
      let el = this.labels.get(id);
      if (!el) {
        el = document.createElement("div");
        el.className = "token-label";
        this.labelLayer.appendChild(el);
        this.labels.set(id, el);
      }
      if (el.textContent !== t.name) el.textContent = t.name;
      v.set(pos.x, TOKEN_HEIGHT + 0.35, pos.z).project(this.camera);
      const visible = v.z < 1;
      el.style.display = visible ? "" : "none";
      if (visible) el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    }
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Widen the view on portrait screens so the table still fits across.
    this.camera.fov = this.camera.aspect < 1 ? Math.min(75, 45 / Math.sqrt(this.camera.aspect)) : 45;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private setPointer(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.drag || !e.isPrimary || e.button !== 0) return;
    this.setPointer(e);
    const hit = this.raycaster.intersectObject(this.tokens, false)[0];
    const id = hit?.instanceId !== undefined ? this.ids[hit.instanceId] : undefined;
    if (!id) {
      this.select(null);
      return;
    }
    // Claim this gesture: keep OrbitControls from rotating the camera.
    e.stopImmediatePropagation();
    this.controls.enabled = false;
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { id, pointerId: e.pointerId, moved: false };
    this.select(id);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    this.setPointer(e);
    if (!this.raycaster.ray.intersectPlane(this.plane, this.hit)) return;
    const lim = TABLE_HALF_SIZE - TOKEN_RADIUS;
    const x = THREE.MathUtils.clamp(this.hit.x, -lim, lim);
    const z = THREE.MathUtils.clamp(this.hit.z, -lim, lim);
    this.drag.moved = true;
    this.glides.delete(this.drag.id);
    this.pending.set(this.drag.id, { x, z, seq: null });
    this.requestRender();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const { id, moved } = this.drag;
    this.drag = null;
    this.controls.enabled = true;
    this.requestRender();

    const p = this.pending.get(id);
    if (!moved || !p) return;
    // Round to keep the log tidy.
    const x = Math.round(p.x * 100) / 100;
    const z = Math.round(p.z * 100) / 100;
    p.x = x;
    p.z = z;
    void this.cb.onMove(id, x, z).then((seq) => {
      if (this.pending.get(id) !== p) return; // a newer drag replaced it
      if (seq === null || (this.state && seq <= this.state.seq)) this.pending.delete(id);
      else p.seq = seq;
      this.requestRender();
    });
  };
}
