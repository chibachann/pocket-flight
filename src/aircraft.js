/**
 * 簡易的な固定翼機の飛行モデル。
 * 揚力・抗力・推力・重力を毎ステップ積分し、姿勢は正規直交基底で保持する。
 * 実機の再現ではなく「それらしく操縦できる」ことを優先している。
 */

import {
  addScaled,
  clamp,
  copy,
  createBasis,
  cross,
  damp,
  dot,
  len,
  normalize,
  orthonormalize,
  rotateBasis,
  scale,
  setv,
  vec3,
} from './math.js';
import { groundHeightAt } from './terrain.js';

/** 機体諸元。 */
export const SPEC = {
  mass: 1200, // kg
  wingArea: 16, // m^2
  maxThrust: 4600, // N
  cl0: 0.15,
  clAlpha: 5.0, // 1/rad
  stallAoA: 0.3, // rad
  cd0: 0.03,
  inducedK: 0.05,
  /**
   * 操縦入力による最大角速度（rad/s）。
   * 感度調整の一環で 1.2/2.2 から下げた。下げすぎるとループが一周し切れないため、
   * scratchpad の物理シミュレーションで宙返り成立を確認しながら決めている。
   */
  pitchRate: 0.95,
  rollRate: 1.6,
  yawRate: 0.55,
  /** 横滑りを打ち消す風見安定の強さ。 */
  weathervane: 1.8,
  gravity: 9.81,
};

/** 高度による空気密度（簡易な等温大気）。 */
function airDensity(altitude) {
  return 1.225 * Math.exp(-Math.max(altitude, 0) / 8500);
}

export class Aircraft {
  constructor() {
    this.pos = vec3(0, 0, 0);
    this.prevPos = vec3(0, 0, 0);
    this.vel = vec3(0, 0, 0);
    this.basis = createBasis();
    this.throttle = 0.7;
    /** 表示・音用のエンジン回転数（0〜1）。 */
    this.rpm = 0.7;
    this.alpha = 0;
    this.beta = 0;
    this.gLoad = 1;
    this.stalling = false;
    this.crashed = false;
    this.onGround = false;
    // 作業用ベクトル（毎フレームの確保を避ける）。
    this._f = vec3();
    this._t = vec3();
    this._vh = vec3();
    this._lift = vec3();
  }

  /** 指定の位置・方位・速度で機体を初期化する。 */
  reset(x, y, z, heading, speed) {
    setv(this.pos, x, y, z);
    copy(this.prevPos, this.pos);
    const b = this.basis;
    setv(b.forward, Math.sin(heading), 0, Math.cos(heading));
    setv(b.up, 0, 1, 0);
    cross(b.right, b.up, b.forward);
    orthonormalize(b);
    scale(this.vel, b.forward, speed);
    this.throttle = 0.75;
    this.rpm = 0.75;
    this.crashed = false;
    this.onGround = false;
    this.stalling = false;
    this.gLoad = 1;
  }

  /** 対気速度（m/s）。 */
  get speed() {
    return len(this.vel);
  }

  /** 高度（m）。 */
  get altitude() {
    return this.pos.y;
  }

  /** 対地高度（m）。 */
  agl() {
    return this.pos.y - groundHeightAt(this.pos.x, this.pos.z);
  }

  /** 上昇率（m/s）。 */
  get verticalSpeed() {
    return this.vel.y;
  }

