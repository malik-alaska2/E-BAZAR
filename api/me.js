/* GET /api/me  →  { configured, ok }  (ok — действует ли вход) */
const { configured, checkSession, bearer, send, cors } = require("./_lib");

module.exports = (req, res) => {
  if (cors(req, res)) return;
  send(res, 200, { configured: configured(), ok: checkSession(bearer(req)) });
};
