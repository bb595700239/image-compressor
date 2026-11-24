'use strict';

const $ = (id) => document.getElementById(id);
const IMG_EXT_RE = /\.(png|jpe?g)$/i;
const SETTINGS_KEY = 'imgcomp-settings-v1';

const state = {
  inputs: [],      // 已添加的输入（文件/文件夹路径）
  running: false,
  outDir: '',
  counts: { done: 0, kept: 0, copied: 0, skipped: 0, error: 0 },
  sizeBefore: 0,
  sizeAfter: 0,
  fileEvents: 0,
};

const settingsEls = {
  quality: $('quality'),
  effort: $('effort'),
  maxWidth: $('maxWidth'),
  maxHeight: $('maxHeight'),
  lossless: $('lossless'),
  pngPalette: $('pngPalette'),
  copyOthers: $('copyOthers'),
  overwrite: $('overwrite'),
  keepIfLarger: $('keepIfLarger'),
  output: $('outputPath'),
};

// ---------- 设置持久化 ----------
function readSettings() {
  return {
    format: document.querySelector('input[name="format"]:checked').value,
    webpQuality: Number(settingsEls.quality.value),
    webpEffort: Number(settingsEls.effort.value),
    webpLossless: settingsEls.lossless.checked,
    pngPalette: settingsEls.pngPalette.checked,
    maxWidth: Number(settingsEls.maxWidth.value) || 0,
    maxHeight: Number(settingsEls.maxHeight.value) || 0,
    copyOthers: settingsEls.copyOthers.checked,
    overwrite: settingsEls.overwrite.checked,
    keepIfLarger: settingsEls.keepIfLarger.checked,
  };
}

function saveSettings() {
  try {
    const s = readSettings();
    s.output = settingsEls.output.value;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch (_) { /* 忽略存储失败 */ }
}

function restoreSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (_) {}
  if (s.format) {
    const el = document.querySelector(`input[name="format"][value="${s.format}"]`);
    if (el) el.checked = true;
  }
  if (s.webpQuality) settingsEls.quality.value = s.webpQuality;
  if (s.webpEffort !== undefined && s.webpEffort !== null) settingsEls.effort.value = s.webpEffort;
  if (typeof s.webpLossless === 'boolean') settingsEls.lossless.checked = s.webpLossless;
  if (s.maxWidth) settingsEls.maxWidth.value = s.maxWidth;
  if (s.maxHeight) settingsEls.maxHeight.value = s.maxHeight;
  if (typeof s.pngPalette === 'boolean') settingsEls.pngPalette.checked = s.pngPalette;
  if (typeof s.copyOthers === 'boolean') settingsEls.copyOthers.checked = s.copyOthers;
  if (typeof s.overwrite === 'boolean') settingsEls.overwrite.checked = s.overwrite;
  if (typeof s.keepIfLarger === 'boolean') settingsEls.keepIfLarger.checked = s.keepIfLarger;
  if (typeof s.output === 'string') settingsEls.output.value = s.output;
  syncSettingLabels();
}

function syncSettingLabels() {
  $('qualityValue').textContent = settingsEls.quality.value;
  $('effortValue').textContent = settingsEls.effort.value;
}

// ---------- 输入管理 ----------
function addInputs(paths) {
  for (const p of paths) {
    if (!p) continue;
    // Windows 路径不区分大小写，避免同一路径重复添加
    const dup = state.inputs.some((q) => q.toLowerCase() === p.toLowerCase());
    if (!dup) state.inputs.push(p);
  }
  renderInputs();
}

function renderInputs() {
  const list = $('inputList');
  const btnClear = $('btnClearInputs');
  if (state.inputs.length === 0) {
    list.hidden = true;
    list.innerHTML = '';
    btnClear.hidden = true;
    $('btnStart').disabled = state.running;
    return;
  }
  list.hidden = false;
  btnClear.hidden = false;
  list.innerHTML = '';
  state.inputs.forEach((p, i) => {
    const isDir = !IMG_EXT_RE.test(p);
    const li = document.createElement('li');
    li.className = 'input-item';

    const icon = document.createElement('span');
    icon.className = 'ii-icon';
    icon.textContent = isDir ? '📁' : '🖼';

    const name = document.createElement('span');
    name.className = 'ii-name';
    name.textContent = p;
    name.title = p;

    const rm = document.createElement('button');
    rm.className = 'ii-remove';
    rm.textContent = '✕';
    rm.title = '移除';
    rm.onclick = () => {
      state.inputs.splice(i, 1);
      renderInputs();
    };

    li.append(icon, name, rm);
    list.appendChild(li);
  });
  $('btnStart').disabled = state.running;
}

