/**
 * ワールドの描画。地形（LOD付きハイトフィールド）、滑走路、樹木、雲、リングを描く。
 * すべて Renderer のカメラ空間ユーティリティ経由で塗る。
 */

import { FAR, FOG_START } from './renderer.js';
import { AIRFIELD_ELEVATION, heightAt, surfaceHeightAt, terrainColor, waterColor } from './terrain.js';
import { RUNWAY } from './course.js';
import { clamp, lerp, vec3 } from './math.js';

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
  // 森のまとまりを作るための粗いグリッド。TREE_CELLよりずっと大きい単位で密度を
  // 決めることで、密な森と疎らな場所がまだらにでき、単調な一様分布を避けられる。
  // 平均密度は元の一様0.55としばぼ同じ（0.3〜0.8の中央値）に保ち、木の総数と
  // 描画コール数が変わらないようにしている。
  const FOREST_CELL = 5;
  for (let j = cj - span; j <= cj + span; j++) {
    for (let i = ci - span; i <= ci + span; i++) {
      const fi = Math.floor(i / FOREST_CELL);
      const fj = Math.floor(j / FOREST_CELL);
      const density = 0.3 + hashCell(fi, fj, 20) * 0.5;
      if (hashCell(i, j, 1) > density) continue;
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
      // 色合いと高さに個体差を付けて、単色三角形の羅列に見えないようにする。
      const tint = hashCell(i, j, 5);
      const color = tint < 0.34 ? [32, 76, 40] : tint < 0.67 ? [46, 96, 46] : [60, 84, 32];
      treeList.push({ x, z, ground, h: 7 + hashCell(i, j, 4) * 16, color, d2 });
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
      renderer.fog(t.color, dist),
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

/**
 * 直方体を描く共通ヘルパー（格納庫・管制塔・街の建物で共用）。
 * 呼び出し側が奥から手前の順で呼ぶことを前提に、ここでは深さソートを行わない。
 * bandT（0〜1、0で帯なし）を指定すると前面と右面だけ上下2色に分け、
 * 窓の帯があるように見せる。実際に窓を1枚ずつ描くとコストが跳ねるための代替表現で、
 * 背面・左面は目立ちにくいため帯を省略してポリゴン数を抑えている
 * （帯なしで5面、帯ありで7面。1棟あたり10面以内という目安に収まる）。
 */
function drawBox(renderer, x, z, w, d, y0, h, base, upper, roof, bandT, dist) {
  const x0 = x - w / 2;
  const x1 = x + w / 2;
  const z0 = z - d / 2;
  const z1 = z + d / 2;
  const top = y0 + h;
  const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const front = shade(base, 1.0);
  const right = shade(base, 0.86);
  const back = shade(base, 0.76);
  const left = shade(base, 0.68);
  if (bandT > 0 && bandT < 1) {
    const midY = y0 + h * bandT;
    const uf = shade(upper, 1.0);
    const ur = shade(upper, 0.86);
    renderer.fillPolygon([vec3(x0, y0, z0), vec3(x1, y0, z0), vec3(x1, midY, z0), vec3(x0, midY, z0)], renderer.fog(front, dist));
    renderer.fillPolygon([vec3(x0, midY, z0), vec3(x1, midY, z0), vec3(x1, top, z0), vec3(x0, top, z0)], renderer.fog(uf, dist));
    renderer.fillPolygon([vec3(x1, y0, z0), vec3(x1, y0, z1), vec3(x1, midY, z1), vec3(x1, midY, z0)], renderer.fog(right, dist));
    renderer.fillPolygon([vec3(x1, midY, z0), vec3(x1, midY, z1), vec3(x1, top, z1), vec3(x1, top, z0)], renderer.fog(ur, dist));
  } else {
    renderer.fillPolygon([vec3(x0, y0, z0), vec3(x1, y0, z0), vec3(x1, top, z0), vec3(x0, top, z0)], renderer.fog(front, dist));
    renderer.fillPolygon([vec3(x1, y0, z0), vec3(x1, y0, z1), vec3(x1, top, z1), vec3(x1, top, z0)], renderer.fog(right, dist));
  }
  renderer.fillPolygon([vec3(x1, y0, z1), vec3(x0, y0, z1), vec3(x0, top, z1), vec3(x1, top, z1)], renderer.fog(back, dist));
  renderer.fillPolygon([vec3(x0, y0, z1), vec3(x0, y0, z0), vec3(x0, top, z0), vec3(x0, top, z1)], renderer.fog(left, dist));
  renderer.fillPolygon([vec3(x0, top, z0), vec3(x1, top, z0), vec3(x1, top, z1), vec3(x0, top, z1)], renderer.fog(roof, dist));
}

/** 飛行場の格納庫群（西側のエプロン沿いに並べる。東側にも1棟だけ置いてバランスを取る）。 */
const HANGARS = [
  { x: -150, z: -300, w: 44, d: 28, h: 15 },
  { x: -150, z: -230, w: 44, d: 28, h: 15 },
  { x: -150, z: -100, w: 50, d: 32, h: 17 },
  { x: -150, z: 40, w: 38, d: 26, h: 13 },
  { x: -150, z: 160, w: 58, d: 34, h: 19 },
  { x: 150, z: 260, w: 60, d: 36, h: 20 },
];

/** 管制塔（軸柱＋上部の見張り所）。エプロンの奥に1つだけ置く。 */
const TOWER = { x: -190, z: -20 };

/** 駐機中の機体（簡易な箱＋主翼、既存のAIRCRAFT_MODELを流用すると重いので専用の簡易形状にした）。 */
const PARKED_AIRCRAFT = [
  { x: -128, z: -268, heading: 0.35 },
  { x: -108, z: -95, heading: -0.2 },
  { x: 130, z: 235, heading: Math.PI + 0.25 },
];

/** 飛行場の建物・機体をまとめて距離順に並べ替えたリスト（配置は固定なので初回だけ組み立てる）。 */
const airportItems = [];
for (const h of HANGARS) airportItems.push({ kind: 'hangar', ...h });
airportItems.push({ kind: 'tower', x: TOWER.x, z: TOWER.z });
for (const p of PARKED_AIRCRAFT) airportItems.push({ kind: 'plane', ...p });

/** 格納庫を箱として描く。 */
function drawHangar(renderer, item, dist) {
  drawBox(renderer, item.x, item.z, item.w, item.d, AIRFIELD_ELEVATION, item.h, [150, 152, 158], [150, 152, 158], [182, 186, 192], 0, dist);
}

/** 管制塔を軸柱＋見張り所の2段の箱で描く。 */
function drawTower(renderer, item, dist) {
  const shaftH = 32;
  const cabH = 8;
  drawBox(renderer, item.x, item.z, 9, 9, AIRFIELD_ELEVATION, shaftH, [150, 150, 156], [150, 150, 156], [126, 128, 134], 0, dist);
  drawBox(renderer, item.x, item.z, 16, 16, AIRFIELD_ELEVATION + shaftH, cabH, [90, 150, 170], [90, 150, 170], [72, 122, 140], 0, dist);
}

/** 駐機中の機体を簡略化した箱＋主翼で描く（機首方向 heading はラジアン、+Zが0）。 */
function drawParkedPlane(renderer, item, dist) {
  const y = AIRFIELD_ELEVATION;
  const cs = Math.cos(item.heading);
  const sn = Math.sin(item.heading);
  const w = (lx, ly, lz) => vec3(item.x + lx * cs + lz * sn, y + ly, item.z - lx * sn + lz * cs);
  renderer.fillPolygon([w(-0.9, 0.2, -3.5), w(0.9, 0.2, -3.5), w(0.6, 1.3, 2.6), w(-0.6, 1.3, 2.6)], renderer.fog([214, 218, 224], dist));
  renderer.fillPolygon([w(0.9, 0.2, -3.5), w(0.9, 0.2, 3.0), w(0, 1.5, 3.6), w(0.6, 1.3, 2.6)], renderer.fog([190, 194, 200], dist));
  renderer.fillPolygon([w(-0.9, 0.2, -3.5), w(-0.6, 1.3, 2.6), w(0, 1.5, 3.6), w(-0.9, 0.2, 3.0)], renderer.fog([176, 180, 188], dist));
  renderer.fillPolygon([w(-0.7, 0.5, 0.6), w(-6.0, 0.5, -0.4), w(-6.0, 0.5, -1.0), w(-0.7, 0.5, -0.4)], renderer.fog([198, 202, 208], dist));
  renderer.fillPolygon([w(0.7, 0.5, 0.6), w(6.0, 0.5, -0.4), w(6.0, 0.5, -1.0), w(0.7, 0.5, -0.4)], renderer.fog([198, 202, 208], dist));
}

/**
 * 飛行場のディテール（格納庫・管制塔・駐機中の機体）をまとめて描く。
 * Zバッファが無いため、必ず距離でソートしてから奥→手前の順で描く
 * （元のdrawBuildingsはソートしていなかったが、棟数を増やすにあたって追加した）。
 */
export function drawBuildings(renderer) {
  const order = [];
  for (const item of airportItems) {
    const cy =
      item.kind === 'tower' ? AIRFIELD_ELEVATION + 17 : item.kind === 'plane' ? AIRFIELD_ELEVATION + 1 : AIRFIELD_ELEVATION + item.h / 2;
    const center = vec3(item.x, cy, item.z);
    if (!renderer.isInFront(center, 5)) continue;
    const d = renderer.distanceTo(center);
    if (d > FAR * 0.5) continue;
    order.push({ item, d });
  }
  order.sort((a, b) => b.d - a.d);
  for (const { item, d } of order) {
    if (item.kind === 'hangar') drawHangar(renderer, item, d);
    else if (item.kind === 'tower') drawTower(renderer, item, d);
    else drawParkedPlane(renderer, item, d);
  }
}

/** 駐機場（エプロン）と、滑走路へ繋がる誘導路。平面ポリゴンなので低コスト。 */
const APRON = { x0: -170, x1: -50, z0: -320, z1: 320 };
const TAXIWAY = { x0: -50, x1: -RUNWAY.halfWidth, z0: -14, z1: 14 };

/** エプロンと誘導路を描く。滑走路と同じ考え方の平面ポリゴン2枚だけなので負荷はごく小さい。 */
export function drawApron(renderer) {
  const y = AIRFIELD_ELEVATION + 0.35;
  const center = vec3((APRON.x0 + APRON.x1) / 2, y, (APRON.z0 + APRON.z1) / 2);
  if (!renderer.isInFront(center, 5)) return;
  const dist = renderer.distanceTo(center);
  if (dist > FAR) return;
  renderer.fillPolygon(
    [vec3(APRON.x0, y, APRON.z0), vec3(APRON.x1, y, APRON.z0), vec3(APRON.x1, y, APRON.z1), vec3(APRON.x0, y, APRON.z1)],
    renderer.fog([72, 74, 80], dist),
  );
  renderer.fillPolygon(
    [vec3(TAXIWAY.x0, y, TAXIWAY.z0), vec3(TAXIWAY.x1, y, TAXIWAY.z0), vec3(TAXIWAY.x1, y, TAXIWAY.z1), vec3(TAXIWAY.x0, y, TAXIWAY.z1)],
    renderer.fog([64, 66, 72], dist),
  );
}

/**
 * 建物候補を配置するグリッドのピッチ(m)。
 * 旧版は85mで、街区(SUPER)を255mまで広げていたため「広く薄く」建物を撒く形に
 * なっていた。低空から見ると街区の舗装が広大な単色面として目立ち、その上に
 * 疎らな建物が点在するだけの寂しい絵になっていたため、45mまで詰めて候補密度
 * そのものを上げた（総描画数は下のCAP系定数で頭打ちにするので、密度だけが上がる）。
 */
const LOT = 45;
/**
 * 道路の格子ピッチ(m)。LOTの3マス分を1街区とし、街区の外周にだけ道路を敷く。
 * 道路をLOTと同じ間隔で敷くと「区画1マスごとに道路」になって不自然に細かくなる
 * ため、複数ロットをまとめた単位を街区とすることで、道路網＋街区内に複数棟という
 * 現実の街に近い密度感にしている。
 * 旧版の255mは実在の街区としても巨大すぎ、道路網がまばらにしか見えなかった。
 * 135mまで詰めることで単位面積あたりの道路本数が増え、格子がひと目で
 * 「街」と分かるようになる。
 */
const SUPER = LOT * 3;
/** 道路の半幅(m)。実効で ROAD_HALF_W*2 の道幅になる。 */
const ROAD_HALF_W = 5;
/**
 * ビルを生成する半径。地形が平坦化されている範囲（terrain.jsのAIRFIELD_OUTER=1900m）の
 * 内側に必ず収める。ここを超えて起伏のある地形に建物を置くと、Zバッファが無い都合上
 * 「建物は常に地形より手前に塗られる」ため、丘の裏の建物が透けて見える破綻が起きる。
 *
 * 旧版は1750mまで広げていたが、同時に描画できる建物・街区の数は
 * MAX_CITY_BUILDINGS/MAX_CITY_BLOCKSで頭打ちのため、広い面積へ薄く撒くほど
 * どの視点を切り取っても密度が足りず「野原に箱が点在」して見えていた。
 * 総量（描画コール数）を変えないまま面積だけ1100mまで縮めることで、同じ棟数・
 * 街区数がより狭い範囲に密集し、見た目の密度が上がる
 * （「広く薄く」から「狭く濃く」への転換。飛行場のクリアランスはそのまま維持）。
 */
const CITY_MIN_R = 260;
const CITY_MAX_R = 1100;
/**
 * 滑走路の中心線からのクリアランス(m)。この帯には建物・道路・舗装のいずれも置かない。
 * 離陸開始位置の直近に巨大なビルが立つと視界を圧迫する（実際に破綻していた）ため、
 * 滑走路本体（halfWidth=30）よりずっと広く余白を取っている。
 */
const RUNWAY_CLEAR_X = 350;
/**
 * 離着陸の進入経路（滑走路の南北延長線上）の帯。RUNWAY_CLEAR_Xより広いこの帯では
 * 建物自体は許すが、APPROACH_LOW_MAX_H（ハンガー程度の高さ）までしか許可しない。
 * 完全に建物なしにすると味気ないが、離陸直後や着陸進入中に正面へ高層ビルが
 * そびえる構図だけは避けたいための折衷。
 */
const APPROACH_CLEAR_X = 600;
const APPROACH_LOW_MAX_H = 18;
/**
 * ダウンタウン（高層ビル密集地）の中心と広がり(m)。
 * 「飛行場に近いほど低層、遠いほど高層」という基本ルールに加えて、この一点だけ
 * 高層の当選確率・存在確率を底上げすることでビルの塊＝スカイラインを作る。
 * RUNWAY_CLEAR_XおよびAPPROACH_CLEAR_Xの外側（xでの余白を確保）かつCITY_MAX_R
 * 寄りに置き、高高度からの広域ショットで遠景のシルエットとして見えるようにしている。
 * CITY_MAX_Rを1750→1100mへ縮めたのに合わせて中心も内側へ寄せ、半径も380→170mへ
 * 絞った。塔として認識できる高さのビルを狭い範囲へ固めるほどスカイラインらしく
 * 見えるため、広がりを削ってでも塊の密度を優先している。
 */
const DOWNTOWN = { x: 860, z: 280 };
const DOWNTOWN_RADIUS = 170;
/**
 * 上限で間引く際、ダウンタウンの候補を優先して残すための下駄(m)。
 * 単純にカメラからの近い順でcapを切ると、高高度・遠方からの俯瞰では
 * カメラ直下の街区ばかりが選ばれてダウンタウン（本来スカイラインとして
 * 見せたい遠くの塊）が候補から漏れてしまう。実距離からこの分だけ差し引いた
 * 見かけの距離で選抜することで、多少遠くてもダウンタウンを優先的に描画対象へ残す。
 * 実際の描画順（画家のアルゴリズム）は本来の距離でソートし直すので、
 * これは「何を描くか」の選抜にのみ影響し、前後関係の破綻は起きない。
 * CITY_MAX_Rの縮小に合わせて値も比例して詰めた。
 */
const DOWNTOWN_PRIORITY_BIAS = 1400;
/**
 * 郊外の建物の最大高さ(m)。ハンガー・管制塔（15〜40m）と隣接しても破綻しない範囲に収める。
 * ダウンタウンだけはDOWNTOWN_MAX_HEIGHTでさらに高くする（heightBudgetAt参照）。
 */
const CITY_MAX_HEIGHT = 70;
/**
 * ダウンタウン中心での建物の最大高さ(m)。塔として認識できる80〜120m級を狭い範囲へ
 * 集めることで、周囲の低層（16〜40m）とのコントラストからスカイラインを作る。
 */
const DOWNTOWN_MAX_HEIGHT = 120;
/**
 * 同時に描画するビル／街区（舗装・道路）の上限（近い順）。高度に応じて絞る。
 * LOTを85→45mへ詰めたことで単位面積あたりの建物候補密度が上がった分、
 * 旧版のBUILDINGS=48のままだと「建物で埋まる近距離の一角」だけが選ばれて、
 * その外側は街区の舗装だけが選ばれ建物が1棟も無い帯（のっぺりしたグレーの
 * リング）ができてしまった。BUILDINGSを増やして建物が埋まる範囲をBLOCKS
 * （舗装・道路）の可視範囲に近づけつつ、BLOCKS自体は逆に減らして舗装の
 * 及ぶ範囲を建物のある一角に合わせて絞ることで、「建物のない舗装」を減らしている。
 */
const MAX_CITY_BUILDINGS = 90;
const MAX_CITY_BLOCKS = 14;
const cityCandidates = [];
const cityBlocks = [];
/** ビルの色みのバリエーション。棟ごとにハッシュで1色選ぶ。 */
const CITY_COLORS = [
  [188, 96, 82],
  [96, 132, 168],
  [178, 168, 120],
  [126, 150, 128],
  [150, 118, 158],
  [176, 176, 184],
  [200, 150, 96],
];

/** v が pitch 格子線（道路の中心線）から clearance 以内にあるか。 */
function nearRoadLine(v, pitch, clearance) {
  const m = ((v % pitch) + pitch) % pitch;
  return m < clearance || m > pitch - clearance;
}

/**
 * この街区(SUPERピッチ格子のi,j)を舗装せず緑地（公園）のまま残すかどうか。
 * 街区の内側を一律にアスファルトで塗ると、面積の大きさも相まって画面下半分が
 * のっぺりしたグレーの平面に見えてしまう（低空視点で最も目立った問題）。
 * ダウンタウンに近いほど公園を減らして密に舗装し、郊外ほど公園を混ぜることで
 * グレー一色の大面積を崩す。建物候補側（collectCityBuildings）でも同じ判定を使い、
 * 公園街区には建物を置かないようにしている。
 */
function isParkBlock(i, j, downtownT) {
  const parkChance = lerp(0.34, 0.05, downtownT);
  return hashCell(i, j, 62) < parkChance;
}

/**
 * 指定位置の建物に許される最大高さ(m)を返す。
 * 飛行場中心からの距離が遠いほど高層化を許し、ダウンタウン中心に近いほどさらに
 * 底上げする。進入経路（approachLow）ではハンガー並みの低さに強制的に抑える。
 * 上限そのものもダウンタウンに近いほどCITY_MAX_HEIGHT(70)からDOWNTOWN_MAX_HEIGHT
 * (120)へ引き上げることで、郊外の低層と対比する「塔」を作る。
 */
function heightBudgetAt(x, z, approachLow) {
  const fieldR = Math.hypot(x, z);
  const farT = clamp((fieldR - CITY_MIN_R) / (CITY_MAX_R - CITY_MIN_R), 0, 1);
  const downtownT = clamp(1 - Math.hypot(x - DOWNTOWN.x, z - DOWNTOWN.z) / DOWNTOWN_RADIUS, 0, 1);
  const maxH = lerp(CITY_MAX_HEIGHT, DOWNTOWN_MAX_HEIGHT, downtownT);
  let budget = Math.min(maxH, lerp(16, 40, farT) + downtownT * 90);
  if (approachLow) budget = Math.min(budget, APPROACH_LOW_MAX_H);
  return budget;
}

/** 街区のビル候補を、近い順に cap 棟まで集める。 */
function collectCityBuildings(renderer, cap) {
  cityCandidates.length = 0;
  const cam = renderer.camPos;
  const ci = Math.floor(cam.x / LOT);
  const cj = Math.floor(cam.z / LOT);
  // 遠方まで律儀に走査すると候補が膨らむだけなので、実際に見える範囲に絞る。
  const scanR = Math.min(FAR * 0.5, CITY_MAX_R + 300);
  const span = Math.ceil(scanR / LOT);
  for (let j = cj - span; j <= cj + span; j++) {
    for (let i = ci - span; i <= ci + span; i++) {
      const cx = (i + 0.5) * LOT;
      const cz = (j + 0.5) * LOT;
      if (Math.abs(cx) < RUNWAY_CLEAR_X) continue; // 滑走路のクリアランス帯には置かない
      // 存在確率（密度）。ダウンタウン中心に近いほど密度を上げて塊にする。
      // 旧版は0.4〜0.75（区画の半分近くが空き地）だったが、街区自体をLOT=45mまで
      // 詰めた上でさらに充填率を0.62〜0.95へ底上げし、区画の大半が建物で
      // 埋まるようにした（描画数の上限はcapで変わらないため、密度だけが上がる）。
      const downtownT = clamp(1 - Math.hypot(cx - DOWNTOWN.x, cz - DOWNTOWN.z) / DOWNTOWN_RADIUS, 0, 1);
      if (hashCell(i, j, 41) > 0.62 + downtownT * 0.33) continue;
      const x = cx + (hashCell(i, j, 42) - 0.5) * (LOT - 20);
      const z = cz + (hashCell(i, j, 43) - 0.5) * (LOT - 20);
      // 街区を区切る道路（SUPER格子の境界線）の上には置かない。
      if (nearRoadLine(x, SUPER, ROAD_HALF_W + 9) || nearRoadLine(z, SUPER, ROAD_HALF_W + 9)) continue;
      const r = Math.hypot(x, z);
      if (r < CITY_MIN_R || r > CITY_MAX_R) continue;
      const downtownT2 = clamp(1 - Math.hypot(x - DOWNTOWN.x, z - DOWNTOWN.z) / DOWNTOWN_RADIUS, 0, 1);
      // 公園街区（drawBlockPavementと同じ判定）には建物を置かない。
      if (isParkBlock(Math.floor(x / SUPER), Math.floor(z / SUPER), downtownT2)) continue;
      // 滑走路の延長線上（進入経路）かどうか。低くする判定はdrawCityBuilding側で使う。
      const approachLow = Math.abs(x) < APPROACH_CLEAR_X && Math.abs(z) > RUNWAY.halfLength;
      const dx = x - cam.x;
      const dz = z - cam.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > scanR * scanR) continue;
      cityCandidates.push({ i, j, x, z, d2, approachLow, downtownT: downtownT2 });
    }
  }
  // 選抜はダウンタウン優先の見かけの距離で行い、最終的な描画順は実距離で並べ直す。
  cityCandidates.sort((a, b) => selectDist(a) - selectDist(b));
  if (cityCandidates.length > cap) cityCandidates.length = cap;
  cityCandidates.sort((a, b) => a.d2 - b.d2);
}

/** cap選抜用の見かけの距離。ダウンタウンの候補ほど近く見せて優先的に残す。 */
function selectDist(c) {
  return Math.sqrt(c.d2) - c.downtownT * DOWNTOWN_PRIORITY_BIAS;
}

/** 舗装・道路を敷く街区（SUPERピッチの格子）を、近い順に cap 個まで集める。 */
function collectCityBlocks(renderer, cap) {
  cityBlocks.length = 0;
  const cam = renderer.camPos;
  const ci = Math.floor(cam.x / SUPER);
  const cj = Math.floor(cam.z / SUPER);
  const scanR = Math.min(FAR * 0.5, CITY_MAX_R + 300);
  const span = Math.ceil(scanR / SUPER) + 1;
  for (let j = cj - span; j <= cj + span; j++) {
    for (let i = ci - span; i <= ci + span; i++) {
      const bx = (i + 0.5) * SUPER;
      const bz = (j + 0.5) * SUPER;
      // 街区は外周の道路まで含めて滑走路帯の外に収まっている必要がある。
      if (Math.abs(bx) < RUNWAY_CLEAR_X + SUPER / 2) continue;
      const r = Math.hypot(bx, bz);
      if (r < CITY_MIN_R || r > CITY_MAX_R) continue;
      const dx = bx - cam.x;
      const dz = bz - cam.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > scanR * scanR) continue;
      const downtownT = clamp(1 - Math.hypot(bx - DOWNTOWN.x, bz - DOWNTOWN.z) / DOWNTOWN_RADIUS, 0, 1);
      cityBlocks.push({ i, j, bx, bz, d2, downtownT });
    }
  }
  // 建物と同様、選抜はダウンタウン優先の見かけの距離で行い、描画順は実距離に戻す。
  cityBlocks.sort((a, b) => selectDist(a) - selectDist(b));
  if (cityBlocks.length > cap) cityBlocks.length = cap;
  cityBlocks.sort((a, b) => a.d2 - b.d2);
}

