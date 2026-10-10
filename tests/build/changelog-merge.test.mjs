// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/changelog-merge.test.mjs — CHANGELOG 增量合并的尾部行为（scripts/release/changelog.mts）
//
// 守一件事：合并后文件尾只有一个换行。旧实现拼接旧内容时只 trimStart（去头不去尾），旧文件尾
// 已有的空行被原样带过来、再加上结尾的 "\n"，于是每次发版在文件尾净增一行——实测历史里
// 36→37→…→44 就是这么叠起来的。这条只有反复发版才看得出来，所以夹具要模拟「带尾空行的旧文件」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeIntoFile } from "../../scripts/release/changelog.mts";

const VER = "1.0.5+dsh-0.2.0-rc.2";
const NEW = `## [${VER}](https://x/cmp/v1.0.4...v1.0.5) (2026-10-10)\n\n### Bug Fixes\n\n* **a:** new ([aaaaaaa](https://x/aaaaaaa))\n`;

function withFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "changelog-merge-"));
  const file = join(dir, "CHANGELOG.md");
  try {
    writeFileSync(file, content, "utf8");
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 文件尾的连续换行数（0 表示末尾无换行）。 */
const tailNewlines = (text) => text.match(/\n*$/)[0].length;

test("插入新段：旧文件带尾空行时，合并后尾部只有一个换行", () => {
  const old = "# Changelog\n\n## [1.0.4+dsh-0.2.0-rc.2](https://x/cmp) (2026-10-08)\n\n### Bug Fixes\n\n* **b:** old ([bbbbbbb](https://x/bbbbbbb))\n\n\n\n\n";
  withFile(old, (file) => {
    const merged = mergeIntoFile(file, NEW, VER);
    assert.equal(tailNewlines(merged), 1, `文件尾应只有一个换行，实际 ${tailNewlines(merged)} 个`);
    assert.ok(merged.startsWith("# Changelog\n\n## [1.0.5"), "新段应在头部");
    assert.ok(merged.includes("bbbbbbb"), "旧段要保留");
  });
});

test("反复合并不叠空行：连跑五次尾部换行数不变", () => {
  let text = "# Changelog\n\n## [1.0.0+dsh-0.2.0-rc.2](https://x/cmp) (2026-10-01)\n\n### Bug Fixes\n\n* **z:** base ([zzzzzzz](https://x/zzzzzzz))\n";
  for (let i = 0; i < 5; i += 1) {
    const ver = `1.0.${i + 1}+dsh-0.2.0-rc.2`;
    const sec = `## [${ver}](https://x/cmp) (2026-10-0${i + 2})\n\n### Bug Fixes\n\n* **c${i}:** x ([c${i}00000](https://x/c${i}00000))\n`;
    const dir = mkdtempSync(join(tmpdir(), "changelog-merge-"));
    const file = join(dir, "CHANGELOG.md");
    writeFileSync(file, text, "utf8");
    text = mergeIntoFile(file, sec, ver);
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(tailNewlines(text), 1, `反复合并后尾部应仍只有一个换行，实际 ${tailNewlines(text)} 个`);
});

test("替换同版本段：尾部同样只有一个换行", () => {
  const old = `# Changelog\n\n## [${VER}](https://x/cmp) (2026-10-10)\n\n### Bug Fixes\n\n* **a:** stale ([ddddddd](https://x/ddddddd))\n\n\n\n## [1.0.4+dsh-0.2.0-rc.2](https://x/cmp2) (2026-10-08)\n\n### Bug Fixes\n\n* **b:** old ([bbbbbbb](https://x/bbbbbbb))\n\n\n`;
  withFile(old, (file) => {
    const merged = mergeIntoFile(file, NEW, VER);
    assert.equal(tailNewlines(merged), 1, `文件尾应只有一个换行，实际 ${tailNewlines(merged)} 个`);
    assert.ok(!merged.includes("ddddddd"), "同版本段的旧内容应被替换掉");
    assert.ok(merged.includes("bbbbbbb"), "更早的段要保留");
    assert.equal((merged.match(/^## \[/gm) || []).length, 2, "只该有两个版本段");
  });
});

test("文件不存在时也能合并（首建 CHANGELOG）", () => {
  const dir = mkdtempSync(join(tmpdir(), "changelog-merge-"));
  const file = join(dir, "CHANGELOG.md");
  try {
    const merged = mergeIntoFile(file, NEW, VER);
    assert.equal(tailNewlines(merged), 1);
    assert.ok(merged.startsWith("# Changelog\n\n## [1.0.5"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
