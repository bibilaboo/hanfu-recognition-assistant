import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';
import path from 'path';

function loadEnvFile(baseDir) {
  const envPath = path.join(baseDir, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnvFile(__dirname);

const PORT = 3000;
const BASE_DIR = __dirname;

const VISION_API_KEY = process.env.VISION_API_KEY || '';
const VISION_API_URL = process.env.VISION_API_URL || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const VISION_MODEL = process.env.VISION_MODEL || 'doubao-seed-2-0-pro-260215';
const VISION_ENDPOINT_ID = process.env.VISION_ENDPOINT_ID || 'ep-m-20260610095142-qh795';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message, extra = {}) {
  sendJSON(res, { error: message, ...extra }, status);
}

function serveFile(filePath, res) {
  if (!fs.existsSync(filePath)) {
    sendError(res, 404, `文件不存在: ${path.relative(BASE_DIR, filePath)}`);
    return;
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    sendError(res, 403, '目录不允许访问');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const cacheMaxAge = ext === '.html' ? 0 : ext === '.js' || ext === '.css' ? 0 : 86400;
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': `public, max-age=${cacheMaxAge}`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  fs.createReadStream(filePath).pipe(res);
}

function readHanfuDB() {
  const dbPath = path.join(BASE_DIR, 'hanfuDB.js');
  const source = fs.readFileSync(dbPath, 'utf8');
  const match = source.match(/const HANFU_DB = \{[\s\S]*?\n\};/);
  if (!match) {
    throw new Error('无法读取 hanfuDB.js');
  }

  const vm = Function(`${match[0]}; return HANFU_DB;`);
  return vm();
}

const HANFU_DB_RAW = readHanfuDB();
const HANFU_ENTRIES = [...HANFU_DB_RAW.female, ...HANFU_DB_RAW.male];

// ========== CLIP Embedding 语义匹配模块 ==========
// 解决"推荐形制与示例图不匹配"问题：用形制名的文本embedding和图片embedding做余弦相似度匹配
// 使用 @xenova/transformers 的正确 API：CLIPModel + AutoTokenizer + AutoProcessor

let imageEmbeddings = []; // [{img_path, embedding: Float32Array(512)}]
let clipModelObj = null;   // CLIPModel instance
let clipTokenizer = null;   // AutoTokenizer instance
let clipProcessor = null;   // AutoProcessor instance
let clipDummyPixelValues = null; // 预计算的 dummy pixel_values Tensor
let clipModelReady = false;

/**
 * 加载预计算的图片 embeddings（来自 embeddings.json）
 * 新格式：{ "image/xxx.jpeg": [512个数字], ... }
 */
function loadImageEmbeddings() {
  try {
    const embPath = path.join(BASE_DIR, 'embeddings.json');
    if (!fs.existsSync(embPath)) {
      console.warn('[Embedding] embeddings.json 不存在，将使用名称匹配模式');
      return false;
    }
    const raw = JSON.parse(fs.readFileSync(embPath, 'utf8'));
    const loaded = [];
    let skipped = 0;
    
    // 新格式：key 是相对路径，value 是 [512] Float32Array
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [imgPath, vec] of Object.entries(raw)) {
        if (!Array.isArray(vec) || vec.length < 100) { skipped++; continue; }
        loaded.push({
          img_path: imgPath,
          embedding: new Float32Array(vec),
        });
      }
    } else {
      // 兼容旧格式（数组）
      for (const item of raw) {
        if (!item.embedding || !item.img_url) { skipped++; continue; }
        let vec = item.embedding;
        while (Array.isArray(vec) && vec.length === 1 && Array.isArray(vec[0])) {
          vec = vec[0];
        }
        if (Array.isArray(vec) && vec.length > 10) {
          loaded.push({
            img_path: item.img_url,
            embedding: new Float32Array(vec),
          });
        } else { skipped++; }
      }
    }
    
    imageEmbeddings = loaded;
    console.log(`[Embedding] 加载完成: ${loaded.length} 张图片有效 (跳过 ${skipped})`);
    return loaded.length > 0;
  } catch (e) {
    console.error('[Embedding] 加载失败:', e.message);
    return false;
  }
}

