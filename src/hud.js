/**
 * HUDの描画。3D描画のあとに同じキャンバスへ2Dで重ねる。
 * 座標はキャンバスの実ピクセル。端末に合わせて基準スケール s を掛ける。
 */

import { clamp, headingOf } from './math.js';
import { controlLayout } from './controls.js';

const FONT = "600 %FPX% ui-monospace, SFMono-Regular, Menlo, 'Roboto Mono', monospace";

/** 指定サイズのフォント指定文字列を作る。 */
function font(px) {
  return FONT.replace('%FPX%', String(Math.round(px)));
}

/** 角丸矩形のパスを作る。 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 値表示用のパネルを描く。 */
function panel(ctx, x, y, w, h, s, label, value, unit, accent) {
  ctx.fillStyle = 'rgba(6, 18, 26, 0.55)';
  roundRect(ctx, x, y, w, h, 6 * s);
  ctx.fill();
  ctx.strokeStyle = accent || 'rgba(120, 240, 214, 0.5)';
  ctx.lineWidth = Math.max(1, 1.2 * s);
  ctx.stroke();
  ctx.fillStyle = 'rgba(190, 224, 232, 0.85)';
  ctx.font = font(9 * s);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(label, x + 7 * s, y + 5 * s);
  ctx.fillStyle = accent || '#7ef0d6';
  ctx.font = font(20 * s);
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(value, x + 7 * s, y + h - 8 * s);
  if (unit) {
    ctx.fillStyle = 'rgba(190, 224, 232, 0.7)';
    ctx.font = font(9 * s);
    ctx.fillText(unit, x + w - 7 * s - ctx.measureText(unit).width, y + h - 8 * s);
  }
}

/** 方位テープを描く。 */
function drawHeadingTape(ctx, renderer, aircraft, s) {
  const w = Math.min(renderer.width * 0.5, 400 * s);
  const h = 22 * s;
  const x = renderer.width / 2 - w / 2;
  // 縦画面は幅が狭く、画面右上のHTMLボタン列と重なる。その分だけ下げる。
  const y = (renderer.portrait ? 46 * renderer.dpr : 0) + 8 * s;
  let hdg = (headingOf(aircraft.basis) * 180) / Math.PI;
  if (hdg < 0) hdg += 360;

  ctx.save();
  ctx.fillStyle = 'rgba(6, 18, 26, 0.5)';
  roundRect(ctx, x, y, w, h, 5 * s);
  ctx.fill();
  ctx.clip();
  const pxPerDeg = w / 90;
  ctx.font = font(10 * s);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const labels = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let d = -50; d <= 50; d += 10) {
    const tick = Math.round((hdg + d) / 10) * 10;
    const off = (tick - hdg) * pxPerDeg;
    const px = renderer.width / 2 + off;
    const norm = ((tick % 360) + 360) % 360;
    ctx.strokeStyle = 'rgba(150, 220, 214, 0.6)';
    ctx.lineWidth = Math.max(1, s);
    ctx.beginPath();
    ctx.moveTo(px, y + h - 6 * s);
    ctx.lineTo(px, y + h);
    ctx.stroke();
    ctx.fillStyle = labels[norm] ? '#ffd166' : 'rgba(190, 224, 232, 0.85)';
    ctx.fillText(labels[norm] || String(norm / 10), px, y + h / 2 - 1 * s);
  }
  ctx.restore();
  ctx.fillStyle = '#7ef0d6';
  ctx.beginPath();
  ctx.moveTo(renderer.width / 2, y + h + 6 * s);
  ctx.lineTo(renderer.width / 2 - 5 * s, y + h + 13 * s);
  ctx.lineTo(renderer.width / 2 + 5 * s, y + h + 13 * s);
  ctx.closePath();
  ctx.fill();
}

