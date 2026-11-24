'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { runCompression } = require('./compress-core');

// ---------- CLI 模式 ----------
// 打包后的 exe 可被命令行 / 脚本 / AI 调用：
//   图片压缩器.exe --cli --input "D:\img" --output "D:\out" [选项]
// CLI 模式不创建窗口、不参与单实例锁；stdout 输出 NDJSON（每行一个 JSON），
// 最后一行为 {"type":"done","summary":{...}}；错误信息走 stderr。
// 退出码：0 = 全部成功；1 = 完成但有文件失败；2 = 无法运行（参数/输入错误）。
const CLI_HELP = `图片压缩器 CLI（供脚本 / AI 调用，--cli 必须为第一个参数）

用法:
  图片压缩器.exe --cli --input <文件/文件夹> [选项]
  图片压缩器.exe --help     显示本帮助
  图片压缩器.exe --version  显示版本号
注意:
  portable 版（图片压缩器-x.x.x-x64.exe）外层是解压外壳，不转发命令行参数；
  CLI 请调用应用本体：win-unpacked\\图片压缩器.exe，或 NSIS 安装后的 exe。

选项:
  --input, -i <路径>     输入文件或文件夹，可重复指定多个（至少一个）
  --output, -o <路径>    输出文件夹。默认：文件夹输入为 <输入>\\compressed，
                         文件输入为 <文件所在目录>\\compressed；
                         与输入相同 = 原地压缩（同格式文件直接覆盖）
  --format, -f <格式>    webp(默认) | png | jpg | original(保持原格式)
  --quality, -q <1-100>  压缩质量，默认 80（同时作用于 webp / png / jpg）
  --effort <0-6>         WebP 压缩力度，默认 4
  --lossless             WebP 无损
  --max-width <像素>     最大宽度，默认 0 = 不限制
  --max-height <像素>    最大高度，默认 0 = 不限制
  --png-palette          PNG 调色板量化（更小，有损）
  --no-copy-others       不处理其它格式图片（webp / gif / svg 等，默认处理）
  --overwrite            覆盖已存在的输出文件
  --keep-if-larger       压缩结果 >= 原图且格式相同时保留原图（默认直接保存压缩结果）

输出（stdout，NDJSON，每行一个 JSON）:
  {"type":"scan-done","total":N}
  {"type":"file","label":"a.png","index":1,"total":N,
   "status":"done|kept|copied|skipped|error","before":123,"after":45,...}
  {"type":"file-retry",...}   文件被占用等待释放时
  {"type":"done","summary":{"total":N,"processed":N,"copied":N,"skipped":N,
   "failed":N,"totalBefore":N,"totalAfter":N,"errors":[],"output":"..."}}
错误信息输出到 stderr。

退出码:
  0 = 全部成功
  1 = 完成但有文件失败（详情见 summary.errors）
  2 = 无法运行（参数错误 / 输入不存在）

示例:
  图片压缩器.exe --cli -i "D:\\img" -o "D:\\out" -f webp -q 80
  图片压缩器.exe --cli -i "D:\\img" -o "D:\\img" --max-width 1920
`;

// argv：打包后 argv[0] = exe 路径；开发模式（electron .）argv[1] = 应用路径
const rawArgs = process.argv.slice(app.isPackaged ? 1 : 2);
if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(CLI_HELP);
  process.exit(0);
}
if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
  console.log(app.getVersion());
  process.exit(0);
}

function runCli(argv) {
  app.disableHardwareAcceleration(); // 无头模式：不建窗口，无需 GPU

  const fail = (msg) => {
    console.error(`[cli] ${msg}`);
    process.exit(2);
  };
  const numOpt = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) fail(`选项 ${name} 需要数字，收到: "${v}"`);
    return n;
  };

  const opts = {
    inputs: [], output: '',
    format: 'webp', quality: 80, effort: 4,
    maxWidth: 0, maxHeight: 0,
    lossless: false, pngPalette: false,
    copyOthers: true, overwrite: false, keepIfLarger: false,
  };
  const VAL_OPTS = {
    '--input': 'inputs', '-i': 'inputs',
    '--output': 'output', '-o': 'output',
    '--format': 'format', '-f': 'format',
    '--quality': 'quality', '-q': 'quality',
    '--effort': 'effort',
    '--max-width': 'maxWidth',
    '--max-height': 'maxHeight',
  };
  const FLAG_OPTS = {
    '--lossless': 'lossless',
    '--png-palette': 'pngPalette',
    '--overwrite': 'overwrite',
    '--keep-if-larger': 'keepIfLarger',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const k = VAL_OPTS[a];
    if (k !== undefined) {
      if (i + 1 >= argv.length) fail(`选项 ${a} 缺少参数值`);
      const v = argv[++i];
      if (k === 'inputs') opts.inputs.push(v);
      else if (k === 'output' || k === 'format') opts[k] = v;
      else opts[k] = numOpt(v, a); // quality / effort / max-width / max-height
    } else if (FLAG_OPTS[a] !== undefined) {
      opts[FLAG_OPTS[a]] = true;
    } else if (a === '--no-copy-others') {
      opts.copyOthers = false;
    } else {
      fail(`未知选项: ${a}（用 --help 查看用法）`);
    }
  }

  if (opts.inputs.length === 0) {
    fail('缺少 --input（输入文件或文件夹，可重复指定多个）');
  }

  // 默认输出与 GUI 一致：文件夹输入 → <输入>\compressed；文件输入 → <文件所在目录>\compressed
  let base = opts.inputs[0].replace(/[\\/]+$/, '');
  if (/\.(png|jpe?g)$/i.test(base)) base = path.dirname(base);
  const config = {
    input: opts.inputs,
    output: opts.output || path.join(base, 'compressed'),
    format: opts.format,
    webpQuality: opts.quality,
    pngQuality: opts.quality,
    jpgQuality: opts.quality,
    webpEffort: opts.effort,
    webpLossless: opts.lossless,
    pngCompressionLevel: 9,
    pngPalette: opts.pngPalette,
    copyOthers: opts.copyOthers,
    overwrite: opts.overwrite,
    keepIfLarger: opts.keepIfLarger,
    maxWidth: opts.maxWidth,
    maxHeight: opts.maxHeight,
  };

  // stdout 被管道捕获时（AI / 脚本）写入是异步的，退出前必须等刷完，否则丢最后一行
  const flushStdout = () => new Promise((resolve) => process.stdout.write('', () => resolve()));

  app.whenReady().then(async () => {
    try {
      const summary = await runCompression(config, {
        onEvent: (ev) => {
          process.stdout.write(JSON.stringify(ev) + '\n');
        },
      });
      await flushStdout();
      process.exit(summary.failed > 0 ? 1 : 0);
    } catch (err) {
      console.error(`[cli] ${(err && err.message) || err}`);
      process.exit(2);
    }
  });
}