/**
 * 异步初始化 CLIP 模型 + tokenizer + processor（用于将形制名转为 embedding）
 * 使用正确的 API：CLIPModel + AutoTokenizer + AutoProcessor
 */
async function initCLIPTextModel() {
  try {
    const { CLIPModel, AutoTokenizer, AutoProcessor, RawImage } = await import('@xenova/transformers');
    
    clipModelObj = await CLIPModel.from_pretrained('clip-vit-base-patch32', {
      local_files_only: true,
    });
    clipTokenizer = await AutoTokenizer.from_pretrained('clip-vit-base-patch32', {
      local_files_only: true,
    });
    clipProcessor = await AutoProcessor.from_pretrained('clip-vit-base-patch32', {
      local_files_only: true,
    });
    
    // 预计算一次 dummy pixel values（用纯白 224x224 图片）
    const whitePixels = new Uint8ClampedArray(3 * 224 * 224).fill(255);
    const dummyImg = new RawImage(new ImageData(whitePixels, 224, 224));
    const dummyInputs = await clipProcessor(dummyImg);
    clipDummyPixelValues = dummyInputs.pixel_values;
    
    clipModelReady = true;
    console.log('[Embedding] CLIP 模型+tokenizer+processor 全部加载成功！');
    return true;
  } catch (e) {
    console.warn('[Embedding] CLIP 模型加载失败，回退到名称匹配:', e.message);
    return false;
  }
}

/**
 * 计算余弦相似度
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return -1;
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dotProduct / denom : -1;
}

/**
 * L2 归一化向量
 */
function l2Normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  const result = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) result[i] = vec[i] / norm;
  return result;
}

/**
 * 核心函数：根据形制名，用 CLIP 语义相似度找到最匹配的图片
 * @param {string} formName - 形制名称，如 "齐腰襦裙（唐式）"
 * @param {number} topK - 返回最相似的 K 张图片
 * @returns {Array} 排序后的匹配结果 [{img_path, similarity, ...}]
 */
async function findBestMatchingImages(formName, topK = 3) {
  // 如果模型或 embeddings 未就绪，返回空数组（让调用方回退到名称匹配）
  if (!clipModelReady || !clipModelObj || !clipTokenizer || imageEmbeddings.length === 0) {
    console.log(`[Embedding] 未就绪 (model=${clipModelReady}, imgs=${imageEmbeddings.length}), 跳过语义匹配`);
    return [];
  }

  try {
    const queryText = `${formName} 汉服服饰照片`;
    console.log(`[Embedding] 查询文本: "${queryText}"`);

    // 用 tokenizer 编码文本
    const textInputs = clipTokenizer(queryText, { padding: true, truncation: true });
    
    // 合并 inputs：文本 + 预计算的 dummy pixel_values
    const allInputs = {};
    for (const [k, v] of Object.entries(textInputs)) allInputs[k] = v;
    allInputs['pixel_values'] = clipDummyPixelValues;

    // 运行 CLIP 推理（只取 text_embeds）
    const output = await clipModelObj(allInputs);
    let textEmb = output.text_embeds.data;
    if (!(textEmb instanceof Float32Array)) {
      textEmb = new Float32Array(textEmb);
    }
    console.log(`[Embedding] 文本 embedding 维度: ${textEmb.length}`);

    // 与所有图片 embedding 计算余弦相似度
    const scores = imageEmbeddings.map(img => ({
      img_path: img.img_path,
      similarity: cosineSimilarity(textEmb, img.embedding),
    }));

    // 按相似度降序排列
    scores.sort((a, b) => b.similarity - a.similarity);

    const results = scores.slice(0, topK);
    console.log(`[Embedding] Top 匹配:`);
    for (const r of results) {
      console.log(`   ${r.similarity.toFixed(4)} | ${r.img_path?.slice(0,60)}`);
    }

    return results;
  } catch (e) {
    console.error('[Embedding] 匹配过程出错:', e.message);
    return [];
  }
}

