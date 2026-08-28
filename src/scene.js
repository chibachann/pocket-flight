/**
 * ワールドの描画。地形（LOD付きハイトフィールド）、滑走路、樹木、雲、リングを描く。
 * すべて Renderer のカメラ空間ユーティリティ経由で塗る。
 */

import { FAR, FOG_START } from './renderer.js';
import { AIRFIELD_ELEVATION, heightAt, surfaceHeightAt, terrainColor, waterColor } from './terrain.js';
import { RUNWAY } from './course.js';
import { clamp, vec3 } from './math.js';

/** 太陽方向（正規化済み）。地形の陰影計算と太陽そのものの描画に使う。 */
const SUN = (() => {
  const v = vec3(0.48, 0.72, -0.5);
  const l = Math.hypot(v.x, v.y, v.z);
  return vec3(v.x / l, v.y / l, v.z / l);
})();

/**
 * 太陽を光芒付きの円で描く。
 * 太陽は無限遠にあるものとして扱い、方向ベクトルをそのままカメラ空間へ
 * 射影する（位置ではなく向きなので camPos は引かない）。地形より先に
 * 塗ることで、山の裏に回ったときは後から描かれる地形に自然に隠れる。
 */
export function drawSun(renderer) {
  const camX = SUN.x * renderer.camRight.x + SUN.y * renderer.camRight.y + SUN.z * renderer.camRight.z;
  const camY = SUN.x * renderer.camUp.x + SUN.y * renderer.camUp.y + SUN.z * renderer.camUp.z;
  const camZ = SUN.x * renderer.camForward.x + SUN.y * renderer.camForward.y + SUN.z * renderer.camForward.z;
  if (camZ < 0.05) return; // 太陽が背後にあるときは描かない
  const sx = renderer.width / 2 + (camX / camZ) * renderer.focal;
  const sy = renderer.height / 2 - (camY / camZ) * renderer.focal;
  // ハローが画面外にはみ出す分の余裕を持たせて、緩めの範囲外判定にする。
  const margin = renderer.width * 0.35;
  if (sx < -margin || sx > renderer.width + margin || sy < -margin || sy > renderer.height + margin) return;

  const ctx = renderer.ctx;
  const r = Math.min(renderer.width, renderer.height) * 0.075;

  // 淡いハロー（空気感を出す大きな光暈）。
  const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 4.5);
  halo.addColorStop(0, 'rgba(255,250,230,0.30)');
  halo.addColorStop(0.4, 'rgba(255,244,210,0.10)');
  halo.addColorStop(1, 'rgba(255,244,210,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(sx, sy, r * 4.5, 0, Math.PI * 2);
  ctx.fill();

  // 十字の光芒。加算合成で薄く重ね、コストは矩形2枚だけに抑える。
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const flareLen = r * 7;
  const flareW = r * 0.16;
  const gh = ctx.createLinearGradient(sx - flareLen, sy, sx + flareLen, sy);
  gh.addColorStop(0, 'rgba(255,244,210,0)');
  gh.addColorStop(0.5, 'rgba(255,244,210,0.22)');
  gh.addColorStop(1, 'rgba(255,244,210,0)');
  ctx.fillStyle = gh;
  ctx.fillRect(sx - flareLen, sy - flareW / 2, flareLen * 2, flareW);
  const gv = ctx.createLinearGradient(sx, sy - flareLen, sx, sy + flareLen);
  gv.addColorStop(0, 'rgba(255,244,210,0)');
  gv.addColorStop(0.5, 'rgba(255,244,210,0.22)');
  gv.addColorStop(1, 'rgba(255,244,210,0)');
  ctx.fillStyle = gv;
  ctx.fillRect(sx - flareW / 2, sy - flareLen, flareW, flareLen * 2);
  ctx.restore();

  // 太陽本体。
  const core = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
  core.addColorStop(0, 'rgba(255,255,246,1)');
  core.addColorStop(0.7, 'rgba(255,236,176,0.95)');
  core.addColorStop(1, 'rgba(255,222,138,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * 地形のLODリング定義。
 * cell はセル一辺の長さ(m)、half は中心からのセル数。外側ほど粗くする。
 */
const RINGS = [
  { cell: 55, half: 7 },
  { cell: 190, half: 8 },
  { cell: 800, half: 8 },
];

/** リングごとの頂点キャッシュ。毎フレーム再確保しないよう初期化時に確保する。 */
const ringData = RINGS.map((r) => {
  const n = r.half * 2 + 1;
  return {
    n,
    originX: 0,
    originZ: 0,
    worldX: new Float64Array(n),
    worldZ: new Float64Array(n),
    height: new Float64Array(n * n),
    // 水面の深さ表現用に、0未満へクランプする前の生の標高も別途保持する。
    rawHeight: new Float64Array(n * n),
    camX: new Float64Array(n * n),
    camY: new Float64Array(n * n),
    camZ: new Float64Array(n * n),
  };
});

/** 深度ソート用の作業配列。 */
const drawList = [];
const quad = [
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 0 },
];

/**
 * 地形を描く。
 * 1) 各LODリングの格子頂点を評価しカメラ空間へ変換
 * 2) 内側リングに覆われるセルを間引き、可視セルを深度付きで収集
 * 3) 奥から手前へ塗る
 */
export function drawTerrain(renderer) {
  const cam = renderer.camPos;

  for (let k = 0; k < RINGS.length; k++) {
    const ring = RINGS[k];
    const d = ringData[k];
    const n = d.n;
    // 格子が滑らないようカメラ位置をセル境界へスナップする。
    d.originX = Math.floor(cam.x / ring.cell) * ring.cell;
    d.originZ = Math.floor(cam.z / ring.cell) * ring.cell;
    for (let i = 0; i < n; i++) {
      d.worldX[i] = d.originX + (i - ring.half) * ring.cell;
      d.worldZ[i] = d.originZ + (i - ring.half) * ring.cell;
    }
    for (let j = 0; j < n; j++) {
      const wz = d.worldZ[j];
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const wx = d.worldX[i];
        // surfaceHeightAt は内部で heightAt を呼ぶだけなので、水深の色分けに使う
        // 生の標高（海面下は負）も欲しい今回は heightAt を直接呼んで二重計算を避ける。
        const raw = heightAt(wx, wz);
        const h = raw > 0 ? raw : 0;
        d.height[idx] = h;
        d.rawHeight[idx] = raw;
        const dx = wx - cam.x;
        const dy = h - cam.y;
        const dz = wz - cam.z;
        d.camX[idx] = dx * renderer.camRight.x + dy * renderer.camRight.y + dz * renderer.camRight.z;
        d.camY[idx] = dx * renderer.camUp.x + dy * renderer.camUp.y + dz * renderer.camUp.z;
        d.camZ[idx] = dx * renderer.camForward.x + dy * renderer.camForward.y + dz * renderer.camForward.z;
      }
    }

  }

  // 粗いリングから順に描くことで、細かいリングが必ず上書きされるようにする。
  for (let k = RINGS.length - 1; k >= 0; k--) {
    drawRing(renderer, k);
  }
}

