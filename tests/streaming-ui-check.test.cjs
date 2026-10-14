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
  if (url === "https://gemini.google.com/") return response('<title>Google Gemini</title><script>window.WIZ_global_data={};</script>,2,1,200,"JPN"');
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
  const names = { "Disney+": "Disneyᐩ", "YouTube Premium": "YouTube" };
  const row = html.split("<br><br>").find(part => part.includes("<b>" + (names[name] || name) + ": </b>")) || "";
  const detail = row.match(/<span title="([^"]*)">/);
  return detail ? detail[1] : row;
}

test("normal responses: evidence-specific labels, selected policy, verified TLS, no sensitive logging", async () => {
  const r = await run();
  assert.match(line(r.html, "Netflix"), /样本可用 2\/2.*JP/);
  assert.match(line(r.html, "Disney+"), /地区检测通过.*JP/);
  assert.match(line(r.html, "ChatGPT"), /网页可访问.*未验证登录或对话/);
  assert.match(line(r.html, "Gemini"), /网页可访问.*JP/);
  assert.doesNotMatch(r.html, /完整支持|anonymous-test/);
  assert.deepEqual(r.logs, []);
  assert.ok(r.calls.every(c => c.opts.policy === "Example Proxy" && c.opts["skip-cert-verify"] === false && c.opts["auto-cookie"] === false));
  assert.ok(r.calls.every(c => !/indazn|paramountplus|discoveryplus|claude|anthropic/.test(c.url)));
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
  const r = await run(url => url === "https://chatgpt.com/" ? new Promise(resolve => setTimeout(() => resolve(happy(url)), 10)) : undefined);
  assert.match(line(r.html, "ChatGPT"), /JP/);
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


test("compact presentation: five services in requested order, flags, separators and red node footer", async () => {
  const r = await run();
  const labels = ["ChatGPT", "Gemini", "Netflix", "Disneyᐩ", "YouTube"];
  const positions = labels.map(name => r.html.indexOf("<b>" + name + ": </b>"));
  assert.ok(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])));
  assert.match(r.html, /text-align: center; font-family: -apple-system; font-size: large/);
  assert.match(r.html, /color="#CD5C5C"><b>节点<\/b> ➟ Example Proxy/);
  const visible = r.html.replace(/<[^>]*>/g, "");
  for (const label of labels) {
    assert.ok(visible.includes(label + ": 支持 ➟ ⟦🇯🇵⟧ 🎉"), label + " must render a successful check as supported");
  }
  assert.doesNotMatch(visible, /未验证|匿名检测|完整支持|检测策略|样本可用|网页可访问|地区识别|地区支持|Dazn|Discovery|Paramount|Claude/);
  assert.equal((visible.match(/--------------------------------------/g) || []).length, 2);
});
test("Disney accepts a 201 Created device assertion and continues region verification", async () => {
  const r = await run(url => url.endsWith("/devices") ? response({ assertion: "anonymous-created-device" }, 201) : undefined);
  assert.match(line(r.html, "Disney+"), /地区检测通过.*JP/);
  assert.ok(r.calls.some(c => c.url.endsWith("/graphql")));
});
test("Disney 201 without a device assertion is still unknown", async () => {
  const r = await run(url => url.endsWith("/devices") ? response({}, 201) : undefined);
  assert.match(line(r.html, "Disney+"), /设备接口异常/);
});
test("non-device 201 responses are not silently accepted", async () => {
  const r = await run(url => url.endsWith("/token") ? response({ refresh_token: "anonymous-test-refresh" }, 201) : undefined);
  assert.match(line(r.html, "Disney+"), /HTTP 201/);
});
test("node footer uses the resolved chain without duplicating the policy name", async () => {
  const r = await run(undefined, { state: async () => ({ ret: { "Example Proxy": ["Example Proxy", "Example Node"] } }) });
  assert.match(r.html, /节点<\/b> ➟ Example Proxy ➟ Example Node/);
  assert.doesNotMatch(r.html, /Example Proxy ➟ Example Proxy/);
});


test("rate limiting never receives a success icon", async () => {
  const r = await run(url => url === "https://chatgpt.com/" ? response("", 429) : undefined);
  const row = r.html.split("<br><br>").find(value => value.includes("<b>ChatGPT: </b>"));
  assert.match(row, /❗️/);
  assert.doesNotMatch(row, /🎉/);
});


