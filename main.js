/* ─── 汉衣图鉴 · main.js ─────────────────────────────────── */
/* 方案A：上传图片 → 服务端调用视觉API → 返回结构化识别结果 + 本地知识库科普 */

const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];

const fileInput = document.getElementById('image-upload');
const previewBox = document.getElementById('preview-box');
const previewImg = document.getElementById('preview-image');
const previewPlaceholder = document.getElementById('preview-placeholder');
const uploadHint = document.getElementById('upload-hint');
const resetBtn = document.getElementById('btn-reset-image');
const recognizeBtn = document.getElementById('btn-recognize');
const stylingForm = document.querySelector('.styling-form');
const generateOutfitBtn = document.getElementById('btn-generate-outfit');
const outfitResultBody = document.getElementById('outfit-result-body');

const cardBodies = [
  document.querySelectorAll('.result-card-body')[0],
  document.querySelectorAll('.result-card-body')[1],
  document.querySelectorAll('.result-card-body')[2],
];
const recognitionExampleGallery = document.getElementById('recognition-example-gallery');

let objectUrl = null;
let serviceConfigured = false;
let latestRecognitionResult = null;

function getExt(filename) {
  const p = filename.split('.');
  return p.length > 1 ? p.pop().toLowerCase() : '';
}

function isValidImage(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('image/')) return true;
  return ALLOWED_EXTENSIONS.includes(getExt(file.name));
}

function revokePreview() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

function setHint(msg, type) {
  uploadHint.textContent = msg;
  uploadHint.classList.remove('upload-hint--error', 'upload-hint--success');
  if (type === 'error') uploadHint.classList.add('upload-hint--error');
  if (type === 'success') uploadHint.classList.add('upload-hint--success');
}

function renderExampleGallery(items = [], emptyText = '暂无示例图') {
  if (!Array.isArray(items) || items.length === 0) {
    return `<p class="result-placeholder">${emptyText}</p>`;
  }

  return `
    <div class="example-gallery">
      ${items.map(item => `
        <figure class="example-card">
          <img class="example-card-image" 
               src="${item.url || item.img_url}" 
               alt="${item.name || '汉服示例图'}"
               onerror="this.onerror=null; this.parentNode.innerHTML='<div class=\'image-placeholder\'>图片加载失败</div>'; console.log('[图片加载失败]', this.src);">
          <figcaption class="example-card-caption">
            <span class="example-card-name">${item.name || '知识库示例'}</span>
            <span class="example-card-meta">${item.dynasty || ''}</span>
          </figcaption>
        </figure>
      `).join('')}
    </div>`;
}

function clearResult() {
  const placeholders = [
    '识别后将在此显示汉服形制名称',
    '识别后将在此显示形制由来与穿着要点',
    '识别后将在此显示发饰、鞋履等搭配建议',
  ];
  cardBodies.forEach((body, i) => {
    body.innerHTML = `<p class="result-placeholder">${placeholders[i]}</p>`;
    body.classList.remove('result-card-body--loading');
  });
  recognitionExampleGallery.innerHTML = '<p class="result-placeholder">识别后将在此显示知识库中的对应示例图</p>';
  recognitionExampleGallery.classList.remove('result-card-body--loading');
  latestRecognitionResult = null;
}

function showPreview(file) {
  revokePreview();
  objectUrl = URL.createObjectURL(file);
  previewImg.src = objectUrl;
  previewImg.hidden = false;
  previewPlaceholder.hidden = true;
  previewBox.classList.add('has-image');
  resetBtn.disabled = false;
  clearResult();
  latestRecognitionResult = null;
  setHint('图片已就绪，可点击「开始识别」', 'success');
}

function resetPreview() {
  revokePreview();
  fileInput.value = '';
  previewImg.removeAttribute('src');
  previewImg.hidden = true;
  previewPlaceholder.hidden = false;
  previewBox.classList.remove('has-image');
  resetBtn.disabled = true;
  clearResult();
  setHint('请选择 JPG、PNG、GIF、WebP 等图片文件', 'default');
}

function setLoadingCard(body, text) {
  body.innerHTML = `<div class="card-loader"><div class="loader-ring"></div><span>${text}</span></div>`;
  body.classList.add('result-card-body--loading');
}

