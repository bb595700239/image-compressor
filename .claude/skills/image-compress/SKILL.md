---
name: image-compress
description: 用本地"图片压缩器"桌面工具（Electron + sharp）批量压缩图片：png/jpg/webp 转 WebP/PNG/JPG，可调质量、最大宽高，原地或输出到指定文件夹。当用户要求压缩图片、减小图片体积、批量转 WebP、压缩文件夹里的图片时使用。
---

# 图片压缩器 CLI

调用本地安装的"图片压缩器"桌面应用的无头 CLI 模式批量压缩图片。

## 找到可执行文件

1. 用户给了路径 → 直接用
2. 否则按顺序找（Windows）：
   - NSIS 安装（默认位置）：`%LOCALAPPDATA%\Programs\图片压缩器\图片压缩器.exe`
   - win-unpacked 版：`...\win-unpacked\图片压缩器.exe`
   - 便携版 `图片压缩器-x.x.x-x64.exe` **不能**用于 CLI——外层是解压外壳，不转发命令行参数。找到它时提醒用户改用上面两种（或 NSIS 安装）
3. macOS：`图片压缩器.app/Contents/MacOS/图片压缩器`
4. 都找不到 → 问用户要路径

## 用法

```bash
图片压缩器.exe --cli -i <输入文件或文件夹> [-i ...更多输入] [-o <输出文件夹>] [选项]
```

`--cli` 必须是第一个参数。常用选项：

| 选项 | 说明 |
| --- | --- |
| `-f` | 输出格式：`webp`(默认) / `png` / `jpg` / `original`(保持原格式) |
| `-q` | 质量 1-100，默认 80 |
| `-o` | 输出文件夹；省略或等于输入文件夹 = **原地压缩**（同格式直接覆盖原文件） |
| `--max-width` / `--max-height` | 最大宽/高（像素），只缩不放 |
| `--lossless` | WebP 无损 |
| `--png-palette` | PNG 调色板量化（更小，有损） |
| `--overwrite` | 覆盖已存在的输出文件 |
| `--keep-if-larger` | 压缩结果 ≥ 原图且格式相同时保留原图 |

完整参数：`图片压缩器.exe --help`。

## 输出与退出码

stdout 是 NDJSON（每行一个 JSON）：

- `{"type":"scan-done","total":N}`
- `{"type":"file","label":"a.png","index":1,"total":N,"status":"done|kept|copied|skipped|error","before":123,"after":45,...}` —— 每文件一条
- `{"type":"done","summary":{...}}` —— 最后一行，summary 含 `total / processed / copied / skipped / failed / totalBefore / totalAfter / errors / output`

退出码：`0` 全部成功；`1` 完成但有文件失败（详情在 summary.errors）；`2` 无法运行（参数/输入错误，原因在 stderr）。

## 执行后的动作

1. 读最后一行 `done` 的 summary，向用户报告：处理张数、压缩前 → 压缩后总体积、节省了百分之多少、失败文件列表（如有）
2. 出现 `file-retry` 事件或"文件被占用"错误时：程序已自动每秒重试最多 30 秒，先等它结束；最终仍失败则提示用户关掉占用程序（资源管理器预览窗格/图片查看器/杀毒软件）后重试
3. 原地压缩（输出=输入）前，如用户没明确要求覆盖原文件，先确认一下
