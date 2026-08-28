/**
 * 操縦入力の抽象化。
 * スマホのタッチ（仮想スティック＋スロットルスライダー）、端末の傾き、
 * PCのキーボードをまとめて同じ形の入力に変換する。
 */

import { clamp, damp } from './math.js';

/** 仮想スティックの最大移動量（画面短辺に対する比率）。 */
const STICK_RADIUS_RATIO = 0.17;
/** スロットルスライダーの配置（画面幅・高さに対する比率）。 */
export const THROTTLE_AREA = { x0: 0.84, x1: 1.0, y0: 0.16, y1: 0.88 };
/** 仮想スティックとして扱う画面左側の範囲。 */
const STICK_AREA_X = 0.62;

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

  /** スロットル領域内かどうか。 */
  _inThrottle(n) {
    return n.x >= THROTTLE_AREA.x0 && n.y >= THROTTLE_AREA.y0 - 0.06 && n.y <= THROTTLE_AREA.y1 + 0.06;
  }

  /** スロットル領域のY座標からスロットル値を決める。 */
  _setThrottleFrom(n) {
    const t = (n.y - THROTTLE_AREA.y0) / (THROTTLE_AREA.y1 - THROTTLE_AREA.y0);
    this.input.throttle = clamp(1 - t, 0, 1);
  }

  _beginTouch(id, n) {
    if (this._inThrottle(n)) {
      this.throttleTouchId = id;
      this._setThrottleFrom(n);
      return;
    }
    if (n.x < STICK_AREA_X && this.scheme === 'touch' && !this.stick.active) {
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
      this._setThrottleFrom(n);
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
    const aspect = r.width / Math.max(r.height, 1);
    // 画面短辺基準の円形リミットにする。
    const radius = STICK_RADIUS_RATIO;
    const dx = ((this.stick.x - this.stick.ox) * (aspect > 1 ? 1 / aspect : 1)) / radius;
    const dy = ((this.stick.y - this.stick.oy) * (aspect > 1 ? 1 : aspect)) / radius;
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
      // 端末を手前に倒す＝機首下げ、右に傾ける＝右ロール。
      pitch = clamp(-dBeta / 26, -1, 1);
      roll = clamp(dGamma / 26, -1, 1);
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
