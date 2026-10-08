// The stage of 琴室: darkness all round and one spotlight from above on the piano - a visible beam with dust drifting in
// it, a warm pool of light on a dark lacquered floor, a faint cool rim from behind - the camera slowly drifting until
// she takes it. Keys go down with the music and glow a little when struck; a tap on a key plays it.
import * as T from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createPiano, type PianoModel } from './pianoModel';

/** Something on the stage that moves with the music (a pianist on the keys): told of every key, updated every frame. */
export type Performer = { onNote: (midi: number, down: boolean, velocity?: number) => void; update: (dt: number) => void; dispose: () => void };

const BEAM_VERT = `
varying vec3 vNormalW; varying vec3 vPosW; varying float vH;
uniform float uHeight;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPosW = w.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vH = (position.y + uHeight * 0.5) / uHeight; // 0 at the bottom, 1 at the lamp
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const BEAM_FRAG = `
varying vec3 vNormalW; varying vec3 vPosW; varying float vH;
uniform vec3 uColor; uniform float uOpacity;
void main() {
  vec3 view = normalize(cameraPosition - vPosW);
  float edge = pow(abs(dot(normalize(vNormalW), view)), 1.6); // soft at the cone's silhouette
  float fall = smoothstep(0.0, 0.35, vH) * (0.35 + 0.65 * vH); // fades toward the floor
  gl_FragColor = vec4(uColor, uOpacity * edge * fall);
}`;

export class PianoStage {
  readonly piano: PianoModel;
  private renderer: T.WebGLRenderer;
  private scene = new T.Scene();
  private camera = new T.PerspectiveCamera(32, 1, 0.05, 60);
  private controls: OrbitControls;
  private down = new Map<number, number>();
  private glow = new Map<number, number>();
  private dust: T.Points;
  private clock = new T.Clock();
  private frame = 0;
  private ray = new T.Raycaster();
  private keyMeshes: T.Mesh[];
  private resizeObs: ResizeObserver;
  private lidOpen = true;
  private idleSince = 0;
  private disposables: { dispose: () => void }[] = [];
  private performers: Performer[] = [];

  constructor(private host: HTMLElement) {
    const r = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = T.PCFSoftShadowMap;
    r.toneMapping = T.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.setClearColor(0x040302, 1);
    host.appendChild(r.domElement);
    this.renderer = r;

    this.scene.background = new T.Color(0x040302);
    this.scene.fog = new T.FogExp2(0x040302, 0.06);
    // a dim environment only for the reflections on lacquer and gold
    const pmrem = new T.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.16;
    pmrem.dispose();

    // the spotlight from above, a little in front
    const spot = new T.SpotLight(0xffe2b8, 140, 16, 0.27, 0.5, 1.3);
    spot.position.set(0.35, 7.5, 1.0);
    spot.target.position.set(0, 0.6, -0.25);
    spot.castShadow = true;
    spot.shadow.mapSize.set(2048, 2048);
    spot.shadow.bias = -0.0002;
    spot.shadow.normalBias = 0.01;
    spot.shadow.radius = 5;
    this.scene.add(spot, spot.target);
    // a faint cool rim from behind, to draw the silhouette out of the dark
    const rim = new T.DirectionalLight(0x8fa6d8, 0.55);
    rim.position.set(-1.2, 0.9, -6); // grazing: it outlines the piano without lighting the floor
    this.scene.add(rim);
    // a whisper of fill so the keys never go dead black
    this.scene.add(new T.HemisphereLight(0x2a1c10, 0x000000, 0.35));

    // the floor: dark lacquered stage boards, a warm pool of light under the piano
    const floorMat = new T.MeshStandardMaterial({ color: 0x0a0705, roughness: 0.42, metalness: 0, envMapIntensity: 0 });
    const floor = new T.Mesh(new T.CircleGeometry(14, 64), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const poolCanvas = document.createElement('canvas');
    poolCanvas.width = poolCanvas.height = 256;
    const pg = poolCanvas.getContext('2d')!;
    const grad = pg.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,214,160,0.55)'); grad.addColorStop(0.5, 'rgba(255,190,120,0.18)'); grad.addColorStop(1, 'rgba(255,190,120,0)');
    pg.fillStyle = grad; pg.fillRect(0, 0, 256, 256);
    const poolTex = new T.CanvasTexture(poolCanvas);
    const pool = new T.Mesh(new T.PlaneGeometry(4.4, 4.4), new T.MeshBasicMaterial({ map: poolTex, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0.05, 0.004, -0.2);
    this.scene.add(pool);
    this.disposables.push(floorMat, floor.geometry, poolTex, pool.geometry, pool.material as T.Material);

    // the beam: an open cone, brightest near the lamp, soft at its edges
    const height = 7.6, radius = Math.tan(0.27) * height;
    const beamGeo = new T.CylinderGeometry(0.12, radius, height, 64, 1, true);
    const beamMat = new T.ShaderMaterial({
      vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide,
      uniforms: { uColor: { value: new T.Color(0xffd9a8) }, uOpacity: { value: 0.18 }, uHeight: { value: height } },
    });
    const beam = new T.Mesh(beamGeo, beamMat);
    // align the cone's axis with the light: from the lamp to its target
    const axis = spot.position.clone().sub(spot.target.position).normalize();
    beam.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), axis);
    beam.position.copy(spot.target.position.clone().addScaledVector(axis, height / 2 - 0.7));
    this.scene.add(beam);
    this.disposables.push(beamGeo, beamMat);

    // dust in the light
    const n = 520, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = Math.random(), a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * (0.3 + t * 1.6);
      pos.set([spot.target.position.x + Math.cos(a) * rr, 0.2 + (1 - t) * 4.8, spot.target.position.z + Math.sin(a) * rr], i * 3);
    }
    const dustGeo = new T.BufferGeometry();
    dustGeo.setAttribute('position', new T.BufferAttribute(pos, 3));
    const dot = document.createElement('canvas');
    dot.width = dot.height = 32;
    const dg = dot.getContext('2d')!;
    const dgr = dg.createRadialGradient(16, 16, 0, 16, 16, 16);
    dgr.addColorStop(0, 'rgba(255,236,200,1)'); dgr.addColorStop(1, 'rgba(255,236,200,0)');
    dg.fillStyle = dgr; dg.fillRect(0, 0, 32, 32);
    const dotTex = new T.CanvasTexture(dot);
    const dustMat = new T.PointsMaterial({ size: 0.022, map: dotTex, transparent: true, opacity: 0.55, depthWrite: false, blending: T.AdditiveBlending, color: 0xffe6c0 });
    this.dust = new T.Points(dustGeo, dustMat);
    this.scene.add(this.dust);
    this.disposables.push(dustGeo, dustMat, dotTex);

    // the piano
    this.piano = createPiano();
    this.piano.root.rotation.y = -0.35;
    this.scene.add(this.piano.root);
    this.keyMeshes = [...this.piano.keys.values()].map((p) => p.children[0] as T.Mesh);

    // the camera: three-quarter view from the bench side, slowly drifting until she takes it
    this.camera.position.set(4.6, 2.9, 4.9);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.target.set(0, 0.75, -0.2);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.6;
    this.controls.maxDistance = 9;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = 1.45;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.25;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; this.idleSince = 0; });
    this.controls.addEventListener('end', () => { this.idleSince = this.clock.elapsedTime; });

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.resize();
    this.loop();
  }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    // a narrow phone sees the whole piano: step back
    this.camera.fov = w / h < 0.8 ? 44 : 32;
    this.camera.updateProjectionMatrix();
  }

  /** A key goes down (and glows by how hard it was struck) or comes up. */
  setKey(midi: number, isDown: boolean, velocity = 0.75) {
    for (const p of this.performers) p.onNote(midi, isDown, velocity);
    if (isDown) { this.down.set(midi, velocity); this.glow.set(midi, Math.max(this.glow.get(midi) ?? 0, 0.35 + velocity * 0.65)); }
    else this.down.delete(midi);
  }

  /** Which key is under this point of the screen. */
  keyAt(clientX: number, clientY: number): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new T.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.intersectObjects(this.keyMeshes, false)[0];
    return hit ? (hit.object.userData.midi as number) : null;
  }

  /** Look at the keyboard (close, from the bench) or the whole piano. */
  view(which: 'hero' | 'keys') {
    this.controls.autoRotate = which === 'hero';
    // the keyboard view looks at middle C from the bench, whichever way the piano is turned
    const mid = this.piano.keys.get(62)!.getWorldPosition(new T.Vector3()).add(new T.Vector3(0, 0.03, 0.12));
    const benchward = new T.Vector3(0.35, 0, 1).applyAxisAngle(new T.Vector3(0, 1, 0), this.piano.root.rotation.y).normalize();
    const toPos = which === 'keys' ? mid.clone().addScaledVector(benchward, 1.7).add(new T.Vector3(0, 1.0, 0)) : new T.Vector3(4.6, 2.9, 4.9);
    const toTarget = which === 'keys' ? mid : new T.Vector3(0, 0.75, -0.2);
    const fromPos = this.camera.position.clone(), fromTarget = this.controls.target.clone();
    const start = this.clock.elapsedTime;
    const step = () => {
      const k = Math.min(1, (this.clock.elapsedTime - start) / 1.4), e = 1 - (1 - k) ** 3;
      this.camera.position.lerpVectors(fromPos, toPos, e);
      this.controls.target.lerpVectors(fromTarget, toTarget, e);
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }

  addPerformer(p: Performer) { this.performers.push(p); }

  toggleLid() { this.lidOpen = !this.lidOpen; return this.lidOpen; }

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    for (const [midi, pivot] of this.piano.keys) {
      const target = this.down.has(midi) ? (pivot.userData.black ? 0.06 : 0.075) : 0;
      pivot.rotation.x = T.MathUtils.damp(pivot.rotation.x, target, this.down.has(midi) ? 40 : 18, dt);
      const g = this.glow.get(midi);
      if (g !== undefined) {
        const held = this.down.has(midi);
        const next = held ? Math.max(g * 0.985, 0.18) : g * Math.exp(-dt * 5);
        this.piano.keyMaterials.get(midi)!.emissiveIntensity = next * 0.55;
        if (next < 0.01 && !held) { this.glow.delete(midi); this.piano.keyMaterials.get(midi)!.emissiveIntensity = 0; } else this.glow.set(midi, next);
      }
    }
    for (const perf of this.performers) perf.update(dt);
    // closing: the desk folds down flat first, then the lid comes down; opening: the lid rises, then the desk stands up.
    // The prop only stands while the lid is up.
    const deskOpen = this.lidOpen && this.piano.lid.rotation.z > 0.5;
    this.piano.desk.rotation.x = T.MathUtils.damp(this.piano.desk.rotation.x, deskOpen ? -0.13 : -1.52, 6, dt);
    this.piano.desk.position.y = T.MathUtils.damp(this.piano.desk.position.y, deskOpen ? 1.145 : 1.042, 6, dt);
    const lidTarget = this.lidOpen ? 0.85 : this.piano.desk.rotation.x < -1.4 ? 0 : this.piano.lid.rotation.z;
    this.piano.lid.rotation.z = T.MathUtils.damp(this.piano.lid.rotation.z, lidTarget, 4, dt);
    this.piano.prop.visible = this.piano.lid.rotation.z > 0.8;
    // dust drifts slowly up and round
    const p = this.dust.geometry.getAttribute('position') as T.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) + dt * 0.035;
      if (y > 5.2) y = 0.2;
      p.setXYZ(i, p.getX(i) + Math.sin(t * 0.3 + i) * dt * 0.012, y, p.getZ(i) + Math.cos(t * 0.27 + i * 1.7) * dt * 0.012);
    }
    p.needsUpdate = true;
    // after a while untouched, the camera drifts again
    if (!this.controls.autoRotate && this.idleSince && t - this.idleSince > 25) this.controls.autoRotate = true;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.performers.forEach((p) => p.dispose());
    this.piano.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