// 启动时异步加载（不阻塞服务器启动）
loadImageEmbeddings();
initCLIPTextModel().then(ok => {
  if (ok) console.log('[Embedding] ✅ 语义匹配系统就绪');
}).catch(() => {});

// ================================================

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function splitKeywords(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item || '').trim())
      .filter(Boolean);
  }

  return String(value || '')
    .split(/[、，,\/｜|；;\s]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function containsAny(text, keywords) {
  const normalizedText = normalizeText(text);
  return keywords.some(keyword => normalizedText.includes(normalizeText(keyword)));
}

function isLikelyLanshanRecognition(recognition) {
  const textPool = [
    recognition.form,
    recognition.dynasty,
    recognition.gender,
    recognition.summary,
    ...(Array.isArray(recognition.features) ? recognition.features : []),
  ].join(' ');

  const lanshanSignals = ['襕衫', '襕边', '横襕', '膝襕', '书生', '士人', '生员', '儒雅'];
  return containsAny(textPool, lanshanSignals);
}

function isLikelyYuanlingpaoRecognition(recognition) {
  const textPool = [
    recognition.form,
    recognition.dynasty,
    recognition.gender,
    recognition.summary,
    ...(Array.isArray(recognition.features) ? recognition.features : []),
  ].join(' ');

  const yuanlingpaoSignals = ['圆领袍', '革带', '官服', '武官', '胡服', '盛唐'];
  return containsAny(textPool, yuanlingpaoSignals);
}

function scoreEntry(entry, recognition) {
  let score = 0;
  const reasons = [];

  const recogForm = normalizeText(recognition.form);
  const recogDynasty = normalizeText(recognition.dynasty);
  const recogGender = normalizeText(recognition.gender);
  const entryGender = normalizeText(entry.gender);
  const recogFeatures = splitKeywords(recognition.features);
  const entryName = normalizeText(entry.name);
  const coreFeature = normalizeText(entry.core_feature);
  const styleAttribute = normalizeText(entry.style_attribute);
  const summary = normalizeText(recognition.summary);
  const textPool = [recogForm, summary, ...recogFeatures].join(' ');

  if (recogGender && recogGender !== '不确定' && entryGender) {
    if (entryGender === recogGender) {
      score += 8;
      reasons.push('性别匹配');
    } else {
      score -= 12;
      reasons.push('性别冲突');
    }
  }

  if (recogForm) {
    if (entryName.includes(recogForm)) {
      score += 18;
      reasons.push('形制名称匹配');
    } else if (recogForm.includes(entryName)) {
      score += 12;
      reasons.push('形制名称近似');
    }
  }

  if (recogDynasty && normalizeText(entry.dynasty).includes(recogDynasty)) {
    score += 6;
    reasons.push('朝代匹配');
  }

  for (const keyword of recogFeatures) {
    const normalizedKeyword = normalizeText(keyword);
    if (coreFeature.includes(normalizedKeyword)) {
      score += 3;
      reasons.push(`特征命中:${keyword}`);
    }
    if (styleAttribute.includes(normalizedKeyword)) {
      score += 2;
      reasons.push(`风格命中:${keyword}`);
    }
  }

  if (entryName.includes('襕衫')) {
    if (containsAny(textPool, ['襕衫', '襕边', '横襕', '膝襕'])) {
      score += 18;
      reasons.push('襕衫关键特征');
    }
    if (containsAny(textPool, ['书生', '士人', '生员', '儒雅'])) {
      score += 6;
      reasons.push('襕衫人群语义');
    }
    if (containsAny(textPool, ['圆领袍']) && !containsAny(textPool, ['襕衫', '襕边', '横襕', '膝襕'])) {
      score -= 6;
      reasons.push('更像普通圆领袍');
    }
  }

  if (entryName.includes('圆领袍')) {
    if (containsAny(textPool, ['圆领袍', '革带', '官服', '武官', '胡服', '盛唐'])) {
      score += 10;
      reasons.push('圆领袍关键特征');
    }
    if (containsAny(textPool, ['襕衫', '襕边', '横襕', '膝襕'])) {
      score -= 14;
      reasons.push('缺少圆领袍特征');
    }
  }

  return { score, reasons };
}

function matchKnowledgeBase(recognition) {
  const preferLanshan = isLikelyLanshanRecognition(recognition);
  const preferYuanlingpao = isLikelyYuanlingpaoRecognition(recognition);

  let candidateEntries = HANFU_ENTRIES;
  if (preferLanshan) {
    candidateEntries = HANFU_ENTRIES.filter(entry => normalizeText(entry.gender) === normalizeText(recognition.gender || entry.gender));
  }

  let best = null;
  let bestScore = -1;
  let bestReasons = [];

  for (const entry of candidateEntries) {
    const entryName = normalizeText(entry.name);

    if (preferLanshan && entryName.includes('圆领袍') && !entryName.includes('襕衫')) {
      continue;
    }

    if (preferYuanlingpao && entryName.includes('襕衫') && !isLikelyLanshanRecognition(recognition)) {
      continue;
    }

    const { score, reasons } = scoreEntry(entry, recognition);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
      bestReasons = reasons;
    }
  }

  return {
    entry: best,
    score: bestScore,
    reasons: bestReasons,
  };
}