/** 1つのLODリングを奥から手前へ描く。 */
function drawRing(renderer, k) {
  const ring = RINGS[k];
  const d = ringData[k];
  const n = d.n;
  drawList.length = 0;

  // 内側リングが覆う範囲。セル全体が完全に内側に入る場合のみ間引く
  // （中心だけで判定すると境界に隙間ができるため）。
  let innerHalfSpan = 0;
  let innerOX = 0;
  let innerOZ = 0;
  if (k > 0) {
    const inner = RINGS[k - 1];
    innerHalfSpan = inner.half * inner.cell;
    innerOX = ringData[k - 1].originX;
    innerOZ = ringData[k - 1].originZ;
  }
  const halfCell = ring.cell * 0.5;

  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const cx = (d.worldX[i] + d.worldX[i + 1]) * 0.5;
      const cz = (d.worldZ[j] + d.worldZ[j + 1]) * 0.5;
      if (
        k > 0 &&
        Math.abs(cx - innerOX) + halfCell < innerHalfSpan &&
        Math.abs(cz - innerOZ) + halfCell < innerHalfSpan
      ) {
        continue;
      }
      const i00 = j * n + i;
      const i10 = i00 + 1;
      const i01 = i00 + n;
      const i11 = i01 + 1;
      const z0 = d.camZ[i00];
      const z1 = d.camZ[i10];
      const z2 = d.camZ[i11];
      const z3 = d.camZ[i01];
      // 4隅すべてがカメラ後方なら描かない。
      if (z0 < 0.6 && z1 < 0.6 && z2 < 0.6 && z3 < 0.6) continue;
      const depth = (z0 + z1 + z2 + z3) * 0.25;
      if (depth > FAR) continue;
      // cx, cz（セル中心のワールド座標）は水面のきらめき計算にも使うのでここで持たせておく。
      drawList.push(i00, i10, i11, i01, depth, cx, cz);
    }
  }

  const STRIDE = 7;
  const count = drawList.length / STRIDE;
  const order = [];
  for (let c = 0; c < count; c++) order.push(c);
  order.sort((a, b) => drawList[b * STRIDE + 4] - drawList[a * STRIDE + 4]);

  const cam = renderer.camPos;
  const sunHLen = Math.hypot(SUN.x, SUN.z) || 1;

  for (let o = 0; o < order.length; o++) {
    const base = order[o] * STRIDE;
    for (let v = 0; v < 4; v++) {
      const idx = drawList[base + v];
      quad[v].x = d.camX[idx];
      quad[v].y = d.camY[idx];
      quad[v].z = d.camZ[idx];
    }
    const h00 = d.height[drawList[base]];
    const h10 = d.height[drawList[base + 1]];
    const h11 = d.height[drawList[base + 2]];
    const h01 = d.height[drawList[base + 3]];
    const avgH = (h00 + h10 + h11 + h01) * 0.25;
    const cell = ring.cell;
    // 高さ差から法線を求めて簡易ライティングを行う。
    const nx = (h00 + h01 - h10 - h11) * 0.5;
    const nz = (h00 + h10 - h01 - h11) * 0.5;
    const nl = Math.hypot(nx, cell, nz);
    const shade = clamp((nx / nl) * SUN.x + (cell / nl) * SUN.y + (nz / nl) * SUN.z, 0, 1);
    const slope = clamp(Math.hypot(nx, nz) / cell, 0, 1);

    let rgb;
    if (avgH <= 0.01) {
      // 水面：生の標高（負値）から水深を求め、浅瀬〜深海のグラデーションにする。
      const r00 = d.rawHeight[drawList[base]];
      const r10 = d.rawHeight[drawList[base + 1]];
      const r11 = d.rawHeight[drawList[base + 2]];
      const r01 = d.rawHeight[drawList[base + 3]];
      const depthM = Math.max(0, -(r00 + r10 + r11 + r01) * 0.25);
      // 太陽方向のきらめき：カメラからセルへの水平方向が太陽の方位に近いセルだけを
      // 明るくする。狭い角度のコーンにした上でセルごとの疑似乱数で間引き、
      // 滑らかな帯ではなく粒状の反射（グリッターパス）に見せる。
      const cxw = drawList[base + 5];
      const czw = drawList[base + 6];
      const dxw = cxw - cam.x;
      const dzw = czw - cam.z;
      const distH = Math.hypot(dxw, dzw) || 1;
      const align = (dxw * SUN.x + dzw * SUN.z) / (distH * sunHLen);
      let sparkle = 0;
      if (align > 0.9) {
        const glint = hashCell(Math.round(cxw / 26), Math.round(czw / 26), 21);
        if (glint > 0.5) sparkle = ((align - 0.9) * 10) ** 2;
      }
      rgb = waterColor(depthM, 0.5 + shade * 0.5 + sparkle);
    } else {
      rgb = terrainColor(avgH, slope, shade);
    }
    renderer.fillCameraPolygon(quad, 4, renderer.fog(rgb, drawList[base + 4]), true);
  }
}