// 默认输出位置：<第一个输入的父目录>\compressed
function defaultOutput() {
  const first = state.inputs[0];
  let base = first.replace(/[\\/]+$/, '');
  if (IMG_EXT_RE.test(first)) {
    base = first.replace(/\\/g, '/');
    const i = base.lastIndexOf('/');
    base = (i > 0 ? base.slice(0, i) : base).replace(/\//g, '\\');
  }
  return base + '\\compressed';
}

// ---------- 进度 UI ----------
function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function resetProgress() {
  closePreview();
  state.counts = { done: 0, kept: 0, copied: 0, skipped: 0, error: 0 };
  state.sizeBefore = 0;
  state.sizeAfter = 0;
  state.fileEvents = 0;
  $('log').innerHTML = '';
  $('logEmpty').hidden = false;
  const bar = $('barFill');
  bar.style.width = '0%';
  bar.classList.remove('error');
  $('progressText').textContent = '等待开始';
  $('progressPct').textContent = '';
  $('chipDone').textContent = '0';
  $('chipCopied').textContent = '0';
  $('chipSkipped').textContent = '0';
  $('chipFailed').textContent = '0';
  $('chipSize').hidden = true;
  $('chipSize').textContent = '';
  $('btnOpenOut').hidden = true;
}

const STATUS_META = {
  done: { icon: '✓', cls: 'st-done' },
  kept: { icon: '＝', cls: 'st-kept' },
  copied: { icon: '⧉', cls: 'st-copied' },
  skipped: { icon: '↷', cls: 'st-skipped' },
  error: { icon: '✕', cls: 'st-error' },
  busy: { icon: '↻', cls: 'st-busy' },
};

function handleFileEvent(ev) {
  const pct = Math.round((ev.index / ev.total) * 100);
  $('barFill').style.width = pct + '%';
  $('progressPct').textContent = pct + '%';
  $('progressText').textContent = `正在处理 ${ev.index} / ${ev.total}`;
  $('logEmpty').hidden = true;

  const c = state.counts;
  switch (ev.status) {
    case 'done': c.done++; state.sizeBefore += ev.before; state.sizeAfter += ev.after; break;
    case 'kept': c.kept++; state.sizeBefore += ev.before; state.sizeAfter += ev.after; break;
    case 'copied': c.copied++; break;
    case 'skipped': c.skipped++; break;
    case 'error': c.error++; break;
    default: break; // busy（重试中）不计入任何计数
  }
  $('chipDone').textContent = c.done + c.kept;
  $('chipCopied').textContent = c.copied;
  $('chipSkipped').textContent = c.skipped;
  $('chipFailed').textContent = c.error;

  if (state.sizeBefore > 0) {
    const chip = $('chipSize');
    chip.hidden = false;
    chip.textContent = state.sizeAfter < state.sizeBefore
      ? `${fmtSize(state.sizeBefore)} → ${fmtSize(state.sizeAfter)}（节省 ${((1 - state.sizeAfter / state.sizeBefore) * 100).toFixed(1)}%）`
      : `${fmtSize(state.sizeBefore)} → ${fmtSize(state.sizeAfter)}（变大 ${((state.sizeAfter / state.sizeBefore - 1) * 100).toFixed(1)}%）`;
  }

  addLogRow(ev);
}

// 同一文件（相同 src）的事件会先创建日志行、后续事件原地更新
// （"等待释放 (n/30)…" → 最终结果），避免同一文件出现多行
function findLogRow(src) {
  if (!src) return null;
  const rows = document.querySelectorAll('#log li[data-src]');
  for (const li of rows) if (li.dataset.src === src) return li;
  return null;
}

function buildDetailText(ev) {
  if (ev.status === 'busy') return ev.detail || '文件被占用，等待释放…';
  if (ev.status === 'done' && ev.before !== undefined) {
    const pct = ev.after < ev.before
      ? `节省 ${((1 - ev.after / ev.before) * 100).toFixed(1)}%`
      : `变大 ${((ev.after / ev.before - 1) * 100).toFixed(1)}%`;
    return `→ ${ev.ext} · ${fmtSize(ev.before)} → ${fmtSize(ev.after)}（${pct}）` +
      (ev.note ? ` · ${ev.note}` : '');
  }
  if (ev.status === 'kept' && ev.before !== undefined) return `压缩后更大，保留原图 · ${fmtSize(ev.before)}`;
  if (ev.status === 'copied' && ev.before !== undefined) return `原样复制 · ${fmtSize(ev.before)}`;
  if (ev.status === 'skipped') return ev.reason === '已存在' ? '已存在（未覆盖）' : '输入输出相同';
  if (ev.status === 'error') return ev.error || '未知错误';
  return ev.status;
}

function addLogRow(ev) {
  const ul = $('log');
  let li = findLogRow(ev.src);
  let icon, label, detail;
  if (li) {
    li.className = 'log-item ' + ev.status;
    if (ev.before != null) li.dataset.before = ev.before;
    if (ev.after != null) li.dataset.after = ev.after;
    icon = li.querySelector('.li-icon');
    detail = li.querySelector('.li-detail');
  } else {
    li = document.createElement('li');
    li.className = 'log-item ' + ev.status;
    // 记录文件路径，供点击打开对比预览
    if (ev.src) li.dataset.src = ev.src;
    if (ev.dest) li.dataset.dest = ev.dest;
    if (ev.before != null) li.dataset.before = ev.before;
    if (ev.after != null) li.dataset.after = ev.after;

    icon = document.createElement('span');
    label = document.createElement('span');
    label.className = 'li-label';
    label.textContent = ev.label;
    label.title = ev.label;
    detail = document.createElement('span');
    detail.className = 'li-detail';
    li.append(icon, label, detail);
    if (ev.src) {
      li.title = '点击预览原图 / 压缩后对比';
      li.addEventListener('click', () => openPreview(li));
    }
    ul.appendChild(li);
  }

  const meta = STATUS_META[ev.status] || STATUS_META.error;
  icon.className = 'li-icon ' + meta.cls;
  icon.textContent = meta.icon;
  const detailText = buildDetailText(ev);
  detail.textContent = detailText;
  detail.title = detailText;
  ul.scrollTop = ul.scrollHeight;
}

// ---------- 对比预览（支持缩放/平移，左右两图联动） ----------
let previewToken = 0; // 异步加载守卫：切换条目后丢弃旧结果
let previewActiveLi = null;
// 视图状态（左右共享，保证同一物理区域在两个窗格中位置一致）：
// S0 基础比例（fit=适应窗口 / one2one=1:1），t 平移（屏幕像素），z 缩放倍数
let pv = null;

const paneEls = {
  Orig: { box: $('paneOrig'), zoom: $('zoomOrig'), img: $('imgOrig'), empty: $('emptyOrig'), info: $('infoOrig') },
  Comp: { box: $('paneComp'), zoom: $('zoomComp'), img: $('imgComp'), empty: $('emptyComp'), info: $('infoComp') },
};

function previewItems() {
  return [...document.querySelectorAll('#log li[data-src]')];
}

function openPreview(li) {
  previewActiveLi = li;
  const token = ++previewToken;
  previewItems().forEach((el) => el.classList.toggle('active', el === li));

  $('previewCard').hidden = false;
  pv = null;
  setToolsEnabled(false);
  const labelEl = li.querySelector('.li-label');
  $('previewName').textContent = labelEl ? labelEl.textContent : '';
  $('previewName').title = labelEl ? labelEl.title : '';

  // 体积对比
  const b = Number(li.dataset.before);
  const a = Number(li.dataset.after);
  if (b > 0 && a > 0) {
    if (a < b) {
      $('previewSize').innerHTML =
        `${fmtSize(b)} → ${fmtSize(a)}（<b>节省 ${((1 - a / b) * 100).toFixed(1)}%</b>）`;
    } else if (a > b) {
      $('previewSize').textContent = `${fmtSize(b)} → ${fmtSize(a)}（变大 ${((a / b - 1) * 100).toFixed(1)}%）`;
    } else {
      $('previewSize').textContent = `${fmtSize(b)}（大小不变）`;
    }
  } else {
    $('previewSize').textContent = '';
  }

  const dest = li.dataset.dest;
  setPane('Orig', null, '加载中…');
  setPane('Comp', null, dest ? '加载中…' : '无输出文件');
  $('previewCard').scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  Promise.all([
    window.api.getPreview(li.dataset.src),
    dest ? window.api.getPreview(dest) : Promise.resolve({ error: '无输出文件' }),
  ]).then(([origRes, compRes]) => {
    if (token !== previewToken) return; // 已切换到其它条目
    setPane('Orig', origRes);
    setPane('Comp', compRes);
    setupView(origRes, compRes);
  });
}

function setPane(side, res, placeholder) {
  const el = paneEls[side];
  if (res == null) {
    el.img.removeAttribute('src');
    el.zoom.style.display = 'none';
    el.empty.textContent = placeholder || '';
    el.info.textContent = '';
    return;
  }
  el.empty.textContent = '';
  if (res.error) {
    el.img.removeAttribute('src');
    el.zoom.style.display = 'none';
    el.empty.textContent = res.error;
    el.info.textContent = '';
    return;
  }
  el.img.src = res.dataUrl;
  el.zoom.style.display = '';
  const dims = res.width && res.height ? `${res.width} × ${res.height} px · ` : '';
  el.info.textContent = dims + fmtSize(res.size);
}

// 两张图按同一基础比例渲染、左上角对齐，缩放/平移状态共享 ——
// 这样即使压缩后尺寸更小，同一物理位置在两个窗格中也严格对齐
function setupView(origRes, compRes) {
  const dim = (r) => (r && !r.error && r.width && r.height ? { w: r.width, h: r.height } : null);
  const d1 = dim(origRes);
  const d2 = dim(compRes);
  if (!d1 && !d2) {
    pv = null;
    setToolsEnabled(false);
    return;
  }
  pv = {
    d1, d2,
    wRef: Math.max(d1 ? d1.w : 0, d2 ? d2.w : 0),
    hRef: Math.max(d1 ? d1.h : 0, d2 ? d2.h : 0),
    mode: 'fit', S0: 1, t: { x: 0, y: 0 }, z: 1,
  };
  setToolsEnabled(true);
  layoutView();
}

function layoutView() {
  if (!pv) return;
  const rect = paneEls.Orig.box.getBoundingClientRect();
  const pw = Math.max(rect.width, 1), ph = Math.max(rect.height, 1);
  pv.S0 = pv.mode === 'one2one' ? 1 : Math.min(pw / pv.wRef, ph / pv.hRef);
  for (const side of ['Orig', 'Comp']) {
    const d = side === 'Orig' ? pv.d1 : pv.d2;
    const el = paneEls[side].zoom;
    if (!d) {
      el.style.display = 'none';
      continue;
    }
    el.style.width = d.w * pv.S0 + 'px';
    el.style.height = d.h * pv.S0 + 'px';
    // 两个窗格都用参考（较大）尺寸定位 → 左上角对齐
    el.style.marginLeft = (-pv.wRef * pv.S0 / 2) + 'px';
    el.style.marginTop = (-pv.hRef * pv.S0 / 2) + 'px';
  }
  pv.t = { x: 0, y: 0 };
  pv.z = 1;
  applyView();
}

function applyView() {
  if (!pv) return;
  const tf = `translate(${pv.t.x}px, ${pv.t.y}px) scale(${pv.z})`;
  paneEls.Orig.zoom.style.transform = tf;
  paneEls.Comp.zoom.style.transform = tf;
  $('zoomVal').textContent = Math.round(pv.z * 100) + '%';
}

// 以 c（相对所在窗格中心的偏移）为不动点缩放
function zoomAt(c, factor) {
  if (!pv) return;
  const z2 = Math.min(64, Math.max(0.05, pv.z * factor));
  if (z2 === pv.z) return;
  const baseX = -pv.wRef * pv.S0 / 2;
  const baseY = -pv.hRef * pv.S0 / 2;
  const q = {
    x: (c.x - baseX - pv.t.x) / pv.z,
    y: (c.y - baseY - pv.t.y) / pv.z,
  };
  pv.t = { x: c.x - baseX - z2 * q.x, y: c.y - baseY - z2 * q.y };
  pv.z = z2;
  applyView();
}

function setToolsEnabled(on) {
  ['btnZoomIn', 'btnZoomOut', 'btnZoom1to1', 'btnZoomReset'].forEach((id) => {
    $(id).disabled = !on;
  });
  $('btnZoom1to1').classList.toggle('active', !!pv && pv.mode === 'one2one');
}

// 滚轮缩放（阻止页面滚动）
for (const side of ['Orig', 'Comp']) {
  const box = paneEls[side].box;
  box.addEventListener('wheel', (e) => {
    if (!pv) return;
    e.preventDefault();
    const r = box.getBoundingClientRect();
    zoomAt(
      { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) },
      e.deltaY < 0 ? 1.2 : 1 / 1.2
    );
  }, { passive: false });
}