function setOutfitLoading(text) {
  outfitResultBody.innerHTML = `<div class="card-loader"><div class="loader-ring"></div><span>${text}</span></div>`;
}

function getSelectedValue(name) {
  return stylingForm.querySelector(`input[name="${name}"]:checked`)?.value || '';
}

function mapQuestionnaireAnswers() {
  console.log('[问卷调试] 开始收集问卷答案...');
  
  const dictionary = {
    gender: {
      女: '女性',
      男: '男性',
    },
    'body-type': {
      slim: '纤细修长',
      average: '匀称适中',
      curvy: '丰润饱满',
    },
    temperament: {
      elegant: '温婉典雅',
      lively: '活泼灵动',
      solemn: '端庄大气',
      fresh: '清新淡雅',
    },
    occasion: {
      daily: '日常出行',
      festival: '节庆聚会',
      photo: '拍照写真',
      ceremony: '礼仪场合',
    },
    'color-pref': {
      warm: '暖色系',
      cool: '冷色系',
      neutral: '中性素雅',
      vivid: '明艳对比',
    },
  };

  const answers = {
    gender: getSelectedValue('gender'),
    bodyType: getSelectedValue('body-type'),
    temperament: getSelectedValue('temperament'),
    occasion: getSelectedValue('occasion'),
    colorPreference: getSelectedValue('color-pref'),
    labels: {
      gender: dictionary.gender[getSelectedValue('gender')] || '',
      bodyType: dictionary['body-type'][getSelectedValue('body-type')] || '',
      temperament: dictionary.temperament[getSelectedValue('temperament')] || '',
      occasion: dictionary.occasion[getSelectedValue('occasion')] || '',
      colorPreference: dictionary['color-pref'][getSelectedValue('color-pref')] || '',
    },
  };
  
  console.log('[问卷调试] 问卷答案:', answers);
  return answers;
}

function validateQuestionnaire(answers) {
  if (!answers.gender || !answers.bodyType || !answers.temperament || !answers.occasion || !answers.colorPreference) {
    throw new Error('请先完成全部问卷选项');
  }
}

async function requestOutfitRecommendation(payload) {
  console.log('[穿搭调试] 开始请求穿搭推荐接口');
  console.log('[穿搭调试] 请求参数:', JSON.stringify(payload, null, 2));
  
  // 创建超时控制器
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.log('[穿搭调试] 请求超时（60秒）');
    controller.abort();
  }, 60000); // 60秒超时（API调用需要较长时间）

  try {
    const resp = await fetch('/api/styling/recommend', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId); // 清除超时定时器

    console.log('[穿搭调试] 响应状态:', resp.status);
    
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      throw new Error(data.error || `HTTP ${resp.status}`);
    }

    console.log('[穿搭调试] 请求成功，返回数据:', data);
    return data;
  } catch (error) {
    clearTimeout(timeoutId); // 清除超时定时器
    if (error.name === 'AbortError') {
      console.error('[穿搭调试] 请求超时');
      throw new Error('穿搭请求超时（60秒），请稍后重试');
    }
    // 某些浏览器abort时抛出 TypeError "Failed to fetch"
    if (error.message && error.message.includes('Failed to fetch')) {
      console.error('[穿搭调试] 请求中断或网络错误');
      throw new Error('请求被中断或网络异常，请检查连接后重试');
    }
    console.error('[穿搭调试] 请求失败:', error);
    throw error;
  }
}

