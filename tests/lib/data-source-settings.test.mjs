// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/data-source-settings.test.mjs — 两个超时、会话模型与强制跟随宿主主题的面同栈
// （一份设置、一个 revision）的语义。
//
// 盯五件事：
//   1. 缺省：设置里没有这两个键时，校验后补上默认（30 / 1800）；强制跟随的面缺省 = ["sidebar"]；
//   2. 非法：负数、小数、字符串一律拒绝，不静默取整或回默认；强制跟随的面词表外的值/重复项/非数组一律拒；
//   3. 往返：写进自持存储后读回来是同值同 revision；空数组（一个都不强制）必须原样保留，不得被当缺省；
//   4. 存量兼容：旧位置（<dataDir>/config.json 的 global.*）只在 settings.json 缺这两个键时当初始值，
//      读路径不落盘；一旦写过一次设置，自持存储就是唯一权威；
//   5. 后加的键（forceFollowFaces）：存量 settings.json 里没有它，读侧必须补缺省而不是撞未知键拒绝。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDataSourceStore, validateSettings } from "@dshana/runtime/data-source.ts";

const TIMEOUT_DEFAULTS = { approvalTimeoutSec: 30, defaultTimeoutSec: 1800 };

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dshana-settings-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("validateSettings: 缺省补上两个超时的默认值", () => {
  const out = validateSettings({ mode: "private" });
  assert.equal(out.approvalTimeoutSec, TIMEOUT_DEFAULTS.approvalTimeoutSec);
  assert.equal(out.defaultTimeoutSec, TIMEOUT_DEFAULTS.defaultTimeoutSec);
});