// 按住拖动平移（左右同时移动）
let drag = null;
for (const side of ['Orig', 'Comp']) {
  paneEls[side].box.addEventListener('mousedown', (e) => {
    if (!pv || e.button !== 0) return;
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY, tx: pv.t.x, ty: pv.t.y };
    paneEls.Orig.box.classList.add('dragging');
    paneEls.Comp.box.classList.add('dragging');
  });
}
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  pv.t = { x: drag.tx + (e.clientX - drag.x), y: drag.ty + (e.clientY - drag.y) };
  applyView();
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  drag = null;
  paneEls.Orig.box.classList.remove('dragging');
  paneEls.Comp.box.classList.remove('dragging');
});

// 工具条
$('btnZoomIn').addEventListener('click', () => zoomAt({ x: 0, y: 0 }, 1.25));
$('btnZoomOut').addEventListener('click', () => zoomAt({ x: 0, y: 0 }, 0.8));
$('btnZoomReset').addEventListener('click', () => {
  if (!pv) return;
  pv.mode = 'fit';
  layoutView();
  setToolsEnabled(true);
});
$('btnZoom1to1').addEventListener('click', () => {
  if (!pv) return;
  pv.mode = pv.mode === 'one2one' ? 'fit' : 'one2one';
  layoutView();
  setToolsEnabled(true);
});
window.addEventListener('resize', () => {
  if (pv) layoutView();
});

