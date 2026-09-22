// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/session-card-display.test.mjs — 会话流卡档位的判定（lib/card-display.ts）
//
// 卡是本 App 最贵的可见物（一张 = 一个注入 DSH 会话的 iframe），档位错了要么聊天流被叠满、
// 要么用户再也找不到那张句柄卡。这里把三档 × 两个动作的判定钉死，并盯住"未知值回落缺省"与
// "缺省档 = open-only"两件事——它们决定没配过的用户看到什么。
import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_CARD_DISPLAYS,
  SESSION_CARD_DISPLAY_DEFAULT,
} from "../src/lib/card-display-modes.ts";
import { normalizeSessionCardDisplay, sessionCardShownFor } from "../src/lib/card-display.ts";
import { APP_SETTING_DEFAULTS } from "../src/lib/config.ts";
import { DEFAULT_SETTINGS, SETTINGS_KEYS, validateSettings } from "../src/lib/data-source.ts";

test("档位词表：三个值，缺省是 open-only", () => {
  assert.deepEqual([...SESSION_CARD_DISPLAYS], ["never", "open-only", "all"]);
  assert.equal(SESSION_CARD_DISPLAY_DEFAULT, "open-only");
  // 缺省值只有一个事实源：词表那一层；config 的 APP_SETTING_DEFAULTS 与它同值。
  assert.equal(APP_SETTING_DEFAULTS.sessionCardDisplay, SESSION_CARD_DISPLAY_DEFAULT);
});

test("判定：三档 × open/reply", () => {
  assert.equal(sessionCardShownFor("never", "open"), false);
  assert.equal(sessionCardShownFor("never", "reply"), false);
  assert.equal(sessionCardShownFor("open-only", "open"), true, "open 那张是句柄卡，缺省留着");
  assert.equal(sessionCardShownFor("open-only", "reply"), false, "reply 不叠卡");
  assert.equal(sessionCardShownFor("all", "open"), true);
  assert.equal(sessionCardShownFor("all", "reply"), true);
});

test("判定：未知 / 空值回落缺省档（不是 never，也不是 all）", () => {
  for (const dirty of ["", "open_only", "ALL", null, undefined, "yes"]) {
    assert.equal(normalizeSessionCardDisplay(dirty), SESSION_CARD_DISPLAY_DEFAULT, JSON.stringify(dirty));
    assert.equal(sessionCardShownFor(dirty, "open"), true);
    assert.equal(sessionCardShownFor(dirty, "reply"), false);
  }
});

test("设置面：档位在键表里、缺省落位、脏值被写入口拒掉", () => {
  assert.ok(SETTINGS_KEYS.includes("sessionCardDisplay"), "设置的键表要认这一格（否则写回被未知键拒）");
  assert.equal(DEFAULT_SETTINGS.sessionCardDisplay, SESSION_CARD_DISPLAY_DEFAULT);
  const base = { mode: "private", path: null, profile: "web" };
  for (const ok of SESSION_CARD_DISPLAYS) {
    assert.equal(validateSettings({ ...base, sessionCardDisplay: ok }).sessionCardDisplay, ok);
  }
  assert.equal(validateSettings(base).sessionCardDisplay, SESSION_CARD_DISPLAY_DEFAULT, "缺省落位");
  assert.throws(() => validateSettings({ ...base, sessionCardDisplay: "some" }), /会话流卡档位/);
});
