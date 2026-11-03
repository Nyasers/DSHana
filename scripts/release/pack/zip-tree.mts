// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/zip-tree.mts — 交付目录 → zip
// zip 根 = 目录的**内容**（不套目录名）：宿主安装时在包根读 manifest.json，
// 套一层会落在 `<base>/manifest.json`，报 INVALID_MANIFEST 拒装。
// 用 yazl 而不是 archiver：这里只要「把一个目录写成 zip」一件事，archiver 为它拉进 44 个包的子树
// （tar-stream、readable-stream 4 连同整套浏览器 polyfill），yazl 只要 buffer-crc32。
import { join, relative, sep } from "node:path";

import fs from "fs-extra";
import { ZipFile } from "yazl";

// 条目名是相对 root 的 posix 路径：zip 规范用 `/`，Windows 的 path.relative 给 `\`。
function entryName(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

// 目录条目显式写入：解压端不会凭文件路径回补空目录，缺了它空目录在解压后消失。
// 文件的 mode/mtime 由 yazl 从 stat 取，与 archiver 目录遍历的口径一致。
function addTree(zip: ZipFile, root: string, dir: string): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    const name = entryName(root, abs);
    if (ent.isSymbolicLink()) throw new Error(`交付树里有符号链接：${name}（跨机解压必断，拒绝出包）`);
    if (ent.isDirectory()) {
      zip.addEmptyDirectory(name, { mtime: fs.statSync(abs).mtime });
      addTree(zip, root, abs);
      continue;
    }
    if (!ent.isFile()) throw new Error(`交付树里有无法入包的条目：${name}`);
    zip.addFile(abs, name, { compress: true, compressionLevel: 9 });
  }
}

// 流式写入，deflate 级别 9（与 archiver 时代的产物口径一致）。
export async function writeDirZip(dir: string, outPath: string): Promise<void> {
  const output = fs.createWriteStream(outPath);
  const zip = new ZipFile();
  // resolve 要包一层：它带 (value) 参数，而 'close' 的 listener 签名是 () => void，
  // 直接传在 @types/node 26 下会被判「目标签名参数太少」。
  const done = new Promise<void>((resolve, reject) => {
    output.on("close", () => resolve());
    output.on("error", reject);
    // yazl 的 addFile 是异步 stat，读不到文件时走自身 error 事件而不是抛出。
    zip.on("error", reject);
    zip.outputStream.on("error", reject);
  });
  zip.outputStream.pipe(output);
  try {
    addTree(zip, dir, dir);
    zip.end();
    await done;
  } catch (e) {
    // 出错就是废件：临时文件由调用方 rename 落位，这里清掉半成品。
    // 句柄在某些平台不会随 destroy 立即可用，删除失败不遮掩真正的原因。
    output.destroy();
    await fs.remove(outPath).catch(() => {});
    throw e;
  }
}