function stepPreview(dir) {
  const items = previewItems();
  if (items.length === 0) return;
  let i = items.indexOf(previewActiveLi) + dir;
  if (i < 0) i = items.length - 1;
  if (i >= items.length) i = 0;
  openPreview(items[i]);
}

function closePreview() {
  previewToken++;
  previewActiveLi = null;
  pv = null;
  setToolsEnabled(false);
  $('previewCard').hidden = true;
  document.querySelectorAll('#log li.active').forEach((el) => el.classList.remove('active'));
}

$('btnPrev').addEventListener('click', () => stepPreview(-1));
$('btnNext').addEventListener('click', () => stepPreview(1));
$('btnClosePreview').addEventListener('click', closePreview);

// ---------- 运行控制 ----------
function setRunning(on) {
  state.running = on;
  $('btnStart').disabled = on || state.inputs.length === 0;
  $('btnCancel').hidden = !on;
  document.querySelectorAll('.settings-lock').forEach((el) => {
    el.disabled = on;
  });
  if (on) $('btnStart').disabled = true;
}

function cleanErrMsg(e) {
  let m = (e && e.message) || String(e);
  m = m.replace(/^Error invoking remote method '[^']+':\s*(error|Error):\s*/, '');
  return m;
}

let toastTimer = null;
function showToast(msg, isError = true) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 4500);
}