if (rawArgs[0] === '--cli') {
  runCli(rawArgs.slice(1));
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
  let win = null;
  const cancelState = { cancelled: false };

  function createWindow() {
    win = new BrowserWindow({
      width: 1060,
      height: 700,
      minWidth: 820,
      minHeight: 560,
      title: '图片压缩器',
      backgroundColor: '#f4f5f9',
      icon: path.join(__dirname, 'build', 'icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    // 调试：转发渲染进程日志 / 崩溃信息到主进程控制台
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const tag = ['debug', 'info', 'warn', 'error'][level] || 'log';
      console.log(`[renderer:${tag}] ${message} (${path.basename(sourceId)}:${line})`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error('[main] render-process-gone:', JSON.stringify(details));
    });
    win.on('closed', () => {
      win = null;
    });
  }

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // ---------- IPC ----------
  ipcMain.handle('dialog:pick-files', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择图片',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return r.canceled ? null : r.filePaths;
  });

  ipcMain.handle('dialog:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择文件夹',
      properties: ['openDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('compress:start', async (_e, config) => {
    cancelState.cancelled = false;
    console.log('[compress] start:', JSON.stringify({
      input: config.input, output: config.output, format: config.format,
      quality: config.webpQuality, effort: config.webpEffort, maxWidth: config.maxWidth, maxHeight: config.maxHeight, keepIfLarger: config.keepIfLarger,
    }));
    const summary = await runCompression(config, {
      onEvent: (ev) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('compress:event', ev);
        }
      },
      isCancelled: () => cancelState.cancelled,
    });
    console.log('[compress] done:', JSON.stringify({
      total: summary.total, processed: summary.processed, copied: summary.copied,
      skipped: summary.skipped, failed: summary.failed, cancelled: summary.cancelled,
      errors: summary.errors,
    }));
    return summary;
  });

  ipcMain.on('compress:cancel', () => {
    cancelState.cancelled = true;
  });

  ipcMain.handle('shell:open-folder', async (_e, p) => {
    if (typeof p !== 'string' || !p) return '路径无效';
    return await shell.openPath(p); // 返回空字符串表示成功
  });

  // 生成对比预览图：统一转成 WebP（浏览器无法直接渲染 tiff/heic 等格式），
  // 最大宽 2048 控制体积；返回 dataUrl 供渲染进程 <img> 使用
  // 注意：必须先把文件读进内存再交给 sharp —— 直接传路径时 libvips 会一直
  // 持有该文件句柄（直到 JS 垃圾回收才释放），期间再次压缩覆盖同一文件
  // 就会报"文件被占用"（用户实测：预览过的文件第二次压缩必然失败）
  ipcMain.handle('image:preview', async (_e, filePath) => {
    try {
      const p = String(filePath || '');
      if (!p || !fs.existsSync(p)) return { error: '文件不存在' };
      const size = fs.statSync(p).size;
      const data = fs.readFileSync(p);
      const meta = await sharp(data).metadata();
      const buf = await sharp(data)
        .rotate() // 按 EXIF 方向旋转，和系统看图效果一致
        .resize({ width: 2048, withoutEnlargement: true })
        .webp({ quality: 92 })
        .toBuffer();
      return {
        dataUrl: 'data:image/webp;base64,' + buf.toString('base64'),
        width: meta.width || null,
        height: meta.height || null,
        size,
      };
    } catch (err) {
      return { error: (err && err.message) || '无法读取图片' };
    }
  });
  }
}
