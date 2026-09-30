// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/vendor/tar-extract.mts — 展开 git archive 产出的 tar（树外检出用）。
//
// 为什么不直接起 tar：Windows 上 git 把符号链接记成 tar 的 symlink 条目，而本机没有
// 创建符号链接的权限（Developer Mode / 管理员），bsdtar 遂在 `Can't create ...: Invalid
// argument` 上整步失败。git 自己在 core.symlinks=false 时是把链接写成「内容为目标路径的普通
// 文件」；这里照做，于是同一份源码在任何平台上都摊成同样的常规文件树。
//
// 另一条理由：本脚本的调用方在受限沙箱里跑，Node 的管道 stdio 会被拒（EPERM）；纯 JS 读 tar
// 不产生任何子进程，也就没有这条依赖。
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";

/** 展开结果计数（日志与断言用）。 */
export interface ExtractCounts {
  files: number;
  directories: number;
  symlinks: number;
}

function readText(buffer: Buffer, start: number, length: number): string {
  const end = buffer.indexOf(0, start);
  const limit = end === -1 || end > start + length ? start + length : end;
  return buffer.toString("utf8", start, limit);
}

function readOctal(buffer: Buffer, start: number, length: number): number {
  const text = buffer.toString("utf8", start, start + length).replace(/\0.*$/su, "").trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

/** 归档内相对路径 → 目标绝对路径；越界（绝对路径、盘符、`..`）当场报错。 */
function resolveMember(raw: string, destination: string): string | null {
  const cleaned = raw.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (cleaned === "") return null;
  if (cleaned.startsWith("/") || /^[a-zA-Z]:/u.test(cleaned)) throw new Error("tar 条目是绝对路径：" + raw);
  const parts: string[] = [];
  for (const part of cleaned.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new Error("tar 条目越出目标目录：" + raw);
    parts.push(part);
  }
  return parts.length === 0 ? null : path.join(destination, ...parts);
}

/** pax 扩展头体（`<len> <key>=<value>\n` 重复）→ 键值表。 */
function parsePax(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(body.toString("utf8", offset, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = body.toString("utf8", space + 1, offset + length).replace(/\n$/u, "");
    const equals = record.indexOf("=");
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

/** 写普通文件；POSIX 上按归档模式位补执行权限，Windows 不管权限位。 */
function writeRegular(absolute: string, body: Buffer, mode: number): void {
  fs.writeFileSync(absolute, body);
  if (process.platform !== "win32" && (mode & 0o111) !== 0) fs.chmodSync(absolute, mode & 0o777);
}

/**
 * 把 tar 展开到 destination（目录可不存在）。
 *
 * @param archivePath - git archive 写出的 tar 绝对路径。
 * @param destination - 目标目录绝对路径。
 * @returns 文件/目录/链接三项计数。
 */
/**
 * 遍历 tar 的成员；对每个普通文件的 (路径, 内容) 调一次 visit。
 *
 * @param archive - 已解压的 tar 字节（npm tarball 要先过 gzip）。
 * @param visit - 逐成员回调；返回 false 可提前结束。
 */
function walkTar(archive: Buffer, visit: (memberPath: string, body: Buffer) => boolean | void): void {
  let pending = new Map<string, string>();
  let longName: string | undefined;
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      pending = new Map();
      longName = undefined;
      continue;
    }
    const name = readText(header, 0, 100);
    const prefix = readText(header, 345, 155);
    const type = String.fromCharCode(header[156] ?? 0);
    const size = readOctal(header, 124, 12);
    const body = size > 0 ? archive.subarray(offset, offset + size) : Buffer.alloc(0);
    offset += Math.ceil(size / 512) * 512;
    if (type === "x") { pending = parsePax(body); continue; }
    if (type === "g" || type === "K") continue;
    if (type === "L") { longName = body.toString("utf8").replace(/\0+$/u, ""); continue; }
    const effective = pending.get("path") ?? longName ?? (prefix === "" ? name : prefix + "/" + name);
    pending = new Map();
    longName = undefined;
    if (type === "0" || type === "\0" || type === "") {
      if (visit(effective, body) === false) return;
    }
  }
}

/**
 * 读一个 tar（或 .tgz）里某个成员的内容。
 *
 * 用途：包集清单要从 tarball 自己的 manifest 取 name/version——不靠文件名反推，也不解包整份
 * 归档。npm tarball 是 gzip，git archive 的输出是裸 tar，所以先看魔数再决定解不解压。
 *
 * @param archivePath - .tgz / .tar 的绝对路径。
 * @param memberPath - 归档内的路径，如 `package/package.json`。
 * @returns 成员内容；不存在返回 null。
 */
export function readTarMember(archivePath: string, memberPath: string): Buffer | null {
  const raw = fs.readFileSync(archivePath);
  const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  const archive = isGzip ? zlib.gunzipSync(raw) : raw;
  let found: Buffer | null = null;
  walkTar(archive, (member, body) => {
    if (member === memberPath) { found = Buffer.from(body); return false; }
  });
  return found;
}

export function extractTar(archivePath: string, destination: string): ExtractCounts {
  const raw = fs.readFileSync(archivePath);
  // npm tarball 是 gzip、git archive 是裸 tar：先看魔数再决定解不解（与 readTarMember 同口径）
  const buffer = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
  fs.mkdirSync(destination, { recursive: true });
  const counts: ExtractCounts = { files: 0, directories: 0, symlinks: 0 };
  let pending = new Map<string, string>();
  let longName: string | undefined;
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      pending = new Map();
      longName = undefined;
      continue;
    }
    const name = readText(header, 0, 100);
    const prefix = readText(header, 345, 155);
    const type = String.fromCharCode(header[156] ?? 0);
    const size = readOctal(header, 124, 12);
    const mode = readOctal(header, 100, 8);
    const body = size > 0 ? buffer.subarray(offset, offset + size) : Buffer.alloc(0);
    offset += Math.ceil(size / 512) * 512;

    if (type === "x") {
      pending = parsePax(body);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0+$/u, "");
      continue;
    }
    if (type === "K") continue;

    const effective = pending.get("path") ?? longName ?? (prefix === "" ? name : prefix + "/" + name);
    // 链接目标住在头部的 linkname 字段（157 起 100 字节），不是数据体；pax/长名头可覆盖它。
    const linkTarget = pending.get("linkpath") ?? readText(header, 157, 100);
    pending = new Map();
    longName = undefined;

    const absolute = resolveMember(effective, destination);
    if (absolute === null) continue;

    if (type === "5") {
      fs.mkdirSync(absolute, { recursive: true });
      counts.directories += 1;
      continue;
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (type === "2") {
      // 有权限就写真链接；没有（Windows 默认）就落到「内容是目标路径的普通文件」，
      // 与 git 在 core.symlinks=false 下的写法一致。
      try {
        fs.symlinkSync(linkTarget ?? body.toString("utf8"), absolute);
      } catch {
        fs.writeFileSync(absolute, linkTarget ?? body.toString("utf8"));
      }
      counts.symlinks += 1;
      continue;
    }
    if (type === "1") {
      const source = linkTarget === undefined ? null : resolveMember(linkTarget, destination);
      if (source !== null && fs.existsSync(source)) fs.linkSync(source, absolute);
      else writeRegular(absolute, body, mode);
      counts.files += 1;
      continue;
    }
    writeRegular(absolute, body, mode);
    counts.files += 1;
  }
  return counts;
}