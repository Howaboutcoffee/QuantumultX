const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../Scripts/streaming-ui-check.js"), "utf8");
const response = (body, statusCode = 200) => ({
  statusCode, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body)
});
function happy(url) {
  if (url.includes("netflix.com/title/")) return response('{"isAvailable":true,"requestCountry":{"id":"JP"}}');
  if (url.endsWith("/devices")) return response({ assertion: "anonymous-test-assertion" });
  if (url.endsWith("/token")) return response({ refresh_token: "anonymous-test-refresh" });
  if (url.endsWith("/graphql")) return response({ extensions: { sdk: { session: { inSupportedLocation: true, location: { countryCode: "JP" } } } } });
  if (url.endsWith("/cdn-cgi/trace")) return response("loc=JP\n");
  if (url === "https://chatgpt.com/") return response("<html><title>ChatGPT</title></html>");
  if (url.includes("youtube.com")) return response('YouTube Premium {"GL":"JP"}');
  if (url.includes("indazn.com")) return response({ GeolocatedCountry: "JP" });
  if (url.includes("paramountplus.com")) return response("Paramount+");
  if (url.includes("/token?")) return response({ data: { attributes: { token: "anonymous-test-cookie" } } });
  if (url.endsWith("/users/me")) return response({ data: { attributes: { currentLocationTerritory: "us" } } });
  throw new Error("Unexpected URL: " + url);
}
async function run(override = () => undefined, options = {}) {
  const calls = [], outputs = [], logs = [];
  let completed;
  const done = new Promise(resolve => { completed = resolve; });
  const context = {
    $environment: { params: options.policy === undefined ? "Example Proxy" : options.policy },
    $task: { fetch: async request => {
      calls.push(request);
      const changed = override(request.url, request);
      return changed === undefined ? happy(request.url) : changed;
    } },
    $configuration: { sendMessage: options.state || (async () => ({ ret: {} })) },
    $done: value => { outputs.push(value); completed(value); },
    console: { log: (...values) => logs.push(values) },
    setTimeout: (fn, ms) => setTimeout(fn, options.clock ? options.clock(ms) : (ms === 25000 ? 250 : 50)),
    clearTimeout
  };
  vm.runInNewContext(source, context, { timeout: 1000 });
  const output = await done;
  return { output, html: output.htmlMessage, calls, outputs, logs };
}
function line(html, name) {
  return html.split("<br><br>").find(part => part.includes("<b>" + name + "：")) || "";
}

