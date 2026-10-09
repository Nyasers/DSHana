// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/transport-takeover.test.mjs — 请求接管的判定规则与接管面
//
// 背景：带前导斜杠的裸路径（`/api/<命名空间>.<方法>`，/api/present.host 就是这样）
// 既不经过 __DSH_TRANSPORT__，也不受 <base> 约束（`/` 开头按 origin 解析，不继承 base 的路径），
// 于是落到宿主源上被凭据闸挡。接管规则必须同时满足两件事，所以两条都锁在这里：
//   ① 只重写「本页 origin（或 dsh.internal）」；
//   ② 宿主前缀 /api/apps/ 与外部 origin 一律原样放行（否则会把 App 自己的宿主访问也改道）。

import test from "node:test";
import assert from "node:assert/strict";

import {
  HOST_PATH_PREFIXES,
  installRequestTakeover,
  resolveRelaySocketUrl,
  resolveRelayUrl,
} from "@dshana/ui/dsh-inject.ts";

const PAGE = "https://hana.local";
const BASE = new URL("https://hana.local/api/apps/dshana/routes/_runtime/r1/_surface/tok/");
const conf = { pageOrigin: PAGE };
const relayed = (input) => resolveRelayUrl(input, BASE, conf);
const expectRelayed = (input, expectedPath) => {
  const url = relayed(input);
  assert.ok(url, `应被接管：${String(input)}`);
  assert.equal(url.toString(), BASE.origin + BASE.pathname + expectedPath);
};

test("内核裸路径（前导斜杠）被接管到中继前缀", () => {
  expectRelayed("/api/present.host", "api/present.host");
  expectRelayed("/api/remote.mux", "api/remote.mux");
  expectRelayed("/api/events.host", "api/events.host");
});

test("无前导斜杠的相对路径同样被接管", () => {
  expectRelayed("api/session.list", "api/session.list");
  expectRelayed("./assets/index-abc.js", "assets/index-abc.js");
});

test("dsh.internal 绝对地址被接管", () => {
  expectRelayed("http://dsh.internal/api/present.host", "api/present.host");
});

test("query 与 hash 原样保留", () => {
  expectRelayed("/api/session.page?cursor=9&x=1", "api/session.page?cursor=9&x=1");
  const withHash = relayed("/api/x.y?a=1#frag");
  assert.equal(withHash.search, "?a=1");
  assert.equal(withHash.hash, "#frag");
});

test("宿主前缀（/api/apps/）与中继自身一律放行，防二次重写", () => {
  assert.equal(relayed("/api/apps/dshana/routes/_runtime/r1/_surface/tok/api/present.host"), null);
  assert.equal(relayed("/api/apps/dshana/ui/default.html"), null);
  assert.equal(relayed(BASE.toString() + "api/present.host"), null);
  assert.deepEqual(HOST_PATH_PREFIXES, ["/api/apps/"]);
});

test("非 http(s)/ws(s) 的 scheme 一律原样放行", () => {
  // blob: 的内层地址不是路径：`blob:https://<本页>/<uuid>` 解析出的 origin 就是本页，
  // 内层 URL 整段落在 pathname 里。若只看 origin 就会被误判成同页路径，改写成一个坏地址。
  assert.equal(relayed("blob:https://hana.local/9f8b-uuid"), null);
  assert.equal(relayed("blob:null/9f8b-uuid"), null);
  assert.equal(relayed("filesystem:https://hana.local/temporary/x"), null);
  assert.equal(relayed("data:image/png;base64,AAA"), null);
  assert.equal(relayed("about:blank"), null);
  // 相对引用与绝对 http(s)/ws(s) 仍照常接管（scheme 闸不能把正常路径一起拦了）。
  assert.equal(relayed(PAGE + "/api/present.host").toString(), BASE.toString() + "api/present.host");
  assert.equal(relayed("wss://hana.local/api/remote.mux").toString(), BASE.toString() + "api/remote.mux");
});

