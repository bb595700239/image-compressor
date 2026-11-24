'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const fg = require('fast-glob');

// ---------- 默认配置 ----------
const DEFAULT_CONFIG = {
  input: './平面图',
  output: './compressed',
  format: 'webp',      // 'webp' | 'png' | 'jpg' | 'original'
  webpQuality: 80,
  webpEffort: 4,
  webpLossless: false,
  pngQuality: 80,
  pngCompressionLevel: 9,
  pngPalette: false,     // true: PNG 量化为调色板(体积小很多，quality 才生效，有损)
  jpgQuality: 80,
  overwrite: false,
  keepIfLarger: false,   // true: 压缩结果 >= 原图且扩展名一致时保留原图（还原）；false: 直接存压缩结果（即使变大）
  copyOthers: true,      // 输入文件夹中的其它图片格式(webp/gif/svg 等)是否处理
  maxWidth: 0,           // 图片最大宽度（像素），0 = 不限制（保持原始宽度）
  maxHeight: 0,          // 图片最大高度（像素），0 = 不限制（保持原始高度）
  debug: false,
};

// 需要压缩的格式（png/jpg/jpeg/webp）
const IMG_RE = /\.(png|jpe?g|webp)$/i;
// 其它格式中，设置了最大宽度/高度时可以缩放并按原格式重编码的
// （webp 属于 IMG_RE 压缩目标，不会走到这里；bmp 此版本 sharp 无编码器，归入下方复制）
const REENCODE_RE = /\.(avif|tiff?|heic?)$/i;
// 无法/不应重编码的（动图/矢量/图标/bmp），始终原样复制
const COPY_RE = /\.(gif|svg|ico|bmp)$/i;

class CoreError extends Error {}

function normalizeConfig(userConfig) {
  const config = { ...DEFAULT_CONFIG, ...(userConfig || {}) };
  if (!['webp', 'png', 'jpg', 'original'].includes(config.format)) {
    throw new CoreError(`不支持的格式: ${config.format}`);
  }
  if (!(config.webpQuality >= 1 && config.webpQuality <= 100)) {
    throw new CoreError('quality 需在 1-100 之间');
  }
  if (!(config.webpEffort >= 0 && config.webpEffort <= 6)) {
    throw new CoreError('effort 需在 0-6 之间');
  }
  if (config.maxWidth != null && config.maxWidth !== 0 && !(config.maxWidth >= 1)) {
    throw new CoreError('max-width 需为正整数（0 表示不限制）');
  }
  if (config.maxHeight != null && config.maxHeight !== 0 && !(config.maxHeight >= 1)) {
    throw new CoreError('max-height 需为正整数（0 表示不限制）');
  }
  return config;
}

// WebP 规格单边硬上限：任一边超过 16383px 时编码会失败
// （报 "Processed image is too large for the WebP format"），见 compressOne 的自动兜底
const WEBP_MAX_DIM = 16383;