/**
 * 街区の舗装色（アスファルト寄りのグレー）。ダウンタウンほど石畳寄りに暗くする。
 * さらに街区ごとにハッシュで明暗のばらつきを乗せる。ダウンタウン距離だけで
 * 決まる滑らかな色勾配だと、隣接する街区どうしがほぼ同じ色になり結局は
 * 「巨大な単色面」に見えてしまうため、街区単位でランダムに明暗を振って
 * パッチワーク状に見せている。
 */
function blockPavementColor(i, j, bx, bz) {
  const downtownT = clamp(1 - Math.hypot(bx - DOWNTOWN.x, bz - DOWNTOWN.z) / DOWNTOWN_RADIUS, 0, 1);
  const base = [lerp(96, 70, downtownT), lerp(98, 72, downtownT), lerp(92, 68, downtownT)];
  const jitter = (hashCell(i, j, 61) - 0.5) * 26;
  return [clamp(base[0] + jitter, 36, 150), clamp(base[1] + jitter, 36, 150), clamp(base[2] + jitter, 36, 150)];
}

/**
 * 街区内側の地面を1枚の平面ポリゴンで舗装寄りの色に塗り替える。
 * isParkBlockに該当する街区は塗らずに地形本来の緑を残し、公園として見せる。
 * 舗装する街区も道路との境目にわずかな余白（緑の縁）を残し、隙間なく
 * 敷き詰められた一枚のグレーに見えないようにしている。
 */
