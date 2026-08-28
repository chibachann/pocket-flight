/**
 * エントリポイント。
 * DOMのUIとゲームループを接続し、リサイズ・可視状態・入力方式の切り替えを扱う。
 */

import { Renderer } from './renderer.js';
import { Controls } from './controls.js';
import { GameAudio } from './audio.js';
import { Game } from './game.js';

const canvas = document.getElementById('view');
const renderer = new Renderer(canvas);
const controls = new Controls(canvas);
const audio = new GameAudio();
const game = new Game(renderer, controls, audio);

const el = {
  menu: document.getElementById('menu'),
  pause: document.getElementById('pause'),
  result: document.getElementById('result'),
  rotate: document.getElementById('rotate'),
  topbar: document.getElementById('topbar'),
  resultTitle: document.getElementById('result-title'),
  resultMessage: document.getElementById('result-message'),
  resultStats: document.getElementById('result-stats'),
  btnSound: document.getElementById('btn-sound'),
};

/** メニューで選択中の設定。 */
const settings = { mode: 'timeattack', scheme: 'touch', pitch: 'up', assist: 'on' };

/** セグメント型のボタン群を設定値に結び付ける。 */
function bindSegment(id, key, onChange) {
  const root = document.getElementById(id);
  if (!root) return;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    settings[key] = btn.dataset.value;
    for (const b of root.querySelectorAll('button')) b.classList.toggle('on', b === btn);
    if (onChange) onChange(btn.dataset.value);
  });
}

bindSegment('opt-mode', 'mode');
bindSegment('opt-scheme', 'scheme', (v) => {
  if (v === 'tilt') requestTilt();
});
bindSegment('opt-pitch', 'pitch');
bindSegment('opt-assist', 'assist');

/** iOSでは明示的な許可が必要なため、傾き操作の選択時に要求する。 */
async function requestTilt() {
  const anyWindow = window;
  const DOE = anyWindow.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    try {
      await DOE.requestPermission();
    } catch {
      // 許可されなければタッチ操作のままにする。
    }
  }
}

/** 指定のオーバーレイだけを表示する。null ならすべて隠す。 */
function showOverlay(name) {
  for (const key of ['menu', 'pause', 'result']) {
    el[key].classList.toggle('hidden', key !== name);
  }
  el.topbar.classList.toggle('hidden', name === 'menu');
  controls.enabled = name === null;
}

/** 端末の向きに応じて案内を出す。 */
function updateOrientationHint() {
  const portrait = window.innerHeight > window.innerWidth * 1.05;
  el.rotate.classList.toggle('hidden', !portrait || game.state === 'ready');
}

/** ゲームを開始する。 */
function startGame() {
  audio.start();
  audio.resume();
  controls.scheme = settings.scheme;
  controls.invertPitch = settings.pitch === 'down';
  game.aircraft.assist = settings.assist === 'on';
  if (settings.scheme === 'tilt') controls.calibrateTilt();
  game.start(settings.mode);
  showOverlay(null);
  updateOrientationHint();
}

/** リザルト画面を表示する。 */
function showResult(result) {
  el.resultTitle.textContent =
    result.kind === 'landed' ? 'MISSION COMPLETE' : result.kind === 'timeup' ? 'TIME UP' : 'CRASHED';
  el.resultMessage.textContent = result.message;
  const stat = (label, value) => `<div><span>${label}</span><strong>${value}</strong></div>`;
  el.resultStats.innerHTML = [
    stat('SCORE', result.score),
    stat('RING', `${result.gates}/${result.total}`),
    stat('TIME', `${result.time.toFixed(1)}s`),
    stat('BONUS', result.bonus),
  ].join('');
  showOverlay('result');
}