// 根据输出文件扩展名决定编码器
// info: 可选出参对象；WebP 上限触发自动缩小时记入 info.autoResized = { width, height }（原始尺寸）
async function compressOne(inputFile, outputFile, config, info) {
  const outExt = path.extname(outputFile).toLowerCase();
  // 先把文件读进内存再交给 sharp：直接传路径时 libvips 会持有该文件的句柄
  // 直到 JS 垃圾回收，期间覆盖/删除/重读该文件都可能失败（Windows 报"文件被占用"）
  const data = fs.readFileSync(inputFile);
  let image = sharp(data);
  if (info) {
    info.beforeSize = data.length; // 原始大小（事件 before / 原地 kept 比对用）
    // 原地（输入输出同一文件）且启用"变大保留原图"：保留原始字节，供写后还原
    if (config.keepIfLarger && path.resolve(inputFile) === path.resolve(outputFile)) info.originalData = data;
  }

  // 缩放决策（maxWidth / maxHeight 均为"上限"，0 = 不限制）：
  // 1) WebP 输出且任一边 > 16383：必须缩进 16383 方框（格式硬上限）；
  //    若同时设置了 maxWidth / maxHeight 取两者较小值；不放大
  // 2) 只设其一：按该边等比缩小，未超出的图不放大
  // 3) 两者都设：等比缩进 width x height 方框，取能同时满足两者的最大尺寸
  let resize = null;
  if (outExt === '.webp') {
    const meta = await sharp(data).metadata();
    const w = meta.width || 0, h = meta.height || 0;
    if (w > WEBP_MAX_DIM || h > WEBP_MAX_DIM) {
      const rw = config.maxWidth > 0 ? Math.min(config.maxWidth, WEBP_MAX_DIM) : WEBP_MAX_DIM;
      const rh = config.maxHeight > 0 ? Math.min(config.maxHeight, WEBP_MAX_DIM) : WEBP_MAX_DIM;
      resize = { width: rw, height: rh, fit: 'inside', withoutEnlargement: true };
      if (info) info.autoResized = { width: w, height: h };
    }
  }
  if (!resize) {
    if (config.maxWidth > 0 && config.maxHeight > 0) {
      resize = { width: config.maxWidth, height: config.maxHeight, fit: 'inside', withoutEnlargement: true };
    } else if (config.maxWidth > 0) {
      resize = { width: config.maxWidth, withoutEnlargement: true };
    } else if (config.maxHeight > 0) {
      resize = { height: config.maxHeight, withoutEnlargement: true };
    }
  }
  if (resize) {
    image = image.resize(resize);
  }

  if (outExt === '.webp') {
    await image
      .webp({
        quality: config.webpQuality,
        effort: config.webpEffort,
        lossless: config.webpLossless,
      })
      .toFile(outputFile);
  } else if (outExt === '.png') {
    await image
      .png({
        quality: config.pngQuality,
        compressionLevel: config.pngCompressionLevel,
        palette: config.pngPalette,
        force: true,
      })
      .toFile(outputFile);
  } else if (outExt === '.jpg' || outExt === '.jpeg') {
    await image
      .jpeg({ quality: config.jpgQuality, force: true })
      .toFile(outputFile);
  } else if (outExt === '.avif') {
    await image
      .avif({ quality: config.webpQuality, effort: config.webpEffort })
      .toFile(outputFile);
  } else if (outExt === '.heic' || outExt === '.heif') {
    await image
      .heif({ quality: config.webpQuality })
      .toFile(outputFile);
  } else if (outExt === '.tif' || outExt === '.tiff') {
    await image.tiff().toFile(outputFile);
  } else {
    throw new CoreError(`不支持的输出扩展名: ${outExt}`);
  }
}

// ---------- 写入（含占用重试） ----------
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// "文件被占用"时的重试策略：
// Windows 上文件被别的进程以独占方式打开时，任何程序都无法强制覆盖
// （操作系统级限制，与权限无关）；但占用通常是短暂的——资源管理器缩略图/
// 预览、Windows 搜索索引、杀毒软件实时扫描、图片查看器等。
// 所以每秒重试一次、最多 30 次：占用一释放就自动写入成功并继续，
// 无需重新点「开始压缩」。
const BUSY_RETRY_MAX = 30;
const BUSY_RETRY_INTERVAL_MS = 1000;

// 判断是否为"文件被占用/无法写入"类错误：
// Windows 上覆盖正被其它程序打开的文件会失败（资源管理器预览窗格、
// 图片查看器、杀毒软件、缩略图缓存等），Node/sharp 报 EPERM/EACCES/
// UNKNOWN(copyfile) 或 "unable to open for write, windows error 32"
function isWriteBusyError(err) {
  if (!err) return false;
  const code = err.code;
  const msg = String(err.message || '');
  return (
    code === 'EPERM' ||
    code === 'EACCES' ||
    code === 'EBUSY' ||
    (code === 'UNKNOWN' && /copyfile/i.test(msg)) ||
    /unable to open for write/i.test(msg) ||
    /being used by another process/i.test(msg)
  );
}

// 复制 / 编码写入输出；遇到"文件被占用"时每秒重试一次（最多 BUSY_RETRY_MAX 次）
// onRetry(attempt, max)：每次重试前的回调（UI 显示"等待释放 (n/30)…"）
// isCancelled()：为 true 时停止等待提前结束
async function writeWithRetry(task, config, onRetry, isCancelled, info) {
  isCancelled = isCancelled || (() => false);
  let lastErr = null;
  for (let attempt = 0; attempt < BUSY_RETRY_MAX; attempt++) {
    try {
      if (task.copy) {
        fs.copyFileSync(task.src, task.dest);
      } else if (task.data) {
        fs.writeFileSync(task.dest, task.data); // 还原原始字节（原地"变大保留原图"）
      } else {
        await compressOne(task.src, task.dest, config, info);
      }
      return;
    } catch (err) {
      lastErr = err;
      if (!isWriteBusyError(err) || attempt === BUSY_RETRY_MAX - 1) break;
      if (onRetry) onRetry(attempt + 1, BUSY_RETRY_MAX);
      // 等待切成小段，让"取消"能及时生效
      const t0 = Date.now();
      while (Date.now() - t0 < BUSY_RETRY_INTERVAL_MS) {
        if (isCancelled()) break;
        await sleepMs(250);
      }
    }
  }
  if (isWriteBusyError(lastErr)) {
    throw new CoreError(
      `文件被占用，无法写入 ${path.basename(task.dest)}：` +
        '它正被其它程序独占打开（常见：资源管理器缩略图/预览窗格、Windows 搜索索引、' +
        '杀毒软件实时扫描、图片查看器），已等待 ' + BUSY_RETRY_MAX +
        ' 秒仍未释放——关掉对应程序（或先关掉 out 文件夹的 Explorer 窗口）后重新压缩即可'
    );
  }
  throw lastErr;
}

