/**
 * コース定義。滑走路の諸元と、シードから生成するリング（ゲート）列を扱う。
 */

import { AIRFIELD_ELEVATION, heightAt } from './terrain.js';
import { clamp, mulberry32, vec3 } from './math.js';

/** 滑走路の諸元。長辺はZ軸（北）方向に伸びる。 */
export const RUNWAY = {
  centerX: 0,
  centerZ: 0,
  halfLength: 700,
  halfWidth: 30,
  elevation: AIRFIELD_ELEVATION,
  /** 進入方位（ラジアン、0＝北向き着陸）。 */
  heading: 0,
};

/** 指定座標が滑走路上かどうか。 */
export function isOverRunway(x, z, margin = 0) {
  return (
    Math.abs(x - RUNWAY.centerX) <= RUNWAY.halfWidth + margin &&
    Math.abs(z - RUNWAY.centerZ) <= RUNWAY.halfLength + margin
  );
}

/**
 * リングコースを生成する。
 * 滑走路の北側から始まり、地形の上を蛇行しながら周回して戻ってくる。
 */
export function createCourse(seed, gateCount) {
  const rand = mulberry32(seed);
  const gates = [];
  let heading = 0;
  let x = 0;
  let z = 1400;
  for (let i = 0; i < gateCount; i++) {
    // 終盤は飛行場へ向き直り、周回コースとして閉じる。
    const homeBias = i >= gateCount - 3 ? 0.45 : 0;
    if (homeBias > 0) {
      const toHome = Math.atan2(-x, -z);
      let diff = toHome - heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      heading += diff * homeBias;
    }
    heading += (rand() - 0.5) * 1.5;
    const dist = 900 + rand() * 700;
    x += Math.sin(heading) * dist;
    z += Math.cos(heading) * dist;
    const ground = Math.max(heightAt(x, z), 0);
    const y = clamp(ground + 120 + rand() * 220, 160, 900);
    gates.push({
      pos: vec3(x, y, z),
      // リングの通過方向。わずかに上下の傾きを付けて単調さを避ける。
      dir: vec3(Math.sin(heading), (rand() - 0.5) * 0.3, Math.cos(heading)),
      radius: 48,
      passed: false,
    });
  }
  // 方向ベクトルを正規化する。
  for (const g of gates) {
    const l = Math.hypot(g.dir.x, g.dir.y, g.dir.z);
    g.dir.x /= l;
    g.dir.y /= l;
    g.dir.z /= l;
  }
  return gates;
}

/**
 * 前フレーム位置 prev から現在位置 cur への移動でリングを通過したか判定する。
 * リング面を正方向に横切り、かつ交点が半径内なら通過とみなす。
 */
export function checkGatePass(gate, prev, cur) {
  const d0 =
    (prev.x - gate.pos.x) * gate.dir.x + (prev.y - gate.pos.y) * gate.dir.y + (prev.z - gate.pos.z) * gate.dir.z;
  const d1 =
    (cur.x - gate.pos.x) * gate.dir.x + (cur.y - gate.pos.y) * gate.dir.y + (cur.z - gate.pos.z) * gate.dir.z;
  if (d0 >= 0 || d1 < 0) return false;
  const t = d0 === d1 ? 0 : d0 / (d0 - d1);
  const ix = prev.x + (cur.x - prev.x) * t - gate.pos.x;
  const iy = prev.y + (cur.y - prev.y) * t - gate.pos.y;
  const iz = prev.z + (cur.z - prev.z) * t - gate.pos.z;
  // 面法線方向の成分を除いた半径距離を測る。
  const n = ix * gate.dir.x + iy * gate.dir.y + iz * gate.dir.z;
  const rx = ix - gate.dir.x * n;
  const ry = iy - gate.dir.y * n;
  const rz = iz - gate.dir.z * n;
  return Math.hypot(rx, ry, rz) <= gate.radius;
}
