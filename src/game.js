/**
 * ゲーム全体の進行管理。
 * 物理は固定ステップで積分し、描画は毎フレーム行う。
 * 状態は 'ready' | 'flying' | 'paused' | 'over' の4つ。
 */

import { Aircraft } from './aircraft.js';
import { checkGatePass, createCourse, isOverRunway, RUNWAY } from './course.js';
import {
  drawAircraft,
  drawAircraftShadow,
  drawApron,
  drawBuildings,
  drawCity,
  drawClouds,
  drawGates,
  drawRunway,
  drawSun,
  drawTerrain,
  drawTrees,
} from './scene.js';
import { drawHud } from './hud.js';
import { groundHeightAt } from './terrain.js';
import {
  addScaled,
  clamp,
  copy,
  createBasis,
  cross,
  damp,
  normalize,
  orthonormalize,
  setv,
  sub,
  vec3,
} from './math.js';

/** 物理の固定ステップ（秒）。 */
const FIXED_DT = 1 / 120;
/** 1フレームで進める最大シミュレーション時間（秒）。 */
const MAX_FRAME = 0.1;

/**
 * 離陸開始位置を滑走路南端から少し内側に取るための余白（m）。
 * 端ぎりぎりに置くと地形の平坦化境界やカメラの初期位置と噛み合わないため、
 * 滑走路全長のうち手前に少し余裕を持たせている。
 */
const TAKEOFF_START_MARGIN = 50;

/**
 * モードごとの設定。
 * timeLimitは離陸から着陸までの制限時間。以前は空中巡航状態から始まっていたが、
 * 滑走路から加速して離陸するようになった分、離陸に要する時間（目安10秒前後）を
 * 加味して75秒→90秒に延長した。
 */
export const MODES = {
  timeattack: { label: 'タイムアタック', gates: 8, timeLimit: 90, gateBonus: 15 },
  free: { label: 'フリーフライト', gates: 6, timeLimit: 0, gateBonus: 0 },
};

export class Game {
  constructor(renderer, controls, audio) {
    this.renderer = renderer;
    this.controls = controls;
    this.audio = audio;
    this.aircraft = new Aircraft();
    this.state = 'ready';
    this.mode = 'timeattack';
    this.gates = [];
    this.activeGate = 0;
    this.score = 0;
    this.timeLeft = 0;
    this.elapsed = 0;
    this.toast = '';
    this.toastAlpha = 0;
    this.result = null;
    /** 'chase' | 'cockpit' */
    this.cameraMode = 'chase';
    this.camPos = vec3();
    this.camBasis = createBasis();
    this.camInit = false;
    this._accum = 0;
    this._tmp = vec3();
    this._tmp2 = vec3();
    this._lookAt = vec3();
    this.landingPhase = false;
  }

  /** 指定モードで新しいランを開始する。 */
  start(mode, seed) {
    this.mode = mode in MODES ? mode : 'timeattack';
    const cfg = MODES[this.mode];
    this.gates = createCourse(seed ?? ((Math.random() * 1e9) | 0), cfg.gates);
    this.activeGate = 0;
    this.score = 0;
    this.timeLeft = cfg.timeLimit;
    this.elapsed = 0;
    this.result = null;
    this.landingPhase = false;
    this.toast = '';
    this.toastAlpha = 0;
    // 滑走路南端に静止した状態から開始する。北（+Z）向きに加速して離陸する。
    const startZ = RUNWAY.centerZ - RUNWAY.halfLength + TAKEOFF_START_MARGIN;
    this.aircraft.reset(RUNWAY.centerX, RUNWAY.elevation + 1.5, startZ, RUNWAY.heading, 0);
    // reset() はデフォルトでスロットル・回転数を0.75にするが、離陸は停止状態から
    // プレイヤー自身がスロットルを上げて加速する体験にしたいので0で上書きする。
    this.aircraft.throttle = 0;
    this.aircraft.rpm = 0;
    this.controls.input.throttle = 0;
    this.camInit = false;
    this._accum = 0;
    this.state = 'flying';
    this.setToast('スロットルを上げて離陸せよ');
  }

  /** 中央に表示する短いメッセージを設定する。 */
  setToast(text) {
    this.toast = text;
    this.toastAlpha = 1.8;
  }