function finishRun(summary, errMsg) {
  const bar = $('barFill');
  if (errMsg) {
    $('progressText').textContent = '出错';
    bar.classList.add('error');
    showToast(errMsg);
    return;
  }
  bar.classList.remove('error');
  const s = summary;
  if (s.cancelled) {
    $('progressText').textContent = '已取消';
  } else if (s.total === 0) {
    $('progressText').textContent = '没有找到图片文件';
    showToast('没有找到可处理的图片', false);
  } else {
    $('progressText').textContent =
      `完成：处理 ${s.processed}，复制 ${s.copied}，跳过 ${s.skipped}` +
      (s.failed ? `，失败 ${s.failed}` : '');
  }
  // 用主进程的最终统计校准计数胶囊，保证和实际结果一致
  if (s.total > 0) {
    $('chipDone').textContent = s.processed;
    $('chipCopied').textContent = s.copied;
    $('chipSkipped').textContent = s.skipped;
    $('chipFailed').textContent = s.failed;
  }
  // 完成后自动打开最后一个条目的对比预览
  if (!s.cancelled && s.total > 0) {
    const items = previewItems();
    if (items.length) openPreview(items[items.length - 1]);
  }
  console.log('[ui] run finished:', JSON.stringify({
    total: s.total, processed: s.processed, copied: s.copied,
    skipped: s.skipped, failed: s.failed, cancelled: s.cancelled,
    fileEventsReceived: state.fileEvents, logRows: $('log').children.length,
  }));
  bar.style.width = '100%';
  if (s.output) {
    state.outDir = s.output;
    $('btnOpenOut').hidden = false;
  }
}