// 生成任务列表: [{ src, label, dest, copy? }]
// dest: 明确的输出文件路径；copy: true 表示原样复制，不处理
async function buildTasks(inputs, output, config) {
  const list = (Array.isArray(inputs) ? inputs : [inputs]).map((p) =>
    path.resolve(String(p))
  );
  if (list.length === 0) throw new CoreError('没有输入');

  const outPath = path.resolve(String(output));
  const hasOutExt = path.extname(outPath) !== '';
  const stripExt = (p) => p.replace(/\.[^./\\]+$/, '');
  // 固定输出格式的扩展名（original 模式为 null，保留源扩展名）
  const fixedExt =
    config.format === 'webp' ? '.webp'
    : config.format === 'png' ? '.png'
    : config.format === 'jpg' ? '.jpg'
    : null;

  const tasks = [];
  const seen = new Set();
  const push = (t) => {
    let key = path.resolve(t.src);
    if (process.platform === 'win32') key = key.toLowerCase(); // Windows 路径不区分大小写
    if (seen.has(key)) return;
    seen.add(key);
    tasks.push(t);
  };

  for (const input of list) {
    if (!fs.existsSync(input)) throw new CoreError(`输入路径不存在: ${input}`);

    if (fs.statSync(input).isFile()) {
      if (!IMG_RE.test(input)) {
        throw new CoreError(`输入文件不是 png/jpg/jpeg 图片: ${path.basename(input)}`);
      }
      const ext = fixedExt || path.extname(input);
      if (hasOutExt) {
        if (list.length === 1) {
          push({ src: input, dest: outPath, label: path.basename(input) });
        } else {
          throw new CoreError('输入多个文件时，输出必须是文件夹（不要带扩展名）');
        }
      } else {
        push({
          src: input,
          dest: path.join(outPath, stripExt(path.basename(input))) + ext,
          label: path.basename(input),
        });
      }
    } else {
      if (hasOutExt) {
        throw new CoreError('输入包含文件夹时，输出必须是文件夹（不要带扩展名）');
      }
      // 输出目录严格在输入目录内：排除输出目录下的文件（避免把上次的输出再压一遍）
      // 输出目录 = 输入目录：原地模式，逐文件压缩并直接覆盖，不排除
      const outStrictlyInside = outPath.startsWith(input + path.sep);
      const files = await fg('**/*', {
        cwd: input,
        caseSensitiveMatch: false,
        onlyFiles: true,
      });
      for (const rel of files) {
        const src = path.join(input, rel);
        if (outStrictlyInside && path.resolve(src).startsWith(outPath + path.sep)) continue;
        if (IMG_RE.test(rel)) {
          const ext = fixedExt || path.extname(rel);
          push({ src, dest: path.join(outPath, stripExt(rel)) + ext, label: rel });
        } else if (config.copyOthers) {
          if (REENCODE_RE.test(rel)) {
            if (config.maxWidth > 0 || config.maxHeight > 0) {
              // 设置了最大宽度/高度：缩放并按原格式重编码
              push({ src, dest: path.join(outPath, rel), label: rel, reencode: true });
            } else {
              // 未设置最大宽度/高度：原样复制
              push({ src, dest: path.join(outPath, rel), label: rel, copy: true });
            }
          } else if (COPY_RE.test(rel)) {
            // gif/svg/ico 等无法安全重编码：始终原样复制
            push({ src, dest: path.join(outPath, rel), label: rel, copy: true });
          }
        }
      }
    }
  }
  return tasks;
}

function emptySummary(output) {
  return {
    total: 0,
    processed: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
    cancelled: false,
    totalBefore: 0,
    totalAfter: 0,
    extCount: {},
    errors: [],
    output: output ? path.resolve(String(output)) : null,
  };
}

