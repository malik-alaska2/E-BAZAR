/**
 * E-Bazar — сервер магазина для VPS (Node.js, без внешних библиотек).
 *
 * Что делает:
 *   отдаёт сайт магазина (public/index.html)
 *   POST /api/order          — принимает заказ и присылает его вам в Telegram
 *   GET  /api/products       — каталог (товары + разделы)
 *   POST /api/admin/check    — проверка пароля админа
 *   PUT  /api/admin/products — сохранение каталога из админки (фото сохраняются в /uploads)
 *   POST /api/tg             — вебхук бота (ответ на /start с кнопкой магазина)
 *   GET  /api/setup          — разовая автонастройка бота (вебхук, кнопка меню, команды)
 *   GET  /api/diag           — диагностика: состояние бота и тестовое сообщение
 *
 * Настройки берутся из файла .env рядом с этим файлом.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const DATA_FILE = path.join(DATA_DIR, "catalog.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

/* ---------- настройки (.env) ---------- */
function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i === -1) continue;
    const key = s.slice(0, i).trim();
    let val = s.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");

for (const dir of [DATA_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/* ---------- вспомогательное ---------- */
const escHtml = (s) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const fmtTry = (n) =>
  new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 }).format(Number(n) || 0) + " ₺";

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limitMb = 25) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitMb * 1024 * 1024) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* ---------- Telegram ---------- */
function tgApi(method, payload) {
  return new Promise((resolve) => {
    if (!BOT_TOKEN) return resolve({ ok: false, description: "BOT_TOKEN не задан" });
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/${method}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 15000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, description: "bad response" }); }
        });
      }
    );
    req.on("error", (e) => resolve({ ok: false, description: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, description: "timeout" }); });
    req.write(body);
    req.end();
  });
}

const sendTelegram = (chatId, text, extra = {}) =>
  tgApi("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });

const webhookSecret = () =>
  crypto.createHash("sha256").update("ebazar:" + BOT_TOKEN).digest("hex").slice(0, 32);

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

/* ---------- каталог ---------- */
function readCatalog() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      products: Array.isArray(raw.products) ? raw.products : [],
      categories: Array.isArray(raw.categories) ? raw.categories : [],
    };
  } catch {
    return { products: [], categories: [] };
  }
}

/* фото из админки приходят как data:image/... — сохраняем их файлами в /uploads */
function extractPhotos(products) {
  return products.map((p) => {
    const img = typeof p.img === "string" ? p.img : "";
    const m = img.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
    if (!m) return p;
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const buf = Buffer.from(m[2], "base64");
    const name = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16) + "." + ext;
    const file = path.join(UPLOADS_DIR, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
    return { ...p, img: "/uploads/" + name };
  });
}

function writeCatalog(products, categories) {
  const clean = extractPhotos(products);
  fs.writeFileSync(DATA_FILE, JSON.stringify({ products: clean, categories }, null, 2));
  return clean;
}

function saveOrder(order) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8")); } catch {}
  list.unshift(order);
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(list.slice(0, 2000), null, 2));
}

/* ---------- заказы ---------- */
const DELIVERY = { delivery: "🚚 Доставка / Yetkazish", pickup: "🏪 Самовывоз / Olib ketish" };

