// The grand piano of 琴室, built in Three.js (after Piano Atelier's model.js: the same case outline, keyboard and 88
// separately pivoted keys), carved and gilded like a salon instrument: a beaded and dentilled rim with rosettes and
// hanging garlands, cabriole legs with acanthus knees and claw-and-ball feet, a lyre for the pedals, volutes on the
// keyboard cheeks, a gilt-inlaid fallboard, a painted lid lining, a carved openwork music desk and a carved bench.
// Static decoration is merged per material (few draw calls on a phone); the keys stay separate so they can move.
import * as T from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type PianoModel = {
  root: T.Group;
  /** MIDI -> the key's pivot group (rotate .x to press). */
  keys: Map<number, T.Group>;
  /** MIDI -> the key's own material (its glow when struck). */
  keyMaterials: Map<number, T.MeshPhysicalMaterial>;
  lid: T.Group;
  /** The stick that holds the lid up: shown only while the lid is open. */
  prop: T.Mesh;
  /** The music desk: upright with the lid open, folded flat under it when it closes. */
  desk: T.Group;
  pedals: T.Mesh[];
  dispose: () => void;
};

const TAU = Math.PI * 2;

function grainTexture(base: string, dark: [number, number, number], light: [number, number, number]) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = base; g.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 1100; i++) {
    const y = i * 0.239;
    const [r, gg, b] = i % 3 ? light : dark;
    g.strokeStyle = `rgba(${r},${gg},${b},${0.05 + (i % 7) / 100})`;
    g.lineWidth = 0.3 + (i % 5) * 0.18;
    g.beginPath();
    for (let x = 0; x <= 512; x += 4) {
      const yy = y + Math.sin(x * 0.016 + i * 0.21) * 1.3 + Math.sin(x * 0.006 + i) * 3;
      if (x) g.lineTo(x, yy); else g.moveTo(x, yy);
    }
    g.stroke();
  }
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace;
  tex.wrapS = tex.wrapT = T.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** Gold arabesques on dark lacquer: a double border of scrolls and a central medallion with a lyre. */