// ---------- 主入口 ----------
// userConfig: 字段见 DEFAULT_CONFIG；input 支持单个路径（文件/文件夹）或路径数组（多选）
// hooks.onEvent(event): 进度事件
//   { type: 'scan-done', total }
//   { type: 'file', label, index, total, status: done|kept|copied|skipped|error,
//     before?, after?, ext?, dest?, reason?, error?, note?（WebP 上限触发自动缩小） }
//   { type: 'file-retry', status: 'busy', label, index, total, src, dest, attempt, max, detail }
//   { type: 'done', summary }
// hooks.isCancelled(): 返回 true 时在处理下一个文件前停止
async function runCompression(userConfig, hooks = {}) {
  const { onEvent = () => {}, isCancelled = () => false } = hooks;
  const config = normalizeConfig(userConfig);
  const output = path.resolve(String(config.output));

  let tasks;
  try {
    tasks = await buildTasks(config.input, config.output, config);
  } catch (err) {
    if (err instanceof CoreError) throw err;
    throw new CoreError(err.message);
  }
  onEvent({ type: 'scan-done', total: tasks.length });

  if (tasks.length === 0) {
    const summary = emptySummary(output);
    onEvent({ type: 'done', summary });
    return summary;
  }

  let processed = 0, skipped = 0, failed = 0, copied = 0;
  let totalBefore = 0, totalAfter = 0;
  const extCount = {};
  const errors = [];
  const total = tasks.length;
  let index = 0;

  for (const task of tasks) {
    index++;
    if (isCancelled()) {
      const summary = {
        total, processed, copied, skipped, failed, cancelled: true,
        totalBefore, totalAfter, extCount, errors, output,
      };
      onEvent({ type: 'done', summary });
      return summary;
    }

    const { src, label, dest } = task;
    // 原地模式：输出文件就是输入文件本身（输出文件夹 = 输入文件夹），压缩后直接覆盖
    const inPlace = path.resolve(src) === path.resolve(dest);
    // 重试进度 → 渲染进程日志行实时更新
    const retryNotifier = (attempt, max) => {
      onEvent({
        type: 'file-retry', status: 'busy', label, index, total, src, dest,
        attempt, max,
        detail: `文件被占用，等待释放（${attempt}/${max}）…`,
      });
    };
    try {
      if (inPlace && task.copy) {
        // 原地模式下的复制任务：源和目标本来就是同一文件，无事可做
        skipped++;
        onEvent({ type: 'file', label, index, total, status: 'skipped', reason: '输入输出相同', src, dest });
        continue;
      }
      if (!inPlace && !config.overwrite && fs.existsSync(dest)) {
        skipped++;
        onEvent({ type: 'file', label, index, total, status: 'skipped', reason: '已存在', src, dest });
        continue;
      }

      fs.mkdirSync(path.dirname(dest), { recursive: true });

      // 其它格式且未设置最大宽度/高度：直接复制
      if (task.copy) {
        await writeWithRetry(task, config, retryNotifier, isCancelled);
        copied++;
        const before = fs.statSync(src).size;
        onEvent({ type: 'file', label, index, total, status: 'copied', before, after: before, src, dest });
        continue;
      }

      const info = {};
      await writeWithRetry(task, config, retryNotifier, isCancelled, info);

      // 压缩后反而变大：保留原文件（仅 keepIfLarger 开启时；同样走占用重试）
      let kept = false;
      if (config.keepIfLarger) {
        if (inPlace) {
          // 原地覆盖：原文件已被压缩结果覆写，用写前留存的原始字节还原
          // （原始大小在 compressOne 读入时记入 info.beforeSize）
          if (fs.statSync(dest).size >= info.beforeSize) {
            await writeWithRetry({ src, dest, data: info.originalData }, config, retryNotifier, isCancelled);
            kept = true;
          }
        } else if (
          fs.statSync(dest).size >= fs.statSync(src).size &&
          path.extname(dest).toLowerCase() === path.extname(src).toLowerCase()
        ) {
          await writeWithRetry({ src, dest, copy: true }, config, retryNotifier, isCancelled);
          kept = true;
        }
      }

      const before = inPlace ? info.beforeSize : fs.statSync(src).size;
      const after = fs.statSync(dest).size;
      totalBefore += before;
      totalAfter += after;
      processed++;
      const outExt = path.extname(dest).toLowerCase();
      extCount[outExt] = (extCount[outExt] || 0) + 1;

      const fileEv = {
        type: 'file', label, index, total,
        status: kept ? 'kept' : 'done', before, after, ext: outExt, src, dest,
      };
      // kept（保留原文件）时输出的是原图，不提示自动缩小
      if (!kept && info.autoResized) {
        fileEv.note = `自动缩小 ${info.autoResized.width}x${info.autoResized.height}（WebP 单边上限 16383）`;
      }
      onEvent(fileEv);
    } catch (err) {
      failed++;
      errors.push({ label, error: err.message });
      onEvent({ type: 'file', label, index, total, status: 'error', error: err.message, src, dest });
    }
  }

  const summary = {
    total, processed, copied, skipped, failed, cancelled: false,
    totalBefore, totalAfter, extCount, errors, output,
  };
  onEvent({ type: 'done', summary });
  return summary;
}

module.exports = {
  runCompression,
  buildTasks,
  normalizeConfig,
  DEFAULT_CONFIG,
  CoreError,
};