function drawBlockPavement(renderer, blk, dist) {
  if (isParkBlock(blk.i, blk.j, blk.downtownT)) return;
  const half = SUPER / 2 - ROAD_HALF_W - 4;
  const y = surfaceHeightAt(blk.bx, blk.bz) + 0.28;
  const color = blockPavementColor(blk.i, blk.j, blk.bx, blk.bz);
  renderer.fillPolygon(
    [
      vec3(blk.bx - half, y, blk.bz - half),
      vec3(blk.bx + half, y, blk.bz - half),
      vec3(blk.bx + half, y, blk.bz + half),
      vec3(blk.bx - half, y, blk.bz + half),
    ],
    renderer.fog(color, dist),
  );
}

/**
 * 街区の西辺・南辺に道路を1枚の平面ポリゴンで敷く（drawRunwayと同じ、地表よりわずかに
 * 高い平面）。隣接する街区がそれぞれ自分の西・南だけを描くことで、格子の各線が
 * 二重に描かれないようにしている。
 */
function drawRoadEdge(renderer, blk, edge, dist) {
  const color = renderer.fog([58, 58, 62], dist);
  if (edge === 'w') {
    const x = blk.bx - SUPER / 2;
    const y = surfaceHeightAt(x, blk.bz) + 0.22;
    renderer.fillPolygon(
      [
        vec3(x - ROAD_HALF_W, y, blk.bz - SUPER / 2),
        vec3(x + ROAD_HALF_W, y, blk.bz - SUPER / 2),
        vec3(x + ROAD_HALF_W, y, blk.bz + SUPER / 2),
        vec3(x - ROAD_HALF_W, y, blk.bz + SUPER / 2),
      ],
      color,
    );
  } else {
    const z = blk.bz - SUPER / 2;
    const y = surfaceHeightAt(blk.bx, z) + 0.22;
    renderer.fillPolygon(
      [
        vec3(blk.bx - SUPER / 2, y, z - ROAD_HALF_W),
        vec3(blk.bx + SUPER / 2, y, z - ROAD_HALF_W),
        vec3(blk.bx + SUPER / 2, y, z + ROAD_HALF_W),
        vec3(blk.bx - SUPER / 2, y, z + ROAD_HALF_W),
      ],
      color,
    );
  }
}