function lidPainting() {
  const W = 1024, H = 1024;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const bg = g.createRadialGradient(W * 0.5, H * 0.45, 40, W * 0.5, H * 0.5, W * 0.75);
  bg.addColorStop(0, '#3a1d10'); bg.addColorStop(1, '#170b06');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const gold = (a: number) => `rgba(214,176,92,${a})`;
  // borders
  g.strokeStyle = gold(0.9); g.lineWidth = 6; g.strokeRect(40, 40, W - 80, H - 80);
  g.lineWidth = 2; g.strokeRect(62, 62, W - 124, H - 124);
  // running scrolls between the borders
  g.lineWidth = 2.5;
  const scrollRow = (x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.round(Math.hypot(x1 - x0, y1 - y0) / 46);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      g.beginPath();
      for (let k = 0; k <= 40; k++) {
        const a = (k / 40) * TAU * 1.4, r = 3 + k * 0.32;
        const px = x + Math.cos(a + i) * r, py = y + Math.sin(a + i) * r;
        if (k) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.stroke();
    }
  };
  scrollRow(75, 51, W - 75, 51); scrollRow(75, H - 51, W - 75, H - 51); scrollRow(51, 75, 51, H - 75); scrollRow(W - 51, 75, W - 51, H - 75);
  // corner fans
  for (const [cx, cy, a0] of [[62, 62, 0], [W - 62, 62, Math.PI / 2], [W - 62, H - 62, Math.PI], [62, H - 62, Math.PI * 1.5]] as const) {
    for (let k = 0; k < 7; k++) {
      const a = a0 + (k / 6) * (Math.PI / 2);
      g.beginPath(); g.moveTo(cx, cy); g.quadraticCurveTo(cx + Math.cos(a - 0.2) * 60, cy + Math.sin(a - 0.2) * 60, cx + Math.cos(a) * 110, cy + Math.sin(a) * 110); g.stroke();
    }
  }
  // the central medallion: a wreath, acanthus sprays, a lyre
  const cx = W / 2, cy = H / 2;
  g.lineWidth = 3;
  g.beginPath(); g.ellipse(cx, cy, 170, 210, 0, 0, TAU); g.stroke();
  g.lineWidth = 1.5;
  g.beginPath(); g.ellipse(cx, cy, 182, 222, 0, 0, TAU); g.stroke();
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * TAU, x = cx + Math.cos(a) * 196, y = cy + Math.sin(a) * 236;
    g.save(); g.translate(x, y); g.rotate(a + Math.PI / 2);
    g.beginPath(); g.ellipse(0, 0, 5, 12, 0.5, 0, TAU); g.fillStyle = gold(0.75); g.fill(); g.restore();
  }
  for (const side of [-1, 1]) {
    for (let k = 0; k < 5; k++) {
      g.beginPath();
      g.moveTo(cx + side * 190, cy + 40 + k * 18);
      g.bezierCurveTo(cx + side * (260 + k * 30), cy - 40 + k * 30, cx + side * (330 + k * 20), cy + 90 - k * 10, cx + side * (300 + k * 35), cy + 150 + k * 12);
      g.stroke();
    }
  }
  // lyre
  g.lineWidth = 6; g.strokeStyle = gold(0.95);
  g.beginPath(); g.moveTo(cx - 70, cy + 110); g.bezierCurveTo(cx - 120, cy + 10, cx - 30, cy - 40, cx - 60, cy - 130); g.stroke();
  g.beginPath(); g.moveTo(cx + 70, cy + 110); g.bezierCurveTo(cx + 120, cy + 10, cx + 30, cy - 40, cx + 60, cy - 130); g.stroke();
  g.beginPath(); g.moveTo(cx - 80, cy + 110); g.lineTo(cx + 80, cy + 110); g.stroke();
  g.beginPath(); g.moveTo(cx - 52, cy - 82); g.lineTo(cx + 52, cy - 82); g.stroke();
  g.lineWidth = 1.5;
  for (let k = -3; k <= 3; k++) { g.beginPath(); g.moveTo(cx + k * 13, cy - 82); g.lineTo(cx + k * 15, cy + 110); g.stroke(); }
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Fallboard marquetry: dark panel, a gilt line border, scrolls running out from a cartouche. */
function fallboardInlay() {
  const W = 1024, H = 160;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2a140a'; g.fillRect(0, 0, W, H);
  const gold = 'rgba(214,176,92,.9)';
  g.strokeStyle = gold; g.lineWidth = 3; g.strokeRect(14, 14, W - 28, H - 28);
  g.lineWidth = 1.2; g.strokeRect(24, 24, W - 48, H - 48);
  g.lineWidth = 2;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 9; i++) {
      const x = W / 2 + side * (110 + i * 42);
      g.beginPath();
      for (let k = 0; k <= 30; k++) {
        const a = (k / 30) * TAU * 1.2 * side, r = 2 + k * 0.6;
        const px = x + Math.cos(a) * r, py = H / 2 + Math.sin(a) * r * 0.8;
        if (k) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.stroke();
    }
    g.beginPath(); g.moveTo(W / 2 + side * 90, H / 2); g.bezierCurveTo(W / 2 + side * 200, H / 2 - 40, W / 2 + side * 300, H / 2 + 40, W / 2 + side * 470, H / 2); g.stroke();
  }
  g.lineWidth = 2.5;
  g.beginPath(); g.ellipse(W / 2, H / 2, 82, 44, 0, 0, TAU); g.stroke();
  g.fillStyle = gold; g.font = 'italic 44px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('Salon', W / 2, H / 2 + 2);
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createPiano(): PianoModel {
  const root = new T.Group();
  root.name = 'Salon_Grand';
  const keys = new Map<number, T.Group>();
  const keyMaterials = new Map<number, T.MeshPhysicalMaterial>();
  const disposables: { dispose: () => void }[] = [];
  const keep = <X extends { dispose: () => void }>(x: X) => { disposables.push(x); return x; };

  const tex = keep(grainTexture('#3d1c0e', [12, 6, 3], [96, 52, 26]));
  const wood = keep(new T.MeshPhysicalMaterial({ color: 0x8a5232, map: tex, roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.12 }));
  const dark = keep(new T.MeshPhysicalMaterial({ color: 0x1a0d07, roughness: 0.28, clearcoat: 0.8 }));
  const gold = keep(new T.MeshStandardMaterial({ color: 0xd2a54e, metalness: 0.92, roughness: 0.28 }));
  const goldDim = keep(new T.MeshStandardMaterial({ color: 0x9c7a36, metalness: 0.85, roughness: 0.4 }));
  const soundboard = keep(new T.MeshStandardMaterial({ color: 0xb98848, map: tex, roughness: 0.55 }));
  const strings = keep(new T.MeshStandardMaterial({ color: 0xd8d2bd, metalness: 1, roughness: 0.3 }));
  const velvet = keep(new T.MeshPhysicalMaterial({ color: 0x4a0d14, roughness: 0.75, sheen: 1, sheenColor: new T.Color(0xb2394a), sheenRoughness: 0.5 }));
  const felt = keep(new T.MeshStandardMaterial({ color: 0x7a1e22, roughness: 1 }));
  const lining = keep(new T.MeshStandardMaterial({ map: keep(lidPainting()), roughness: 0.35, metalness: 0.15, side: T.DoubleSide }));
  const inlay = keep(new T.MeshPhysicalMaterial({ map: keep(fallboardInlay()), roughness: 0.25, clearcoat: 0.9 }));

  // static parts collected per material and merged at the end
  const bins = new Map<T.Material, T.BufferGeometry[]>();
  const put = (geo: T.BufferGeometry, mat: T.Material) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!g.getAttribute('uv')) g.setAttribute('uv', new T.Float32BufferAttribute(new Float32Array((g.getAttribute('position').count) * 2), 2));
    (bins.get(mat) ?? bins.set(mat, []).get(mat)!).push(g);
  };
  const at = (geo: T.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s: number | [number, number, number] = 1) => {
    const m = new T.Matrix4().compose(new T.Vector3(x, y, z), new T.Quaternion().setFromEuler(new T.Euler(rx, ry, rz)), new T.Vector3(...(Array.isArray(s) ? s : [s, s, s])));
    return geo.applyMatrix4(m);
  };
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: T.Material = wood) => put(at(new T.BoxGeometry(w, h, d), x, y, z), mat);
  const rod = (a: number[], b: number[], r: number, mat: T.Material = gold, seg = 8) => {
    const av = new T.Vector3(...a), bv = new T.Vector3(...b), v = bv.clone().sub(av);
    const geo = new T.CylinderGeometry(r, r, v.length(), seg);
    geo.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), v.clone().normalize()));
    geo.translate(...av.add(bv).multiplyScalar(0.5).toArray());
    put(geo, mat);
  };
  const tube = (points: number[][], r: number, mat: T.Material = gold, closed = false, radial = 6) =>
    put(new T.TubeGeometry(new T.CatmullRomCurve3(points.map((p) => new T.Vector3(...p)), closed), Math.max(8, points.length * 4), r, radial, closed), mat);
  /** A carved spiral (volute), in a plane given by two directions. */
  const volute = (c: T.Vector3, u: T.Vector3, v: T.Vector3, r0: number, turns: number, thick: number, mat: T.Material = gold) => {
    const pts: number[][] = [];
    const n = Math.round(turns * 28);
    for (let k = 0; k <= n; k++) {
      const a = (k / 28) * TAU, r = r0 * (1 - (k / n) * 0.85);
      const p = c.clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r);
      pts.push(p.toArray());
    }
    tube(pts, thick, mat, false, 5);
  };
  /** A carved rosette facing `normal`: two rings of petals and a raised boss. */
  const rosette = (c: T.Vector3, normal: T.Vector3, r: number, mat: T.Material = gold) => {
    const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, 1), normal.clone().normalize());
    const place = (geo: T.BufferGeometry) => { geo.applyQuaternion(q); geo.translate(c.x, c.y, c.z); put(geo, mat); };
    for (let ring = 0; ring < 2; ring++) {
      const n = ring ? 8 : 10, rr = ring ? r * 0.5 : r * 0.78;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU + ring * 0.3;
        const petal = new T.SphereGeometry(1, 8, 6);
        petal.scale(r * 0.2, r * 0.42, r * 0.12);
        petal.rotateZ(a - Math.PI / 2);
        petal.translate(Math.cos(a) * rr * 0.62, Math.sin(a) * rr * 0.62, ring * r * 0.1);
        place(petal);
      }
    }
    const boss = new T.SphereGeometry(r * 0.22, 10, 8);
    boss.scale(1, 1, 0.7);
    boss.translate(0, 0, r * 0.18);
    place(boss);
  };
  /** An acanthus leaf: a long curled blade, gilded, pointing along `dir`. */
  const acanthus = (base: T.Vector3, dir: T.Vector3, out: T.Vector3, len: number, mat: T.Material = gold) => {
    const pts: number[][] = [];
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      const p = base.clone().addScaledVector(dir, len * t).addScaledVector(out, Math.sin(t * Math.PI) * len * 0.18 + t * t * len * 0.25);
      pts.push(p.toArray());
    }
    tube(pts, len * 0.07, mat, false, 5);
    // the curled tip
    const tip = new T.Vector3(...pts.at(-1)!);
    volute(tip, out.clone(), dir.clone().negate(), len * 0.14, 1.2, len * 0.03, mat);
  };

  // ---------------------------------------------------------------- the case
  const outline = () => {
    const s = new T.Shape();
    s.moveTo(-0.78, 0.55); s.lineTo(0.78, 0.55); s.lineTo(0.78, 0.19);
    s.bezierCurveTo(0.78, -0.24, 0.21, -0.28, 0.19, -0.72);
    s.bezierCurveTo(0.18, -1.1, -0.05, -1.3, -0.4, -1.3);
    s.bezierCurveTo(-0.64, -1.3, -0.78, -1.15, -0.78, -0.91);
    s.closePath();
    return s;
  };
  const slab = (shape: T.Shape, depth: number, y: number, mat: T.Material) => {
    const geo = new T.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.005, bevelSegments: 2, steps: 1, curveSegments: 32 });
    geo.rotateX(Math.PI / 2);
    geo.translate(0, y, 0);
    return geo;
  };
  put(slab(outline(), 0.045, 0.99, soundboard), soundboard);

  // the bent side: a band from 0.84 to 1.08 following the outline
  const ring = outline().getSpacedPoints(160);
  {
    const verts: number[] = [], uvs: number[] = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i], b = ring[i + 1];
      const quad = [[a.x, 0.84, a.y], [b.x, 0.84, b.y], [b.x, 1.075, b.y], [a.x, 0.84, a.y], [b.x, 1.075, b.y], [a.x, 1.075, a.y]];
      for (const q of quad) verts.push(...q);
      const u0 = i / 40, u1 = (i + 1) / 40;
      uvs.push(u0, 0, u1, 0, u1, 1, u0, 0, u1, 1, u0, 1);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(verts, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
    g.computeVertexNormals();
    const side = keep(wood.clone());
    side.side = T.DoubleSide;
    put(g, side);
  }
  // moldings round the rim: a wooden cap, gold beads, an ogee, a dentil band, a gold base bead
  const lift = (y: number) => ring.map((p) => [p.x, y, p.y]);
  tube(lift(1.085), 0.026, wood, true, 8);
  tube(lift(1.06), 0.008, gold, true);
  tube(lift(0.99), 0.016, dark, true);
  tube(lift(0.865), 0.009, gold, true);
  tube(lift(0.835), 0.028, wood, true, 8);
  // outward normals along the outline (the shape winds counter-clockwise in x/y, z is -y after the rotation)
  const normalAt = (i: number) => {
    const a = ring[Math.max(0, i - 1)], b = ring[Math.min(ring.length - 1, i + 1)];
    const t = new T.Vector3(b.x - a.x, 0, b.y - a.y).normalize();
    return new T.Vector3(t.z, 0, -t.x);
  };
  const centre = new T.Vector3(0, 0, -0.35);
  const outward = (i: number) => {
    const n = normalAt(i);
    const p = new T.Vector3(ring[i].x, 0, ring[i].y);
    return n.dot(p.clone().sub(centre)) < 0 ? n.negate() : n;
  };
  // dentils (skip the front, where the keyboard sits)
  for (let i = 0; i < ring.length; i += 2) {
    const p = ring[i];
    if (p.y > 0.5) continue;
    const n = outward(i);
    const d = new T.BoxGeometry(0.012, 0.022, 0.012);
    d.lookAt(n);
    put(at(d, p.x + n.x * 0.004, 1.04, p.y + n.z * 0.004), gold);
  }
  // rosettes with garlands swagging between them, along the curved side
  const roses: { p: T.Vector3; n: T.Vector3 }[] = [];
  for (let i = 8; i < ring.length - 4; i += 13) {
    const p = ring[i];
    if (p.y > 0.45) continue;
    const n = outward(i);
    const c = new T.Vector3(p.x, 0.955, p.y).addScaledVector(n, 0.012);
    rosette(c, n, 0.032);
    roses.push({ p: c, n });
  }
  for (let k = 0; k < roses.length - 1; k++) {
    const a = roses[k], b = roses[k + 1];
    const pts: number[][] = [];
    for (let s = 0; s <= 14; s++) {
      const t = s / 14;
      const p = a.p.clone().lerp(b.p, t).addScaledVector(a.n.clone().lerp(b.n, t), 0.006);
      p.y -= Math.sin(t * Math.PI) * 0.045;
      pts.push(p.toArray());
    }
    tube(pts, 0.0065, gold);
    // little leaves along the garland
    for (let s = 2; s < 13; s += 3) {
      const p = new T.Vector3(...pts[s]);
      const leaf = new T.SphereGeometry(1, 6, 4);
      leaf.scale(0.006, 0.014, 0.004);
      leaf.rotateZ((s % 2 ? 1 : -1) * 0.8);
      leaf.lookAt(a.n);
      put(at(leaf, p.x, p.y, p.z), gold);
    }
  }

  // ---------------------------------------------------------------- the keyboard, its cheeks and the fallboard
  box(1.62, 0.1, 0.42, 0, 0.79, 0.73);
  box(1.65, 0.065, 0.055, 0, 0.805, 0.96);
  box(1.66, 0.012, 0.06, 0, 0.85, 0.953, gold);
  // the apron under the keys: a carved swag with a central rosette
  {
    const pts: number[][] = [];
    for (let s = 0; s <= 40; s++) { const t = s / 40, x = -0.72 + t * 1.44; pts.push([x, 0.755 - Math.abs(Math.sin(t * Math.PI * 4)) * 0.022, 0.99]); }
    tube(pts, 0.0055, gold);
    rosette(new T.Vector3(0, 0.77, 0.992), new T.Vector3(0, 0, 1), 0.03);
    for (const x of [-0.36, 0.36]) rosette(new T.Vector3(x, 0.77, 0.992), new T.Vector3(0, 0, 1), 0.018);
  }
  const fall = new T.BoxGeometry(1.48, 0.22, 0.055);
  // inlay only on the front face (BoxGeometry group 4 = +z): the rest stays wood
  put(at(fall, 0, 1.01, 0.535), wood);
  put(at(new T.PlaneGeometry(1.42, 0.17), 0, 1.01, 0.5635), inlay);
  box(1.53, 0.025, 0.083, 0, 1.13, 0.535);
  tube([[-0.765, 1.145, 0.575], [0.765, 1.145, 0.575]], 0.006, gold);
  box(1.44, 0.01, 0.012, 0, 0.877, 0.59, felt);
  for (const x of [-0.795, 0.795]) {
    box(0.095, 0.15, 0.45, x, 0.87, 0.75);
    box(0.11, 0.018, 0.48, x, 0.945, 0.75, dark);
    // a volute on the front of each cheek
    volute(new T.Vector3(x, 0.875, 0.978), new T.Vector3(0, 1, 0), new T.Vector3(Math.sign(x), 0, 0), 0.05, 2.2, 0.007);
    acanthus(new T.Vector3(x, 0.83, 0.97), new T.Vector3(0, -1, 0.2).normalize(), new T.Vector3(0, 0, 1), 0.09);
  }

  // the keys: separate meshes on pivots, each its own material so a struck key can glow
  const keyWidth = 1.43 / 52;
  let whiteIndex = 0;
  const ivory = new T.MeshPhysicalMaterial({ color: 0xf6ecd4, roughness: 0.26, clearcoat: 0.35, emissive: 0xffb35c, emissiveIntensity: 0 });
  const ebony = new T.MeshPhysicalMaterial({ color: 0x141210, roughness: 0.22, clearcoat: 0.7, emissive: 0xffb35c, emissiveIntensity: 0 });
  keep(ivory); keep(ebony);
  for (let midi = 21; midi <= 108; midi++) {
    const black = [1, 3, 6, 8, 10].includes(midi % 12);
    const x = black ? -0.715 + whiteIndex * keyWidth : -0.715 + (whiteIndex + 0.5) * keyWidth;
    if (!black) whiteIndex++;
    const pivot = new T.Group();
    pivot.name = `key_${midi}`;
    pivot.position.set(x, 0.863, 0.555);
    pivot.userData = { midi, black };
    root.add(pivot);
    const mat = keep((black ? ebony : ivory).clone());
    const geo = keep(new T.BoxGeometry(black ? keyWidth * 0.59 : keyWidth - 0.0012, black ? 0.035 : 0.019, black ? 0.185 : 0.355));
    const key = new T.Mesh(geo, mat);
    key.position.set(0, black ? 0.024 : 0, black ? 0.095 : 0.18);
    key.castShadow = true;
    key.receiveShadow = true;
    key.userData.midi = midi;
    pivot.add(key);
    keys.set(midi, pivot);
    keyMaterials.set(midi, mat);
  }

  // ---------------------------------------------------------------- inside: strings, pins, the iron frame, the bridge
  for (let i = 0; i < 68; i++) {
    const x = -0.7 + i * 0.0205, end = -1.12 + (i / 67) ** 1.9 * 1.49;
    rod([x, 1.015, 0.47], [x, 1.015, end], i < 20 ? 0.0018 : 0.0009, i < 20 ? goldDim : strings, 5);
    put(at(new T.CylinderGeometry(0.003, 0.003, 0.013, 6), x, 1.023, 0.48), gold);
  }
  for (const x of [-0.57, -0.16, 0.31]) rod([x, 1.035, 0.46], [x - 0.05, 1.035, x < 0 ? -1.06 : -0.07], 0.014, gold);
  // the frame's openings: gilded rings in the plate
  for (const [x, z, r] of [[-0.45, -0.55, 0.09], [0.0, -0.35, 0.07], [-0.25, -0.95, 0.06]] as const) {
    put(at(new T.TorusGeometry(r, 0.008, 6, 32), x, 1.04, z, Math.PI / 2), gold);
  }
  tube([[-0.64, 1.03, -0.66], [-0.35, 1.03, -0.64], [-0.04, 1.03, -0.42], [0.29, 1.03, -0.08], [0.64, 1.03, 0.19]], 0.013, dark);

  // ---------------------------------------------------------------- the lid (hinged on the straight side) and its painted lining
  const lid = new T.Group();
  lid.name = 'Lid_hinge';
  lid.position.set(-0.78, 1.1, 0);
  root.add(lid);
  const lidGeo = keep(slab(outline(), 0.03, 0, wood));
  lidGeo.translate(0.78, 0, 0);
  const lidMesh = new T.Mesh(lidGeo, wood);
  lidMesh.castShadow = true;
  lid.add(lidMesh);
  {
    // the lining: the outline as a flat shape, its uv mapped to the painting, just under the lid
    const shape = new T.ShapeGeometry(outline(), 48);
    const pos = shape.getAttribute('position');
    const uv: number[] = [];
    for (let i = 0; i < pos.count; i++) uv.push((pos.getX(i) + 0.78) / 1.56, (pos.getY(i) + 1.3) / 1.85);
    shape.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    shape.rotateX(Math.PI / 2);
    shape.translate(0.78, -0.036, 0);
    keep(shape);
    const lin = new T.Mesh(shape, lining);
    lid.add(lin);
    // a gilt edge round the lid
    const edge = outline().getSpacedPoints(120).map((p) => new T.Vector3(p.x + 0.78, -0.012, p.y));
    const edgeGeo = keep(new T.TubeGeometry(new T.CatmullRomCurve3(edge, true), 240, 0.006, 5, true));
    lid.add(new T.Mesh(edgeGeo, gold));
  }
  lid.rotation.z = 0.85;
  for (const z of [-0.85, -0.3, 0.3]) box(0.045, 0.014, 0.075, -0.78, 1.11, z, gold);
  let prop: T.Mesh;
  {
    const a = new T.Vector3(0.6, 1.085, 0.06), b = new T.Vector3(0.23, 2.22, 0.06), v = b.clone().sub(a);
    const geo = keep(new T.CylinderGeometry(0.011, 0.011, v.length(), 10));
    prop = new T.Mesh(geo, gold);
    prop.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), v.clone().normalize());
    prop.position.copy(a.add(b).multiplyScalar(0.5));
    prop.castShadow = true;
    root.add(prop);
  }

  // ---------------------------------------------------------------- cabriole legs: acanthus knees, gilt collars, claw-and-ball feet
  const leg = (x: number, z: number) => {
    const height = 0.78;
    const profile = [[0.05, 0], [0.058, 0.06], [0.042, 0.12], [0.034, 0.2], [0.038, 0.3], [0.05, 0.42], [0.066, 0.52], [0.078, 0.6], [0.09, 0.66], [0.082, 0.7], [0.1, 0.74], [0.11, 0.78]]
      .map(([r, y]) => new T.Vector2(r, (y * height) / 0.78));
    put(at(new T.LatheGeometry(profile, 28), x, 0.07, z), wood);
    // gilt collars
    for (const [y, r] of [[0.13, 0.044], [0.5, 0.06], [0.72, 0.093], [0.8, 0.104]] as const) put(at(new T.TorusGeometry(r, 0.007, 6, 28), x, y, z, Math.PI / 2), gold);
    // acanthus leaves round the knee, curling outward
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU;
      const outDir = new T.Vector3(Math.cos(a), 0, Math.sin(a));
      acanthus(new T.Vector3(x + outDir.x * 0.08, 0.78, z + outDir.z * 0.08), new T.Vector3(0, -1, 0), outDir, 0.16);
    }
    // carved fluting down the shaft
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU + 0.2;
      rod([x + Math.cos(a) * 0.045, 0.3, z + Math.sin(a) * 0.045], [x + Math.cos(a) * 0.06, 0.52, z + Math.sin(a) * 0.06], 0.004, goldDim, 5);
    }
    // the foot: a gilt ball held by four claws
    put(at(new T.SphereGeometry(0.045, 16, 12), x, 0.05, z), gold);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU + Math.PI / 4;
      const pts: number[][] = [];
      for (let s = 0; s <= 8; s++) {
        const t = s / 8, ang = Math.PI * 0.9 * t - 0.3;
        pts.push([x + Math.cos(a) * (0.048 * Math.cos(ang) + 0.005), 0.05 + 0.048 * Math.sin(ang) + (1 - t) * 0.03, z + Math.sin(a) * (0.048 * Math.cos(ang) + 0.005)]);
      }
      tube(pts.reverse(), 0.0085, wood, false, 6);
    }
  };
  leg(-0.69, 0.64); leg(0.69, 0.64); leg(-0.36, -1.07);

  // ---------------------------------------------------------------- the pedal lyre
  box(0.36, 0.06, 0.1, 0, 0.66, 0.46);
  box(0.33, 0.06, 0.21, 0, 0.14, 0.54);
  rosette(new T.Vector3(0, 0.66, 0.512), new T.Vector3(0, 0, 1), 0.026);
  for (const side of [-1, 1]) {
    const pts: number[][] = [];
    for (let s = 0; s <= 24; s++) {
      const t = s / 24, y = 0.18 + t * 0.47;
      const xx = side * (0.06 + Math.sin(t * Math.PI) * 0.09 - Math.sin(t * Math.PI * 2) * 0.02);
      pts.push([xx, y, 0.49 - t * 0.03]);
    }
    tube(pts, 0.014, gold, false, 8);
    volute(new T.Vector3(side * 0.07, 0.645, 0.465), new T.Vector3(side, 0, 0), new T.Vector3(0, 1, 0), 0.035, 1.6, 0.007);
  }
  for (let k = -2; k <= 2; k++) rod([k * 0.022, 0.2, 0.49], [k * 0.02, 0.63, 0.462], 0.0025, gold, 5);
  const pedals: T.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const p = new T.Mesh(keep(new T.BoxGeometry(0.047, 0.022, 0.16)), gold);
    p.position.set((i - 1) * 0.095, 0.115, 0.63);
    p.castShadow = true;
    root.add(p);
    pedals.push(p);
  }

  // ---------------------------------------------------------------- the carved openwork music desk
  const rack = new T.Group();
  {
    rack.name = 'Carved_music_desk';
    rack.position.set(0, 1.145, 0.35);
    rack.rotation.x = -0.13;
    root.add(rack);
    const deskBins: [T.BufferGeometry, T.Material][] = [];
    const rTube = (pts: number[][], r: number, mat: T.Material, closed = false) => deskBins.push([new T.TubeGeometry(new T.CatmullRomCurve3(pts.map((p) => new T.Vector3(...p)), closed), Math.max(8, pts.length * 3), r, 5, closed), mat]);
    deskBins.push([new T.BoxGeometry(1.2, 0.024, 0.085).translate(0, 0, 0.005), dark]);
    deskBins.push([new T.BoxGeometry(1.2, 0.008, 0.01).translate(0, 0.016, 0.05), gold]);
    for (const [cx, cy, r] of [[0, 0.23, 0.235], [-0.4, 0.16, 0.17], [0.4, 0.16, 0.17]] as const) {
      const ringPts: number[][] = [];
      for (let j = 0; j < 65; j++) { const a = (j * TAU) / 64; ringPts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0]); }
      rTube(ringPts, 0.01, wood, true);
      rTube(ringPts.map(([x, y]) => [cx + (x - cx) * 0.92, cy + (y - cy) * 0.92, 0.004]), 0.004, gold, true);
      for (let j = 0; j < 8; j++) {
        const a = (j * Math.PI) / 4, pts: number[][] = [];
        for (let k = 0; k < 33; k++) { const t = (k * TAU) / 32, rr = r * (0.45 + 0.38 * Math.cos(t)), aa = a + 0.23 * Math.sin(t); pts.push([cx + rr * Math.cos(aa), cy + rr * Math.sin(aa), 0]); }
        rTube(pts, 0.0055, gold, true);
      }
      for (let j = 0; j < 4; j++) {
        const pts: number[][] = [];
        for (let k = 0; k < 36; k++) { const t = (k / 35) * TAU, rr = r * 0.2 * (1 - k / 40), a = (j * Math.PI) / 2; pts.push([cx + r * 0.46 * Math.cos(a) + rr * Math.cos(t), cy + r * 0.46 * Math.sin(a) + rr * Math.sin(t), 0.002]); }
        rTube(pts, 0.004, wood);
      }
    }
    // scrolls joining the medallions
    for (const side of [-1, 1]) rTube([[side * 0.21, 0.1, 0], [side * 0.27, 0.2, 0.003], [side * 0.24, 0.32, 0]], 0.006, gold);
    const byMat = new Map<T.Material, T.BufferGeometry[]>();
    for (const [g, m] of deskBins) { const gg = g.index ? g.toNonIndexed() : g; (byMat.get(m) ?? byMat.set(m, []).get(m)!).push(gg); }
    for (const [m, list] of byMat) {
      const merged = keep(mergeGeometries(list)!);
      list.forEach((g) => g.dispose());
      const mesh = new T.Mesh(merged, m);
      mesh.castShadow = true;
      rack.add(mesh);
    }
  }

  // ---------------------------------------------------------------- the carved bench, in velvet
  {
    const bz = 1.48;
    const benchLeg = (x: number, z: number) => {
      const prof = [[0.03, 0], [0.036, 0.05], [0.024, 0.1], [0.02, 0.2], [0.028, 0.3], [0.036, 0.36], [0.04, 0.4]].map(([r, y]) => new T.Vector2(r, y));
      put(at(new T.LatheGeometry(prof, 18), x, 0.02, bz + z), wood);
      put(at(new T.TorusGeometry(0.03, 0.005, 6, 18), x, 0.33, bz + z, Math.PI / 2), gold);
      put(at(new T.SphereGeometry(0.026, 12, 8), x, 0.025, bz + z), gold);
    };
    for (const x of [-0.32, 0.32]) for (const z of [-0.15, 0.15]) benchLeg(x, z);
    box(0.8, 0.07, 0.44, 0, 0.44, bz);
    tube([[-0.4, 0.42, bz + 0.222], [0.4, 0.42, bz + 0.222]], 0.006, gold);
    for (const s of [-1, 1]) tube([[-0.4, 0.42, bz + s * 0.222], [0.4, 0.42, bz + s * 0.222]], 0.005, gold);
    rosette(new T.Vector3(0, 0.425, bz + 0.226), new T.Vector3(0, 0, 1), 0.022);
    // a swag under the seat front
    const sw: number[][] = [];
    for (let s = 0; s <= 24; s++) { const t = s / 24; sw.push([-0.3 + t * 0.6, 0.395 - Math.abs(Math.sin(t * Math.PI * 2)) * 0.03, bz + 0.225]); }
    tube(sw, 0.004, gold);
    const seat = new T.BoxGeometry(0.78, 0.06, 0.42, 6, 1, 3);
    put(at(seat, 0, 0.5, bz), velvet);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      const t = new T.SphereGeometry(1, 14, 8);
      put(at(t, (i - 2.5) * 0.124, 0.525, bz + (j - 1) * 0.13, 0, 0, 0, [0.07, 0.025, 0.075]), velvet);
    }
    for (let i = 0; i < 5; i++) for (let j = 0; j < 2; j++) put(at(new T.SphereGeometry(0.007, 8, 6), (i - 2) * 0.124, 0.54, bz + (j - 0.5) * 0.13), gold);
  }

  // ---------------------------------------------------------------- merge what does not move
  for (const [mat, list] of bins) {
    const merged = mergeGeometries(list);
    list.forEach((g) => g.dispose());
    if (!merged) continue;
    keep(merged);
    const mesh = new T.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  return { root, keys, keyMaterials, lid, prop, desk: rack, pedals, dispose: () => disposables.forEach((d) => d.dispose()) };
}
