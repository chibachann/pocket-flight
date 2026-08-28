/**
 * 操縦入力の抽象化。
 * スマホのタッチ（仮想スティック＋スロットルスライダー）、端末の傾き、
 * PCのキーボードをまとめて同じ形の入力に変換する。
 */

import { clamp, damp } from './math.js';

/** 仮想スティックの最大移動量（画面短辺に対する比率）。 */
const STICK_RADIUS_RATIO = 0.17;

/**
 * 画面の向きごとの操作エリア配置（画面幅・高さに対する比率）。
 * throttle はスロットルスライダーの範囲、stickMaxX は仮想スティックとして扱う左側の範囲。
 * 縦画面では画面が細長く上端に指が届かないため、スロットルを下半分に寄せる。
 */
const LAYOUT = {
  landscape: { throttle: { x0: 0.84, x1: 1.0, y0: 0.16, y1: 0.88 }, stickMaxX: 0.62 },
  portrait: { throttle: { x0: 0.78, x1: 1.0, y0: 0.6, y1: 0.95 }, stickMaxX: 0.72 },
};

/** 画面の向きに応じた操作エリアの配置を返す。 */
export function controlLayout(portrait) {
  return portrait ? LAYOUT.portrait : LAYOUT.landscape;
}

/** 画面（表示内容）が自然な向きから何度回転しているか。傾き操作の軸合わせに使う。 */
function screenAngle() {
  const so = window.screen && window.screen.orientation;
  if (so && typeof so.angle === 'number') return so.angle;
  // 旧 iOS Safari 向けのフォールバック。-90 などを 0〜359 に正規化する。
  if (typeof window.orientation === 'number') return ((window.orientation % 360) + 360) % 360;
  return 0;
}

export class Controls {
  constructor(canvas) {
    this.canvas = canvas;
    /** 外部が読む最終的な操縦入力。 */
    this.input = { pitch: 0, roll: 0, yaw: 0, throttle: 0.75 };
    /** 平滑化前の目標値。 */
    this.target = { pitch: 0, roll: 0, yaw: 0 };
    /** 'touch' | 'tilt' */
    this.scheme = 'touch';
    /** 上方向スワイプで機首上げにするか（false なら操縦桿と同じく引き＝上げ）。 */
    this.invertPitch = false;
    this.sensitivity = 1;

    this.stick = { active: false, id: null, ox: 0, oy: 0, x: 0, y: 0 };
    this.throttleTouchId = null;
    this.keys = new Set();
    /** 傾き操作の基準姿勢。 */
    this.tiltZero = { beta: 35, gamma: 0 };
    this.tiltRaw = { beta: 35, gamma: 0 };
    this.tiltAvailable = false;
    this.enabled = false;

    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onOrientation = this._onOrientation.bind(this);
  }

  /** イベント購読を開始する。 */
  attach() {
    const c = this.canvas;
    c.addEventListener('touchstart', this._onTouchStart, { passive: false });
    c.addEventListener('touchmove', this._onTouchMove, { passive: false });
    c.addEventListener('touchend', this._onTouchEnd, { passive: false });
    c.addEventListener('touchcancel', this._onTouchEnd, { passive: false });
    // マウス操作（PCでの動作確認用）。
    c.addEventListener('mousedown', this._onPointerDown);
    window.addEventListener('mousemove', this._onPointerMove);
    window.addEventListener('mouseup', this._onPointerUp);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('deviceorientation', this._onOrientation);
  }

  /** 画面座標（CSSピクセル）を 0〜1 の正規化座標へ変換する。 */
  _norm(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
  }

  /** 現在の画面の向きに応じた操作エリアの配置。 */
  _layout() {
    const r = this.canvas.getBoundingClientRect();
    return controlLayout(r.height > r.width);
  }

  /** スロットル領域内かどうか。 */
  _inThrottle(n, layout) {
    const a = layout.throttle;
    return n.x >= a.x0 && n.y >= a.y0 - 0.06 && n.y <= a.y1 + 0.06;
  }

  /** スロットル領域のY座標からスロットル値を決める。 */
  _setThrottleFrom(n, layout) {
    const a = layout.throttle;
    const t = (n.y - a.y0) / (a.y1 - a.y0);
    this.input.throttle = clamp(1 - t, 0, 1);
  }

  _beginTouch(id, n) {
    const layout = this._layout();
    if (this._inThrottle(n, layout)) {
      this.throttleTouchId = id;
      this._setThrottleFrom(n, layout);
      return;
    }
    if (n.x < layout.stickMaxX && this.scheme === 'touch' && !this.stick.active) {
      this.stick.active = true;
      this.stick.id = id;
      this.stick.ox = n.x;
      this.stick.oy = n.y;
      this.stick.x = n.x;
      this.stick.y = n.y;
    }
  }

  _moveTouch(id, n) {
    if (id === this.throttleTouchId) {
      this._setThrottleFrom(n, this._layout());
      return;
    }
    if (this.stick.active && id === this.stick.id) {
      this.stick.x = n.x;
      this.stick.y = n.y;
    }
  }

  _endTouch(id) {
    if (id === this.throttleTouchId) this.throttleTouchId = null;
    if (this.stick.active && id === this.stick.id) {
      this.stick.active = false;
      this.stick.id = null;
    }
  }