function buildPrompt() {
  return [
    '你是汉服识别助手。请根据上传图片识别汉服形制，并严格输出 JSON。',
    '如果不是汉服，也要输出 JSON，不要输出 markdown。',
    '字段要求：',
    '{',
    '  "is_hanfu": true/false,',
    '  "form": "形制名称，尽量简短，如 齐胸襦裙 / 马面裙 / 袄裙 / 曲裾深衣",',
    '  "dynasty": "朝代倾向，如 唐 / 宋 / 明 / 魏晋 / 秦汉",',
    '  "gender": "男/女/不确定",',
    '  "features": ["可见特征1", "可见特征2"],',
    '  "confidence": 0到1之间的小数,',
    '  "summary": "一句话总结这张图的服饰判断依据"',
    '}',
    '只输出 JSON 本身。'
  ].join('\n');
}

function pickStylingCandidates(questionnaire) {
  const gender = normalizeText(questionnaire.gender);
  const temperament = normalizeText(questionnaire.labels?.temperament || questionnaire.temperament);
  const occasion = normalizeText(questionnaire.labels?.occasion || questionnaire.occasion);
  const colorPreference = normalizeText(questionnaire.labels?.colorPreference || questionnaire.colorPreference);
  const bodyType = normalizeText(questionnaire.labels?.bodyType || questionnaire.bodyType);
  const recognizedForm = normalizeText(questionnaire.recognition?.form || questionnaire.recognition?.matchedEntry?.name);
  const recognizedDynasty = normalizeText(questionnaire.recognition?.dynasty || questionnaire.recognition?.matchedEntry?.dynasty);
  const recognizedFeatures = splitKeywords(questionnaire.recognition?.features || questionnaire.recognition?.core_feature);

  return HANFU_ENTRIES
    .filter(entry => !gender || normalizeText(entry.gender) === gender)
    .map(entry => {
      let score = 0;
      const reasons = [];
      const style = normalizeText(entry.style_attribute);
      const crowd = normalizeText(entry.crowd_match);
      const colors = normalizeText(entry.color_match);
      const intro = normalizeText(entry.introduction);
      const features = normalizeText(entry.core_feature);
      const entryName = normalizeText(entry.name);
      const dynasty = normalizeText(entry.dynasty);

      if (recognizedForm) {
        if (entryName.includes(recognizedForm) || recognizedForm.includes(entryName)) {
          score += 18;
          reasons.push('识图形制匹配');
        } else if (containsAny(`${entryName} ${features}`, recognizedFeatures)) {
          score += 8;
          reasons.push('识图特征接近');
        }
      }

      if (recognizedDynasty && dynasty.includes(recognizedDynasty)) {
        score += 8;
        reasons.push('识图朝代匹配');
      }

      for (const feature of recognizedFeatures) {
        const normalizedFeature = normalizeText(feature);
        if (normalizedFeature && features.includes(normalizedFeature)) {
          score += 3;
          reasons.push(`识图特征命中:${feature}`);
        }
      }

      if (temperament && (style.includes(temperament) || crowd.includes(temperament) || intro.includes(temperament))) {
        score += 10;
        reasons.push('气质匹配');
      }

      if (occasion && (crowd.includes(occasion) || intro.includes(occasion))) {
        score += 10;
        reasons.push('场景匹配');
      }

      if (bodyType && crowd.includes(bodyType)) {
        score += 7;
        reasons.push('身形匹配');
      }

      if (colorPreference) {
        if (colorPreference.includes('暖') && containsAny(colors, ['红', '橙', '金', '黄', '绛', '赤'])) {
          score += 6;
          reasons.push('暖色偏好匹配');
        }
        if (colorPreference.includes('冷') && containsAny(colors, ['蓝', '青', '绿', '紫', '黛'])) {
          score += 6;
          reasons.push('冷色偏好匹配');
        }
        if (colorPreference.includes('素雅') && containsAny(colors, ['白', '素', '灰', '月白', '浅'])) {
          score += 6;
          reasons.push('素雅配色匹配');
        }
        if (colorPreference.includes('明艳') && containsAny(colors, ['金', '红', '绯', '宝蓝', '对比'])) {
          score += 6;
          reasons.push('明艳配色匹配');
        }
      }

      if (containsAny(features, ['大袖', '广袖']) && occasion.includes('礼仪')) {
        score += 3;
      }

      return {
        ...entry,
        matchScore: score,
        matchReasons: reasons,
      };
    })
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 5);
}

