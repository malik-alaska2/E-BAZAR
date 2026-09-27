/* Отзывы о товарах. Хранятся в reviews.json в отдельной ветке (по умолчанию "reviews"),
 * чтобы каждый отзыв не пересобирал сайт.
 *   GET  /api/reviews                                  →  { "<id товара>": [{ id, n, s, t, d }] }
 *   POST /api/reviews  { pid, name, stars, text }      →  { ok, review }
 *   POST /api/reviews  { action:"delete", pid, id }    —  только для админа (вход по паролю)
 */
const crypto = require("crypto");
const { checkSession, bearer, send, cors, ghReadJson, ghUpdateJson, env } = require("./_lib");

const FILE = "reviews.json";
const BRANCH = () => env("REVIEWS_BRANCH", "reviews");
const MAX_PER_PRODUCT = 300;

/* простая защита от спама: не больше 5 отзывов с одного адреса за 10 минут (в пределах одного сервера) */
const recent = new Map();
function tooMany(ip) {
  const now = Date.now(), list = (recent.get(ip) || []).filter(t => now - t < 10 * 60e3);
  list.push(now); recent.set(ip, list);
  return list.length > 5;
}
const clean = (s, max) => String(s || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  try {
    if (req.method === "GET") {
      const { data } = await ghReadJson(FILE, BRANCH());
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=0, s-maxage=15, stale-while-revalidate=300");
      return res.end(JSON.stringify(data || {}));
    }
    if (req.method !== "POST") return send(res, 405, { error: "method" });
    const b = req.body || {};
    const pid = Number(b.pid);
    if (!Number.isInteger(pid) || pid <= 0) return send(res, 400, { error: "pid" });

    if (b.action === "delete") {
      if (!checkSession(bearer(req))) return send(res, 401, { error: "session" });
      await ghUpdateJson(FILE, BRANCH(), data => {
        data = data || {};
        data[pid] = (data[pid] || []).filter(r => r.id !== String(b.id));
        if (!data[pid].length) delete data[pid];
        return data;
      }, "review: delete");
      return send(res, 200, { ok: true });
    }

    if (b.website) return send(res, 200, { ok: true });   // ловушка для ботов: это поле люди не видят
    const stars = Number(b.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return send(res, 400, { error: "stars" });
    const name = clean(b.name, 40), text = clean(b.text, 600);
    if (!name) return send(res, 400, { error: "name" });
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (tooMany(ip)) return send(res, 429, { error: "rate" });

    const { data: catalog } = await ghReadJson("catalog.json", env("GITHUB_BRANCH", "main"));
    if (!catalog || !(catalog.products || []).some(p => p.id === pid)) return send(res, 400, { error: "pid" });

    const review = { id: crypto.randomBytes(5).toString("hex"), n: name, s: stars, t: text, d: new Date().toISOString() };
    await ghUpdateJson(FILE, BRANCH(), data => {
      data = data || {};
      data[pid] = [review, ...(data[pid] || [])].slice(0, MAX_PER_PRODUCT);
      return data;
    }, `review: ${pid} ${"★".repeat(stars)}`);
    send(res, 200, { ok: true, review });
  } catch (e) {
    console.error("reviews failed:", String(e.message || e));
    send(res, 502, { error: "github" });
  }
};
