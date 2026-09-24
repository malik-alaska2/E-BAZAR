/* GET /api/me  →  { configured, ok }  (ok — действует ли вход) */
const { configured, checkSession, bearer, send } = require("./_lib");

module.exports = (req, res) => {
  send(res, 200, { configured: configured(), ok: checkSession(bearer(req)) });
};