  /**
   * 1ステップ進める。
   * input は {pitch, roll, yaw, throttle} で各成分は -1〜1（throttleのみ0〜1）。
   */
  step(input, dt) {
    if (this.crashed) return;
    const b = this.basis;
    copy(this.prevPos, this.pos);

    // スロットルは急変させず滑らかに追従させる。
    this.throttle = clamp(input.throttle, 0, 1);
    this.rpm = damp(this.rpm, this.throttle, 2.4, dt);

    const speed = len(this.vel);
    const rho = airDensity(this.pos.y);
    const q = 0.5 * rho * speed * speed;

    // 迎角・横滑り角を求める。
    if (speed > 0.5) {
      normalize(this._vh, this.vel);
      this.alpha = Math.atan2(-dot(this._vh, b.up), Math.max(dot(this._vh, b.forward), 0.05));
      this.beta = Math.asin(clamp(dot(this._vh, b.right), -1, 1));
    } else {
      this.alpha = 0;
      this.beta = 0;
    }

    // 舵の効きは対気速度に依存する（低速では効きが落ちる）。
    // 下限を0→0.35へ引き上げ、低速でも最低限の舵が残るようにした（アーケード的な割り切り）。
    // 0のままだとループ頂点などで速度が落ちたときに舵が完全に死に、姿勢を保てず失敗するため。
    const authority = clamp(speed / 55, 0.35, 1.15);
    let pitchCmd = clamp(input.pitch, -1, 1);
    let rollCmd = clamp(input.roll, -1, 1);
    const yawCmd = clamp(input.yaw, -1, 1);

    // 地上にいる間はロール入力を完全に無効化し、翼を水平に保つ。
    // resolveGround() の接地条件は roll<0.35（約20度）で「穏やかな接地」を判定しており、
    // アシストを廃止した今は自動水平復帰も無いため、わずかでもロールが残ると
    // 積み上がって接地クラッシュになってしまう。速度で条件を切ると、離陸滑走中に
    // 機首を上げずロールだけ入れ続けた場合など、速度がしきい値を超えた瞬間に
    // まだ地上にいるのにロール操作が復活してクラッシュしうる（実際に検証で確認した）。
    // onGroundだけで判定すれば、浮き上がって初めて（＝速度に関係なく実際に接地が
    // 解けた瞬間から）通常のロール操作に戻るため、この抜け道がなくなる。
    if (this.onGround) rollCmd = 0;

    const pitchRate = pitchCmd * SPEC.pitchRate * authority;
    const rollRate = rollCmd * SPEC.rollRate * authority;
    // 風見安定：機首を速度ベクトル側へ向けて横滑りを打ち消し、旋回を協調させる。
    const yawRate = yawCmd * SPEC.yawRate * authority + this.beta * SPEC.weathervane;

    rotateBasis(b, b.right, -pitchRate * dt);
    rotateBasis(b, b.up, yawRate * dt);
    rotateBasis(b, b.forward, -rollRate * dt);
    orthonormalize(b);

    // 揚力係数（失速後は急減させる）。
    let cl = SPEC.cl0 + SPEC.clAlpha * clamp(this.alpha, -0.6, 0.6);
    const over = Math.abs(this.alpha) - SPEC.stallAoA;
    this.stalling = over > 0 && speed > 1;
    if (over > 0) cl *= Math.max(0.22, 1 - over * 2.6);

    const cd = SPEC.cd0 + SPEC.inducedK * cl * cl + Math.abs(this.beta) * 0.35;

    // 合力を求める。
    const f = setv(this._f, 0, -SPEC.mass * SPEC.gravity, 0);
    // 推力
    addScaled(f, f, b.forward, this.rpm * SPEC.maxThrust);

    if (speed > 0.5) {
      // 揚力は速度に垂直で機体対称面内。
      cross(this._lift, this._vh, b.right);
      normalize(this._lift, this._lift);
      const liftMag = q * SPEC.wingArea * cl;
      addScaled(f, f, this._lift, liftMag);
      // 抗力は速度と逆向き。
      addScaled(f, f, this._vh, -q * SPEC.wingArea * cd);
      // 横力（横滑りを空力的にも減衰させる）。
      addScaled(f, f, b.right, -q * SPEC.wingArea * 0.9 * this.beta);
      this.gLoad = liftMag / (SPEC.mass * SPEC.gravity);
    } else {
      this.gLoad = 0;
    }

    // 速度・位置を積分する。
    scale(this._t, f, dt / SPEC.mass);
    this.vel.x += this._t.x;
    this.vel.y += this._t.y;
    this.vel.z += this._t.z;
    addScaled(this.pos, this.pos, this.vel, dt);
  }

  /**
   * 地面との接触を処理する。
   * onRunway が true かつ接地条件を満たせば着陸成功として扱う。
   * 戻り値は 'none' | 'landed' | 'crashed'。
   */
  resolveGround(onRunway, groundY) {
    const clearance = this.pos.y - groundY;
    if (clearance > 1.6) {
      this.onGround = false;
      return 'none';
    }
    const roll = Math.abs(Math.atan2(-this.basis.right.y, this.basis.up.y));
    const pitch = Math.asin(clamp(this.basis.forward.y, -1, 1));
    const sinkRate = -this.vel.y;
    const speed = len(this.vel);
    // カジュアル向けに接地条件はやや甘めにしている。
    const gentle = onRunway && sinkRate < 7 && roll < 0.35 && pitch > -0.2 && pitch < 0.45 && speed < 110;
    if (!gentle) {
      this.crashed = true;
      this.onGround = true;
      return 'crashed';
    }
    // 接地：地面に沿って減速させる。
    this.pos.y = groundY + 1.5;
    this.vel.y = Math.max(this.vel.y, 0);
    const brake = this.throttle < 0.15 ? 0.985 : 0.999;
    this.vel.x *= brake;
    this.vel.z *= brake;
    this.onGround = true;
    return 'landed';
  }
}