test("validateSettings: 非法超时值一律拒绝（不取整、不回默认）", () => {
  for (const bad of [-1, 1.5, "abc", {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => validateSettings({ mode: "private", approvalTimeoutSec: bad }),
      /approvalTimeoutSec/,
      "应拒绝 approvalTimeoutSec=" + JSON.stringify(bad),
    );
  }
  assert.throws(() => validateSettings({ mode: "private", defaultTimeoutSec: -5 }), /defaultTimeoutSec/);
});

test("validateSettings: 0 是显式禁用，保留不改成默认", () => {
  const out = validateSettings({ mode: "private", approvalTimeoutSec: 0, defaultTimeoutSec: 0 });
  assert.equal(out.approvalTimeoutSec, 0);
  assert.equal(out.defaultTimeoutSec, 0);
});

test("store: 两个超时随设置一起落盘并与 revision 同步", async () => {
  await withTempDir(async (dir) => {
    const store = createDataSourceStore({ dataDir: dir });
    const first = await store.write({ mode: "private", approvalTimeoutSec: 45, defaultTimeoutSec: 900 });
    assert.equal(first.revision, 1);
    assert.equal(first.settings.approvalTimeoutSec, 45);
    assert.equal(first.settings.defaultTimeoutSec, 900);

    const onDisk = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    assert.equal(onDisk.settings.approvalTimeoutSec, 45);

    const reread = await createDataSourceStore({ dataDir: dir }).read();
    assert.equal(reread.revision, 1);
    assert.equal(reread.settings.approvalTimeoutSec, 45);
    assert.equal(reread.settings.defaultTimeoutSec, 900);

    // 再写一次只改其中一个，另一个保持不变（不做整段重置）
    const second = await store.write({ mode: "private", approvalTimeoutSec: 15, defaultTimeoutSec: 900 });
    assert.equal(second.revision, 2);
    assert.equal(second.settings.approvalTimeoutSec, 15);
  });
});

test("存量兼容：旧位置只在缺键时当初始值，且不写回旧位置", async () => {
  await withTempDir(async (dir) => {
    // 旧栈：dataDir/config.json 的 global.*
    writeFileSync(join(dir, "config.json"), JSON.stringify({ global: { approvalTimeoutSec: 77, defaultTimeoutSec: 1234 } }), "utf8");

    // 1) settings.json 还没有 → 读到的初值来自旧位置（读路径不落盘）
    const fresh = await createDataSourceStore({ dataDir: dir }).read();
    assert.equal(fresh.settings.approvalTimeoutSec, 77);
    assert.equal(fresh.settings.defaultTimeoutSec, 1234);
    assert.equal(fresh.revision, 0, "读不制造 revision");
    assert.throws(
      () => readFileSync(join(dir, "settings.json"), "utf8"),
      /ENOENT/,
      "只读不该落盘",
    );

    // 2) 写一次设置（把值显式带上）→ 自持存储从此是权威
    const store = createDataSourceStore({ dataDir: dir });
    await store.write({ mode: "private", approvalTimeoutSec: 77, defaultTimeoutSec: 1234 });

    // 3) 旧位置被改也不再影响读（键已在 settings.json 里）
    writeFileSync(join(dir, "config.json"), JSON.stringify({ global: { approvalTimeoutSec: 999, defaultTimeoutSec: 999 } }), "utf8");
    const after = await createDataSourceStore({ dataDir: dir }).read();
    assert.equal(after.settings.approvalTimeoutSec, 77);
    assert.equal(after.settings.defaultTimeoutSec, 1234);

    // 4) 旧位置仍是旧位置：自持存储不往它写
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.equal(cfg.global.approvalTimeoutSec, 999, "自持存储不写 config.json");
  });
});

// ---- 强制跟随宿主主题的面（forceFollowFaces）----
// 声明与严格口径在 packages/shared/src/face-theme.ts（那一侧有自己的测试）；这里只盯存储这一口：
// 缺省落位、往返、空数组不被当缺省、非法值拒绝、以及存量存档缺键时的读侧兼容。

test("validateSettings: 缺省只强制侧栏面", () => {
  assert.deepEqual(validateSettings({ mode: "private" }).forceFollowFaces, ["sidebar"]);
});

test("validateSettings: 强制跟随的面非法值一律拒绝", () => {
  // settings 是 App 自己的设置页（不注入 DSH，没有覆盖可言），不在候选词表里
  for (const bad of [["settings"], ["nope"], ["sidebar", "sidebar"], "sidebar", [1], [null], [["sidebar"]]]) {
    assert.throws(
      () => validateSettings({ mode: "private", forceFollowFaces: bad }),
      /强制跟随宿主主题的面/,
      "应拒绝 forceFollowFaces=" + JSON.stringify(bad),
    );
  }
});

test("store: 强制跟随的面往返同值，revision 递增", async () => {
  await withTempDir(async (dir) => {
    const store = createDataSourceStore({ dataDir: dir });
    const first = await store.write({ mode: "private", forceFollowFaces: ["main", "stream"] });
    assert.equal(first.revision, 1);
    assert.deepEqual(first.settings.forceFollowFaces, ["main", "stream"]);

    const onDisk = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    assert.deepEqual(onDisk.settings.forceFollowFaces, ["main", "stream"]);

    const reread = await createDataSourceStore({ dataDir: dir }).read();
    assert.equal(reread.revision, 1);
    assert.deepEqual(reread.settings.forceFollowFaces, ["main", "stream"]);

    // 再写一次只改这张表（patch 形制：其余键缺省落位），revision 再 +1
    const second = await store.write({ mode: "private", forceFollowFaces: ["sidebar"] });
    assert.equal(second.revision, 2);
    assert.deepEqual(second.settings.forceFollowFaces, ["sidebar"]);
  });
});

test("store: 空数组合法且往返保留（不得被当成缺省变回 sidebar）", async () => {
  await withTempDir(async (dir) => {
    const store = createDataSourceStore({ dataDir: dir });
    const written = await store.write({ mode: "private", forceFollowFaces: [] });
    assert.deepEqual(written.settings.forceFollowFaces, [], "写侧：空数组是显式「一个都不强制」");

    const onDisk = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    assert.deepEqual(onDisk.settings.forceFollowFaces, [], "落盘：空数组不被默认盖掉");

    const reread = await createDataSourceStore({ dataDir: dir }).read();
    assert.deepEqual(reread.settings.forceFollowFaces, [], "读侧：空数组仍是空数组");
  });
});

test("存量兼容：settings.json 没有这个键时补缺省，不撞未知键拒绝", async () => {
  await withTempDir(async (dir) => {
    // 升级前的存档：完整但**没有** forceFollowFaces（那个键是后加的）
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      version: 1,
      revision: 5,
      settings: {
        mode: "private",
        path: null,
        profile: "dshana",
        approvalTimeoutSec: 45,
        defaultTimeoutSec: 900,
        sessionModelMode: "caller",
        sessionModelProvider: "",
        sessionModelModel: "",
        sessionModelReasoningEffort: "",
      },
    }), "utf8");

    const snap = await createDataSourceStore({ dataDir: dir }).read();
    assert.deepEqual(snap.settings.forceFollowFaces, ["sidebar"], "缺键补缺省");
    assert.equal(snap.settings.approvalTimeoutSec, 45, "同份存档里的其余键原样读回");
    assert.equal(snap.revision, 5, "补缺省不改 revision");
  });
});