function renderOutfitResult(data) {
  const recommendation = data.recommendation || {};
  const matchedEntries = Array.isArray(data.matchedEntries) ? data.matchedEntries : [];
  const recognizedContext = data.recognizedContext || null;
  const matchedHtml = matchedEntries.length
    ? matchedEntries.map(item => `<span class="attr-tag">${item.name}${item.dynasty ? ` · ${item.dynasty}` : ''}</span>`).join('')
    : '<span class="attr-text">暂无候选条目</span>';
  const recognizedHtml = recognizedContext
    ? `<div class="result-tags">
        <span class="attr-label">联合参考</span>
        <span class="attr-text">${recognizedContext.form || recognizedContext.matchedEntry?.name || '已结合最近识图结果'}${recognizedContext.dynasty ? ` · ${recognizedContext.dynasty}` : recognizedContext.matchedEntry?.dynasty ? ` · ${recognizedContext.matchedEntry.dynasty}` : ''}</span>
      </div>`
    : '';
  const galleryHtml = renderExampleGallery(matchedEntries, '暂无可展示的知识库示例图');

  outfitResultBody.innerHTML = `
    <div class="result-section result-section--outfit">
      <h4 class="result-name">${recommendation.title || '专属穿搭方案'}</h4>
      <p class="result-intro">${recommendation.summary || '已根据你的问卷生成穿搭建议。'}</p>
      ${recognizedHtml}
      <div class="result-tags">
        <span class="attr-label">推荐形制</span>
        <span class="attr-text">${recommendation.form || '待补充'}</span>
      </div>
      <div class="result-tags">
        <span class="attr-label">推荐朝代</span>
        <span class="attr-text">${recommendation.dynasty || '待补充'}</span>
      </div>
      <div class="result-tags">
        <span class="attr-label">配色建议</span>
        <span class="attr-text">${recommendation.colors || '待补充'}</span>
      </div>
      <div class="result-tags">
        <span class="attr-label">配饰建议</span>
        <span class="attr-text">${recommendation.accessories || '待补充'}</span>
      </div>
      <div class="result-tags">
        <span class="attr-label">适用场景</span>
        <span class="attr-text">${recommendation.scene || '待补充'}</span>
      </div>
      <div class="result-tags">
        <span class="attr-label">穿着说明</span>
        <span class="attr-text">${recommendation.tips || '待补充'}</span>
      </div>
      <div class="result-tags">
        <span class="attr-label">参考条目</span>
        ${matchedHtml}
      </div>
      <div class="result-gallery-block">
        <span class="attr-label">知识库示例图</span>
        ${galleryHtml}
      </div>
    </div>`;
}

async function generateOutfitRecommendation() {
  console.log('[穿搭调试] ===== 开始生成穿搭方案 =====');
  
  try {
    console.log('[穿搭调试] 开始收集问卷答案...');
    const answers = mapQuestionnaireAnswers();
    console.log('[穿搭调试] 问卷答案:', answers);
    
    validateQuestionnaire(answers);
    console.log('[穿搭调试] 问卷验证通过');

    const payload = {
      ...answers,
      recognition: latestRecognitionResult
        ? {
            form: latestRecognitionResult.recognition?.form || latestRecognitionResult.display?.name,
            dynasty: latestRecognitionResult.recognition?.dynasty || latestRecognitionResult.display?.dynasty,
            gender: latestRecognitionResult.recognition?.gender || latestRecognitionResult.display?.gender,
            features: latestRecognitionResult.recognition?.features || [],
            matchedEntry: latestRecognitionResult.matchedEntry || null,
            core_feature: latestRecognitionResult.display?.core_feature || '',
          }
        : null,
    };
    console.log('[穿搭调试] 发送给后端的payload:', payload);

    setOutfitLoading('生成专属穿搭方案中…');
    console.log('[穿搭调试] 检查服务状态...');
    const status = await checkServiceStatus();
    console.log('[穿搭调试] 服务状态:', status);
    
    if (!status.configured) {
      throw new Error('服务端尚未配置视觉 API Key，暂时无法生成智能穿搭方案');
    }

    console.log('[穿搭调试] 开始请求穿搭推荐接口...');
    const result = await requestOutfitRecommendation(payload);
    console.log('[穿搭调试] 穿搭推荐结果:', result);
    
    renderOutfitResult(result);
    console.log('[穿搭调试] 穿搭结果渲染完成');
  } catch (error) {
    console.error('[穿搭调试] 生成穿搭方案失败:', error);
    outfitResultBody.innerHTML = `<p class="result-placeholder">生成失败：${error.message}</p>`;
    console.error('[generateOutfitRecommendation]', error);
  }
  console.log('[穿搭调试] ===== 生成穿搭方案结束 =====');
}