test("外部 origin 不重写也不抛（原生语义照旧）", () => {
  assert.equal(relayed("https://example.com/api/present.host"), null);
  assert.equal(relayed("http://127.0.0.1:5173/api/x.y"), null);
});

test("WebSocket 映射：跟随中继前缀的 http(s) → ws(s)", () => {
  // 页面是 https → 中继也是 https → 映射结果应为 wss（跟页面协议一致，不是写死 ws）。
  const mapped = resolveRelaySocketUrl("/api/remote.mux", BASE, conf);
  assert.ok(mapped);
  assert.equal(mapped.protocol, "wss:");
  assert.equal(mapped.toString(), "wss://hana.local/api/apps/dshana/routes/_runtime/r1/_surface/tok/api/remote.mux");
  // 输入自己就是 wss:// 时 origin 归一后同样认得（协议族等价）。
  const secure = resolveRelaySocketUrl("wss://hana.local/api/remote.mux", BASE, conf);
  assert.ok(secure);
  assert.equal(secure.protocol, "wss:");
  assert.equal(secure.toString(), "wss://hana.local/api/apps/dshana/routes/_runtime/r1/_surface/tok/api/remote.mux");
  assert.equal(resolveRelaySocketUrl("https://example.com/api/remote.mux", BASE, conf), null);
});

/** 假元素基类工厂：每次调用产出独立类（与其余替身同规格：测试间零共享）。 */
function fakeElementClass() {
  return class FakeElement {
    constructor(tag = "DIV") { this.tagName = tag; this.attrs = {}; }
    setAttribute(name, value) { this.attrs[String(name).toLowerCase()] = String(value); }
  };
}
/**
 * 假资源类：URL 访问器定义在指定原型上（与浏览器同形）。
 * `src` 在真实浏览器里定义在 HTMLMediaElement.prototype 上、video/audio 自己不带——
 * 所以要能把访问器挂到父类，才测得出「video.src 赋值有没有真的被覆盖」。
 */
function fakeResourceClass(BaseElement, owner, tag, prop) {
  if (owner) {
    Object.defineProperty(owner.prototype, prop, {
      get() { return this["_" + prop]; },
      set(value) { this["_" + prop] = value; },
      configurable: true,
    });
  }
  class FakeResource extends (owner || BaseElement) {
    constructor() { super(tag); }
  }
  if (!owner) {
    Object.defineProperty(FakeResource.prototype, prop, {
      get() { return this["_" + prop]; },
      set(value) { this["_" + prop] = value; },
      configurable: true,
    });
  }
  return FakeResource;
}
/** 一套最小的宿主替身：五个原语 + 元素资源 + 调用记录。 */
function fakeTarget() {
  const calls = [];
  const FakeElement = fakeElementClass();
  class FakeXHR {
    open(method, url) { this.method = method; this.url = url; }
  }
  class FakeEventSource {
    constructor(url) { this.url = url; }
  }
  FakeEventSource.CONNECTING = 0;
  FakeEventSource.OPEN = 1;
  class FakeWebSocket {
    constructor(url) { this.url = url; }
  }
  FakeWebSocket.OPEN = 1;
  // media 子类先建，再让它们的共同父类带上 src 访问器（浏览器就是这么分的）。
  class FakeMediaElement extends FakeElement {}
  const FakeVideo = fakeResourceClass(FakeElement, FakeMediaElement, "VIDEO", "src");
  const FakeAudio = fakeResourceClass(FakeElement, FakeMediaElement, "AUDIO", "src");
  const target = {
    location: { origin: PAGE },
    fetch: (input) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ kind: "fetch", url });
      return Promise.resolve({ ok: true });
    },
    XMLHttpRequest: FakeXHR,
    EventSource: FakeEventSource,
    WebSocket: FakeWebSocket,
    Element: FakeElement,
    HTMLMediaElement: FakeMediaElement,
    HTMLImageElement: fakeResourceClass(FakeElement, null, "IMG", "src"),
    HTMLScriptElement: fakeResourceClass(FakeElement, null, "SCRIPT", "src"),
    HTMLIFrameElement: fakeResourceClass(FakeElement, null, "IFRAME", "src"),
    HTMLVideoElement: FakeVideo,
    HTMLAudioElement: FakeAudio,
    HTMLSourceElement: fakeResourceClass(FakeElement, null, "SOURCE", "src"),
    HTMLTrackElement: fakeResourceClass(FakeElement, null, "TRACK", "src"),
    HTMLEmbedElement: fakeResourceClass(FakeElement, null, "EMBED", "src"),
    HTMLLinkElement: fakeResourceClass(FakeElement, null, "LINK", "href"),
    navigator: {
      sendBeacon: (url) => { calls.push({ kind: "beacon", url: String(url) }); return true; },
    },
  };
  return { target, calls };
}

