// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/data-source.test.mjs — packages/runtime/src/data-source.ts 设置校验与自持存储单测
// 覆盖：设置校验（未知键 / 超时 / 会话模型 / 主题面）、数据目录身份、存储读默认与原子写、
// 损坏与版本拒绝、退役键（会话流卡档位 + 换源时代的 mode/path/profile）的读侧丢弃。
// 注：期望值一律经 path.normalize 生成，测试在 win32/darwin/linux 下同义。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  PRIVATE_HOME_NAME,
  PRIVATE_PROFILE,
  SETTINGS_VERSION,
  createDataSourceStore,
  privateHomeOf,
  privateSource,
  validateSettings,
} from "@dshana/runtime/data-source.ts";

/** 临时目录夹具（await 回调体，退出时清理）。 */
const withTempDir = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "dshana-ds-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// 两个超时的默认值（钉住数字：与 config.ts 的 APP_SETTING_DEFAULTS 一致，也是存储的缺省）
const TIMEOUT_DEFAULTS = { approvalTimeoutSec: 30, defaultTimeoutSec: 1800 };
// 会话模型缺省：复用调用方（caller），自定义那条留空
const SESSION_DEFAULTS = {
  sessionModelMode: "caller",
  sessionModelProvider: "",
  sessionModelModel: "",
  sessionModelReasoningEffort: "",
};
// 强制跟随宿主主题的面缺省：只有侧栏面（与 shared/face-theme.ts 的 FORCE_FOLLOW_FACES 同源）
const FACE_FOLLOW_DEFAULTS = { forceFollowFaces: ["sidebar"] };

test("validateSettings: 空设置落全部缺省", () => {
  const expected = { ...TIMEOUT_DEFAULTS, ...SESSION_DEFAULTS, ...FACE_FOLLOW_DEFAULTS };
  assert.deepEqual(validateSettings({}), expected);
  assert.deepEqual({ ...DEFAULT_SETTINGS }, expected, "DEFAULT_SETTINGS 与校验产物同形");
});

test("validateSettings: 拒绝未知键与非对象（换源时代的 mode/path/profile 也属未知）", () => {
  assert.throws(() => validateSettings({ extra: 1 }), /未知键/);
  assert.throws(() => validateSettings({ mode: "private" }), /未知键/);
  assert.throws(() => validateSettings(null), /必须是对象/);
  assert.throws(() => validateSettings([]), /必须是对象/);
});

test("validateSettings: 两个超时是非负整数秒", () => {
  assert.equal(validateSettings({ approvalTimeoutSec: 0 }).approvalTimeoutSec, 0);
  assert.equal(validateSettings({ defaultTimeoutSec: 600 }).defaultTimeoutSec, 600);
  for (const bad of [-1, 1.5, "30", Number.NaN]) {
    assert.throws(() => validateSettings({ approvalTimeoutSec: bad }), /不小于 0 的整数秒/);
  }
});

test("validateSettings: 会话模型模式限定两种，custom 要求 provider/model 都填", () => {
  const caller = validateSettings({});
  assert.equal(caller.sessionModelMode, "caller");
  assert.equal(caller.sessionModelProvider, "");
  assert.equal(caller.sessionModelModel, "");
  // caller 模式下那两个值原样保留（来回切不丢用户选过的那条）
  const kept = validateSettings({ sessionModelMode: "caller", sessionModelProvider: "deepseek", sessionModelModel: "deepseek-flash" });
  assert.equal(kept.sessionModelMode, "caller");
  assert.equal(kept.sessionModelProvider, "deepseek");
  const custom = validateSettings({
    sessionModelMode: "custom",
    sessionModelProvider: " agnes ",
    sessionModelModel: " agnes-3.0-flash ",
    sessionModelReasoningEffort: " high ",
  });
  assert.deepEqual(
    {
      mode: custom.sessionModelMode,
      provider: custom.sessionModelProvider,
      model: custom.sessionModelModel,
      effort: custom.sessionModelReasoningEffort,
    },
    { mode: "custom", provider: "agnes", model: "agnes-3.0-flash", effort: "high" },
  );
  // 推理强度是可选一侧：不填不报错，落空串（= 不指定，由 DSH 决定）
  assert.equal(validateSettings({ sessionModelMode: "custom", sessionModelProvider: "a", sessionModelModel: "b" }).sessionModelReasoningEffort, "");
  assert.throws(() => validateSettings({ sessionModelMode: "fixed" }), /caller 或 custom/);
  assert.throws(() => validateSettings({ sessionModelMode: "custom" }), /provider 与 model/);
  assert.throws(() => validateSettings({ sessionModelMode: "custom", sessionModelProvider: "deepseek" }), /provider 与 model/);
  assert.throws(() => validateSettings({ sessionModelProvider: 7 }), /sessionModelProvider/);
});