  /** ポーズと再開を切り替える。 */
  togglePause() {
    if (this.state === 'flying') {
      this.state = 'paused';
      this.controls.release();
    } else if (this.state === 'paused') {
      this.state = 'flying';
    }
    return this.state;
  }

  /** カメラの視点を切り替える。 */
  toggleCamera() {
    this.cameraMode = this.cameraMode === 'chase' ? 'cockpit' : 'chase';
    this.camInit = false;
    return this.cameraMode;
  }

  /** 決着処理。 */
  finish(kind, message) {
    if (this.state === 'over') return;
    this.state = 'over';
    const remaining = Math.max(0, this.timeLeft);
    let bonus = 0;
    if (kind === 'landed') {
      bonus = 5000 + Math.round(remaining * 25);
      this.audio.success();
    } else if (kind === 'timeup') {
      this.audio.crash();
    } else {
      this.audio.crash();
    }
    this.score += bonus;
    this.result = {
      kind,
      message,
      score: this.score,
      gates: this.gates.filter((g) => g.passed).length,
      total: this.gates.length,
      time: this.elapsed,
      bonus,
    };
    this.controls.release();
  }

  /** 物理を1ステップ進める。 */
  _stepPhysics(dt) {
    const a = this.aircraft;
    const input = this.controls.input;
    a.step(input, dt);

    // リング通過判定（通過順は問わず、未通過のものを全て確認する）。
    for (let i = 0; i < this.gates.length; i++) {
      const g = this.gates[i];
      if (g.passed) continue;
      if (checkGatePass(g, a.prevPos, a.pos)) {
        g.passed = true;
        this.score += 1000;
        this.timeLeft += MODES[this.mode].gateBonus;
        this.audio.gate();
        const left = this.gates.filter((x) => !x.passed).length;
        this.setToast(left > 0 ? `リング通過！残り ${left}` : 'リング全通過！滑走路へ着陸せよ');
        if (left === 0) this.landingPhase = true;
      }
    }
    // 次に狙うリングを更新する。
    let next = -1;
    for (let i = 0; i < this.gates.length; i++) {
      if (!this.gates[i].passed) {
        next = i;
        break;
      }
    }
    this.activeGate = next;

    // 地面との接触。
    const groundY = groundHeightAt(a.pos.x, a.pos.z);
    const onRunway = isOverRunway(a.pos.x, a.pos.z, 6) && Math.abs(groundY - RUNWAY.elevation) < 2;
    const contact = a.resolveGround(onRunway, groundY);
    if (contact === 'crashed') {
      this.finish('crashed', '墜落しました');
      return;
    }
    // 全リング通過後に滑走路で停止できたらミッション完了。
    // それ以外の接地は着陸・再離陸として扱い、ゲームは続行する。
    if (contact === 'landed' && a.speed < 22 && this.landingPhase) {
      this.finish('landed', '着陸成功！ミッション完了');
      return;
    }

    if (MODES[this.mode].timeLimit > 0) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        this.finish('timeup', 'タイムアップ');
      }
    }
    this.elapsed += dt;
  }

  /** カメラ位置と姿勢を更新する。 */
  _updateCamera(dt) {
    const a = this.aircraft;
    const b = this.camBasis;
    if (this.cameraMode === 'cockpit') {
      // 操縦席視点：機体基準そのまま。
      addScaled(this.camPos, a.pos, a.basis.forward, 3.2);
      addScaled(this.camPos, this.camPos, a.basis.up, 1.1);
      copy(b.forward, a.basis.forward);
      copy(b.up, a.basis.up);
      cross(b.right, b.up, b.forward);
      orthonormalize(b);
      this.camInit = true;
      return;
    }

    // 追従視点：機体後方やや上に滑らかに追従する。
    const speedFactor = clamp(a.speed / 120, 0, 1);
    const back = 20 + speedFactor * 9;
    const upOff = 7 + speedFactor * 2;
    const desired = this._tmp;
    addScaled(desired, a.pos, a.basis.forward, -back);
    // 機体の上方向とワールド上方向を混ぜ、ロールが分かりつつ酔いにくい位置にする。
    setv(this._tmp2, a.basis.up.x * 0.5, a.basis.up.y * 0.5 + 0.5, a.basis.up.z * 0.5);
    normalize(this._tmp2, this._tmp2);
    addScaled(desired, desired, this._tmp2, upOff);

    if (!this.camInit) {
      copy(this.camPos, desired);
      this.camInit = true;
    } else {
      const k = a.crashed ? 3 : 9;
      this.camPos.x = damp(this.camPos.x, desired.x, k, dt);
      this.camPos.y = damp(this.camPos.y, desired.y, k, dt);
      this.camPos.z = damp(this.camPos.z, desired.z, k, dt);
    }
    // カメラが地面にめり込まないよう最低高度を保つ。
    const gy = groundHeightAt(this.camPos.x, this.camPos.z) + 3;
    if (this.camPos.y < gy) this.camPos.y = gy;

    addScaled(this._lookAt, a.pos, a.basis.forward, 26);
    sub(b.forward, this._lookAt, this.camPos);
    normalize(b.forward, b.forward);
    // 上方向はロール量を抑えて混合する。
    setv(b.up, a.basis.up.x * 0.55, a.basis.up.y * 0.55 + 0.45, a.basis.up.z * 0.55);
    normalize(b.up, b.up);
    cross(b.right, b.up, b.forward);
    orthonormalize(b);
  }

  /** 1フレーム更新する。dt は実時間（秒）。 */
  update(dt) {
    const clamped = Math.min(dt, MAX_FRAME);
    if (this.state === 'flying') {
      this.controls.update(clamped);
      this._accum += clamped;
      let guard = 0;
      while (this._accum >= FIXED_DT && guard < 60) {
        this._stepPhysics(FIXED_DT);
        this._accum -= FIXED_DT;
        guard++;
        if (this.state !== 'flying') break;
      }
    } else if (this.state === 'over') {
      // 墜落後もカメラだけ動かして余韻を出す。
      this._accum = 0;
    }
    if (this.toastAlpha > 0) this.toastAlpha -= clamped;
    this._updateCamera(clamped);
    this.audio.update(this.aircraft.rpm, this.aircraft.speed, clamped);
  }

  /** HUDに渡す表示情報を組み立てる。 */
  _status() {
    const cfg = MODES[this.mode];
    const lines = [];
    if (cfg.timeLimit > 0) {
      const t = Math.max(0, this.timeLeft);
      lines.push({
        text: `残り ${t.toFixed(1)}s`,
        big: true,
        color: t < 10 ? '#ff6b6b' : '#ffd166',
      });
    } else {
      lines.push({ text: `経過 ${this.elapsed.toFixed(1)}s`, big: true, color: '#ffd166' });
    }
    lines.push({ text: `SCORE ${this.score}` });
    const passed = this.gates.filter((g) => g.passed).length;
    lines.push({ text: `RING ${passed}/${this.gates.length}` });
    if (this.landingPhase) lines.push({ text: '滑走路へ着陸せよ', color: '#7ef0d6' });

    let target = null;
    if (this.activeGate >= 0) target = this.gates[this.activeGate].pos;
    else if (this.landingPhase) target = vec3(RUNWAY.centerX, RUNWAY.elevation + 60, RUNWAY.centerZ - 400);

    return { lines, target, toast: this.toast, toastAlpha: this.toastAlpha, time: this.elapsed };
  }

  /** 1フレーム描画する。withHud が false なら計器を描かない（タイトル用）。 */
  render(withHud = true) {
    const r = this.renderer;
    r.setCamera(this.camPos, this.camBasis);
    // 描画順が全て（Zバッファ無しの画家のアルゴリズムのため）。
    // 空・太陽 → 地形（山や海に隠れるべきもの） → 樹木 → 滑走路・エプロン →
    // 飛行場の建物・街 → 自機の影 → 雲 → リング → 自機、の順に必ず奥から手前へ塗る。
    // この順序を崩すと、丘の裏の建物が手前に透ける・影が地形の下に沈む等の
    // 破綻が起きるので、要素を追加するときもこの並びを維持すること。
    r.drawSky();
    drawSun(r);
    drawTerrain(r);
    drawTrees(r);
    drawRunway(r);
    drawApron(r);
    drawCity(r);
    drawBuildings(r);
    drawAircraftShadow(r, this.aircraft);
    drawClouds(r);
    drawGates(r, this.gates, this.activeGate);
    if (withHud && this.cameraMode === 'chase') drawAircraft(r, this.aircraft, this.elapsed);
    if (withHud) drawHud(r, this.aircraft, this.controls, this._status());
  }
}
