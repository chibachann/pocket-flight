/**
 * 依存なしの静的ファイルサーバー。
 * ESモジュールは file:// では読み込めないため、ゲームの動作確認に使う。
 *
 *   npm start               # http://localhost:5173/ を開く
 *   npm start -- --port=8080
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';

/** 拡張子とContent-Typeの対応。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/** --key=value 形式の引数を読み取る。 */
function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const port = Number(arg('port', '5173'));
const root = resolve(process.cwd(), arg('root', '.'));

/** LAN内のIPv4アドレスを列挙する（実機での確認用）。 */
function localAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    // ルート外へのアクセスを防ぐ。
    const target = normalize(join(root, rel));
    if (target !== root && !target.startsWith(root + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(target);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: rel.endsWith('/') ? `${rel}index.html` : `${rel}/` }).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
});

server.listen(port, () => {
  console.log(`静的サーバーを起動しました: ${root}`);
  console.log(`  ローカル : http://localhost:${port}/`);
  for (const ip of localAddresses()) console.log(`  同一LAN  : http://${ip}:${port}/  （スマホ実機の確認用）`);
});