function findExampleImages(recognitionData, allEntries) {
  const recognizedForm = (recognitionData.recognition?.form || recognitionData.display?.name || '').trim();
  const recognizedDynasty = (recognitionData.recognition?.dynasty || recognitionData.display?.dynasty || '').trim();
  const recognizedGender = (recognitionData.recognition?.gender || recognitionData.display?.gender || '').trim();
  const recognizedFeatures = Array.isArray(recognitionData.recognition?.features)
    ? recognitionData.recognition.features
    : [];

  console.log('[识图调试] ===== 开始匹配示例图 =====');
  console.log('[识图调试] 识别结果:');
  console.log('  朝代:', recognizedDynasty);
  console.log('  形制关键词:', recognizedForm);
  console.log('  性别:', recognizedGender);
  console.log('  特征列表:', recognizedFeatures);

  if (!recognizedForm && !recognizedDynasty) {
    console.log('[识图调试] 识别出的形制和朝代均为空，无法匹配示例图');
    return [];
  }

  // 提取关键词：将形制名称拆分为更细的关键词
  const formKeywords = [];
  if (recognizedForm) {
    // 按常见分隔符拆分
    const splitResult = recognizedForm.split(/[·\-\s、，,/]/);
    for (const kw of splitResult) {
      const trimmed = kw.trim();
      if (trimmed.length >= 2) {
        formKeywords.push(trimmed);
      }
    }
    // 如果没有拆分出关键词，使用原始字符串
    if (formKeywords.length === 0 && recognizedForm.length >= 2) {
      formKeywords.push(recognizedForm);
    }
  }
  console.log('[识图调试] 形制关键词列表:', formKeywords);

  const results = [];
  for (const entry of allEntries) {
    const entryName = entry.name || '';
    const entryDynasty = entry.dynasty || '';
    const entryGender = entry.gender || '';

    console.log(`[识图调试] 遍历知识库条目: "${entryName}" (${entryDynasty})`);

    // 改进的名称匹配：检查是否包含任意一个关键词
    let nameMatch = false;
    for (const kw of formKeywords) {
      if (entryName.includes(kw) || kw.includes(entryName)) {
        nameMatch = true;
        console.log(`[识图调试]   名称匹配成功: 关键词 "${kw}" 匹配到 "${entryName}"`);
        break;
      }
    }
    
    // 如果关键词匹配失败，尝试原始匹配逻辑
    if (!nameMatch && recognizedForm) {
      nameMatch = entryName.includes(recognizedForm) ||
                  recognizedForm.includes(entryName) ||
                  recognizedForm.split(/[·\-\s]/).some(kw => kw.length >= 2 && entryName.includes(kw)) ||
                  entryName.split(/[·\-\s]/).some(kw => kw.length >= 2 && recognizedForm.includes(kw));
    }

    const dynastyMatch = !recognizedDynasty || 
                        entryDynasty.includes(recognizedDynasty) || 
                        recognizedDynasty.includes(entryDynasty) ||
                        // 处理朝代变体：如"汉"匹配"秦汉"
                        (recognizedDynasty === '汉' && entryDynasty.includes('汉')) ||
                        (entryDynasty === '汉' && recognizedDynasty.includes('汉'));

    const genderMatch = !recognizedGender || !entryGender || 
                        recognizedGender === entryGender ||
                        // 如果知识库条目是"通用"，则性别匹配
                        entryGender === '通用';

    const featureMatch = recognizedFeatures.some(f => 
      entry.core_feature?.includes(f) || 
      entry.style_attribute?.includes(f) ||
      entry.introduction?.includes(f)
    );

    if ((nameMatch || featureMatch) && dynastyMatch && genderMatch) {
      console.log(`[识图调试]   → 命中! nameMatch=${nameMatch}, dynastyMatch=${dynastyMatch}, genderMatch=${genderMatch}, featureMatch=${featureMatch}`);
      results.push({ url: entry.img_url, name: entry.name, dynasty: entryDynasty });
      if (results.length >= 4) break;
    }
  }

  console.log(`[识图调试] ===== 匹配结束，共匹配到 ${results.length} 张示例图 =====`);
  return results;
}