// ---------- 事件绑定 ----------
$('btnStart').addEventListener('click', async () => {
  if (state.running || state.inputs.length === 0) return;
  const output = settingsEls.output.value.trim() || defaultOutput();
  settingsEls.output.value = output; // 回填，方便下次复用
  saveSettings();

  const cfg = readSettings();
  cfg.input = state.inputs.slice();
  cfg.output = output;

  resetProgress();
  setRunning(true);
  $('progressText').textContent = '正在扫描文件…';

  const done = window.api.startCompression(cfg);
  // 注意：不能用 invoke 的返回值收尾 —— 它可能先于最后的进度事件到达，
  // 提前结束会丢弃后续事件（导致计数完整、日志却缺条目）。
  // 正常流程由 'done' 事件收尾（见下方 onEvent）；这里只负责兜底和报错。
  done.then((summary) => {
    if (!state.running) return; // 已由 'done' 事件正常收尾
    // 兜底：'done' 事件理论上一定会到，万一丢失则延迟用返回值收尾
    setTimeout(() => {
      if (state.running) {
        finishRun(summary);
        setRunning(false);
      }
    }, 1000);
  }).catch((err) => {
    // 参数错误/输入不存在等：core 直接抛错，不会有 'done' 事件
    if (state.running) {
      finishRun(null, cleanErrMsg(err));
      setRunning(false);
    }
  });
});

$('btnCancel').addEventListener('click', () => window.api.cancelCompression());

$('btnOpenOut').addEventListener('click', async () => {
  if (!state.outDir) return;
  const err = await window.api.openFolder(state.outDir);
  if (err) showToast(`无法打开文件夹：${err}`);
});

$('btnAddFiles').addEventListener('click', async () => {
  const r = await window.api.pickFiles();
  if (r) addInputs(r);
});

$('btnAddFolder').addEventListener('click', async () => {
  const r = await window.api.pickFolder();
  if (r) addInputs([r]);
});

$('btnClearInputs').addEventListener('click', () => {
  state.inputs = [];
  renderInputs();
});

$('btnPickOutput').addEventListener('click', async () => {
  const r = await window.api.pickFolder();
  if (r) {
    settingsEls.output.value = r;
    saveSettings();
  }
});

// 拖拽
const dz = $('dropzone');
let dragDepth = 0;
dz.addEventListener('click', () => {
  if (!state.running) $('btnAddFolder').click();
});
dz.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dz.classList.add('drag');
});
dz.addEventListener('dragover', (e) => e.preventDefault());
dz.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dz.classList.remove('drag');
});
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dz.classList.remove('drag');
  if (state.running) return;
  const paths = [...e.dataTransfer.files]
    .map((f) => window.api.getPathForFile(f))
    .filter(Boolean);
  if (paths.length) addInputs(paths);
});

// 设置变更
[settingsEls.quality, settingsEls.effort].forEach((el) =>
  el.addEventListener('input', () => { syncSettingLabels(); saveSettings(); })
);
['lossless', 'pngPalette', 'copyOthers', 'overwrite', 'keepIfLarger'].forEach((k) =>
  settingsEls[k].addEventListener('change', saveSettings)
);
settingsEls.output.addEventListener('change', saveSettings);
settingsEls.maxWidth.addEventListener('change', saveSettings);
settingsEls.maxHeight.addEventListener('change', saveSettings);
document.querySelectorAll('input[name="format"]').forEach((el) =>
  el.addEventListener('change', saveSettings)
);

// 进度事件
window.api.onEvent((ev) => {
  if (!state.running) {
    console.warn('[ui] event dropped (not running):', ev.type, ev.label || '');
    return;
  }
  if (ev.type === 'file') {
    state.fileEvents++;
    handleFileEvent(ev);
  } else if (ev.type === 'file-retry') {
    // 文件被占用、等待释放：进度条不动，日志行原地刷新重试次数
    $('progressText').textContent =
      `正在处理 ${ev.index} / ${ev.total}（文件被占用，等待释放…）`;
    addLogRow(ev);
  } else if (ev.type === 'done') {
    // 用 'done' 事件收尾：它一定在最后一个文件事件之后到达，
    // 而 invoke 的返回值不保证，拿它收尾会丢日志
    finishRun(ev.summary);
    setRunning(false);
  }
});

// 初始化
restoreSettings();
renderInputs();
