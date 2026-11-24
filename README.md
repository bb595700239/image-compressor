# 图片压缩器

带 UI 的桌面图片压缩工具（Electron + sharp），支持 WebP / PNG / JPG，自动识别透明，压缩前后左右对比预览。

![图片压缩器界面](pic/screen.jpg)

## 功能

- **批量压缩**：拖拽或选择多个图片文件 / 文件夹，一键压缩
- **输出格式四选一**：全部 WebP / 全部 PNG / 全部 JPG / 保持原格式
- **压缩参数可调**：质量（1–100）、WebP effort（0–6）、最大宽度 / 高度（只缩不放，留空 = 不缩放）、WebP 无损、PNG 调色板量化
- **变大保留原图**（可选）：压缩结果 ≥ 原图且格式相同时保留原文件
- **格式智能处理**：

| 格式 | 处理 |
| --- | --- |
| png / jpg / webp | sharp 压缩 |
| avif / tiff / heic | 设置了最大宽度/高度 → 缩放并按原格式重编码；否则原样复制 |
| gif / svg / ico / bmp | 原样复制（动图不能安全重编码） |

- **对比预览**：压缩前后左右联动缩放 / 平移，支持 1:1 像素模式查看细节
- **逐条文件日志**：✓ 处理 / ＝ 保留 / ⧉ 复制 / ↷ 跳过 / ✕ 失败，点击任意一条打开对比预览
- **体积统计**：压缩前 → 压缩后，节省百分比
- **文件占用自动重试**：Windows 上文件被预览窗格 / 搜索索引 / 杀毒软件临时占用时，每秒自动重试（最多 30 次），释放后继续，无需重新开始
- **CLI 模式**：同一个 exe 可被脚本 / CI / AI 调用，输出 NDJSON（见下文）

## 下载

**发布版本**：[Releases](https://github.com/bb595700239/image-compressor/releases)。推送 `v*` tag（如 `v1.3.0`）后，GitHub Actions 自动创建对应 Release 并附上安装包：

| 文件 | 平台 |
| --- | --- |
| `图片压缩器-Setup-x.x.x-x64.exe` | Windows 安装包 |
| `图片压缩器-x.x.x-x64.exe` | Windows 便携版 |
| `图片压缩器-x.x.x-x64.dmg` / `.zip` | macOS Intel |
| `图片压缩器-x.x.x-arm64.dmg` / `.zip` | macOS Apple Silicon |

**最新构建（未打 tag）**：打开 [Actions · build](https://github.com/bb595700239/image-compressor/actions/workflows/build.yml)，点最近一次 **成功** 的 run，在页面底部 **Artifacts** 区下载（`windows-x64` / `macos-x64` / `macos-arm64`）。Artifact 默认 90 天后被 GitHub 清理，过期后推一次提交重新构建即可。

> Mac 包未签名，首次打开需右键 → 打开

## 开发

```bash
# Node.js ≥ 18.17（推荐 20+）
npm install
npm start          # 启动开发版
```

## 打包

```bash
npm run dist             # Windows 安装包（NSIS）+ 便携版
npm run dist:portable    # Windows 仅便携版
npm run dist:mac         # macOS（dmg + zip，x64 和 arm64）
```

产物输出到 `release/` 目录。

### 打包 macOS 版本

Mac 包**只能在 macOS 上构建**（electron-builder 不支持从 Windows 交叉打包 Mac），两种方式：

1. **在 Mac 上构建**：`git pull` 后执行

   ```bash
   # Apple Silicon（M 系列）上跳过签名，本地自用：
   CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
   # Intel Mac 同理
   ```

   未签名 / 未公证的应用，用户首次打开需右键 → 打开（或 `xattr -dr com.apple.quarantine` 去掉隔离标记）。正式分发给他人需 Apple 开发者账号做签名 + 公证（notarization）。

2. **GitHub Actions（推荐）**：工作流见 `.github/workflows/build.yml`，推送 `main`（或打 `v*` tag）自动构建，也可以在 Actions 页面手动触发。产物下载方式见上方 [下载](#下载) 章节（CI 产物同样是未签名包）。

## CLI 模式

打包后的 exe 支持命令行调用（`--cli` 必须为第一个参数）：

```bash
图片压缩器.exe --cli --input "D:\img" --output "D:\out" --format webp --quality 80
```

常用选项：

| 选项 | 说明 |
| --- | --- |
| `--input, -i <路径>` | 输入文件/文件夹，可重复指定多个（至少一个） |
| `--output, -o <路径>` | 输出文件夹；与输入相同 = 原地压缩 |
| `--format, -f <格式>` | `webp`（默认）/ `png` / `jpg` / `original` |
| `--quality, -q <1-100>` | 压缩质量，默认 80 |
| `--effort <0-6>` | WebP 压缩力度，默认 4 |
| `--lossless` | WebP 无损 |
| `--max-width / --max-height <像素>` | 最大宽/高，默认 0 = 不限制 |
| `--png-palette` | PNG 调色板量化（更小，有损） |
| `--overwrite` | 覆盖已存在的输出文件 |
| `--keep-if-larger` | 压缩结果 ≥ 原图且格式相同时保留原图 |
| `--no-copy-others` | 不处理其它格式图片 |

stdout 输出 NDJSON（每行一个 JSON 事件：`scan-done` / `file` / `file-retry` / `done`），错误信息走 stderr。

退出码：`0` = 全部成功，`1` = 完成但有文件失败，`2` = 无法运行。

完整帮助：`图片压缩器.exe --help`。

> 注意：portable 版（`图片压缩器-x.x.x-x64.exe`）外层是解压外壳，不转发命令行参数；CLI 请调用 `win-unpacked\图片压缩器.exe` 或 NSIS 安装后的 exe。

## 项目结构

```
├── main.js            # Electron 主进程：窗口 / IPC / 预览图生成 / CLI 入口
├── preload.js         # contextBridge 安全桥接
├── compress-core.js   # 压缩核心（独立于 GUI，CLI 与 GUI 共用）
├── renderer/
│   ├── index.html     # 界面结构
│   ├── renderer.js    # 渲染进程逻辑（日志 / 预览 / 交互）
│   └── style.css      # 样式
└── build/             # 应用图标（打包用）
```

## 技术栈

Electron 36 · sharp · fast-glob · electron-builder（无前端框架，原生 JS + CSS）

## License

MIT
