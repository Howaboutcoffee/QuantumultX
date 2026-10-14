/**
 * Quantumult X interactive streaming checks.
 * Based on KOP-XIAO's streaming-ui-check.js and its original contributors:
 * Hyseen, AtlantisGawrGura, CoiaPrant and Netflixxp.
 *
 * [task_local]
 * event-interaction https://raw.githubusercontent.com/Howaboutcoffee/QuantumultX/master/Scripts/streaming-ui-check.js, tag=流媒体-解锁查询, img-url=checkmark.seal.system, enabled=true
 *
 * Anonymous availability checks only; no account, playback or chat session is tested.
 */
const REQUEST_TIMEOUT = 7000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const policy = typeof $environment === "object" ? $environment.params : "";
// Public Disney browser client identifier, inherited from the upstream checker.
// This is not a subscriber credential. Anonymous device tokens stay in memory.
const DISNEY_CLIENT = "ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84";

function bounded(promise, ms = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("检测超时，无法判断")), ms);
    Promise.resolve(promise).then(value => {
      clearTimeout(timer);
      resolve(value);
    }, error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function request(url, options = {}) {
  try {
    return await bounded($task.fetch({
      ...options, url,
      headers: { "User-Agent": UA, ...options.headers },
      opts: { ...options.opts, policy, "auto-cookie": false, "skip-cert-verify": false }
    }));
  } catch (error) {
    if (error && error.message === "检测超时，无法判断") throw error;
    // Never expose raw transport errors, response bodies, tokens or endpoint IPs.
    throw new Error("网络或 TLS 异常，无法判断");
  }
}

function json(response) {
  try { return JSON.parse(response.body); }
  catch (_) { throw new Error("接口格式变化，无法判断"); }
}

function httpError(response) {
  const code = response.statusCode;
  if (code === 429) return "请求受限（HTTP 429），请稍后重试";
  if (code === 403) return "访问被拒绝或需要验证（HTTP 403），无法判断";
  if (code === 401) return "检测接口未授权（HTTP 401），无法判断";
  if (code >= 300 && code < 400) return "请求发生重定向，无法判断";
  return "接口异常（HTTP " + code + "），无法判断";
}

function requireOK(response, accepted = [200]) {
  if (!accepted.includes(response.statusCode)) throw new Error(httpError(response));
  if (/cf-chl-|challenge-platform|<title>\s*Just a moment/i.test(response.body || "")) {
    throw new Error("需要网页验证，无法判断");
  }
}

function regionLabel(region) {
  return typeof region === "string" && /^[A-Z]{2}$/i.test(region)
    ? " · " + region.toUpperCase() : " · 地区未知";
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

async function testNetflix() {
  const samples = await Promise.all(["81280792", "70143836"].map(async id => {
    try {
      const response = await request("https://www.netflix.com/title/" + id);
      if (response.statusCode === 404) return { available: false };
      requireOK(response);
      const body = (response.body || "").replace(/\\"/g, '"');
      const matches = [...body.matchAll(/"isAvailable"\s*:\s*(true|false)/g)];
      const values = [...new Set(matches.map(m => m[1]))];
      if (values.length !== 1) throw new Error("片目页面格式变化，无法判断");
      const country = body.match(/"requestCountry"\s*:\s*\{[^}]*?"id"\s*:\s*"([A-Z]{2})"/i);
      return { available: values[0] === "true", country: country ? country[1] : "" };
    } catch (error) { return { error: error.message }; }
  }));
  const available = samples.filter(s => s.available === true);
  const countries = [...new Set(samples.map(s => s.country).filter(Boolean))];
  const suffix = countries.length === 1 ? regionLabel(countries[0]) : " · 地区未确认";
  if (available.length) {
    return "非自制片样本可用 " + available.length + "/2" + suffix +
      (samples.some(s => s.error) ? "；另一项检测异常" : "") + "（未验证播放）";
  }
  const failed = samples.find(s => s.error);
  if (failed) return failed.error;
  return "两个样本均不可用" + suffix + "；可能为片库差异或访问限制，不能据此认定仅自制";
}

function checkDisneyResponse(response, accepted = [200]) {
  let data;
  try { data = JSON.parse(response.body); } catch (_) { /* requireOK diagnoses HTTP errors first */ }
  if (data && /"forbidden-location"|"unsupported-location"/i.test(JSON.stringify(data))) {
    throw new Error("地区受限（服务明确返回）");
  }
  requireOK(response, accepted);
  if (!data || typeof data !== "object") throw new Error("Disney 接口格式变化，无法判断");
  return data;
}

async function testDisney() {
  const base = "https://disney.api.edge.bamgrid.com";
  const auth = { Authorization: "Bearer " + DISNEY_CLIENT, "Content-Type": "application/json" };
  const device = checkDisneyResponse(await request(base + "/devices", {
    method: "POST", headers: auth,
    body: JSON.stringify({ deviceFamily: "browser", applicationRuntime: "chrome", deviceProfile: "windows", attributes: {} })
  }), [200, 201]);
  if (typeof device.assertion !== "string" || !device.assertion) {
    throw new Error("Disney 设备接口异常，无法判断");
  }
  const fields = {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    latitude: "0", longitude: "0", platform: "browser",
    subject_token: device.assertion, subject_token_type: "urn:bamtech:params:oauth:token-type:device"
  };
  const token = checkDisneyResponse(await request(base + "/token", {
    method: "POST", headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: Object.keys(fields).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(fields[k])).join("&")
  }));
  if (typeof token.refresh_token !== "string" || !token.refresh_token) {
    throw new Error("Disney 授权接口异常，无法判断");
  }
  const data = checkDisneyResponse(await request(base + "/graph/v1/device/graphql", {
    method: "POST", headers: { ...auth, Authorization: DISNEY_CLIENT },
    body: JSON.stringify({
      query: "mutation refreshToken($input: RefreshTokenInput!) { refreshToken(refreshToken: $input) { activeSession { sessionId } } }",
      variables: { input: { refreshToken: token.refresh_token } }
    })
  }));
  const session = data.extensions && (data.extensions.sdk ? data.extensions.sdk.session : data.extensions.session);
  if (!session || ![true, false, "true", "false"].includes(session.inSupportedLocation)) {
    throw new Error("Disney 地区字段缺失，无法判断");
  }
  const region = regionLabel(session.location && session.location.countryCode);
  return session.inSupportedLocation === true || session.inSupportedLocation === "true"
    ? "地区检测通过" + region + "（未验证播放）" : "地区不支持" + region;
}

async function testChatGPT() {
  const [page, trace] = await Promise.all([
    request("https://chatgpt.com/"),
    request("https://chatgpt.com/cdn-cgi/trace").catch(() => null)
  ]);
  const body = page.body || "";
  if (/"unsupported_country"|unsupported_country_region_territory|not available in your country|not available in your region/i.test(body)) {
    return "地区受限（服务明确返回）";
  }
  requireOK(page);
  if (!/chatgpt/i.test(body)) return "页面内容未识别，无法判断";
  const match = trace && trace.statusCode === 200 && String(trace.body).match(/^loc=([A-Z]{2})\s*$/m);
  return "网页可访问" + regionLabel(match ? match[1] : "") + "（未验证登录或对话）";
}

async function testYouTube() {
  const response = await request("https://www.youtube.com/premium");
  requireOK(response);
  const body = response.body || "";
  if (body.includes("Premium is not available in your country")) return "Premium 地区不支持";
  const region = body.match(/"GL"\s*:\s*"([A-Z]{2})"/i);
  if (!region || !/youtube/i.test(body)) return "页面内容未识别，无法判断";
  return "Premium 页面可访问" + regionLabel(region[1]) + "（未验证订阅资格）";
}

async function testDazn() {
  const response = await request("https://startup.core.indazn.com/misl/v5/Startup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ LandingPageKey: "generic", Platform: "web", PlatformAttributes: {}, Manufacturer: "", PromoCode: "", Version: "2" })
  });
  requireOK(response);
  const data = json(response);
  const region = JSON.stringify(data).match(/"GeolocatedCountry":"([A-Z]{2})"/i);
  if (!region) return "接口未返回地区，无法判断";
  return "地区识别" + regionLabel(region[1]) + "（未验证播放权限）";
}

async function testParamount() {
  const response = await request("https://www.paramountplus.com/", { opts: { redirection: false } });
  requireOK(response);
  if (!/paramount/i.test(response.body || "")) return "页面内容未识别，无法判断";
  return "网页可访问（未验证播放权限）";
}

async function testDiscovery() {
  const base = "https://us1-prod-direct.discoveryplus.com";
  const response = await request(base + "/token?deviceId=d1a4a5d25212400d1e6985984604d740&realm=go&shortlived=true");
  requireOK(response);
  const data = json(response);
  const token = data && data.data && data.data.attributes && data.data.attributes.token;
  if (typeof token !== "string" || !token || /[;\r\n]/.test(token)) {
    throw new Error("Discovery 授权接口异常，无法判断");
  }
  const user = await request(base + "/users/me", { headers: { Cookie: "st=" + token } });
  requireOK(user);
  const info = json(user);
  const region = info && info.data && info.data.attributes && info.data.attributes.currentLocationTerritory;
  if (typeof region !== "string" || !/^[A-Z]{2}$/i.test(region)) return "接口未返回地区，无法判断";
  return "地区识别" + regionLabel(region) + "（未验证播放权限）";
}

// Keep the upstream compact UI; full evidence remains in the row title.
function displayResult(value) {
  let text = value
    .replace(/（未验证[^）]*）/g, "")
    .replace("非自制片样本可用 2/2", "样本可用")
    .replace("非自制片样本可用 1/2", "样本可用 1/2")
    .replace("地区检测通过", "地区支持")
    .replace("Premium 页面可访问", "网页可访问")
    .replace("；可能为片库差异或访问限制，不能据此认定仅自制", "")
    .replace("（服务明确返回）", "")
    .replace("访问被拒绝或需要验证", "需要验证/访问受限")
    .replace("，请稍后重试", "")
    .replace("，无法判断", "")
    .replace(/ · ([A-Z]{2})\b/g, (_, country) => {
      const flag = [...country].map(c => String.fromCodePoint(127397 + c.charCodeAt(0))).join("");
      return " ➟ ⟦" + flag + "⟧";
    });
  const icon = /超时/.test(value) ? "🚦"
    : /地区受限|地区不支持/.test(value) ? "🚫"
    : /两个样本均不可用/.test(value) ? "⚠️"
    : /异常|无法判断/.test(value) ? "❗️"
    : /样本可用|地区检测通过|网页可访问|地区识别/.test(value) ? "🎉" : "❗️";
  return text + " " + icon;
}

function render(rows, selected) {
  const order = ["DAZN", "Discovery+", "Paramount+", "Disney+", "ChatGPT", "Netflix", "YouTube Premium"];
  const names = { DAZN: "Dazn", "Discovery+": "Discoveryᐩ", "Paramount+": "Paramountᐩ", "Disney+": "Disneyᐩ" };
  const content = [...rows].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([name, value]) => "<b>" + escapeHTML(names[name] || name) + ": </b>" +
      '<span title="' + escapeHTML(value) + '">' + escapeHTML(displayResult(value)) + "</span>")
    .join("<br><br>");
  const divider = "--------------------------------------";
  return '<p style="text-align: center; font-family: -apple-system; font-size: large; font-weight: thin">' +
    divider + "<br>" + content + "<br>" + divider + "<br>" +
    '<font color="#CD5C5C"><b>节点</b> ➟ ' + escapeHTML(selected || "未指定") + "</font></p>";
}

