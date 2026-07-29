#!/usr/bin/env bash
#
# E-Bazar — установка магазина на VPS (Ubuntu 22.04 / 24.04)
#
# Запуск от root:
#   bash install.sh
#
# Скрипт:
#   1. спросит домен, токен бота, ваш Telegram ID и пароль админки
#   2. освободит порты 80/443 (при необходимости остановит n8n)
#   3. поставит Node.js и Caddy (бесплатный HTTPS-сертификат)
#   4. запустит магазин как системную службу (автозапуск после перезагрузки)
#   5. настроит бота: вебхук, кнопку меню, команды
#
set -euo pipefail

APP_DIR=/opt/ebazar
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

green() { printf "\033[0;32m%s\033[0m\n" "$1"; }
blue()  { printf "\033[0;34m%s\033[0m\n" "$1"; }
warn()  { printf "\033[0;33m%s\033[0m\n" "$1"; }
fail()  { printf "\033[0;31mОШИБКА: %s\033[0m\n" "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Запустите от root:  sudo bash install.sh"

blue "=============================================="
blue "     E-Bazar — установка магазина на VPS"
blue "=============================================="
echo

# ---------- 1. Вопросы ----------
DEFAULT_DOMAIN="$(hostname -f 2>/dev/null || true)"
read -rp "Домен магазина [${DEFAULT_DOMAIN}]: " DOMAIN
DOMAIN="${DOMAIN:-$DEFAULT_DOMAIN}"
[ -n "$DOMAIN" ] || fail "Домен не указан"

echo
echo "Токен бота берётся у @BotFather (вида 1234567:AAE...)"
read -rp "BOT_TOKEN: " BOT_TOKEN
[ -n "$BOT_TOKEN" ] || fail "Токен не указан"

echo
echo "Ваш Telegram ID можно узнать у @userinfobot (число)"
read -rp "ADMIN_CHAT_ID: " ADMIN_CHAT_ID
[ -n "$ADMIN_CHAT_ID" ] || fail "ID не указан"

echo
read -rp "Пароль для входа в админку магазина: " ADMIN_PASSWORD
[ -n "$ADMIN_PASSWORD" ] || fail "Пароль не указан"
echo

# ---------- 2. Проверка домена ----------
blue "[1/6] Проверяю домен..."
SERVER_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
DOMAIN_IP="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
if [ -n "$DOMAIN_IP" ] && [ "$DOMAIN_IP" = "$SERVER_IP" ]; then
  green "      Домен $DOMAIN указывает на этот сервер ($SERVER_IP) ✓"
elif [ -n "$DOMAIN_IP" ]; then
  warn "      Внимание: $DOMAIN указывает на $DOMAIN_IP, а сервер имеет $SERVER_IP."
  warn "      Если это неверно, HTTPS-сертификат получить не удастся."
  read -rp "      Продолжить? (y/n): " a; [ "$a" = "y" ] || exit 1
else
  warn "      Не удалось проверить домен — продолжаю."
fi

# ---------- 3. Освобождаем порты ----------
blue "[2/6] Освобождаю порты 80 и 443..."
if command -v docker >/dev/null 2>&1 && [ -n "$(docker ps -q 2>/dev/null)" ]; then
  BUSY="$(docker ps --format '{{.Names}} {{.Ports}}' | grep -E ':(80|443)->' || true)"
  if [ -n "$BUSY" ]; then
    echo "      Порты заняты контейнерами:"
    echo "$BUSY" | sed 's/^/        /'
    read -rp "      Остановить их и отключить автозапуск? (y/n): " a
    if [ "$a" = "y" ]; then
      for c in $(docker ps --format '{{.Names}} {{.Ports}}' | grep -E ':(80|443)->' | awk '{print $1}'); do
        docker stop "$c" >/dev/null && docker update --restart=no "$c" >/dev/null 2>&1 || true
        green "        остановлен: $c"
      done
    else
      fail "Порты 80/443 должны быть свободны"
    fi
  fi
fi
for svc in nginx apache2; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    systemctl stop "$svc" && systemctl disable "$svc" >/dev/null 2>&1 || true
    green "      остановлен: $svc"
  fi
done

# ---------- 4. Node.js и Caddy ----------
blue "[3/6] Устанавливаю Node.js и Caddy (2-4 минуты)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
green "      Node.js $(node -v) ✓"

if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list 2>/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
green "      Caddy $(caddy version | head -1) ✓"

# ---------- 5. Файлы и служба ----------
blue "[4/6] Ставлю магазин в $APP_DIR..."
mkdir -p "$APP_DIR/public" "$APP_DIR/data/uploads"
cp "$SRC_DIR/server.js" "$APP_DIR/"
if [ -f "$SRC_DIR/public/index.html" ]; then
  cp "$SRC_DIR/public/index.html" "$APP_DIR/public/"
elif [ -f "$SRC_DIR/index.html" ]; then
  cp "$SRC_DIR/index.html" "$APP_DIR/public/"
else
  fail "не найден index.html рядом с install.sh"
fi

cat > "$APP_DIR/.env" <<EOF
BOT_TOKEN=$BOT_TOKEN
ADMIN_CHAT_ID=$ADMIN_CHAT_ID
ADMIN_PASSWORD=$ADMIN_PASSWORD
PUBLIC_URL=https://$DOMAIN
PORT=3000
EOF
chmod 600 "$APP_DIR/.env"

cat > /etc/systemd/system/ebazar.service <<EOF
[Unit]
Description=E-Bazar shop
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ebazar >/dev/null 2>&1
systemctl restart ebazar
sleep 2
systemctl is-active --quiet ebazar || { journalctl -u ebazar -n 20 --no-pager; fail "магазин не запустился"; }
green "      Служба ebazar запущена ✓"

# ---------- 6. HTTPS ----------
blue "[5/6] Настраиваю HTTPS для $DOMAIN..."
[ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.backup.$(date +%s)"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy
echo -n "      Получаю сертификат"
for _ in $(seq 1 30); do
  sleep 2; echo -n "."
  if curl -fsS --max-time 5 "https://$DOMAIN/api/products" >/dev/null 2>&1; then break; fi
done
echo

if curl -fsS --max-time 10 "https://$DOMAIN/api/products" >/dev/null 2>&1; then
  green "      HTTPS работает ✓"
else
  warn "      Сертификат ещё выпускается. Проверьте через минуту: https://$DOMAIN"
  warn "      Логи: journalctl -u caddy -n 30 --no-pager"
fi

# ---------- 7. Настройка бота ----------
blue "[6/6] Настраиваю бота..."
sleep 2
SETUP="$(curl -fsS --max-time 20 "https://$DOMAIN/api/setup" 2>/dev/null || echo '')"
if echo "$SETUP" | grep -q '"ok":true'; then
  green "      Бот настроен ✓"
  echo "$SETUP" | sed 's/^/      /'
else
  warn "      Не удалось настроить автоматически. Откройте в браузере: https://$DOMAIN/api/setup"
fi

echo
green "=============================================="
green "   ГОТОВО! Магазин работает"
green "=============================================="
echo
echo "  Магазин:   https://$DOMAIN"
echo "  Админка:   https://$DOMAIN/#admin   (пароль тот, что вы задали)"
echo "             либо 5 нажатий на логотип E-Bazar"
echo "  Проверка:  https://$DOMAIN/api/diag"
echo
echo "  Полезные команды:"
echo "    systemctl restart ebazar     — перезапустить магазин"
echo "    systemctl status ebazar      — состояние"
echo "    journalctl -u ebazar -f      — смотреть логи"
echo
echo "  Напишите боту /start в Telegram — появится кнопка магазина."
echo