test("Gemini current app bootstrap works without the removed numeric flag", async () => {
  const r = await run(url => url === "https://gemini.google.com/" ? response('<title>Gemini</title>window.WIZ_global_data={};,2,1,200,"SGP"') : undefined);
  assert.match(r.html.replace(/<[^>]*>/g, ""), /Gemini: 支持 ➟ ⟦🇸🇬⟧ 🎉/);
});
for (const body of ["Gemini isn't available in your country", "Gemini is not available in your country", "Gemini is currently not supported in this region", "45631641,null,false"]) {
  test("Gemini explicit region restriction: " + body, async () => {
    const r = await run(url => url === "https://gemini.google.com/" ? response(body) : undefined);
    assert.match(line(r.html, "Gemini"), /地区受限/);
    assert.match(r.html.replace(/<[^>]*>/g, ""), /Gemini: 未支持 🚫/);
  });
}
test("Gemini legacy true flag remains compatible", async () => {
  const r = await run(url => url === "https://gemini.google.com/" ? response('45631641,null,true,2,1,200,"USA"') : undefined);
  assert.match(r.html.replace(/<[^>]*>/g, ""), /Gemini: 支持 ➟ ⟦🇺🇸⟧ 🎉/);
});
test("Gemini consent page is unknown, not a successful availability check", async () => {
  const r = await run(url => url === "https://gemini.google.com/" ? {
    ...response("<title>Before you continue to Gemini</title>WIZ_global_data"),
    headers: { "X-Originating-URL": "https://consent.google.com/" }
  } : undefined);
  assert.match(line(r.html, "Gemini"), /需要网页验证/);
});
test("Gemini generic 200 page is unknown, not unsupported", async () => {
  const r = await run(url => url === "https://gemini.google.com/" ? response("unknown page") : undefined);
  assert.match(line(r.html, "Gemini"), /格式变化/);
});
test("unknown country code is not replaced with a made-up flag", async () => {
  const r = await run(url => url === "https://gemini.google.com/" ? response('45631641,null,true,2,1,200,"ZZZ"') : undefined);
  assert.match(r.html.replace(/<[^>]*>/g, ""), /Gemini: 支持 🎉/);
  assert.match(line(r.html, "Gemini"), /地区未知/);
});
test("native transport timeout is displayed as timeout", async () => {
  const r = await run(url => url === "https://chatgpt.com/" ? Promise.reject({ error: "The request timed out. (-1001)" }) : undefined);
  assert.match(r.html.replace(/<[^>]*>/g, ""), /ChatGPT: 检测超时 🚦/);
});
test("Netflix unavailable samples produce the requested compact unsupported label", async () => {
  const r = await run(url => url.includes("netflix.com") ? response('{"isAvailable":false}') : undefined);
  assert.match(r.html.replace(/<[^>]*>/g, ""), /Netflix: 未支持 🚫/);
});


test("Taiwan uses the requested China flag without changing the detected region", async () => {
  const r = await run(url => {
    if (url.endsWith("/graphql")) return response({ extensions: { session: { inSupportedLocation: true, location: { countryCode: "TW" } } } });
    if (url === "https://gemini.google.com/") return response('45631641,null,true,2,1,200,"TWN"');
  });
  const visible = r.html.replace(/<[^>]*>/g, "");
  assert.match(visible, /Disneyᐩ: 支持 ➟ ⟦🇨🇳⟧ 🎉/);
  assert.match(visible, /Gemini: 支持 ➟ ⟦🇨🇳⟧ 🎉/);
  assert.doesNotMatch(visible, /🇹🇼/);
  assert.match(line(r.html, "Disney+"), /TW/);
  assert.match(line(r.html, "Gemini"), /TW/);
});

for (const [body, code, expected] of [
  ['YouTube Premium {"GL":"TW"}', 200, "支持 ➟ ⟦🇨🇳⟧ 🎉"],
  ["Premium is not available in your country", 200, "未支持 🚫"],
  ["<title>Just a moment</title>", 200, "需要验证 ❗️"],
  ["retry later", 429, "检测异常 ❗️"],
  ["<html>login</html>", 200, "检测异常 ❗️"]
]) {
  test("YouTube renders " + code + " " + expected, async () => {
    const r = await run(url => url.includes("youtube.com") ? response(body, code) : undefined);
    const visible = r.html.replace(/<[^>]*>/g, "");
    assert.ok(visible.includes("YouTube: " + expected), visible);
  });
}