function renderResult(entry, meta = {}) {
  console.log('[渲染调试] ===== 开始渲染识别结果 =====');
  console.log('[渲染调试] 条目数据:', entry);
  console.log('[渲染调试] 元数据:', meta);
  
  const gender = entry.gender || '不确定';
  const dynasty = entry.dynasty || '未判定';
  console.log(`[渲染调试] 解析结果: 性别=${gender}, 朝代=${dynasty}`);
  
  const tag = `<span class="result-tag result-tag--${gender === '男' ? 'male' : 'female'}">${gender}</span>
               <span class="result-tag result-tag--dynasty">${dynasty}</span>`;
  const matchSummary = meta.matchSummary
    ? `<p class="result-confidence">${meta.matchSummary}</p>`
    : '';

  cardBodies[0].classList.remove('result-card-body--loading');
  cardBodies[1].classList.remove('result-card-body--loading');
  cardBodies[2].classList.remove('result-card-body--loading');
  recognitionExampleGallery.classList.remove('result-card-body--loading');

  cardBodies[0].innerHTML = `
    <div class="result-name-wrap">
      ${tag}
      <h3 class="result-name">${entry.name || '待确认形制'}</h3>
      <p class="result-core-feature">${entry.core_feature || '未提取到明显特征'}</p>
      ${meta.confidenceText ? `<p class="result-confidence">${meta.confidenceText}</p>` : ''}
      ${matchSummary}
    </div>`;

  const styleTags = String(entry.style_attribute || '—')
    .split('、')
    .filter(Boolean)
    .map(s => `<span class="attr-tag">${s}</span>`)
    .join('');

  cardBodies[1].innerHTML = `
    <div class="result-section">
      <p class="result-intro">${entry.introduction || '暂无说明'}</p>
      <div class="result-tags">
        <span class="attr-label">风格</span>
        ${styleTags || '<span class="attr-text">—</span>'}
      </div>
      <div class="result-tags">
        <span class="attr-label">配色</span>
        <span class="attr-text">${entry.color_match || '—'}</span>
      </div>
    </div>`;

  const accessoryTags = String(entry.accessory_match || '—')
    .split('、')
    .filter(Boolean)
    .map(s => `<span class="attr-tag">${s}</span>`)
    .join('');

  cardBodies[2].innerHTML = `
    <div class="result-section">
      <div class="result-tags">
        <span class="attr-label">配饰</span>
        ${accessoryTags || '<span class="attr-text">—</span>'}
      </div>
      <div class="result-tags">
        <span class="attr-label">人群</span>
        <span class="attr-text">${entry.crowd_match || '—'}</span>
      </div>
    </div>`;

  const galleryItems = findExampleImages(meta.recognitionData || {}, HANFU_DB?.all || []);
  recognitionExampleGallery.innerHTML = renderExampleGallery(galleryItems, '暂未匹配到知识库示例图');
}

async function checkServiceStatus() {
  console.log('[服务状态调试] 开始检查服务状态...');
  try {
    const resp = await fetch('/api/status');
    console.log('[服务状态调试] 响应状态:', resp.status);
    
    if (!resp.ok) {
      console.log('[服务状态调试] 响应不正常，返回默认状态');
      return { ok: false, configured: false };
    }
    
    const data = await resp.json();
    console.log('[服务状态调试] 服务状态:', data);
    return data;
  } catch (error) {
    console.error('[服务状态调试] 检查失败:', error);
    return { ok: false, configured: false };
  }
}

async function recognizeViaServer(file) {
  console.log('[识图调试] 开始请求识图接口');
  console.log('[识图调试] 文件类型:', file.type, '文件大小:', file.size, 'bytes');
  
  // 创建超时控制器
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.log('[识图调试] 请求超时（60秒）');
    controller.abort();
  }, 60000); // 60秒超时（视觉API需要上传图片+AI识别，耗时较长）

  try {
    const resp = await fetch('/api/recognize', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'image/jpeg',
      },
      body: file,
      signal: controller.signal
    });

    clearTimeout(timeoutId); // 清除超时定时器

    console.log('[识图调试] 响应状态:', resp.status);
    
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      throw new Error(data.error || `HTTP ${resp.status}`);
    }

    console.log('[识图调试] 请求成功，返回数据:', data);
    return data;
  } catch (error) {
    clearTimeout(timeoutId); // 清除超时定时器
    if (error.name === 'AbortError') {
      console.error('[识图调试] 请求超时');
      throw new Error('识图请求超时（60秒），图片可能较大或网络较慢，请稍后重试');
    }
    if (error.message && error.message.includes('Failed to fetch')) {
      console.error('[识图调试] 请求中断或网络错误');
      throw new Error('请求被中断或网络异常，请检查连接后重试');
    }
    console.error('[识图调试] 请求失败:', error);
    throw error;
  }
}