test("接管面：五个原语都被改写，宿主侧与外部 origin 不动，disposer 还原", async () => {
  const { target, calls } = fakeTarget();
  const nativeFetch = target.fetch;
  const nativeXHR = target.XMLHttpRequest;
  const nativeEventSource = target.EventSource;
  const nativeWebSocket = target.WebSocket;
  const nativeBeacon = target.navigator.sendBeacon;

  const restore = installRequestTakeover(BASE, { target, navigator: target.navigator, ...conf });

  // fetch：重写 + same-origin 凭据
  await target.fetch("/api/present.host");
  await target.fetch("/api/apps/dshana/routes/keep-me");
  await target.fetch("https://example.com/out");
  assert.deepEqual(calls.filter((c) => c.kind === "fetch").map((c) => c.url), [
    BASE.toString() + "api/present.host",
    "/api/apps/dshana/routes/keep-me",
    "https://example.com/out",
  ]);

  // XHR
  const xhr = new target.XMLHttpRequest();
  xhr.open("GET", "/api/session.list");
  assert.equal(xhr.url, BASE.toString() + "api/session.list");

  // EventSource / WebSocket
  assert.equal(new target.EventSource("/api/events.host").url, BASE.toString() + "api/events.host");
  assert.equal(new target.WebSocket("/api/remote.mux").url, "wss://hana.local/api/apps/dshana/routes/_runtime/r1/_surface/tok/api/remote.mux");
  assert.equal(target.WebSocket.OPEN, 1);
  assert.equal(target.EventSource.OPEN, 1);

  // sendBeacon
  target.navigator.sendBeacon("/api/present.host", "x");
  assert.equal(calls.filter((c) => c.kind === "beacon")[0].url, BASE.toString() + "api/present.host");

  // disposer
  restore();
  assert.equal(target.fetch, nativeFetch);
  assert.equal(target.XMLHttpRequest, nativeXHR);
  assert.equal(target.EventSource, nativeEventSource);
  assert.equal(target.WebSocket, nativeWebSocket);
  assert.equal(target.navigator.sendBeacon, nativeBeacon);
});

test("Request 对象输入：方法/请求体保住，URL 换成中继前缀", async () => {
  const { target, calls } = fakeTarget();
  installRequestTakeover(BASE, { target, navigator: target.navigator, ...conf });
  await target.fetch(new Request(PAGE + "/api/present.host", { method: "POST", body: "payload" }));
  assert.equal(calls.find((c) => c.kind === "fetch").url, BASE.toString() + "api/present.host");
});

