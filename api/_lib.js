/**
 * Общие функции для админки на Vercel.
 *
 * Настройки (Vercel → Project → Settings → Environment Variables):
 *   ADMIN_LOGIN     — логин админа
 *   ADMIN_PASSWORD  — пароль админа
 *   SESSION_SECRET  — любая длинная случайная строка (подпись входа)
 *
 * Доступ к GitHub — одно из двух:
 *   GH_APP_ID + GH_APP_PRIVATE_KEY — GitHub App (рекомендуется: ключ не истекает,
 *                     сервер сам получает временный доступ на час)
 *   GH_APP_INSTALLATION_ID — необязательно, иначе находится автоматически
 *   GITHUB_TOKEN    — личный ключ GitHub с правом Contents: Read and write (истекает, нужно менять)
 *
 *   GITHUB_REPO     — необязательно, по умолчанию malik-alaska2/E-BAZAR
 *   GITHUB_BRANCH   — необязательно, по умолчанию main
 */
const crypto = require("crypto");

const env = (k, d = "") => (process.env[k] || d).trim();
const REPO = () => env("GITHUB_REPO", "malik-alaska2/E-BAZAR");
const BRANCH = () => env("GITHUB_BRANCH", "main");
const SESSION_DAYS = 30;

function configured() {
  return !!(env("ADMIN_LOGIN") && env("ADMIN_PASSWORD") && (appConfigured() || env("GITHUB_TOKEN")) && env("SESSION_SECRET"));
}

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* подпись входа: смена логина, пароля или SESSION_SECRET выкидывает все старые входы */
function sign(data) {
  return crypto.createHmac("sha256", env("SESSION_SECRET") + "|" + env("ADMIN_PASSWORD")).update(data).digest("base64url");
}
function makeSession() {
  const payload = Buffer.from(JSON.stringify({ l: env("ADMIN_LOGIN"), exp: Date.now() + SESSION_DAYS * 864e5 })).toString("base64url");
  return payload + "." + sign(payload);
}
function checkSession(token) {
  if (!configured() || !token) return false;
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig || !safeEq(sign(payload), sig)) return false;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString());
    return d.exp > Date.now() && safeEq(d.l, env("ADMIN_LOGIN"));
  } catch (e) { return false; }
}
const bearer = req => {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
};

/* админка с GitHub Pages (owner.github.io) ходит сюда с другого адреса — разрешаем только ему */
function cors(req, res) {
  const origin = req.headers.origin || "";
  if (origin === `https://${REPO().split("/")[0].toLowerCase()}.github.io`) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return true; }
  return false;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/* ---------- GitHub ---------- */
const ghHeaders = auth => ({
  Authorization: "Bearer " + auth,
  Accept: "application/vnd.github+json",
  "User-Agent": "e-bazar-admin",
  "Content-Type": "application/json",
});

/* GitHub App: подписываем JWT приватным ключом и меняем его на ключ установки (живёт 1 час) */
function appConfigured() { return !!(env("GH_APP_ID") && env("GH_APP_PRIVATE_KEY")); }
let appToken = { token: "", exp: 0 };
function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  const part = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = part({ alg: "RS256", typ: "JWT" }) + "." + part({ iat: now - 60, exp: now + 540, iss: env("GH_APP_ID") });
  const key = env("GH_APP_PRIVATE_KEY").replace(/\\n/g, "\n");   // в Vercel ключ могли вставить одной строкой с \n
  return data + "." + crypto.sign("sha256", Buffer.from(data), key).toString("base64url");
}
async function ghAuth() {
  if (!appConfigured()) return env("GITHUB_TOKEN");
  if (appToken.token && appToken.exp > Date.now() + 5 * 60e3) return appToken.token;
  const jwt = appJwt();
  let id = env("GH_APP_INSTALLATION_ID");
  if (!id) {
    const r = await fetch(`https://api.github.com/repos/${REPO()}/installation`, { headers: ghHeaders(jwt) });
    if (!r.ok) throw new Error(`GitHub App не установлен на ${REPO()} (${r.status})`);
    id = (await r.json()).id;
  }
  const r = await fetch(`https://api.github.com/app/installations/${id}/access_tokens`, { method: "POST", headers: ghHeaders(jwt) });
  if (!r.ok) throw new Error(`GitHub App: не выдан ключ установки (${r.status})`);
  const j = await r.json();
  appToken = { token: j.token, exp: Date.parse(j.expires_at) };
  return appToken.token;
}

const encodePath = p => p.split("/").map(encodeURIComponent).join("/");
async function gh(path, opts = {}, query = "") {
  return fetch(`https://api.github.com/repos/${REPO()}/contents/${encodePath(path)}${query}`, {
    ...opts,
    headers: ghHeaders(await ghAuth()),
  });
}
async function ghSha(path) {
  const res = await gh(path, {}, "?ref=" + encodeURIComponent(BRANCH()) + "&_=" + Date.now());
  if (res.ok) { const j = await res.json(); return j && j.sha; }
  return undefined;
}
/* запись файла; при конфликте версий (409/422) берём свежую версию и повторяем */
async function ghPut(path, contentBase64, message) {
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const sha = await ghSha(path);
    const res = await gh(path, {
      method: "PUT",
      body: JSON.stringify({ message, content: contentBase64, branch: BRANCH(), ...(sha ? { sha } : {}) }),
    });
    if (res.ok) return res.json();
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch (e) {}
    last = `${res.status} ${detail}`;
    if (res.status === 409 || res.status === 422) { await new Promise(r => setTimeout(r, 800 * attempt)); continue; }
    break;
  }
  throw new Error(last);
}

/* JSON-файл в ветке: прочитать ({ data, sha }), data = null, если файла нет */
async function ghReadJson(path, branch) {
  const res = await gh(path, {}, "?ref=" + encodeURIComponent(branch) + "&_=" + Date.now());
  if (res.status === 404) return { data: null, sha: undefined };
  if (!res.ok) throw new Error(`${res.status} read ${path}`);
  const j = await res.json();
  return { data: JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8") || "null"), sha: j.sha };
}
/* прочитать → изменить → записать; если файл успели поменять (409/422), начинаем заново со свежей версии */
async function ghUpdateJson(path, branch, change, message) {
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const { data, sha } = await ghReadJson(path, branch);
    const next = change(data);
    const content = Buffer.from(JSON.stringify(next, null, 1)).toString("base64");
    const res = await gh(path, {
      method: "PUT",
      body: JSON.stringify({ message, content, branch, ...(sha ? { sha } : {}) }),
    });
    if (res.ok) return next;
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch (e) {}
    last = `${res.status} ${detail}`;
    if (res.status === 409 || res.status === 422) { await new Promise(r => setTimeout(r, 300 * attempt)); continue; }
    break;
  }
  throw new Error(last);
}

module.exports = { configured, safeEq, makeSession, checkSession, bearer, send, cors, ghPut, ghReadJson, ghUpdateJson, env };
