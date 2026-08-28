/**
 * WebAudioによる簡易サウンド。
 * エンジン音（鋸波＋ローパス）と風切り音（ノイズ＋バンドパス）を合成し、
 * リング通過や警告は短い効果音で鳴らす。
 */

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.started = false;
  }

  /** ユーザー操作のタイミングで初期化する（自動再生制限のため）。 */
  start() {
    if (this.started) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    this.ctx = new AudioCtx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.5 : 0;
    this.master.connect(this.ctx.destination);

    // エンジン：基音と倍音を重ねる。
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 800;
    this.engineGain.connect(this.engineFilter);
    this.engineFilter.connect(this.master);
    this.engineOscs = [];
    for (const [type, mul, gain] of [
      ['sawtooth', 1, 0.5],
      ['square', 2.01, 0.18],
      ['sawtooth', 0.5, 0.3],
    ]) {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      const g = this.ctx.createGain();
      g.gain.value = gain;
      osc.connect(g);
      g.connect(this.engineGain);
      osc.start();
      this.engineOscs.push({ osc, mul });
    }

    // 風切り音：ホワイトノイズをループ再生する。
    const len = this.ctx.sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.windSource = this.ctx.createBufferSource();
    this.windSource.buffer = buffer;
    this.windSource.loop = true;
    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 700;
    this.windFilter.Q.value = 0.7;
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSource.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    this.windSource.start();

    this.started = true;
  }

  /** 停止中のコンテキストを再開する（画面復帰時など）。 */
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  /** 音のオン・オフを切り替える。 */
  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.5 : 0;
  }

  /**
   * 毎フレームの状態更新。
   * rpm は0〜1、speed は m/s。
   */
  update(rpm, speed, dt) {
    if (!this.started || !this.ctx) return;
    const now = this.ctx.currentTime;
    const base = 55 + rpm * 130;
    for (const e of this.engineOscs) {
      e.osc.frequency.setTargetAtTime(base * e.mul, now, 0.08);
    }
    this.engineGain.gain.setTargetAtTime(0.05 + rpm * 0.18, now, 0.1);
    this.engineFilter.frequency.setTargetAtTime(500 + rpm * 1600, now, 0.15);
    const w = Math.min(speed / 160, 1);
    this.windGain.gain.setTargetAtTime(w * w * 0.16, now, 0.2);
    this.windFilter.frequency.setTargetAtTime(400 + w * 1400, now, 0.2);
    void dt;
  }

  /** 短い効果音を鳴らす。 */
  blip(freq, duration, type = 'sine', volume = 0.3) {
    if (!this.started || !this.ctx || !this.enabled) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(volume, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(g);
    g.connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.05);
  }

  /** リング通過音。 */
  gate() {
    this.blip(880, 0.16, 'triangle', 0.35);
    this.blip(1320, 0.22, 'triangle', 0.2);
  }

  /** 墜落音。 */
  crash() {
    if (!this.started || !this.ctx || !this.enabled) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    const len = Math.floor(this.ctx.sampleRate * 0.7);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1400, now);
    f.frequency.exponentialRampToValueAtTime(120, now + 0.6);
    const g = this.ctx.createGain();
    g.gain.value = 0.6;
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(now);
  }

  /** 着陸成功音。 */
  success() {
    this.blip(660, 0.18, 'sine', 0.3);
    window.setTimeout(() => this.blip(880, 0.2, 'sine', 0.3), 120);
    window.setTimeout(() => this.blip(1174, 0.35, 'sine', 0.3), 260);
  }
}
