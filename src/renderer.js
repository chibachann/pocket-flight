/**
 * Canvas 2D の上に構築した最小限の3Dレンダラ。
 * WebGLやライブラリを使わず、ニアクリップ＋透視投影＋画家のアルゴリズムで描く。
 */

import { clamp, vec3 } from './math.js';

/** カメラ空間でのニアクリップ距離（m）。 */
const NEAR = 0.6;
/** 描画距離（m）。この距離で地形は完全にフォグへ溶ける。 */
export const FAR = 6400;
/** フォグが効き始める距離（m）。 */
export const FOG_START = 800;

/** 空の色（フォグの到達色でもある）。 */
export const SKY_HORIZON = [176, 202, 226];
export const SKY_ZENITH = [42, 92, 168];

/** 縦画面で確保したい水平視野角の下限（ラジアン）。 */
const PORTRAIT_MIN_H_FOV = (68 * Math.PI) / 180;
/** 縦画面で許容する垂直視野角の上限（ラジアン）。 */
const PORTRAIT_MAX_V_FOV = (90 * Math.PI) / 180;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    /** 端末性能に応じた解像度倍率（1.0が最高画質）。 */
    this.qualityScale = 1;
    /** 視野角（横画面での垂直方向・ラジアン）。 */
    this.fov = (68 * Math.PI) / 180;
    this.focal = 1;
    /** 画面が縦長かどうか。HUDや操作エリアの配置切り替えに使う。 */
    this.portrait = false;
    this.camPos = vec3();
    this.camRight = vec3(1, 0, 0);
    this.camUp = vec3(0, 1, 0);
    this.camForward = vec3(0, 0, 1);
    // クリッピング用の作業バッファ（毎フレーム再確保しないよう使い回す）。
    this._a = [];
    this._b = [];
    for (let i = 0; i < 16; i++) {
      this._a.push({ x: 0, y: 0, z: 0 });
      this._b.push({ x: 0, y: 0, z: 0 });
    }
    this._sx = new Float32Array(16);
    this._sy = new Float32Array(16);
  }

  /** キャンバスの実解像度を表示サイズとデバイス比に合わせる。 */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    // 高解像度端末で負荷が上がりすぎないよう倍率を抑える。
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.qualityScale;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
    this.width = w;
    this.height = h;
    this.portrait = h > w;
    if (this.portrait) {
      // 縦画面で垂直視野角を横画面と同じにすると、水平方向が極端に狭くなって前が見えない。
      // 水平視野角を一定以上確保しつつ、垂直が広がって歪みすぎないよう上限で止める。
      // アスペクト比1では横画面の式と一致するため、回転しても見え方が飛ばない。
      const byWidth = this.width / 2 / Math.tan(PORTRAIT_MIN_H_FOV / 2);
      const byHeight = this.height / 2 / Math.tan(PORTRAIT_MAX_V_FOV / 2);
      this.focal = Math.max(byWidth, byHeight);
    } else {
      this.focal = this.height / 2 / Math.tan(this.fov / 2);
    }
  }

  /** カメラの位置と姿勢を設定する。 */
  setCamera(pos, basis) {
    this.camPos.x = pos.x;
    this.camPos.y = pos.y;
    this.camPos.z = pos.z;
    this.camRight.x = basis.right.x;
    this.camRight.y = basis.right.y;
    this.camRight.z = basis.right.z;
    this.camUp.x = basis.up.x;
    this.camUp.y = basis.up.y;
    this.camUp.z = basis.up.z;
    this.camForward.x = basis.forward.x;
    this.camForward.y = basis.forward.y;
    this.camForward.z = basis.forward.z;
  }

  /** ワールド座標をカメラ空間 (右, 上, 前) に変換して out に入れる。 */
  toCamera(out, p) {
    const dx = p.x - this.camPos.x;
    const dy = p.y - this.camPos.y;
    const dz = p.z - this.camPos.z;
    out.x = dx * this.camRight.x + dy * this.camRight.y + dz * this.camRight.z;
    out.y = dx * this.camUp.x + dy * this.camUp.y + dz * this.camUp.z;
    out.z = dx * this.camForward.x + dy * this.camForward.y + dz * this.camForward.z;
    return out;
  }

  /** カメラ空間の点をスクリーンX座標へ。 */
  screenX(c) {
    return this.width / 2 + (c.x * this.focal) / c.z;
  }

  /** カメラ空間の点をスクリーンY座標へ。 */
  screenY(c) {
    return this.height / 2 - (c.y * this.focal) / c.z;
  }

  /** 空と水平線のグラデーションで画面を塗る。 */
  drawSky() {
    const ctx = this.ctx;
    // カメラの上方向がどれだけ空を向いているかで天頂色の量を決める。
    const g = ctx.createLinearGradient(0, 0, 0, this.height);
    const t = clamp(0.5 - this.camForward.y * 0.5, 0, 1);
    const mix = (a, b, k) => `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)},${Math.round(
      a[1] + (b[1] - a[1]) * k,
    )},${Math.round(a[2] + (b[2] - a[2]) * k)})`;
    g.addColorStop(0, mix(SKY_ZENITH, SKY_HORIZON, clamp(t - 0.25, 0, 1)));
    g.addColorStop(1, mix(SKY_ZENITH, SKY_HORIZON, clamp(t + 0.75, 0, 1)));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  /**
   * カメラ空間の多角形をニア平面でクリップする。
   * 入力は src[0..count-1]、結果は this._b に入り、頂点数を返す。
   */
  _clipNear(src, count) {
    const out = this._b;
    let n = 0;
    for (let i = 0; i < count; i++) {
      const cur = src[i];
      const nxt = src[(i + 1) % count];
      const curIn = cur.z >= NEAR;
      const nxtIn = nxt.z >= NEAR;
      if (curIn) {
        if (n < out.length) {
          out[n].x = cur.x;
          out[n].y = cur.y;
          out[n].z = cur.z;
          n++;
        }
      }
      if (curIn !== nxtIn) {
        const t = (NEAR - cur.z) / (nxt.z - cur.z);
        if (n < out.length) {
          out[n].x = cur.x + (nxt.x - cur.x) * t;
          out[n].y = cur.y + (nxt.y - cur.y) * t;
          out[n].z = NEAR;
          n++;
        }
      }
    }
    return n;
  }

  /**
   * カメラ空間の多角形を塗る。cam は {x,y,z} の配列。
   * 画面外に完全に出るものは描かない。
   */
  fillCameraPolygon(cam, count, style, strokeSeam) {
    let pts = cam;
    let n = count;
    let allIn = true;
    let allOut = true;
    for (let i = 0; i < count; i++) {
      if (cam[i].z >= NEAR) allOut = false;
      else allIn = false;
    }
    if (allOut) return false;
    if (!allIn) {
      n = this._clipNear(cam, count);
      if (n < 3) return false;
      pts = this._b;
    }

    const sx = this._sx;
    const sy = this._sy;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const x = this.width / 2 + (p.x * this.focal) / p.z;
      const y = this.height / 2 - (p.y * this.focal) / p.z;
      sx[i] = x;
      sy[i] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (maxX < 0 || minX > this.width || maxY < 0 || minY > this.height) return false;

    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(sx[0], sy[0]);
    for (let i = 1; i < n; i++) ctx.lineTo(sx[i], sy[i]);
    ctx.closePath();
    ctx.fillStyle = style;
    ctx.fill();
    if (strokeSeam) {
      // 隣接ポリゴンの間に生じる隙間（アンチエイリアスの継ぎ目）を同色の線で埋める。
      ctx.strokeStyle = style;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    return true;
  }

  /** ワールド座標の多角形を塗る。 */
  fillPolygon(points, style, strokeSeam) {
    const count = Math.min(points.length, this._a.length);
    for (let i = 0; i < count; i++) this.toCamera(this._a[i], points[i]);
    return this.fillCameraPolygon(this._a, count, style, strokeSeam);
  }

  /** ワールド座標の折れ線を描く。線幅は距離に応じて細くする。 */
  strokePolyline(points, style, worldWidth, closed) {
    const ctx = this.ctx;
    ctx.strokeStyle = style;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const tmpA = { x: 0, y: 0, z: 0 };
    const tmpB = { x: 0, y: 0, z: 0 };
    ctx.beginPath();
    let started = false;
    const n = points.length;
    const last = closed ? n : n - 1;
    let widthAcc = 0;
    let widthCount = 0;
    for (let i = 0; i < last; i++) {
      this.toCamera(tmpA, points[i]);
      this.toCamera(tmpB, points[(i + 1) % n]);
      if (tmpA.z < NEAR && tmpB.z < NEAR) {
        started = false;
        continue;
      }
      // 片側がカメラ後方なら線分をニア平面で切る。
      if (tmpA.z < NEAR) {
        const t = (NEAR - tmpA.z) / (tmpB.z - tmpA.z);
        tmpA.x += (tmpB.x - tmpA.x) * t;
        tmpA.y += (tmpB.y - tmpA.y) * t;
        tmpA.z = NEAR;
        started = false;
      } else if (tmpB.z < NEAR) {
        const t = (NEAR - tmpB.z) / (tmpA.z - tmpB.z);
        tmpB.x += (tmpA.x - tmpB.x) * t;
        tmpB.y += (tmpA.y - tmpB.y) * t;
        tmpB.z = NEAR;
      }
      const ax = this.width / 2 + (tmpA.x * this.focal) / tmpA.z;
      const ay = this.height / 2 - (tmpA.y * this.focal) / tmpA.z;
      const bx = this.width / 2 + (tmpB.x * this.focal) / tmpB.z;
      const by = this.height / 2 - (tmpB.y * this.focal) / tmpB.z;
      if (!started) {
        ctx.moveTo(ax, ay);
        started = true;
      }
      ctx.lineTo(bx, by);
      widthAcc += (worldWidth * this.focal) / ((tmpA.z + tmpB.z) * 0.5);
      widthCount++;
    }
    if (!widthCount) return;
    ctx.lineWidth = clamp(widthAcc / widthCount, 1 * this.dpr, 60 * this.dpr);
    ctx.stroke();
  }

  /**
   * 距離に応じて色をフォグ（空色）へ寄せる。
   * rgb は [r,g,b] 配列、distance はメートル。
   */
  fog(rgb, distance) {
    const t = clamp((distance - FOG_START) / (FAR - FOG_START), 0, 1) ** 1.5;
    const r = Math.round(rgb[0] + (SKY_HORIZON[0] - rgb[0]) * t);
    const g = Math.round(rgb[1] + (SKY_HORIZON[1] - rgb[1]) * t);
    const b = Math.round(rgb[2] + (SKY_HORIZON[2] - rgb[2]) * t);
    return `rgb(${r},${g},${b})`;
  }

  /** ワールド座標の点が視錐台の前方にあるかを大まかに判定する。 */
  isInFront(p, margin = NEAR) {
    const dx = p.x - this.camPos.x;
    const dy = p.y - this.camPos.y;
    const dz = p.z - this.camPos.z;
    return dx * this.camForward.x + dy * this.camForward.y + dz * this.camForward.z > margin;
  }

  /** カメラから点までの距離。 */
  distanceTo(p) {
    return Math.hypot(p.x - this.camPos.x, p.y - this.camPos.y, p.z - this.camPos.z);
  }
}