test("privateSource: DSH_HOME 恒为 <dataDir>/.dsh，profile 与 sourceId 固定", () => {
  const dataDir = "/app-data/dshana";
  const src = privateSource(dataDir);
  assert.equal(src.sourceId, "private");
  assert.equal(src.home, privateHomeOf(dataDir));
  assert.equal(src.home, join(dataDir, PRIVATE_HOME_NAME));
  assert.equal(src.profileName, PRIVATE_PROFILE);
});

test("store.read: 文件不存在回落默认（revision 0）", async () => {
  await withTempDir(async (dir) => {
    const st = await createDataSourceStore({ dataDir: dir }).read();
    assert.equal(st.version, SETTINGS_VERSION);
    assert.equal(st.revision, 0);
    assert.deepEqual(st.settings, { ...DEFAULT_SETTINGS });
  });
});

test("store.write: 原子落盘 + revision 递增（不留 .pending）", async () => {
  await withTempDir(async (dir) => {
    const store = createDataSourceStore({ dataDir: dir });
    const first = await store.write({ approvalTimeoutSec: 45 });
    assert.equal(first.revision, 1);
    assert.equal(first.settings.approvalTimeoutSec, 45);

    const onDisk = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    assert.equal(onDisk.revision, 1);
    assert.equal(onDisk.version, SETTINGS_VERSION);
    assert.deepEqual(readdirSync(dir), ["settings.json"], "原子写不留 .pending 残片");

    const second = await store.write({ ...first.settings, defaultTimeoutSec: 600 });
    assert.equal(second.revision, 2);

    const reread = await createDataSourceStore({ dataDir: dir }).read();
    assert.equal(reread.revision, 2);
    assert.deepEqual(reread.settings, {
      approvalTimeoutSec: 45,
      defaultTimeoutSec: 600,
      ...SESSION_DEFAULTS,
      ...FACE_FOLLOW_DEFAULTS,
    });
  });
});

test("store.read: 损坏 JSON / 版本不符 / revision 非法都明确抛错（不静默回落）", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "settings.json");
    writeFileSync(file, "{not json");
    await assert.rejects(() => createDataSourceStore({ dataDir: dir }).read(), /不是合法 JSON/);
    writeFileSync(file, JSON.stringify({ version: 99, revision: 0, settings: DEFAULT_SETTINGS }));
    await assert.rejects(() => createDataSourceStore({ dataDir: dir }).read(), /版本不受支持/);
    writeFileSync(file, JSON.stringify({ version: SETTINGS_VERSION, revision: -1, settings: DEFAULT_SETTINGS }));
    await assert.rejects(() => createDataSourceStore({ dataDir: dir }).read(), /revision 非法/);
    writeFileSync(file, JSON.stringify({ version: SETTINGS_VERSION, revision: 1, settings: { unknownKey: 1 } }));
    await assert.rejects(() => createDataSourceStore({ dataDir: dir }).read(), /未知键/);
  });
});

test("store.read: 退役键（卡档位 + mode/path/profile）在读侧丢弃，不撞未知键拒绝", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      version: SETTINGS_VERSION,
      revision: 3,
      lastShared: { path: "D:/dsh", profile: "web" },
      settings: { ...DEFAULT_SETTINGS, sessionCardDisplay: "open-only", mode: "shared", path: "D:/dsh", profile: "web" },
    }));
    const snap = await createDataSourceStore({ dataDir: dir }).read();
    for (const key of ["sessionCardDisplay", "mode", "path", "profile", "lastShared"]) {
      assert.equal(key in snap.settings, false, key + " 应在读侧丢掉");
    }
    assert.equal("lastShared" in snap, false, "快照不再带 lastShared");
    assert.equal(snap.revision, 3, "丢键不改 revision");
  });
});
