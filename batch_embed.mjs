// 批量提取图片 CLIP embeddings -> 保存为 embeddings.json
import { imageToEmbedding, initClip } from './clip_embedder.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_DIR = path.join(__dirname, 'image');
const OUTPUT_FILE = path.join(__dirname, 'embeddings.json');

// 收集所有图片文件（递归）
function collectImages(dir) {
  const files = [];
  function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const fp = path.join(d, f);
      if (fs.statSync(fp).isDirectory()) walk(fp);
      else if (/\.(jpg|jpeg|png|bmp|webp)$/i.test(f)) {
        files.push(fp);
      }
    }
  }
  walk(dir);
  return files;
}

async function main() {
  await initClip();

  console.log('收集图片文件...');
  let images = collectImages(IMAGE_DIR);
  // 过滤掉 test_image 目录的图片
  images = images.filter(p => !p.includes('test_image'));
  console.log(`共 ${images.length} 张图片`);

  const embeddings = {};
  let idx = 0;

  for (const imgPath of images) {
    try {
      // 用相对于项目根目录的路径作为 key
      const relPath = path.relative(__dirname, imgPath).replace(/\\/g, '/');
      process.stdout.write(`[${++idx}/${images.length}] ${relPath} ...`);
      const emb = await imageToEmbedding(imgPath);
      embeddings[relPath] = Array.from(emb); // Float32Array -> 普通数组 JSON 可序列化
      console.log(' OK');
    } catch (e) {
      console.error(` ERROR: ${e.message}`);
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(embeddings, null, 2));
  console.log(`\n完成！已保存 ${Object.keys(embeddings).length} 个 embeddings 到 ${OUTPUT_FILE}`);
}

main().catch(e => console.error('Fatal:', e.message, '\n' + e.stack));