test("normal responses: evidence-specific labels, selected policy, verified TLS, no sensitive logging", async () => {
  const r = await run();
  assert.match(line(r.html, "Netflix"), /样本可用 2\/2.*JP/);
  assert.match(line(r.html, "Disney+"), /地区检测通过.*JP/);
  assert.match(line(r.html, "ChatGPT"), /网页可访问.*未验证登录或对话/);
  assert.match(line(r.html, "Discovery+"), /US/);
  assert.doesNotMatch(r.html, /完整支持|anonymous-test/);
  assert.deepEqual(r.logs, []);
  assert.ok(r.calls.every(c => c.opts.policy === "Example Proxy" && c.opts["skip-cert-verify"] === false && c.opts["auto-cookie"] === false));
  assert.equal(r.calls.find(c => c.url.endsWith("/users/me")).headers.Cookie, "st=anonymous-test-cookie");
});
for (const [body, code, expected] of [
  ['{"isAvailable":false}', 200, /两个样本均不可用/],
  ["", 404, /两个样本均不可用/],
  ["<html>login</html>", 200, /格式变化/],
  ['{"isAvailable":true,"other":{"isAvailable":false}}', 200, /格式变化/],
  ["denied", 403, /无法判断/],
  ["rate limit", 429, /请求受限/],
  ['<title>Just a moment</title>{"isAvailable":true}', 200, /需要网页验证/],
  ["server error", 500, /接口异常/]
]) {
  test("Netflix classifies " + code + " " + expected, async () => {
    const r = await run(url => url.includes("netflix.com") ? response(body, code) : undefined);
    assert.match(line(r.html, "Netflix"), expected);
    assert.doesNotMatch(line(r.html, "Netflix"), /完整支持|支持自制剧集/);
    assert.match(line(r.html, "Disney+"), /地区检测通过/);
  });
}
test("Netflix one failed sample does not discard the other sample", async () => {
  const r = await run(url => url.endsWith("/70143836") ? response("", 429) : undefined);
  assert.match(line(r.html, "Netflix"), /1\/2.*另一项检测异常/);
});
test("Netflix escaped metadata and absent X-Originating-URL are supported", async () => {
  const r = await run(url => url.includes("netflix.com") ? response('{\\"isAvailable\\":true,\\"requestCountry\\":{\\"id\\":\\"SG\\"}}') : undefined);
  assert.match(line(r.html, "Netflix"), /2\/2.*SG/);
});
for (const [body, code, expected] of [
  [{ errors: [{ code: "forbidden-location" }] }, 403, /地区受限/],
  [{ error: "unauthorized_client" }, 401, /未授权.*无法判断/],
  ["<html>verification</html>", 403, /访问被拒绝.*无法判断/],
  ["{}", 429, /请求受限/],
  ["not-json", 200, /格式变化/],
  [{}, 200, /设备接口异常/]
]) {
  test("Disney error " + code + " " + expected, async () => {
    const r = await run(url => url.endsWith("/devices") ? response(body, code) : undefined);
    assert.match(line(r.html, "Disney+"), expected);
    assert.match(line(r.html, "Netflix"), /2\/2/);
  });
}
for (const [session, expected] of [
  [{}, /地区字段缺失/],
  [{ inSupportedLocation: null }, /地区字段缺失/],
  [{ inSupportedLocation: "unknown" }, /地区字段缺失/],
  [{ inSupportedLocation: false, location: { countryCode: "CN" } }, /地区不支持.*CN/],
  [{ inSupportedLocation: "true" }, /地区检测通过.*地区未知/]
]) {
  test("Disney session semantics " + expected, async () => {
    const r = await run(url => url.endsWith("/graphql") ? response({ extensions: { session } }) : undefined);
    assert.match(line(r.html, "Disney+"), expected);
  });
}
test("Disney token error does not leak anonymous tokens or report a blocked region", async () => {
  const r = await run(url => url.endsWith("/token") ? response({ error: "invalid_client", private_value: "DO-NOT-LOG" }, 401) : undefined);
  assert.match(line(r.html, "Disney+"), /未授权/);
  assert.doesNotMatch(r.html, /DO-NOT-LOG|anonymous-test/);
  assert.equal(r.calls.filter(c => c.url.endsWith("/graphql")).length, 0);
});
for (const [body, code, expected] of [
  ["<title>Just a moment</title>chatgpt", 200, /需要网页验证/],
  ["challenge-platform", 403, /无法判断/],
  ['{"error":{"code":"unsupported_country_region_territory"}}', 403, /地区受限/],
  ["retry", 429, /请求受限/],
  ["unknown page", 200, /页面内容未识别/],
  ["", 302, /重定向/]
]) {
  test("ChatGPT does not equate country or HTTP code with usable chat " + expected, async () => {
    const r = await run(url => url === "https://chatgpt.com/" ? response(body, code) : undefined);
    assert.match(line(r.html, "ChatGPT"), expected);
    assert.doesNotMatch(line(r.html, "ChatGPT"), /支持 🎉/);
  });
}
test("ChatGPT missing trace is unknown region, not blocked", async () => {
  const r = await run(url => url.endsWith("/cdn-cgi/trace") ? response("", 403) : undefined);
  assert.match(line(r.html, "ChatGPT"), /网页可访问.*地区未知/);
});
test("Discovery invalid JSON finishes without raw cookie/token output", async () => {
  const r = await run(url => url.includes("/token?") ? response("invalid JSON") : undefined);
  assert.match(line(r.html, "Discovery+"), /格式变化/);
  assert.equal(r.outputs.length, 1);
});
test("all transport failures finish once with unknown status", async () => {
  const r = await run(() => Promise.reject({ error: "private endpoint DO-NOT-LOG" }));
  assert.match(r.html, /网络或 TLS 异常/);
  assert.doesNotMatch(r.html, /DO-NOT-LOG/);
  assert.equal(r.outputs.length, 1);
});
test("a stalled service times out while other results survive", async () => {
  const r = await run(url => url.endsWith("/devices") ? new Promise(() => {}) : undefined);
  assert.match(line(r.html, "Disney+"), /检测超时/);
  assert.match(line(r.html, "Netflix"), /2\/2/);
  assert.equal(r.outputs.length, 1);
});
test("wait for secondary checks before rendering", async () => {
  const r = await run(url => url.includes("indazn.com") ? new Promise(resolve => setTimeout(() => resolve(happy(url)), 10)) : undefined);
  assert.match(line(r.html, "DAZN"), /地区识别.*JP/);
});
test("policy state failure keeps results and safely escapes the name", async () => {
  const r = await run(undefined, { policy: '<img src=x onerror="x">', state: async () => { throw new Error("failure"); } });
  assert.match(r.html, /&lt;img/);
  assert.doesNotMatch(r.html, /<img/);
  assert.match(line(r.html, "Netflix"), /2\/2/);
});
test("missing policy does not silently test a different route", async () => {
  const r = await run(undefined, { policy: "" });
  assert.equal(r.calls.length, 0);
  assert.match(r.html, /请从 Quantumult X/);
});
test("global deadline finishes once even when checks complete late", async () => {
  const r = await run(() => new Promise(resolve => setTimeout(() => resolve(response("", 500)), 30)), {
    clock: ms => ms === 25000 ? 10 : 100
  });
  assert.match(r.html, /检测未完成/);
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(r.outputs.length, 1);
});
test("task gallery and sample configuration reference this fork's fixed checker", () => {
  const root = path.join(__dirname, "..");
  const gallery = JSON.parse(fs.readFileSync(path.join(root, "Scripts/UI-Action.json"), "utf8"));
  const url = "https://raw.githubusercontent.com/Howaboutcoffee/QuantumultX/master/Scripts/streaming-ui-check.js";
  assert.ok(gallery.task.find(t => t.startsWith("event-interaction " + url)));
  assert.ok(fs.readFileSync(path.join(root, "QuantumultX_Profiles.conf"), "utf8").includes(url));
});