  _onTouchStart(e) {
    if (!this.enabled) return;
    e.preventDefault();
    for (const t of e.changedTouches) this._beginTouch(t.identifier, this._norm(t.clientX, t.clientY));
  }

  _onTouchMove(e) {
    if (!this.enabled) return;
    e.preventDefault();
    for (const t of e.changedTouches) this._moveTouch(t.identifier, this._norm(t.clientX, t.clientY));
  }

  _onTouchEnd(e) {
    if (!this.enabled) return;
    e.preventDefault();
    for (const t of e.changedTouches) this._endTouch(t.identifier);
  }

  _onPointerDown(e) {
    if (!this.enabled) return;
    this._beginTouch('mouse', this._norm(e.clientX, e.clientY));
  }

  _onPointerMove(e) {
    if (!this.enabled) return;
    this._moveTouch('mouse', this._norm(e.clientX, e.clientY));
  }

  _onPointerUp() {
    if (!this.enabled) return;
    this._endTouch('mouse');
  }

  _onKeyDown(e) {
    this.keys.add(e.code);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  }

  _onKeyUp(e) {
    this.keys.delete(e.code);
  }

  _onOrientation(e) {
    if (e.beta === null || e.gamma === null) return;
    this.tiltAvailable = true;
    this.tiltRaw.beta = e.beta;
    this.tiltRaw.gamma = e.gamma;
  }

  /** 現在の端末の傾きを中立位置として記録する。 */
  calibrateTilt() {
    this.tiltZero.beta = this.tiltRaw.beta;
    this.tiltZero.gamma = this.tiltRaw.gamma;
  }

  /** 仮想スティックの現在の変位（-1〜1）。HUDの描画にも使う。 */
  stickVector() {
    if (!this.stick.active) return { x: 0, y: 0 };
    const r = this.canvas.getBoundingClientRect();
    // 画面短辺を基準にした円形リミット。実ピクセルで計算するので、
    // 縦横どちらの向きでも上下と左右の必要な指の移動量が揃う。
    const radius = Math.max(Math.min(r.width, r.height), 1) * STICK_RADIUS_RATIO;
    const dx = ((this.stick.x - this.stick.ox) * r.width) / radius;
    const dy = ((this.stick.y - this.stick.oy) * r.height) / radius;
    const l = Math.hypot(dx, dy);
    if (l > 1) return { x: dx / l, y: dy / l };
    return { x: dx, y: dy };
  }

  /** 毎フレーム呼び出して入力を更新する。 */
  update(dt) {
    let pitch = 0;
    let roll = 0;
    let yaw = 0;

    if (this.scheme === 'touch') {
      const v = this.stickVector();
      roll = v.x;
      // 画面下方向がプラスなので、上スワイプで機首上げなら符号を反転する。
      pitch = this.invertPitch ? v.y : -v.y;
    } else if (this.scheme === 'tilt') {
      const dBeta = this.tiltRaw.beta - this.tiltZero.beta;
      let dGamma = this.tiltRaw.gamma - this.tiltZero.gamma;
      if (dGamma > 180) dGamma -= 360;
      if (dGamma < -180) dGamma += 360;
      // beta/gamma は端末の自然な向き（縦）を基準にした角度なので、
      // 画面の回転角ぶんだけ傾きベクトルを回して、見た目の左右・上下に合わせる。
      const a = (screenAngle() * Math.PI) / 180;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      const tx = dGamma * cs + dBeta * sn;
      const ty = -dGamma * sn + dBeta * cs;
      // 画面を手前に倒す＝機首下げ、右に傾ける＝右ロール。
      pitch = clamp(-ty / 26, -1, 1);
      roll = clamp(tx / 26, -1, 1);
      if (this.invertPitch) pitch = -pitch;
      // 傾き操作では微小な揺れを無視する。
      if (Math.abs(pitch) < 0.08) pitch = 0;
      if (Math.abs(roll) < 0.08) roll = 0;
    }

    // キーボード（PCでの操作・デバッグ用）。
    const k = this.keys;
    if (k.has('ArrowUp') || k.has('KeyI')) pitch += 1;
    if (k.has('ArrowDown') || k.has('KeyK')) pitch -= 1;
    if (k.has('ArrowLeft') || k.has('KeyJ')) roll -= 1;
    if (k.has('ArrowRight') || k.has('KeyL')) roll += 1;
    if (k.has('KeyA')) yaw -= 1;
    if (k.has('KeyD')) yaw += 1;
    if (k.has('KeyW')) this.input.throttle = clamp(this.input.throttle + dt * 0.6, 0, 1);
    if (k.has('KeyS')) this.input.throttle = clamp(this.input.throttle - dt * 0.6, 0, 1);

    pitch = clamp(pitch * this.sensitivity, -1, 1);
    roll = clamp(roll * this.sensitivity, -1, 1);

    // 入力を平滑化して操作をなめらかにする。
    this.input.pitch = damp(this.input.pitch, pitch, 14, dt);
    this.input.roll = damp(this.input.roll, roll, 14, dt);
    this.input.yaw = damp(this.input.yaw, clamp(yaw, -1, 1), 14, dt);
    return this.input;
  }

  /** 入力を中立へ戻す（ポーズ時など）。 */
  release() {
    this.stick.active = false;
    this.stick.id = null;
    this.throttleTouchId = null;
    this.input.pitch = 0;
    this.input.roll = 0;
    this.input.yaw = 0;
  }
}
