/**
 * 汉衣图鉴 · CORS 代理服务器 v3
 *
 * 改进：
 * 1. 静态文件服务（HTML, CSS, JS, 图片, embeddings.json 等）
 * 2. 模型文件从本地 model-cache/ 直接读取，无需网络代理
 * 3. 为所有响应自动加上 CORS 头，解决浏览器跨域限制
 *
 * 启动：node proxy-server.js
 * 访问：http://localhost:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const MODEL_CACHE = path.join(__dirname, 'model-cache');
const STATIC_ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
  '.eot':  'application/vnd.ms-fontobject',
  '.bin':  'application/octet-stream',
  '.onnx': 'application/octet-stream',
};

function addCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
}

function sendError(res, status, message) {
  if (!res.headersSent) {
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(message);
  }
}

function serveFile(filePath, res, cacheMaxAge = 86400) {
  const normalized = path.normalize(filePath);

  if (!fs.existsSync(normalized)) {
    sendError(res, 404, `文件不存在: ${path.relative(STATIC_ROOT, normalized)}`);
    return;
  }

  const stat = fs.statSync(normalized);
  if (stat.isDirectory()) {
    sendError(res, 403, '目录不允许访问');
    return;
  }

  const ext = path.extname(normalized).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const fileSize = stat.size;

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': fileSize,
    'Cache-Control': `public, max-age=${cacheMaxAge}`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Type',
  });

  const stream = fs.createReadStream(normalized);
  stream.on('error', (err) => {
    console.error(`[serveFile error] ${normalized}: ${err.message}`);
    if (!res.headersSent) sendError(res, 500, '文件读取错误');
    else res.end();
  });
  stream.pipe(res);
}

function serveModelFile(proxyPath, res) {
  // proxyPath 例如: /Xenova/clip-vit-base-patch32/resolve/main/config.json
  // 映射到本地: model-cache/Xenova/clip-vit-base-patch32/config.json
  const match = proxyPath.match(/^\/[^\/]+\/[^\/]+\/resolve\/[^\/]+\/(.+)$/);
  if (!match) {
    sendError(res, 400, '无效的模型路径格式');
    return;
  }

  const modelFile = match[1];
  const localPath = path.join(MODEL_CACHE, modelFile);

  console.log(`[Model] ${proxyPath} -> ${path.relative(MODEL_CACHE, localPath)}`);
  serveFile(localPath, res);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    addCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const pathname = url.parse(req.url).pathname;
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${pathname}`);

  // 模型文件请求（transformers.js 请求格式）
  // 例如: /Xenova/clip-vit-base-patch32/resolve/main/config.json
  // 或者: /models/Xenova/clip-vit-base-patch32/tokenizer.json
  if (pathname.includes('/resolve/') || pathname.startsWith('/models/')) {
    serveModelFile(pathname, res);
    return;
  }

  // 静态文件服务
  let filePath;
  if (pathname === '/' || pathname === '/index.html') {
    filePath = path.join(STATIC_ROOT, 'index.html');
  } else {
    filePath = path.join(STATIC_ROOT, pathname);
  }

  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(STATIC_ROOT)) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  // HTML 文件不过缓存
  const ext = path.extname(normalized).toLowerCase();
  const cacheMaxAge = ext === '.html' ? 0 : 86400;
  serveFile(normalized, res, cacheMaxAge);
});

server.listen(PORT, () => {
  console.log('');
  console.log('========================================');
  console.log(`  汉衣图鉴 · CORS 代理服务器 v3`);
  console.log(`  访问地址: http://localhost:${PORT}`);
  console.log(`  模型目录: ${MODEL_CACHE}`);
  console.log('========================================');
  console.log('');

  // 检查模型目录
  if (fs.existsSync(MODEL_CACHE)) {
    const files = [];
    const walk = (dir, prefix = '') => {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const full = path.join(dir, item);
        const rel = path.join(prefix, item);
        if (fs.statSync(full).isDirectory()) {
          walk(full, rel);
        } else {
          const size = fs.statSync(full).size;
          files.push({ path: rel, size });
        }
      }
    };
    walk(MODEL_CACHE);
    if (files.length > 0) {
      console.log('已缓存的模型文件:');
      for (const f of files) {
        console.log(`  ${f.path}: ${(f.size / 1024 / 1024).toFixed(2)} MB`);
      }
    } else {
      console.log('模型目录为空，请先运行: python download_clip_model.py');
    }
  } else {
    console.log('模型目录不存在，请先运行: python download_clip_model.py');
  }
  console.log('');
});