/**
 * 根据豆包API推荐的形制名称，在知识库中二次精确匹配对应条目
 * 解决"推荐形制名与示例图不一致"的问题
 */
async function resolveFormEntries(recommendation, allEntries, gender) {
  const form = normalizeText(recommendation.form || '');
  const dynasty = normalizeText(recommendation.dynasty || '');
  if (!form) return allEntries.slice(0, 3);

  // 提取推荐的形制关键词（可能包含多个，如"齐腰襦裙 + 披帛 + 半臂"）
  const formParts = form
    .split(/[,/;、+和与]|(?:s+(?:和|与|配)s+)/)
    .map(s => normalizeText(s.trim()))
    .filter(s => s.length > 1)
    .slice(0, 5);

  console.log(`[匹配] 解析推荐形制: "${form}" →`, formParts);

  // 对每个形制部分，在知识库中找最佳匹配条目（名称层面）
  const matched = [];
  const usedIds = new Set();

  for (const part of formParts) {
    let bestEntry = null;
    let bestScore = -1;
    let bestReason = '';

    for (const entry of allEntries) {
      if (usedIds.has(entry.id)) continue;
      if (gender && normalizeText(entry.gender) !== gender) continue;

      let score = 0;
      const reasons = [];
      const entryName = normalizeText(entry.name);
      const entryDynasty = normalizeText(entry.dynasty);
      const features = normalizeText(entry.core_feature);

      // 1. 精确名称匹配（最高优先级）
      if (entryName === part || part.includes(entryName) || entryName.includes(part)) {
        score += 50; reasons.push('精确名称匹配');
      }
      // 2. 名称核心词匹配
      else {
        const coreName = entryName.replace(/[（(][^)）]*[)）]/g, '');
        const corePart = part.replace(/[（(][^)）]*[)）]/g, '');
        if (coreName && corePart && (coreName.includes(corePart) || corePart.includes(coreName))) {
          score += 30; reasons.push('核心名称匹配');
        }
        else if (features.includes(part) || part.includes(features.slice(0, 10))) {
          score += 15; reasons.push('特征文本匹配');
        }
        else {
          for (const keyword of part.replace(/[（）()、，；]/g, '').split('')) {
            if (keyword.length >= 2 && entryName.includes(keyword)) {
              score += 5; reasons.push(`关键词"${keyword}"匹配`);
            }
          }
        }
      }

      // 朝代加权
      if (dynasty && (entryDynasty.includes(dynasty) || dynasty.includes(entryDynasty))) {
        score += 10; reasons.push('朝代一致');
      }

      if (score > bestScore) { bestScore = score; bestEntry = entry; bestReason = reasons.join('、'); }
    }

    if (bestEntry && bestScore >= 5) {
      usedIds.add(bestEntry.id);
      matched.push({ ...bestEntry, _queryPart: part, matchScore: bestScore, matchReasons: [bestReason] });
      console.log(`[匹配] 形制"${part}" → ${bestEntry.name} (${bestEntry.dynasty}) [${bestScore}分] ${bestReason}`);
    } else {
      console.log(`[匹配] 形制"${part}" 未找到匹配条目 (最佳得分: ${bestScore})`);
    }
  }

  // 如果不足3条，补足
  if (matched.length < 3) {
    for (const entry of allEntries) {
      if (usedIds.has(entry.id)) continue;
      if (gender && normalizeText(entry.gender) !== gender) continue;
      matched.push({ ...entry, _queryPart: entry.name, matchScore: 0, matchReasons: ['补位'] });
      usedIds.add(entry.id);
      if (matched.length >= 3) break;
    }
  }

  // ===== CLIP 语义匹配选图 =====
  const usedImgPaths = new Set();
  for (const item of matched) {
    const queryName = item._queryPart || item.name;
    try {
      const semanticMatches = await findBestMatchingImages(queryName, 5);
      if (semanticMatches.length > 0) {
        let selected = null;
        for (const sm of semanticMatches) { 
          if (!usedImgPaths.has(sm.img_path)) { selected = sm; break; } 
        }
        if (selected && selected.similarity > 0.15) {
          console.log(`[Embedding] ✅ "${queryName}" → ${selected.similarity.toFixed(4)} ${selected.img_path?.slice(0,60)}`);
          item.img_url = selected.img_path;
          item.embedding_similarity = selected.similarity;
          usedImgPaths.add(selected.img_path);
          // 尝试从知识库找到对应条目（通过 img_path 反查）
          const correctEntry = HANFU_ENTRIES.find(e => e.img_url === selected.img_path);
          if (correctEntry) { item._nameOverride = correctEntry.name; item._dynastyOverride = correctEntry.dynasty; item.id = correctEntry.id; }
        } else {
          console.log(`[Embedding] ⚠️ "${queryName}" 相似度过低, 保留原图`);
        }
      } else { console.log(`[Embedding] ⚠️ "${queryName}" 无匹配结果`); }
    } catch (e) { console.error(`[Embedding] "${queryName}" 异常:`, e.message); }
    delete item._queryPart;
  }

  for (const item of matched) {
    if (item._nameOverride) { item.name = item._nameOverride; delete item._nameOverride; }
    if (item._dynastyOverride) { item.dynasty = item._dynastyOverride; delete item._dynastyOverride; }
  }

  return matched.slice(0, 3);
}

