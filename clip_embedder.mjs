// CLIP Embedding 提取器 —— 基于 @xenova/transformers 正确 API
// 用途：对图片和文本分别提取 CLIP embedding 向量，用于相似度匹配

import { CLIPModel, AutoTokenizer, AutoProcessor, RawImage } from '@xenova/transformers';

const MODEL_ID = 'clip-vit-base-patch32';
let model = null;
let tokenizer = null;
let processor = null;

/** 初始化 CLIP 模型、tokenizer、processor */
export async function initClip() {
  if (model) return;
  console.log('[CLIP] 加载模型...');
  model = await CLIPModel.from_pretrained(MODEL_ID, {
    local_files_only: true,
    cache_dir: process.env.TRANSFORMERS_CACHE || undefined,
    progress_callback: (p) => {
      if (p.status === 'done') console.log('  done');
      else if (p.status && p.progress !== undefined) console.log(`  ${p.status} ${(p.progress*100).toFixed(0)}%`);
    }
  });
  processor = await AutoProcessor.from_pretrained(MODEL_ID, { local_files_only: true });
  tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, { local_files_only: true });
  console.log('[CLIP] 就绪');
}

/**
 * 对单张图片计算 CLIP embedding (归一化 Float32Array)
 * 注意：CLIP 合并模型要求同时传图片+文本输入，这里用 dummy text
 * @param {string} imagePath - 相对于项目根目录的图片路径
 * @returns {Promise<Float32Array>} 归一化的 [512] embedding 向量
 */
export async function imageToEmbedding(imagePath) {
  if (!model) await initClip();
  const image = await RawImage.read(imagePath);
  const imgInputs = await processor(image);
  // 必须同时传 dummy text inputs（CLIP 模型需要）
  const txtInputs = tokenizer('photo', { padding: true, truncation: true });
  const allInputs = {};
  Object.assign(allInputs, imgInputs, txtInputs);
  const output = await model(allInputs);
  const emb = new Float32Array(output.image_embeds.data);
  // L2 归一化
  let norm = 0;
  for (let i = 0; i < emb.length; i++) norm += emb[i] * emb[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < emb.length; i++) emb[i] /= norm;
  return emb;
}

/**
 * 对文本字符串计算 CLIP embedding (归一化 Float32Array)
 * 注意：CLIP 合并模型要求同时传图片+文本，这里用 dummy image
 * @param {string} text - 文本描述
 * @returns {Promise<Float32Array>} 归一化的 [512] embedding 向量
 */
export async function textToEmbedding(text) {
  if (!model) await initClip();
  const txtInputs = tokenizer(text, { padding: true, truncation: true });
  // 必须同时传 dummy pixel_values
  const dummyImg = RawImage.fromURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAApgAAAKYB3X3/OAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAFYSURBVFiF7ZY9TsNAEIW/6t1oQJbQVBCwsLCwsLGwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwAAAAAAAAAAAAAAAAAAAAA=');
  const imgInputs = await processor(dummyImg);
  const allInputs = {};
  Object.assign(allInputs, txtInputs, imgInputs);
  const output = await model(allInputs);
  const emb = new Float32Array(output.text_embeds.data);
  // L2 归一化
  let norm = 0;
  for (let i = 0; i < emb.length; i++) norm += emb[i] * emb[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < emb.length; i++) emb[i] /= norm;
  return emb;
}

/**
 * 计算一组文本与一张图片的 cosine similarity
 * @param {string} imagePath - 图片路径（相对）
 * @param {string[]} texts - 文本列表
 * @returns {Promise<Array<{text:string,similarity:number}>>}
 */
export async function imageTextSimilarity(imagePath, texts) {
  const imgEmb = await imageToEmbedding(imagePath);
  const results = [];
  for (const t of texts) {
    const txtEmb = await textToEmbedding(t);
    let dot = 0;
    for (let i = 0; i < imgEmb.length; i++) dot += imgEmb[i] * txtEmb[i];
    results.push({ text: t, similarity: dot }); // 已归一化，dot product = cosine sim
  }
  results.sort((a,b) => b.similarity - a.similarity);
  return results;
}

/** 导出原始模型引用供高级用法 */
export function getModel() { return model; }
