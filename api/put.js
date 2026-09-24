/* POST /api/put  { path, content (base64), message }  — сохранение каталога и фото в GitHub */
const { checkSession, bearer, send, ghPut } = require("./_lib");

const ALLOWED = /^(catalog\.json|photos\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp))$/;
const MAX_B64 = 3.5 * 1024 * 1024;

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  if (!checkSession(bearer(req))) return send(res, 401, { error: "session" });
  const { path = "", content = "", message = "" } = req.body || {};
  if (!ALLOWED.test(path)) return send(res, 400, { error: "path" });
  if (typeof content !== "string" || !content || content.length > MAX_B64 || !/^[A-Za-z0-9+/=]+$/.test(content))
    return send(res, 400, { error: "content" });
  try {
    await ghPut(path, content, String(message || "admin: " + path).slice(0, 200));
    send(res, 200, { ok: true });
  } catch (e) {
    send(res, 502, { error: "github", detail: String(e.message || e).slice(0, 200) });
  }
};