function buildStylingPrompt(questionnaire, candidates) {
  const candidateText = candidates.map((entry, index) => [
    `${index + 1}. ${entry.name}（${entry.dynasty} · ${entry.gender}）`,
    `核心特征：${entry.core_feature}`,
    `风格属性：${entry.style_attribute}`,
    `配色建议：${entry.color_match}`,
    `配饰建议：${entry.accessory_match}`,
    `适用人群：${entry.crowd_match}`,
    `匹配理由：${entry.matchReasons?.join('、') || '综合匹配'}`,
  ].join('\n')).join('\n\n');

  return [
    '你是汉服穿搭顾问。请根据用户问卷、识图结果与候选汉服条目，生成一套简洁、实用、符合场景的汉服穿搭建议。',
    '必须优先参考给定候选条目，不要脱离候选数据瞎编。',
    '如果识图结果与问卷偏好存在冲突，请给出折中方案，并在 summary 中说明如何兼顾。',
    '请严格输出 JSON，不要输出 markdown。',
    '用户问卷：',
    JSON.stringify(questionnaire, null, 2),
    '候选条目：',
    candidateText,
    '输出字段：',
    '{',
    '  "title": "一句吸引人的方案名",',
    '  "summary": "2-3句总结，解释为什么适合用户，并说明如何融合识图结果与问卷偏好",',
    '  "form": "推荐形制名称",',
    '  "dynasty": "推荐朝代",',
    '  "colors": "推荐配色",',
    '  "accessories": "推荐配饰",',
    '  "scene": "适用场景说明",',
    '  "tips": "穿着或搭配注意事项"',
    '}',
    '只输出 JSON 本身。',
  ].join('\n');
}