/** スロットルスライダーを描く。 */
function drawThrottle(ctx, renderer, aircraft, s, layout) {
  const area = layout.throttle;
  const x0 = area.x0 * renderer.width;
  const y0 = area.y0 * renderer.height;
  const y1 = area.y1 * renderer.height;
  const barW = 26 * s;
  const bx = x0 + (renderer.width - x0) / 2 - barW / 2;
  ctx.fillStyle = 'rgba(6, 18, 26, 0.45)';
  roundRect(ctx, bx, y0, barW, y1 - y0, barW / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(126, 240, 214, 0.4)';
  ctx.lineWidth = Math.max(1, 1.2 * s);
  ctx.stroke();

  const t = clamp(aircraft.throttle, 0, 1);
  const fh = (y1 - y0) * t;
  ctx.fillStyle = 'rgba(126, 240, 214, 0.35)';
  roundRect(ctx, bx, y1 - fh, barW, fh, barW / 2);
  ctx.fill();

  const ky = y1 - fh;
  ctx.fillStyle = '#7ef0d6';
  ctx.beginPath();
  ctx.arc(bx + barW / 2, ky, 11 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#04222a';
  ctx.font = font(9 * s);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(Math.round(t * 100)), bx + barW / 2, ky + 0.5 * s);
  ctx.fillStyle = 'rgba(190, 224, 232, 0.8)';
  ctx.font = font(9 * s);
  ctx.fillText('THR', bx + barW / 2, y0 - 9 * s);
}

/** 仮想スティックの位置を可視化する。 */
function drawStick(ctx, renderer, controls, s) {
  if (controls.scheme !== 'touch' || !controls.stick.active) return;
  const ox = controls.stick.ox * renderer.width;
  const oy = controls.stick.oy * renderer.height;
  const v = controls.stickVector();
  const radius = 52 * s;
  ctx.strokeStyle = 'rgba(126, 240, 214, 0.35)';
  ctx.lineWidth = Math.max(1.4, 2 * s);
  ctx.beginPath();
  ctx.arc(ox, oy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(126, 240, 214, 0.55)';
  ctx.beginPath();
  ctx.arc(ox + v.x * radius, oy + v.y * radius, 20 * s, 0, Math.PI * 2);
  ctx.fill();
}

/** 目標地点の方向指示を描く。 */
function drawTargetPointer(ctx, renderer, target, s) {
  const cf = renderer.camForward;
  const cr = renderer.camRight;
  const cu = renderer.camUp;
  const dx = target.x - renderer.camPos.x;
  const dy = target.y - renderer.camPos.y;
  const dz = target.z - renderer.camPos.z;
  const dist = Math.hypot(dx, dy, dz);
  const z = dx * cf.x + dy * cf.y + dz * cf.z;
  const x = dx * cr.x + dy * cr.y + dz * cr.z;
  const y = dx * cu.x + dy * cu.y + dz * cu.z;

  const cx = renderer.width / 2;
  const cy = renderer.height / 2;
  let sx;
  let sy;
  let offscreen = false;
  if (z > 1) {
    sx = cx + (x * renderer.focal) / z;
    sy = cy - (y * renderer.focal) / z;
    const m = 46 * s;
    if (sx < m || sx > renderer.width - m || sy < m || sy > renderer.height - m) offscreen = true;
  } else {
    offscreen = true;
  }
  if (offscreen) {
    // 画面外なら中心からの方向で縁に矢印を出す。
    const ang = Math.atan2(-y, x) + (z > 0 ? 0 : Math.PI);
    const rx = renderer.width * 0.38;
    // 縦画面で矢印が縦に離れすぎないよう、画面幅でも頭打ちにする。
    const ry = Math.min(renderer.height * 0.36, renderer.width * 0.5);
    sx = cx + Math.cos(ang) * rx;
    sy = cy + Math.sin(ang) * ry;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(ang);
    ctx.fillStyle = 'rgba(255, 209, 102, 0.9)';
    ctx.beginPath();
    ctx.moveTo(16 * s, 0);
    ctx.lineTo(-8 * s, -10 * s);
    ctx.lineTo(-8 * s, 10 * s);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else {
    // GTAのウェイポイントマーカーのように、目標の少し上に浮かぶ下向きの三角形（シェブロン）を描く。
    // 4円弧のリングは計器のスコープに見えるためやめ、シンプルな図形にした。
    const r = 11 * s;
    const topY = sy - 24 * s;
    ctx.fillStyle = '#ffd166';
    ctx.strokeStyle = 'rgba(6, 18, 26, 0.6)';
    ctx.lineWidth = Math.max(1, 1.2 * s);
    ctx.beginPath();
    ctx.moveTo(sx, topY + r); // 下の頂点が目標側を指す
    ctx.lineTo(sx - r, topY - r * 0.55);
    ctx.lineTo(sx + r, topY - r * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255, 209, 102, 0.95)';
  ctx.font = font(11 * s);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`${(dist / 1000).toFixed(2)} km`, sx, sy + 26 * s);
}

/** 警告文を点滅表示する。 */
function drawWarnings(ctx, renderer, aircraft, time, s) {
  const msgs = [];
  if (aircraft.stalling) msgs.push(['STALL 失速', '#ff6b6b']);
  const agl = aircraft.agl();
  if (agl < 130 && aircraft.verticalSpeed < -3 && !aircraft.onGround) msgs.push(['PULL UP 地面接近', '#ff9f43']);
  if (aircraft.speed * 3.6 > 520) msgs.push(['OVERSPEED 超過速度', '#ff9f43']);
  if (!msgs.length) return;
  if (Math.floor(time * 3) % 2 === 0) return;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = font(17 * s);
  // 縦画面では下側が操作エリアなので、警告はやや上に出す。
  let y = renderer.height * (renderer.portrait ? 0.66 : 0.72);
  for (const [text, color] of msgs) {
    ctx.fillStyle = color;
    ctx.fillText(text, renderer.width / 2, y);
    y += 24 * s;
  }
}

/**
 * HUD全体を描く。
 * status には残り時間・スコアなどゲーム側の状態を渡す。
 */
export function drawHud(renderer, aircraft, controls, status) {
  const ctx = renderer.ctx;
  // 基準スケールは画面の短辺で決める（横画面では高さと同じ）。
  // 縦画面で高さを基準にすると計器が画面幅からはみ出すため。
  const s = Math.max(Math.min(renderer.width, renderer.height) / 620, 0.75);
  const layout = controlLayout(renderer.portrait);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 画面中央のピッチラダー／飛行経路マーカーは計器然として見えるため描画しない。
  // GTA的なアーケード視点では、方位テープと左右パネルだけで十分に飛ばせる。
  drawHeadingTape(ctx, renderer, aircraft, s);

  const pw = 92 * s;
  const ph = 46 * s;
  const midY = renderer.height / 2 - ph / 2;
  // 縦画面ではスロットルが画面下側にあるので、右の計器を画面端まで寄せられる。
  const rightX = renderer.portrait
    ? renderer.width - pw - 10 * s
    : layout.throttle.x0 * renderer.width - pw - 10 * s;
  panel(ctx, 10 * s, midY, pw, ph, s, '対気速度 SPD', String(Math.round(aircraft.speed * 3.6)), 'km/h');
  panel(ctx, rightX, midY, pw, ph, s, '高度 ALT', String(Math.round(aircraft.altitude)), 'm');
  panel(
    ctx,
    rightX,
    midY + ph + 6 * s,
    pw,
    ph * 0.78,
    s,
    '昇降率 V/S',
    (aircraft.verticalSpeed >= 0 ? '+' : '') + aircraft.verticalSpeed.toFixed(1),
    'm/s',
    aircraft.verticalSpeed < -12 ? '#ff9f43' : undefined,
  );

  drawThrottle(ctx, renderer, aircraft, s, layout);
  drawStick(ctx, renderer, controls, s);

  // 左上のミッション情報
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let ty = 10 * s;
  if (status.lines) {
    for (const line of status.lines) {
      ctx.font = font((line.big ? 19 : 12) * s);
      ctx.fillStyle = line.color || 'rgba(226, 242, 246, 0.92)';
      ctx.fillText(line.text, 10 * s, ty);
      ty += (line.big ? 24 : 16) * s;
    }
  }

  if (status.target) drawTargetPointer(ctx, renderer, status.target, s);
  drawWarnings(ctx, renderer, aircraft, status.time || 0, s);

  // 中央下のメッセージ（通過表示など）
  if (status.toast && status.toastAlpha > 0) {
    ctx.globalAlpha = clamp(status.toastAlpha, 0, 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(24 * s);
    ctx.fillStyle = '#7ef0d6';
    ctx.fillText(status.toast, renderer.width / 2, renderer.height * 0.3);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}