/** ビルを1棟描く。高さはheightBudgetAtの上限内でハッシュから決める。 */
function drawCityBuilding(renderer, c, dist) {
  const { i, j, x, z, approachLow } = c;
  const groundY = surfaceHeightAt(x, z);
  const budget = heightBudgetAt(x, z, approachLow);
  const downtownT = clamp(1 - Math.hypot(x - DOWNTOWN.x, z - DOWNTOWN.z) / DOWNTOWN_RADIUS, 0, 1);
  const hSeed = hashCell(i, j, 44);
  // 高層・中層・低層を混ぜて街らしい高さのばらつきを出す。高層の当選率は
  // ダウンタウン中心ほど大きく上げ（郊外12%→ダウンタウン中心85%）、狭い範囲に
  // 80〜120m級の塔を数棟〜十数棟固めてスカイラインの塊を作る。
  const highChance = 0.12 + downtownT * 0.73;
  let h;
  if (hSeed < highChance) h = budget * (0.5 + hashCell(i, j, 45) * 0.5);
  else if (hSeed < highChance + 0.35) h = 16 + hashCell(i, j, 46) * Math.max(4, budget * 0.4 - 16);
  else h = 8 + hashCell(i, j, 47) * 8;
  h = Math.min(h, budget);
  // 街区(LOT=45m)の大半を建物で埋めるよう、旧版(14〜34m)より一回り大きくした
  // （狭くした街区に合わせて充填率を上げる狙い。街区ピッチとの余白は
  // collectCityBuildingsのオフセット・道路クリアランスで確保している）。
  const w = 16 + hashCell(i, j, 48) * 22;
  const dpt = 16 + hashCell(i, j, 49) * 22;
  const base = CITY_COLORS[Math.floor(hashCell(i, j, 50) * CITY_COLORS.length)];
  // 窓の帯は中層以上（高くて目立つビル）にだけ入れてポリゴン数を抑える。
  const banded = h > 26;
  const upper = [Math.min(255, base[0] + 46), Math.min(255, base[1] + 46), Math.min(255, base[2] + 50)];
  drawBox(renderer, x, z, w, dpt, groundY, h, base, upper, [66, 68, 74], banded ? 0.62 : 0, dist);
}