/** 滑走路と誘導灯を描く。 */
export function drawRunway(renderer) {
  const y = RUNWAY.elevation + 0.4;
  const hw = RUNWAY.halfWidth;
  const hl = RUNWAY.halfLength;
  const dist = Math.hypot(renderer.camPos.x, renderer.camPos.z);
  if (dist > FAR) return;
  const fogDist = Math.max(0, dist - hl);

  renderer.fillPolygon(
    [vec3(-hw, y, -hl), vec3(hw, y, -hl), vec3(hw, y, hl), vec3(-hw, y, hl)],
    renderer.fog([54, 56, 62], fogDist),
  );

  // 中心線の破線。
  const dash = 40;
  const gap = 30;
  for (let z = -hl + 40; z < hl - 40; z += dash + gap) {
    renderer.fillPolygon(
      [vec3(-1.6, y + 0.05, z), vec3(1.6, y + 0.05, z), vec3(1.6, y + 0.05, z + dash), vec3(-1.6, y + 0.05, z + dash)],
      renderer.fog([226, 226, 226], fogDist),
    );
  }
  // 両端のしきい標識。
  for (const end of [-1, 1]) {
    for (let s = -3; s <= 3; s++) {
      const x = s * 8;
      const z0 = end * (hl - 60);
      const z1 = end * (hl - 10);
      renderer.fillPolygon(
        [vec3(x - 2.5, y + 0.05, z0), vec3(x + 2.5, y + 0.05, z0), vec3(x + 2.5, y + 0.05, z1), vec3(x - 2.5, y + 0.05, z1)],
        renderer.fog([236, 236, 236], fogDist),
      );
    }
  }
  // 滑走路脇のマーカー。着陸時の高度感を出す。
  for (let z = -hl; z <= hl; z += 100) {
    for (const side of [-1, 1]) {
      const x = side * (hw + 6);
      renderer.fillPolygon(
        [vec3(x - 1.5, y, z - 1.5), vec3(x + 1.5, y, z - 1.5), vec3(x + 1.5, y + 3, z), vec3(x - 1.5, y + 3, z)],
        renderer.fog([230, 190, 70], fogDist),
      );
    }
  }
}

