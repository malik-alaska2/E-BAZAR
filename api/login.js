/* POST /api/login  { login, password }  →  { token } */
const { configured, safeEq, makeSession, send, env } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  if (!configured()) return send(res, 503, { error: "not_configured" });
  const { login = "", password = "" } = req.body || {};
  const okLogin = safeEq(String(login).trim().toLowerCase(), env("ADMIN_LOGIN").toLowerCase());
  const okPass = safeEq(String(password), env("ADMIN_PASSWORD"));
  if (!(okLogin && okPass)) {
    await new Promise(r => setTimeout(r, 900));   // замедляем подбор пароля
    return send(res, 401, { error: "wrong" });
  }
  send(res, 200, { token: makeSession() });
};