/**
 * 街並みを描く（飛行場周辺の平坦地のみ、詳細はCITY_MAX_R/MIN_Rのコメント参照）。
 * 配置はhashCellによる決定的な擬似乱数で、毎回同じ街になる。地表の実際の標高
 * （surfaceHeightAt）に載せることで、平坦化のブレンド境界（AIRFIELD_INNER〜OUTERの間）
 * でも建物・道路・舗装が地面から浮いたり埋まったりしないようにする。
 *
 * 道路網・街区の舗装・ビルをすべて1本の距離順（画家のアルゴリズム：奥から手前）の
 * リストにまとめて描く。種類ごとにばらばらにソートして描くと、種類の切り替わり目で
 * 手前・奥の関係が壊れる（近い道路が遠いビルの後ろに塗られてしまう等）ため。
 *
 * 高度に応じて描画上限を絞る（drawTreesの高度カリングと同じ考え方）。高高度から
 * 見ると個々の建物・道路はほとんど視認できないのに、見渡せる範囲が広がる分だけ
 * 候補数は増えてしまうため、上限を下げてコストを頭打ちにする。
 */
export function drawCity(renderer) {
  const camY = renderer.camPos.y;
  const buildingCap = camY > 700 ? 14 : camY > 350 ? 44 : MAX_CITY_BUILDINGS;
  const blockCap = camY > 700 ? 8 : camY > 350 ? 10 : MAX_CITY_BLOCKS;
  collectCityBuildings(renderer, buildingCap);
  collectCityBlocks(renderer, blockCap);

  const items = [];
  for (const blk of cityBlocks) {
    const d = Math.sqrt(blk.d2);
    items.push({ kind: 'pave', blk, d });
    items.push({ kind: 'roadW', blk, d });
    items.push({ kind: 'roadS', blk, d });
  }
  for (const c of cityCandidates) {
    items.push({ kind: 'bld', c, d: Math.sqrt(c.d2) });
  }
  items.sort((a, b) => b.d - a.d);

  for (const it of items) {
    if (it.kind === 'pave') drawBlockPavement(renderer, it.blk, it.d);
    else if (it.kind === 'roadW') drawRoadEdge(renderer, it.blk, 'w', it.d);
    else if (it.kind === 'roadS') drawRoadEdge(renderer, it.blk, 's', it.d);
    else drawCityBuilding(renderer, it.c, it.d);
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

const shadowPoints = [];
for (let i = 0; i < 16; i++) shadowPoints.push(vec3());

/**
 * 自機の影を地表（水面を含む）に落とす。
 * Zバッファが無いレンダラなので、呼び出し側（game.js）で必ず
 * 「地形より後・自機より前」の順に呼ぶこと。高度が上がるほど影を
 * 大きく・薄くすることで、簡易ながらそれらしい遠近感を出している。
 */
export function drawAircraftShadow(renderer, aircraft) {
  const groundY = surfaceHeightAt(aircraft.pos.x, aircraft.pos.z);
  const agl = aircraft.pos.y - groundY;
  if (agl > 450 || agl < -5) return; // 高すぎる/めり込み中は省略して負荷を下げる
  const alpha = clamp(0.38 * (1 - agl / 450), 0.02, 0.38);
  if (alpha <= 0.02) return;
  const centerDist = renderer.distanceTo(vec3(aircraft.pos.x, groundY, aircraft.pos.z));
  if (centerDist > FAR) return;
  // 高度に応じて影を大きくする（実際の投影計算ではないが、簡易な近似として十分）。
  const spread = 1 + agl / 130;
  const rx = 5.8 * spread;
  const rz = 3.8 * spread;
  // 機首方向の水平成分だけを使って影の向きの基底を作る（宙返り中の急なピッチは無視する）。
  const b = aircraft.basis;
  let fx = b.forward.x;
  let fz = b.forward.z;
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl;
  fz /= fl;
  const rightX = fz;
  const rightZ = -fx;
  for (let i = 0; i < shadowPoints.length; i++) {
    const a = (i / shadowPoints.length) * Math.PI * 2;
    const lx = Math.cos(a) * rx;
    const lz = Math.sin(a) * rz;
    const p = shadowPoints[i];
    p.x = aircraft.pos.x + lx * rightX + lz * fx;
    p.y = groundY + 0.12; // 地表からわずかに浮かせ、地形との継ぎ目のちらつきを避ける
    p.z = aircraft.pos.z + lx * rightZ + lz * fz;
  }
  const ctx = renderer.ctx;
  ctx.globalAlpha = alpha;
  renderer.fillPolygon(shadowPoints, 'rgb(8,12,16)');
  ctx.globalAlpha = 1;
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