/** 樹木の描画範囲（m）。 */
const TREE_RANGE = 620;
const TREE_CELL = 62;
const treeList = [];

/** 座標ハッシュ（樹木の配置を決定的にする）。 */
function hashCell(ix, iz, salt) {
  let h = Math.imul(ix, 2246822519) ^ Math.imul(iz, 3266489917) ^ Math.imul(salt, 668265263);
  h = Math.imul(h ^ (h >>> 15), 2654435761);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * カメラ周辺に樹木をばらまいて描く。
 * 低空飛行時の速度感を出すための簡易ビルボード。
 */
export function drawTrees(renderer) {
  const cam = renderer.camPos;
  // 高高度では見えないので省略して負荷を下げる。
  if (cam.y > 900) return;
  treeList.length = 0;
  const ci = Math.floor(cam.x / TREE_CELL);
  const cj = Math.floor(cam.z / TREE_CELL);
  const span = Math.ceil(TREE_RANGE / TREE_CELL);
  for (let j = cj - span; j <= cj + span; j++) {
    for (let i = ci - span; i <= ci + span; i++) {
      if (hashCell(i, j, 1) > 0.55) continue;
      const x = (i + hashCell(i, j, 2)) * TREE_CELL;
      const z = (j + hashCell(i, j, 3)) * TREE_CELL;
      const dx = x - cam.x;
      const dz = z - cam.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > TREE_RANGE * TREE_RANGE) continue;
      const ground = surfaceHeightAt(x, z);
      // 水面と高山、飛行場の内側には生やさない。
      if (ground < 6 || ground > 420) continue;
      if (Math.abs(x) < 220 && Math.abs(z) < RUNWAY.halfLength + 220) continue;
      treeList.push({ x, z, ground, h: 9 + hashCell(i, j, 4) * 11, d2 });
    }
  }
  treeList.sort((a, b) => b.d2 - a.d2);
  const right = renderer.camRight;
  for (const t of treeList) {
    const dist = Math.sqrt(t.d2);
    const w = t.h * 0.34;
    const base = t.ground;
    renderer.fillPolygon(
      [
        vec3(t.x - right.x * w, base - right.y * w, t.z - right.z * w),
        vec3(t.x + right.x * w, base + right.y * w, t.z + right.z * w),
        vec3(t.x, base + t.h, t.z),
      ],
      renderer.fog([38, 68, 40], dist),
    );
  }
}

/** 雲の配置（初期化時に決定）。 */
const clouds = (() => {
  const list = [];
  for (let i = 0; i < 46; i++) {
    const a = hashCell(i, 11, 7) * Math.PI * 2;
    const r = 900 + hashCell(i, 12, 8) * 6200;
    list.push({
      x: Math.cos(a) * r,
      y: 780 + hashCell(i, 13, 9) * 900,
      z: Math.sin(a) * r,
      size: 260 + hashCell(i, 14, 10) * 420,
    });
  }
  return list;
})();