async function callStylingAPI(questionnaire, candidates) {
  if (!VISION_API_KEY) {
    throw new Error('缺少 VISION_API_KEY');
  }

  const response = await fetch(VISION_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VISION_API_KEY}`,
    },
    body: JSON.stringify({
      model: VISION_ENDPOINT_ID,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: buildStylingPrompt(questionnaire, candidates),
            },
          ],
        },
      ],
      temperature: 0.5,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || `穿搭接口调用失败: HTTP ${response.status}`;
    throw new Error(message);
  }

  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) {
    throw new Error('穿搭接口未返回文本结果');
  }

  try {
    return JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('穿搭接口返回结果不是有效 JSON');
    }
    return JSON.parse(jsonMatch[0]);
  }
}

async function callVisionAPI(imageBuffer, mimeType) {
  if (!VISION_API_KEY) {
    throw new Error('缺少 VISION_API_KEY');
  }

  const base64 = imageBuffer.toString('base64');
  const imageUrl = `data:${mimeType};base64,${base64}`;

  const response = await fetch(VISION_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VISION_API_KEY}`,
    },
    body: JSON.stringify({
      model: VISION_ENDPOINT_ID,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: buildPrompt(),
            },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
              },
            },
          ],
        },
      ],
      temperature: 0.2,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || `视觉接口调用失败: HTTP ${response.status}`;
    throw new Error(message);
  }

  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) {
    throw new Error('视觉接口未返回文本结果');
  }

  try {
    return JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('视觉接口返回结果不是有效 JSON');
    }
    return JSON.parse(jsonMatch[0]);
  }
}