async function handleOrder(req, res) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
    return sendJson(res, { error: "BOT_TOKEN / ADMIN_CHAT_ID не заданы в .env" }, 500);
  }
  let o;
  try {
    o = JSON.parse(await readBody(req, 2));
  } catch {
    return sendJson(res, { error: "bad json" }, 400);
  }
  if (!o || !o.name || !o.phone || !Array.isArray(o.items) || !o.items.length) {
    return sendJson(res, { error: "missing fields" }, 400);
  }
  if (String(o.name).length > 100 || String(o.phone).length > 40 || o.items.length > 100) {
    return sendJson(res, { error: "too long" }, 400);
  }

  const invoice =
    new Date().toISOString().slice(2, 10).replace(/-/g, "") + "-" +
    Math.floor(1000 + Math.random() * 9000);

  const lines = o.items
    .map((i) => `• ${escHtml(i.name)} — ${i.qty} × ${fmtTry(i.price)} = <b>${fmtTry((Number(i.price) || 0) * (Number(i.qty) || 0))}</b>`)
    .join("\n");

  const tgUser = o.tgUser && o.tgUser.id ? o.tgUser : null;

  const msg =
    `🛍 <b>Новый заказ №${invoice}</b>\n\n` +
    `${lines}\n\n` +
    (Number(o.deliveryFee) > 0 ? `Доставка: ${fmtTry(o.deliveryFee)}\n` : "") +
    `💰 <b>Итого: ${fmtTry(o.total)}</b>\n` +
    `💵 Оплата наличными при получении\n\n` +
    `👤 ${escHtml(o.name)}\n` +
    `📞 ${escHtml(o.phone)}\n` +
    `${DELIVERY[o.deliveryMode] || ""}\n` +
    (o.address && o.address !== "-" ? `📍 ${escHtml(o.address)}\n` : "") +
    (o.comment ? `💬 ${escHtml(o.comment)}\n` : "") +
    (tgUser && tgUser.username ? `✈️ @${escHtml(tgUser.username)}\n` : "") +
    (tgUser ? `🆔 <code>${tgUser.id}</code>` : "🌐 Заказ с сайта");

  const sent = await sendTelegram(ADMIN_CHAT_ID, msg);
  if (!sent.ok) return sendJson(res, { error: "telegram: " + (sent.description || "") }, 502);

  if (tgUser) {
    const confirm =
      o.lang === "uz"
        ? `✅ Buyurtmangiz qabul qilindi!\n№${invoice}\nJami: ${fmtTry(o.total)}\nTez orada bog'lanamiz.`
        : o.lang === "en"
        ? `✅ Your order has been received!\n#${invoice}\nTotal: ${fmtTry(o.total)}\nWe will contact you soon.`
        : `✅ Ваш заказ принят!\n№${invoice}\nИтого: ${fmtTry(o.total)}\nСкоро свяжемся с вами.`;
    sendTelegram(tgUser.id, confirm).catch(() => {});
  }

  saveOrder({ ...o, invoice, date: new Date().toISOString() });
  return sendJson(res, { ok: true, invoice });
}

/* ---------- бот ---------- */
function welcomeText(lang) {
  if (lang === "uz")
    return "🛍 <b>E-Bazar'ga xush kelibsiz!</b>\n\nQuyidagi tugmani bosib do'konni oching, mahsulot tanlang va buyurtma bering. To'lov — qabul qilishda naqd pul.";
  if (lang === "en")
    return "🛍 <b>Welcome to E-Bazar!</b>\n\nTap the button below to open the shop, pick your products and place an order. Payment — cash on delivery.";
  return "🛍 <b>Добро пожаловать в E-Bazar!</b>\n\nНажмите кнопку ниже, чтобы открыть магазин, выберите товары и оформите заказ. Оплата — наличными при получении.";
}

async function handleWebhook(req, res, origin) {
  if (req.headers["x-telegram-bot-api-secret-token"] !== webhookSecret()) {
    return sendJson(res, { error: "forbidden" }, 403);
  }
  let update;
  try { update = JSON.parse(await readBody(req, 1)); } catch { return sendJson(res, { ok: true }); }
  const msg = update.message;
  if (msg && msg.chat && msg.chat.type === "private") {
    let lang = (msg.from?.language_code || "ru").slice(0, 2);
    if (!["ru", "uz", "en"].includes(lang)) lang = "ru";
    await sendTelegram(msg.chat.id, welcomeText(lang), {
      reply_markup: {
        inline_keyboard: [[{ text: "🛒 Открыть магазин / Do'kon / Shop", web_app: { url: origin + "/" } }]],
      },
    });
  }
  return sendJson(res, { ok: true });
}

async function handleSetup(res, origin) {
  if (!BOT_TOKEN) return sendJson(res, { error: "BOT_TOKEN не задан в .env" }, 500);
  const me = await tgApi("getMe", {});
  if (!me.ok) return sendJson(res, { error: "BOT_TOKEN неверный", details: me.description }, 500);
  const webhook = await tgApi("setWebhook", {
    url: origin + "/api/tg",
    secret_token: webhookSecret(),
    drop_pending_updates: true,
    allowed_updates: ["message"],
  });
  const menu = await tgApi("setChatMenuButton", {
    menu_button: { type: "web_app", text: "🛒 Магазин", web_app: { url: origin + "/" } },
  });
  const commands = await tgApi("setMyCommands", {
    commands: [{ command: "start", description: "Открыть магазин / Do'konni ochish / Open shop" }],
  });
  return sendJson(res, {
    ok: true,
    бот: "@" + me.result.username,
    адрес: origin,
    вебхук: webhook.ok,
    кнопка_меню: menu.ok,
    команды: commands.ok,
  });
}