document.getElementById('btn-start').addEventListener('click', startGame);
document.getElementById('btn-retry').addEventListener('click', startGame);
document.getElementById('btn-menu').addEventListener('click', () => {
  game.state = 'ready';
  showOverlay('menu');
});
document.getElementById('btn-quit').addEventListener('click', () => {
  game.state = 'ready';
  showOverlay('menu');
});
document.getElementById('btn-resume').addEventListener('click', () => {
  game.togglePause();
  showOverlay(null);
});
document.getElementById('btn-pause').addEventListener('click', () => {
  if (game.state === 'flying') {
    game.togglePause();
    showOverlay('pause');
  }
});
document.getElementById('btn-camera').addEventListener('click', () => {
  game.toggleCamera();
});
el.btnSound.addEventListener('click', () => {
  audio.setEnabled(!audio.enabled);
  el.btnSound.textContent = audio.enabled ? '♪' : '×';
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyP') {
    if (game.state === 'flying') {
      game.togglePause();
      showOverlay('pause');
    } else if (game.state === 'paused') {
      game.togglePause();
      showOverlay(null);
    }
  }
  if (e.code === 'KeyC') game.toggleCamera();
  if (e.code === 'KeyR' && (game.state === 'over' || game.state === 'flying')) startGame();
});

window.addEventListener('resize', () => {
  renderer.resize();
  updateOrientationHint();
});
window.addEventListener('orientationchange', () => {
  window.setTimeout(() => {
    renderer.resize();
    updateOrientationHint();
  }, 250);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.state === 'flying') {
    game.togglePause();
    showOverlay('pause');
  } else {
    audio.resume();
  }
});

// デバッグ・自動テスト用に主要オブジェクトを公開しておく。
window.pocketFlight = { game, renderer, controls, audio, settings };

controls.attach();
renderer.resize();
showOverlay('menu');
updateOrientationHint();

let last = performance.now();
let reported = false;
/** 直近フレームの所要時間（描画負荷の自動調整に使う）。 */
let frameSamples = 0;
let frameTimeSum = 0;

/**
 * 平均フレーム時間から解像度倍率を上げ下げする。
 * 低スペック端末でもフレームレートを保つための簡易な自動調整。
 */
function adaptQuality(dt) {
  frameTimeSum += dt;
  frameSamples++;
  if (frameSamples < 60) return;
  const avg = frameTimeSum / frameSamples;
  frameSamples = 0;
  frameTimeSum = 0;
  if (avg > 0.024 && renderer.qualityScale > 0.55) {
    renderer.qualityScale = Math.max(0.55, renderer.qualityScale - 0.15);
  } else if (avg < 0.0135 && renderer.qualityScale < 1) {
    renderer.qualityScale = Math.min(1, renderer.qualityScale + 0.1);
  }
}

/** メインループ。 */
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  adaptQuality(dt);
  renderer.resize();

  if (game.state === 'ready') {
    // タイトル表示中は飛行場を俯瞰したデモ映像を流す。
    demoCamera(now / 1000);
    game.render(false);
  } else {
    game.update(dt);
    game.render();
    if (game.state === 'over' && !reported) {
      reported = true;
      showResult(game.result);
    }
    if (game.state !== 'over') reported = false;
  }
  requestAnimationFrame(frame);
}

/** タイトル画面用に飛行場の周囲をゆっくり回るカメラ。 */
function demoCamera(t) {
  const a = t * 0.06;
  const r = 1500;
  game.camPos.x = Math.cos(a) * r;
  game.camPos.y = 420;
  game.camPos.z = Math.sin(a) * r;
  const b = game.camBasis;
  b.forward.x = -Math.cos(a);
  b.forward.y = -0.16;
  b.forward.z = -Math.sin(a);
  b.up.x = 0;
  b.up.y = 1;
  b.up.z = 0;
  const l = Math.hypot(b.forward.x, b.forward.y, b.forward.z);
  b.forward.x /= l;
  b.forward.y /= l;
  b.forward.z /= l;
  b.right.x = b.up.y * b.forward.z - b.up.z * b.forward.y;
  b.right.y = b.up.z * b.forward.x - b.up.x * b.forward.z;
  b.right.z = b.up.x * b.forward.y - b.up.y * b.forward.x;
  const rl = Math.hypot(b.right.x, b.right.y, b.right.z);
  b.right.x /= rl;
  b.right.y /= rl;
  b.right.z /= rl;
  b.up.x = b.forward.y * b.right.z - b.forward.z * b.right.y;
  b.up.y = b.forward.z * b.right.x - b.forward.x * b.right.z;
  b.up.z = b.forward.x * b.right.y - b.forward.y * b.right.x;
}

requestAnimationFrame(frame);
