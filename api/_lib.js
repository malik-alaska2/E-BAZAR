/**
 * Общие функции для админки на Vercel.
 *
 * Настройки (Vercel → Project → Settings → Environment Variables):
 *   ADMIN_LOGIN     — логин админа
 *   ADMIN_PASSWORD  — пароль админа
 *   GITHUB_TOKEN    — ключ GitHub с правом Contents: Read and write на репозиторий
 *   SESSION_SECRET  — любая длинная случайная строка (подпись входа)
 *   GITHUB_REPO     — необязательно, по умолчанию malik-alaska2/E-BAZAR
 *   GITHUB_BRANCH   — необязательно, по умолчанию main
 */
const crypto = require("crypto");

const env = (k, d = "") => (process.env[k] || d).trim();
const REPO = () => env("GITHUB_REPO", "malik-alaska2/E-BAZAR");
const BRANCH = () => env("GITHUB_BRANCH", "main");
const SESSION_DAYS = 30;

function configured() {
  return !!(env("ADMIN_LOGIN") && env("ADMIN_PASSWORD") && env("GITHUB_TOKEN") && env("SESSION_SECRET"));
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

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/* ---------- GitHub ---------- */
const encodePath = p => p.split("/").map(encodeURIComponent).join("/");
function gh(path, opts = {}, query = "") {
  return fetch(`https://api.github.com/repos/${REPO()}/contents/${encodePath(path)}${query}`, {
    ...opts,
    headers: {
      Authorization: "Bearer " + env("GITHUB_TOKEN"),
      Accept: "application/vnd.github+json",
      "User-Agent": "e-bazar-admin",
      "Content-Type": "application/json",
    },
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

module.exports = { configured, safeEq, makeSession, checkSession, bearer, send, ghPut, env };