test("元素资源：src / href 赋值改写到中继前缀", () => {
  const { target } = fakeTarget();
  installRequestTakeover(BASE, { target, navigator: target.navigator, ...conf });

  const img = new target.HTMLImageElement();
  img.src = "/wallpaper-engine/preview/x.gif";
  assert.equal(img.src, BASE.toString() + "wallpaper-engine/preview/x.gif");

  const frame = new target.HTMLIFrameElement();
  frame.src = "/wallpaper-engine/scene-live/index.html?type=scene&src=a%2Fb";
  assert.equal(frame.src, BASE.toString() + "wallpaper-engine/scene-live/index.html?type=scene&src=a%2Fb");

  const script = new target.HTMLScriptElement();
  script.src = "assets/chunk.js";
  assert.equal(script.src, BASE.toString() + "assets/chunk.js");

  const link = new target.HTMLLinkElement();
  link.href = "/theme.css";
  assert.equal(link.href, BASE.toString() + "theme.css");

  const video = new target.HTMLVideoElement();
  video.src = "/wallpaper-engine/media/tok";
  assert.equal(video.src, BASE.toString() + "wallpaper-engine/media/tok");

  const audio = new target.HTMLAudioElement();
  audio.src = "/wallpaper-engine/media/tok.mp3";
  assert.equal(audio.src, BASE.toString() + "wallpaper-engine/media/tok.mp3");

  const track = new target.HTMLTrackElement();
  track.src = "/wallpaper-engine/subtitles/zh.vtt";
  assert.equal(track.src, BASE.toString() + "wallpaper-engine/subtitles/zh.vtt");
});

test("元素资源守卫：空值 / blob: / 外部 origin / 已在中继前缀一律原样", () => {
  const { target } = fakeTarget();
  installRequestTakeover(BASE, { target, navigator: target.navigator, ...conf });

  const img = new target.HTMLImageElement();
  img.src = "";
  assert.equal(img.src, "");
  img.src = "data:image/png;base64,AAA";
  assert.equal(img.src, "data:image/png;base64,AAA");
  img.src = "blob:https://hana.local/9f8b-uuid";
  assert.equal(img.src, "blob:https://hana.local/9f8b-uuid");
  img.src = "https://example.com/a.png";
  assert.equal(img.src, "https://example.com/a.png");
  img.src = BASE.toString() + "wallpaper-engine/preview/x.gif";
  assert.equal(img.src, BASE.toString() + "wallpaper-engine/preview/x.gif");
  img.src = "/api/apps/dshana/routes/keep-me.png";
  assert.equal(img.src, "/api/apps/dshana/routes/keep-me.png");
});

test("元素资源：setAttribute 仅资源标签生效，a.href 与普通元素的 src 不动", () => {
  const { target } = fakeTarget();
  installRequestTakeover(BASE, { target, navigator: target.navigator, ...conf });

  const im = new target.HTMLImageElement();
  im.setAttribute("src", "/wallpaper-engine/preview/y.gif");
  assert.equal(im.attrs.src, BASE.toString() + "wallpaper-engine/preview/y.gif");

  const anchor = new target.Element("A");
  anchor.setAttribute("href", "/somewhere");
  assert.equal(anchor.attrs.href, "/somewhere");

  const div = new target.Element("DIV");
  div.setAttribute("src", "/not-a-resource");
  assert.equal(div.attrs.src, "/not-a-resource");

  const link = new target.HTMLLinkElement();
  link.setAttribute("href", "/fonts/x.woff2");
  assert.equal(link.attrs.href, BASE.toString() + "fonts/x.woff2");
});

test("元素资源 disposer：还原访问器与 setAttribute", () => {
  const { target } = fakeTarget();
  const restore = installRequestTakeover(BASE, { target, navigator: target.navigator, ...conf });
  restore();

  const img = new target.HTMLImageElement();
  img.src = "/wallpaper-engine/preview/z.gif";
  assert.equal(img.src, "/wallpaper-engine/preview/z.gif");

  const video = new target.HTMLVideoElement();
  video.src = "/wallpaper-engine/media/z.mp4";
  assert.equal(video.src, "/wallpaper-engine/media/z.mp4");

  const im = new target.HTMLImageElement();
  im.setAttribute("src", "/wallpaper-engine/preview/z.gif");
  assert.equal(im.attrs.src, "/wallpaper-engine/preview/z.gif");
});