async function handleDiag(res, origin) {
  const out = {
    адрес: origin,
    BOT_TOKEN_задан: !!BOT_TOKEN,
    ADMIN_CHAT_ID: ADMIN_CHAT_ID || null,
    ADMIN_PASSWORD_задан: !!ADMIN_PASSWORD,
    товаров: readCatalog().products.length,
  };
  if (BOT_TOKEN) {
    const me = await tgApi("getMe", {});
    out.бот = me.ok ? "@" + me.result.username : "ТОКЕН НЕВЕРНЫЙ";
    const wh = await tgApi("getWebhookInfo", {});
    out.вебхук = wh.ok
      ? { url: wh.result.url, последняя_ошибка: wh.result.last_error_message || "нет", ожидают: wh.result.pending_update_count }
      : "не удалось получить";
    if (ADMIN_CHAT_ID) {
      const t = await sendTelegram(ADMIN_CHAT_ID, "✅ Проверка связи: магазин E-Bazar работает на вашем сервере.");
      out.тестовое_сообщение = t.ok ? "ОТПРАВЛЕНО" : "ОШИБКА: " + (t.description || "");
    }
  }
  return sendJson(res, out);
}

/* ---------- статика ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

function serveFile(res, file, cache) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Не найдено");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": cache || "no-cache",
      "Content-Length": data.length,
    });
    res.end(data);
  });
}

/* ---------- сервер ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const origin = baseUrl(req);

  try {
    if (p === "/api/order" && req.method === "POST") return await handleOrder(req, res);
    if (p === "/api/tg" && req.method === "POST") return await handleWebhook(req, res, origin);
    if (p === "/api/setup" && req.method === "GET") return await handleSetup(res, origin);
    if (p === "/api/diag" && req.method === "GET") return await handleDiag(res, origin);

    if (p === "/api/products" && req.method === "GET") return sendJson(res, readCatalog());

    if (p === "/api/admin/check" && req.method === "POST") {
      const ok = ADMIN_PASSWORD && req.headers["x-admin-password"] === ADMIN_PASSWORD;
      return sendJson(res, ok ? { ok: true } : { error: "forbidden" }, ok ? 200 : 403);
    }

    if (p === "/api/admin/products" && req.method === "PUT") {
      if (!ADMIN_PASSWORD || req.headers["x-admin-password"] !== ADMIN_PASSWORD) {
        return sendJson(res, { error: "forbidden" }, 403);
      }
      let body;
      try { body = JSON.parse(await readBody(req, 25)); } catch { return sendJson(res, { error: "bad json" }, 400); }
      const products = Array.isArray(body) ? body : body.products;
      const categories = Array.isArray(body) ? [] : body.categories || [];
      if (!Array.isArray(products) || products.length > 1000) return sendJson(res, { error: "bad data" }, 400);
      if (!Array.isArray(categories) || categories.length > 200) return sendJson(res, { error: "bad data" }, 400);
      const saved = writeCatalog(products, categories);
      return sendJson(res, { ok: true, products: saved, categories });
    }

    /* загруженные фото товаров */
    if (p.startsWith("/uploads/") && req.method === "GET") {
      const name = path.basename(p);
      return serveFile(res, path.join(UPLOADS_DIR, name), "public, max-age=31536000, immutable");
    }

    /* сайт магазина */
    if (req.method === "GET" || req.method === "HEAD") {
      const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
      const file = path.join(PUBLIC_DIR, rel);
      if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return serveFile(res, file);
      }
      return serveFile(res, path.join(PUBLIC_DIR, "index.html"));
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Не найдено");
  } catch (e) {
    console.error("Ошибка:", e.message);
    if (!res.headersSent) sendJson(res, { error: "server error" }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`E-Bazar запущен на http://127.0.0.1:${PORT}`);
  console.log(`Бот: ${BOT_TOKEN ? "токен задан" : "ТОКЕН НЕ ЗАДАН"} | Админ: ${ADMIN_CHAT_ID || "не задан"}`);
});