/** 雲をビルボードで描く。 */
export function drawClouds(renderer) {
  const ctx = renderer.ctx;
  const list = [];
  for (const c of clouds) {
    if (!renderer.isInFront(c, 40)) continue;
    const d = renderer.distanceTo(c);
    if (d > FAR) continue;
    list.push({ c, d });
  }
  list.sort((a, b) => b.d - a.d);
  const tmp = { x: 0, y: 0, z: 0 };
  for (const item of list) {
    renderer.toCamera(tmp, item.c);
    const sx = renderer.screenX(tmp);
    const sy = renderer.screenY(tmp);
    const r = (item.c.size * renderer.focal) / tmp.z;
    if (sx + r < 0 || sx - r > renderer.width || sy + r < 0 || sy - r > renderer.height) continue;
    const alpha = 0.55 * (1 - clamp((item.d - FOG_START) / (FAR - FOG_START), 0, 1));
    if (alpha <= 0.02) continue;
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
    g.addColorStop(0, `rgba(255,255,255,${alpha.toFixed(3)})`);
    g.addColorStop(0.55, `rgba(244,248,255,${(alpha * 0.55).toFixed(3)})`);
    g.addColorStop(1, 'rgba(240,246,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

const ringPoints = [];
for (let i = 0; i < 24; i++) ringPoints.push(vec3());

/**
 * リング（ゲート）を描く。
 * active が true のゲートは強調表示する。
 */
export function drawGates(renderer, gates, activeIndex) {
  const order = [];
  for (let i = 0; i < gates.length; i++) {
    const g = gates[i];
    if (g.passed && i !== activeIndex) continue;
    if (!renderer.isInFront(g.pos, 5)) continue;
    const d = renderer.distanceTo(g.pos);
    if (d > FAR) continue;
    order.push({ i, d });
  }
  order.sort((a, b) => b.d - a.d);

  const u = vec3();
  const v = vec3();
  for (const item of order) {
    const g = gates[item.i];
    const active = item.i === activeIndex;
    // リング面内の直交基底を作る。
    if (Math.abs(g.dir.y) < 0.9) {
      u.x = -g.dir.z;
      u.y = 0;
      u.z = g.dir.x;
    } else {
      u.x = 1;
      u.y = 0;
      u.z = 0;
    }
    const ul = Math.hypot(u.x, u.y, u.z);
    u.x /= ul;
    u.y /= ul;
    u.z /= ul;
    v.x = g.dir.y * u.z - g.dir.z * u.y;
    v.y = g.dir.z * u.x - g.dir.x * u.z;
    v.z = g.dir.x * u.y - g.dir.y * u.x;

    for (let k = 0; k < ringPoints.length; k++) {
      const a = (k / ringPoints.length) * Math.PI * 2;
      const ca = Math.cos(a) * g.radius;
      const sa = Math.sin(a) * g.radius;
      ringPoints[k].x = g.pos.x + u.x * ca + v.x * sa;
      ringPoints[k].y = g.pos.y + u.y * ca + v.y * sa;
      ringPoints[k].z = g.pos.z + u.z * ca + v.z * sa;
    }
    const color = g.passed ? [110, 130, 140] : active ? [86, 240, 214] : [232, 176, 72];
    const fogged = renderer.fog(color, item.d);
    if (active && !g.passed) {
      // 遠くからでも見えるよう薄い膜を張る。
      renderer.ctx.globalAlpha = 0.16;
      renderer.fillPolygon(ringPoints, fogged);
      renderer.ctx.globalAlpha = 1;
    }
    renderer.strokePolyline(ringPoints, fogged, active ? 4.5 : 3, true);
  }
}

/** 飛行場を示す簡易な建物群。 */
const HANGARS = [
  { x: -140, z: -220, w: 46, d: 30, h: 16 },
  { x: -140, z: -140, w: 46, d: 30, h: 16 },
  { x: 150, z: 260, w: 60, d: 36, h: 20 },
];

/** 格納庫を箱として描く。 */
export function drawBuildings(renderer) {
  const y = AIRFIELD_ELEVATION;
  for (const b of HANGARS) {
    const center = vec3(b.x, y + b.h / 2, b.z);
    if (!renderer.isInFront(center, 5)) continue;
    const d = renderer.distanceTo(center);
    if (d > FAR * 0.5) continue;
    const x0 = b.x - b.w / 2;
    const x1 = b.x + b.w / 2;
    const z0 = b.z - b.d / 2;
    const z1 = b.z + b.d / 2;
    const top = y + b.h;
    renderer.fillPolygon(
      [vec3(x0, y, z0), vec3(x1, y, z0), vec3(x1, top, z0), vec3(x0, top, z0)],
      renderer.fog([150, 152, 158], d),
    );
    renderer.fillPolygon(
      [vec3(x0, y, z1), vec3(x1, y, z1), vec3(x1, top, z1), vec3(x0, top, z1)],
      renderer.fog([132, 134, 140], d),
    );
    renderer.fillPolygon(
      [vec3(x0, y, z0), vec3(x0, y, z1), vec3(x0, top, z1), vec3(x0, top, z0)],
      renderer.fog([120, 122, 128], d),
    );
    renderer.fillPolygon(
      [vec3(x1, y, z0), vec3(x1, y, z1), vec3(x1, top, z1), vec3(x1, top, z0)],
      renderer.fog([166, 168, 174], d),
    );
    renderer.fillPolygon(
      [vec3(x0, top, z0), vec3(x1, top, z0), vec3(x1, top, z1), vec3(x0, top, z1)],
      renderer.fog([182, 186, 192], d),
    );
  }
}

/**
 * 自機の簡易ローポリモデル。
 * 機体ローカル座標は 右=+x / 上=+y / 前=+z（メートル）。
 */
const AIRCRAFT_MODEL = [
  // 胴体上面
  { pts: [[0, 0.9, 4.2], [0.7, 0.5, 1.0], [0.7, 0.5, -3.4], [0, 0.9, -3.6]], color: [228, 232, 238] },
  { pts: [[0, 0.9, 4.2], [-0.7, 0.5, 1.0], [-0.7, 0.5, -3.4], [0, 0.9, -3.6]], color: [208, 214, 222] },
  // 胴体側面から下面
  { pts: [[0.7, 0.5, 1.0], [0, -0.45, 3.6], [0, -0.5, -3.2], [0.7, 0.5, -3.4]], color: [176, 182, 192] },
  { pts: [[-0.7, 0.5, 1.0], [0, -0.45, 3.6], [0, -0.5, -3.2], [-0.7, 0.5, -3.4]], color: [162, 168, 178] },
  // 主翼（上下面と前縁で薄い箱にし、真後ろから見ても消えないようにする）
  { pts: [[0.6, 0.5, 1.5], [5.4, 1.05, 0.3], [5.4, 1.05, -0.8], [0.6, 0.5, -1.6]], color: [222, 92, 80] },
  { pts: [[-0.6, 0.5, 1.5], [-5.4, 1.05, 0.3], [-5.4, 1.05, -0.8], [-0.6, 0.5, -1.6]], color: [206, 80, 70] },
  { pts: [[0.6, 0.26, 1.5], [5.4, 0.81, 0.3], [5.4, 0.81, -0.8], [0.6, 0.26, -1.6]], color: [150, 56, 50] },
  { pts: [[-0.6, 0.26, 1.5], [-5.4, 0.81, 0.3], [-5.4, 0.81, -0.8], [-0.6, 0.26, -1.6]], color: [140, 50, 46] },
  { pts: [[0.6, 0.5, -1.6], [5.4, 1.05, -0.8], [5.4, 0.81, -0.8], [0.6, 0.26, -1.6]], color: [168, 62, 56] },
  { pts: [[-0.6, 0.5, -1.6], [-5.4, 1.05, -0.8], [-5.4, 0.81, -0.8], [-0.6, 0.26, -1.6]], color: [158, 58, 52] },
  // 水平尾翼
  { pts: [[0.3, 0.62, -3.0], [2.2, 0.85, -3.3], [2.2, 0.85, -3.9], [0.3, 0.62, -3.8]], color: [214, 82, 72] },
  { pts: [[-0.3, 0.62, -3.0], [-2.2, 0.85, -3.3], [-2.2, 0.85, -3.9], [-0.3, 0.62, -3.8]], color: [196, 72, 64] },
  // 垂直尾翼
  { pts: [[0, 0.9, -2.8], [0, 2.5, -3.6], [0, 2.5, -4.1], [0, 0.9, -3.75]], color: [232, 236, 242] },
  // キャノピー
  { pts: [[0, 1.02, 2.7], [0.45, 0.78, 1.9], [0.45, 0.78, 0.5], [0, 1.06, 0.3]], color: [64, 104, 138] },
  { pts: [[0, 1.02, 2.7], [-0.45, 0.78, 1.9], [-0.45, 0.78, 0.5], [0, 1.06, 0.3]], color: [54, 92, 122] },
];

const modelWorld = [];
for (let i = 0; i < 4; i++) modelWorld.push(vec3());
const propPoints = [];
for (let i = 0; i < 14; i++) propPoints.push(vec3());

/** 機体ローカル座標をワールド座標へ変換する。 */
function localToWorld(out, aircraft, lx, ly, lz) {
  const b = aircraft.basis;
  out.x = aircraft.pos.x + b.right.x * lx + b.up.x * ly + b.forward.x * lz;
  out.y = aircraft.pos.y + b.right.y * lx + b.up.y * ly + b.forward.y * lz;
  out.z = aircraft.pos.z + b.right.z * lx + b.up.z * ly + b.forward.z * lz;
  return out;
}

/**
 * 追従視点のときに自機を描く。
 * 面ごとに奥行きで並べ替え、法線から簡易な陰影を付ける。
 */
export function drawAircraft(renderer, aircraft, time) {
  // 機首がカメラと反対を向いている（真後ろからの追従視点）ときは、
  // プロペラを胴体より先に描いて手前に重ならないようにする。
  const toCamX = renderer.camPos.x - aircraft.pos.x;
  const toCamY = renderer.camPos.y - aircraft.pos.y;
  const toCamZ = renderer.camPos.z - aircraft.pos.z;
  const b = aircraft.basis;
  const noseAway = toCamX * b.forward.x + toCamY * b.forward.y + toCamZ * b.forward.z < 0;
  if (noseAway) drawPropeller(renderer, aircraft, time);

  const faces = [];
  for (let i = 0; i < AIRCRAFT_MODEL.length; i++) {
    const face = AIRCRAFT_MODEL[i];
    let depth = 0;
    for (const p of face.pts) {
      localToWorld(modelWorld[0], aircraft, p[0], p[1], p[2]);
      depth += renderer.distanceTo(modelWorld[0]);
    }
    faces.push({ face, depth: depth / face.pts.length });
  }
  faces.sort((a, b) => b.depth - a.depth);

  for (const item of faces) {
    const pts = item.face.pts;
    for (let i = 0; i < pts.length; i++) {
      localToWorld(modelWorld[i], aircraft, pts[i][0], pts[i][1], pts[i][2]);
    }
    // 3点から法線を求めて陰影を付ける（裏表は区別せず絶対値を使う）。
    const ax = modelWorld[1].x - modelWorld[0].x;
    const ay = modelWorld[1].y - modelWorld[0].y;
    const az = modelWorld[1].z - modelWorld[0].z;
    const bx = modelWorld[2].x - modelWorld[0].x;
    const by = modelWorld[2].y - modelWorld[0].y;
    const bz = modelWorld[2].z - modelWorld[0].z;
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const lambert = Math.abs((nx / nl) * SUN.x + (ny / nl) * SUN.y + (nz / nl) * SUN.z);
    const k = 0.6 + lambert * 0.5;
    const c = item.face.color;
    const shaded = [
      clamp(c[0] * k, 0, 255),
      clamp(c[1] * k, 0, 255),
      clamp(c[2] * k, 0, 255),
    ];
    renderer.fillPolygon(modelWorld.slice(0, pts.length), renderer.fog(shaded, item.depth), true);
  }

  if (!noseAway) drawPropeller(renderer, aircraft, time);
}

/** プロペラの回転円盤とブレードを描く。 */
function drawPropeller(renderer, aircraft, time) {
  const spin = time * (6 + aircraft.rpm * 40);
  for (let i = 0; i < propPoints.length; i++) {
    const a = (i / propPoints.length) * Math.PI * 2;
    localToWorld(propPoints[i], aircraft, Math.cos(a) * 1.5, Math.sin(a) * 1.5 + 0.2, 4.3);
  }
  renderer.ctx.globalAlpha = 0.1 + aircraft.rpm * 0.12;
  renderer.fillPolygon(propPoints, 'rgb(215,225,235)');
  renderer.ctx.globalAlpha = 1;
  for (let blade = 0; blade < 2; blade++) {
    const a = spin + blade * Math.PI;
    const tip = [vec3(), vec3()];
    localToWorld(tip[0], aircraft, Math.cos(a) * 1.5, Math.sin(a) * 1.5 + 0.2, 4.32);
    localToWorld(tip[1], aircraft, -Math.cos(a) * 0.1, -Math.sin(a) * 0.1 + 0.2, 4.32);
    renderer.strokePolyline(tip, 'rgba(40,44,50,0.8)', 0.12, false);
  }
}
