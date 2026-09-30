// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/e2e/packed-profile-boot.mjs — 从交付 zip 解出真交付树，boot 指定预设到 HTTP 200。
//
// 为什么必须从 zip 解出来跑（不能拿仓库树代替）：仓库 node_modules 是 registry 成品与开发布局，
// 交付树是物化后的扁平树 + 我们的集成 delta。profile/模板这条链只在交付树里才同形。
// 用临时 DSH_HOME（--home 参数），绝不碰真实数据目录。
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i+1] : def; };
const APP_DIR = resolve(arg("app", ""));
const PROFILE = arg("profile", "dshana");
const HOME = resolve(arg("home", ""));
const TIMEOUT = Number(arg("timeout", "120000"));

if (!existsSync(join(APP_DIR, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"))) {
  console.error("交付树里没有 dsh bin.js：" + APP_DIR); process.exit(2);
}
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });

// 端口：让系统给一个空闲的（避免与真实 dsh 撞）。
const port = await new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const origin = "http://127.0.0.1:" + port;

const bin = join(APP_DIR, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const child = spawn(process.execPath, [bin, "--profile", PROFILE, "--port", String(port), "--no-open"], {
  cwd: APP_DIR,
  env: { ...process.env, DSH_HOME: HOME, NO_COLOR: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "", err = "", bodyBytes = 0, authFlow = null;
child.stdout.on("data", (b) => { const s = b.toString(); out += s; process.stdout.write("[dsh:out] " + s); });
child.stderr.on("data", (b) => { const s = b.toString(); err += s; process.stdout.write("[dsh:err] " + s); });

const deadline = Date.now() + TIMEOUT;
let status = null, lastHttp = null;
// 就绪判据是那行 "dsh web: http://127.0.0.1:<port>/?token=..."（由 web app 行挂载后打印）。
// **不能**拿 "/" 的任何 HTTP 应答当就绪：服务器先起来、路由后挂，中间那一小段 "/" 会 404，
// 提前跳出就会把"还没挂好"误报成失败（web 对照第一版就是这么假阴的）。
while (Date.now() < deadline) {
  if (child.exitCode !== null) { status = "exited"; break; }
  const m = out.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_\-]+)/);
  if (m) {
    try {
      // BrowserAuth：① token URL → 303 + Set-Cookie；② 带 cookie 请求干净 "/" → 200 + index.html。
      const step1 = await fetch(m[1], { redirect: "manual" });
      const raw = typeof step1.headers.getSetCookie === "function"
        ? step1.headers.getSetCookie()[0]
        : step1.headers.get("set-cookie");
      if (raw) {
        const step2 = await fetch(origin + "/", { redirect: "manual", headers: { cookie: String(raw).split(";", 1)[0] } });
        lastHttp = step2.status;
        if (step2.status === 200) {
          status = "http:200";
          bodyBytes = (await step2.text()).length;
          authFlow = "token->" + step1.status + "->cookie->" + step2.status;
          break;
        }
      }
    } catch { /* 铸凭据途中重试 */ }
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (status === null) status = lastHttp === null ? "no-ready-line" : "http:" + lastHttp + "(no-200)";
const profileDir = join(HOME, "profiles", PROFILE);
const manifest = existsSync(join(profileDir, "package.json"))
  ? JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8")) : null;
console.log("\n=== result ===");
console.log(JSON.stringify({
  profile: PROFILE, home: HOME, port, status, authFlow, bodyBytes,
  profileDirExists: existsSync(profileDir),
  profileDir,
  bundles: manifest?.dsh?.profile?.bundles ?? null,
  exitCode: child.exitCode,
}, null, 1));
try { child.kill(); } catch { /* 已退出 */ }
await new Promise((r) => setTimeout(r, 500));
try { child.kill("SIGKILL"); } catch { /* 忽略 */ }
process.exit(status === "http:200" ? 0 : 1);
