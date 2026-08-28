/**
 * 3Dベクトル・回転・補間のための最小限の数学ユーティリティ。
 * ゲームループ中のGCを避けるため、多くの関数は出力先オブジェクト out を受け取る。
 * 座標系は X=東 / Y=上（高度） / Z=北 の右手系。
 */

/** 3次元ベクトルを生成する。 */
export function vec3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

/** out に成分を直接代入する。 */
export function setv(out, x, y, z) {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** a の値を out にコピーする。 */
export function copy(out, a) {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

/** out = a + b */
export function add(out, a, b) {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

/** out = a - b */
export function sub(out, a, b) {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

/** out = a * s */
export function scale(out, a, s) {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

/** out = a + b * s（力の積算などで多用する） */
export function addScaled(out, a, b, s) {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

/** 内積 */
export function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** 外積 out = a × b（out と入力が同一でも安全） */
export function cross(out, a, b) {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** ベクトルの長さ */
export function len(a) {
  return Math.hypot(a.x, a.y, a.z);
}

/** 正規化する。長さ0のときは (0,0,1) を返す。 */
export function normalize(out, a) {
  const l = Math.hypot(a.x, a.y, a.z);
  if (l < 1e-9) return setv(out, 0, 0, 1);
  out.x = a.x / l;
  out.y = a.y / l;
  out.z = a.z / l;
  return out;
}

const rodriguesTmp = vec3();

/** ロドリゲスの回転公式で v を軸 axis まわりに angle ラジアン回す。 */
export function rotateAround(out, v, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  cross(rodriguesTmp, axis, v);
  const d = dot(axis, v) * (1 - c);
  const x = v.x * c + rodriguesTmp.x * s + axis.x * d;
  const y = v.y * c + rodriguesTmp.y * s + axis.y * d;
  const z = v.z * c + rodriguesTmp.z * s + axis.z * d;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** 値を範囲内に収める。 */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 線形補間 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 0→1 に滑らかに遷移させる。 */
export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * フレームレートに依存しない指数補間。
 * lambda が大きいほど target に速く追従する。
 */
export function damp(current, target, lambda, dt) {
  return lerp(target, current, Math.exp(-lambda * dt));
}

/** シード固定の擬似乱数生成器（mulberry32）。コースを再現可能にするために使う。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 機体姿勢を表す正規直交基底を作る。
 * right × up = forward の関係を保つ。
 */
export function createBasis() {
  return { forward: vec3(0, 0, 1), right: vec3(1, 0, 0), up: vec3(0, 1, 0) };
}

const axisTmp = vec3();

/** 基底全体を軸まわりに回転させる。 */
export function rotateBasis(basis, axis, angle) {
  if (Math.abs(angle) < 1e-9) return basis;
  copy(axisTmp, axis);
  rotateAround(basis.forward, basis.forward, axisTmp, angle);
  rotateAround(basis.right, basis.right, axisTmp, angle);
  rotateAround(basis.up, basis.up, axisTmp, angle);
  return basis;
}

/** 数値誤差で歪んだ基底を直交化し直す。 */
export function orthonormalize(basis) {
  normalize(basis.forward, basis.forward);
  cross(basis.right, basis.up, basis.forward);
  normalize(basis.right, basis.right);
  cross(basis.up, basis.forward, basis.right);
  return basis;
}

/** 前方ベクトルから方位角（ラジアン、0が北・時計回り）を求める。 */
export function headingOf(basis) {
  return Math.atan2(basis.forward.x, basis.forward.z);
}

/** ピッチ角（ラジアン、正が機首上げ）を求める。 */
export function pitchOf(basis) {
  return Math.asin(clamp(basis.forward.y, -1, 1));
}

/** ロール角（ラジアン、正が右バンク）を求める。 */
export function rollOf(basis) {
  return Math.atan2(-basis.right.y, basis.up.y);
}
