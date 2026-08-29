/**
 * 手続き的な地形フィールド。
 * 値ノイズのfBmで高さを決め、原点付近は飛行場として平坦化する。
 * 高さが0未満の領域は海面として扱う。
 */

import { clamp, lerp, smoothstep } from './math.js';

/** 飛行場の標高（m）。滑走路はこの高さに置く。 */
export const AIRFIELD_ELEVATION = 24;
/** 飛行場として平坦化する半径（m）。 */
const AIRFIELD_INNER = 700;
const AIRFIELD_OUTER = 1900;

/** 整数格子座標から 0〜1 の疑似乱数を返すハッシュ関数。 */
function hash2(ix, iz) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 5次補間つきの値ノイズ。 */
function valueNoise(x, z, seed) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const s = Math.imul(seed, 0x9e3779b1);
  const n00 = hash2(x0 + s, z0);
  const n10 = hash2(x0 + 1 + s, z0);
  const n01 = hash2(x0 + s, z0 + 1);
  const n11 = hash2(x0 + 1 + s, z0 + 1);
  return lerp(lerp(n00, n10, ux), lerp(n01, n11, ux), uz) * 2 - 1;
}

/** 各オクターブの周波数（1/m）と振幅（m）。 */
const OCTAVES = [
  { f: 1 / 2600, a: 300, seed: 1 },
  { f: 1 / 1100, a: 130, seed: 2 },
  { f: 1 / 420, a: 46, seed: 3 },
  { f: 1 / 160, a: 16, seed: 4 },
  { f: 1 / 55, a: 5, seed: 5 },
];

/**
 * ワールド座標 (x, z) の地形標高（m）を返す。
 * 負の値は水面下を意味する。
 */
export function heightAt(x, z) {
  let h = 30;
  for (let i = 0; i < OCTAVES.length; i++) {
    const o = OCTAVES[i];
    h += valueNoise(x * o.f, z * o.f, o.seed) * o.a;
  }
  // 尾根状のノイズを足して山脈らしさを出す。
  const ridge = 1 - Math.abs(valueNoise(x / 1700, z / 1700, 9));
  h += ridge * ridge * 210 - 60;

  // 飛行場周辺を平坦にならす。
  const d = Math.hypot(x, z);
  const blend = smoothstep(AIRFIELD_INNER, AIRFIELD_OUTER, d);
  return lerp(AIRFIELD_ELEVATION, h, blend);
}

/** 描画用の高さ。海面下は0（水面）に丸める。 */
export function surfaceHeightAt(x, z) {
  return Math.max(heightAt(x, z), 0);
}

/** 衝突判定用の高さ。水面も地面として扱う（着水＝墜落）。 */
export function groundHeightAt(x, z) {
  return surfaceHeightAt(x, z);
}

/**
 * 水面の色を水深から決める。浅瀬は明るいターコイズ、深海は濃紺にする。
 * depth は海面下の深さ（m、正の値）。shade は太陽方向のきらめきを
 * 上乗せできるよう 0〜1 を超えて渡せる（drawRing 側でハイライト分を加算する）。
 */
export function waterColor(depth, shade) {
  const t = clamp(depth / 40, 0, 1); // 水深40mあたりで最も濃い色に達する
  const shallow = [58, 168, 178];
  const deep = [14, 46, 92];
  const r = lerp(shallow[0], deep[0], t);
  const g = lerp(shallow[1], deep[1], t);
  const b = lerp(shallow[2], deep[2], t);
  const s = 0.55 + shade * 0.55;
  return [Math.round(clamp(r * s, 0, 255)), Math.round(clamp(g * s, 0, 255)), Math.round(clamp(b * s, 0, 255))];
}

/**
 * 標高と斜度から地表色を決める。
 * shade は 0〜1 程度の簡易ライティング係数。
 */
export function terrainColor(height, slope, shade) {
  let r;
  let g;
  let b;
  if (height <= 0.01) {
    // 海（水深情報を持たない呼び出し元向けのフォールバック。通常は waterColor を使う）
    r = 26;
    g = 74;
    b = 116;
  } else if (height < 14) {
    r = 196;
    g = 182;
    b = 138;
  } else if (height < 140) {
    const t = clamp((height - 14) / 126, 0, 1);
    r = lerp(96, 74, t);
    g = lerp(134, 112, t);
    b = lerp(70, 62, t);
  } else if (height < 330) {
    const t = clamp((height - 140) / 190, 0, 1);
    r = lerp(74, 118, t);
    g = lerp(112, 110, t);
    b = lerp(62, 100, t);
  } else {
    const t = clamp((height - 330) / 180, 0, 1);
    r = lerp(118, 236, t);
    g = lerp(110, 240, t);
    b = lerp(100, 248, t);
  }
  // 急斜面は岩肌寄りに寄せる。
  const rock = clamp(slope * 1.5 - 0.35, 0, 0.75);
  r = lerp(r, 104, rock);
  g = lerp(g, 98, rock);
  b = lerp(b, 92, rock);

  const s = 0.55 + shade * 0.55;
  return [Math.round(clamp(r * s, 0, 255)), Math.round(clamp(g * s, 0, 255)), Math.round(clamp(b * s, 0, 255))];
}