function buildFinalPayload(recognition, matched) {
  const entry = matched.entry;
  const confidence = typeof recognition.confidence === 'number'
    ? recognition.confidence
    : 0;
  const recognitionFeatures = Array.isArray(recognition.features)
    ? recognition.features.filter(Boolean)
    : [];

  if (!recognition.is_hanfu) {
    return {
      success: true,
      mode: 'vision-api',
      recognition,
      matchedEntry: null,
      display: {
        name: '未识别为汉服',
        dynasty: recognition.dynasty || '未判定',
        gender: recognition.gender || '不确定',
        core_feature: recognitionFeatures.length > 0 ? recognitionFeatures.join('、') : '未提取到明显形制特征',
        introduction: recognition.summary || '视觉模型判断当前图片不属于可明确识别的汉服形制。',
        style_attribute: '建议更换正面、半身、光线充足的汉服照片重试',
        color_match: '—',
        accessory_match: '—',
        crowd_match: '—',
      },
      confidence,
    };
  }

  if (!entry) {
    return {
      success: true,
      mode: 'vision-api',
      recognition,
      matchedEntry: null,
      display: {
        name: recognition.form || '待人工确认形制',
        dynasty: recognition.dynasty || '未判定',
        gender: recognition.gender || '不确定',
        core_feature: recognitionFeatures.length > 0 ? recognitionFeatures.join('、') : '未提取到明显特征',
        introduction: recognition.summary || '已识别为汉服，但暂未在本地知识库中匹配到最接近条目。',
        style_attribute: '建议补充该形制到本地知识库',
        color_match: '—',
        accessory_match: '—',
        crowd_match: '—',
      },
      confidence,
    };
  }

  return {
    success: true,
    mode: 'vision-api',
    recognition,
    matchedEntry: {
      id: entry.id,
      score: matched.score,
      reasons: matched.reasons,
      name: entry.name,
      dynasty: entry.dynasty,
    },
    display: {
      ...entry,
      name: entry.name,
      dynasty: recognition.dynasty || entry.dynasty,
      gender: recognition.gender || entry.gender || '不确定',
      core_feature: recognitionFeatures.length > 0
        ? `图像特征：${recognitionFeatures.join('、')}`
        : entry.core_feature,
      introduction: recognition.summary || entry.introduction,
      style_attribute: entry.style_attribute,
    },
    exampleImages: [{
      url: entry.img_url,
      name: entry.name,
      dynasty: entry.dynasty,
    }],
    confidence,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${pathname}`);

  if (pathname === '/api/status' && req.method === 'GET') {
    sendJSON(res, {
      ok: true,
      mode: 'vision-api',
      configured: Boolean(VISION_API_KEY),
      model: VISION_MODEL,
      endpointId: VISION_ENDPOINT_ID,
    });
    return;
  }

  if (pathname === '/api/recognize' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] || 'image/jpeg';

    if (!contentType.includes('image/')) {
      sendError(res, 400, '需要直接上传图片二进制，Content-Type 必须为 image/*');
      return;
    }

    try {
      const recognition = await callVisionAPI(body, contentType);
      const matched = matchKnowledgeBase(recognition);
      const payload = buildFinalPayload(recognition, matched);
      sendJSON(res, payload);
    } catch (e) {
      console.error('[recognize error]', e);
      sendError(res, 500, e.message, {
        mode: 'vision-api',
        configured: Boolean(VISION_API_KEY),
      });
    }
    return;
  }

  if (pathname === '/api/styling/recommend' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    try {
      const rawBody = Buffer.concat(chunks).toString('utf8') || '{}';
      const questionnaire = JSON.parse(rawBody);
      const candidates = pickStylingCandidates(questionnaire);

      if (candidates.length === 0) {
        sendError(res, 400, '未找到符合当前问卷性别条件的候选汉服条目');
        return;
      }

      const recommendation = await callStylingAPI(questionnaire, candidates);
      const gender = normalizeText(questionnaire.gender);
      // 用豆包API返回的推荐形制名做二次精确匹配，确保示例图与形制一致
      const matchedEntries = await resolveFormEntries(recommendation, HANFU_ENTRIES, gender);
      sendJSON(res, {
        success: true,
        mode: 'styling-api',
        recommendation,
        recognizedContext: questionnaire.recognition || null,
        matchedEntries: matchedEntries.map(entry => ({
          id: entry.id,
          name: entry.name,
          dynasty: entry.dynasty,
          gender: entry.gender,
          score: entry.matchScore,
          reasons: entry.matchReasons,
          img_url: entry.img_url,
        })),
      });
    } catch (e) {
      console.error('[styling error]', e);
      sendError(res, 500, e.message, {
        mode: 'styling-api',
        configured: Boolean(VISION_API_KEY),
      });
    }
    return;
  }

  let filePath;
  // 对中文等特殊字符进行URL解码
  const decodedPathname = decodeURIComponent(pathname);
  if (decodedPathname === '/' || decodedPathname === '/index.html') {
    filePath = path.join(BASE_DIR, 'index.html');
  } else {
    filePath = path.join(BASE_DIR, decodedPathname);
  }

  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(BASE_DIR)) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  serveFile(normalized, res);
});

server.listen(PORT, () => {
  console.log('');
  console.log('========================================');
  console.log('  汉衣图鉴 · 服务端 (Vision API + 知识库)');
  console.log(`  访问地址: http://localhost:${PORT}`);
  console.log('========================================');
  console.log('');
  console.log('API 接口:');
  console.log('  POST /api/recognize - 调用视觉模型识别汉服');
  console.log('  GET  /api/status    - 服务状态');
  console.log('');
});