async function doRecognize() {
  console.log('[主流程调试] ===== 开始识图流程 =====');
  
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    setHint('请先选择一张图片文件', 'error');
    return;
  }
  console.log('[主流程调试] 已选择文件:', file.name, '类型:', file.type, '大小:', file.size, 'bytes');

  cardBodies.forEach(b => setLoadingCard(b, '检查服务状态…'));
  console.log('[主流程调试] 检查服务状态...');
  const status = await checkServiceStatus();
  serviceConfigured = Boolean(status.configured);
  console.log('[主流程调试] 服务状态:', status);

  if (!serviceConfigured) {
    clearResult();
    cardBodies[0].innerHTML = '<p class="result-placeholder">服务端尚未配置视觉 API Key，暂时无法识图</p>';
    setHint('缺少视觉 API 配置，请先提供 API Key', 'error');
    return;
  }

  cardBodies.forEach(b => setLoadingCard(b, '视觉识别中…'));
  setLoadingCard(recognitionExampleGallery, '匹配知识库示例图…');
  console.log('[主流程调试] 开始调用识图接口...');

  try {
    const result = await recognizeViaServer(file);
    console.log('[主流程调试] 识图接口返回结果:', result);
    latestRecognitionResult = result;
    const confidence = typeof result.confidence === 'number'
      ? `识别置信度 ${Math.round(result.confidence * 100)}%`
      : '';
    const matchSummary = result.matchedEntry?.name
      ? `图匹配结果：${result.matchedEntry.name}${result.matchedEntry.dynasty ? ` · ${result.matchedEntry.dynasty}` : ''}${Array.isArray(result.matchedEntry.reasons) && result.matchedEntry.reasons.length ? `（${result.matchedEntry.reasons.join('、')}）` : ''}`
      : '';

    console.log('[主流程调试] 开始渲染结果...');
    renderResult(result.display, {
      confidenceText: confidence,
      matchSummary,
      exampleImages: result.exampleImages || [],
      recognitionData: result,
    });
    console.log('[主流程调试] 结果渲染完成');
    
    if (result.matchedEntry?.id) {
      setHint(`识别完成：已匹配本地知识库条目 #${result.matchedEntry.id} ${result.matchedEntry.name || ''}`.trim(), 'success');
    } else {
      setHint('识别完成：已返回视觉判断，但本地知识库未精确命中', 'success');
    }
  } catch (e) {
    console.error('[主流程调试] 识图流程失败:', e);
    clearResult();
    cardBodies[0].innerHTML = `<p class="result-placeholder">视觉识别失败：${e.message}</p>`;
    const modelHint = e.message.includes('does not exist') || e.message.includes('do not have access')
      ? '当前接入点可能未开通、区域不匹配，或 API Key 无权限访问该 endpoint。'
      : '';
    setHint(`识图失败：${e.message}${modelHint ? `；${modelHint}` : ''}`, 'error');
    console.error('[doRecognize]', e);
  }
  console.log('[主流程调试] ===== 识图流程结束 =====');
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  if (!isValidImage(file)) {
    fileInput.value = '';
    setHint('文件格式不支持，请选择图片文件（如 JPG、PNG、GIF、WebP）', 'error');
    return;
  }
  showPreview(file);
});

resetBtn.addEventListener('click', resetPreview);
recognizeBtn.addEventListener('click', doRecognize);
generateOutfitBtn.addEventListener('click', generateOutfitRecommendation);
window.addEventListener('beforeunload', revokePreview);

(async () => {
  const status = await checkServiceStatus();
  serviceConfigured = Boolean(status.configured);
  if (serviceConfigured) {
    setHint(`视觉识别服务已就绪（${status.model || '已配置模型'}）`, 'success');
  } else {
    setHint('等待配置视觉 API Key…', 'default');
  }
})();