async function main() {
  const checks = [
    ["Netflix", testNetflix], ["Disney+", testDisney], ["ChatGPT", testChatGPT],
    ["YouTube Premium", testYouTube], ["DAZN", testDazn],
    ["Paramount+", testParamount], ["Discovery+", testDiscovery]
  ];
  let rows = checks.map(([name]) => [name, "检测未完成，无法判断"]);
  let selected = typeof policy === "string" ? policy : "";
  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    $done({
      title: "    📺  流媒体服务查询",
      htmlMessage: render(rows, selected)
    });
  }
  const deadline = setTimeout(finish, 25000);
  try {
    if (!selected) {
      rows = [["检测未开始", "请从 Quantumult X 节点或策略菜单运行本任务"]];
      return;
    }
    await Promise.all(checks.map(async ([name, check], index) => {
      try { rows[index] = [name, await check()]; }
      catch (error) { rows[index] = [name, error.message || "检测异常，无法判断"]; }
    }));
    // Policy display failure must not discard completed service checks.
    if (typeof $configuration !== "undefined") {
      try {
        const state = await bounded($configuration.sendMessage({ action: "get_policy_state", content: selected }), 1500);
        const chain = state && state.ret && state.ret[selected];
        if (Array.isArray(chain) && chain.length) selected = chain.join(" ➟ ");
        else if (typeof chain === "string" && chain) selected = chain;
      } catch (_) { /* Keep the requested policy name. */ }
    }
  } finally { finish(); }
}
main();
