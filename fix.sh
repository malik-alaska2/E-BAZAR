#!/usr/bin/env bash
# Чинит настройки HTTPS и проверяет магазин.
# Запуск:  bash /root/eb/fix.sh
set -uo pipefail

green() { printf "\033[0;32m%s\033[0m\n" "$1"; }
blue()  { printf "\033[0;34m%s\033[0m\n" "$1"; }
warn()  { printf "\033[0;33m%s\033[0m\n" "$1"; }
red()   { printf "\033[0;31m%s\033[0m\n" "$1"; }

# домен берём от самого сервера — надёжнее, чем из настроек
DOMAIN="$(hostname -f 2>/dev/null | tr -d ' \r\n')"
case "$DOMAIN" in
  ""|localhost*|*[!a-zA-Z0-9.-]*) DOMAIN="$(hostname | tr -d ' \r\n').hstgr.cloud" ;;
esac

blue "=============================================="
blue "   E-Bazar — проверка и починка"
blue "=============================================="
echo
echo "  Домен: $DOMAIN"
echo

# 0. Чиним настройки магазина (.env), сохраняя токен, ID и пароль
blue "[0/5] Проверяю настройки магазина..."
ENV_FILE=/opt/ebazar/.env
if [ -f "$ENV_FILE" ]; then
  TOKEN="$(grep -oP '^BOT_TOKEN=\K[0-9]+:[A-Za-z0-9_-]+' "$ENV_FILE" | head -1)"
  CHAT="$(grep -oP '^ADMIN_CHAT_ID=\K-?[0-9]+' "$ENV_FILE" | head -1)"
  PASS="$(grep -oP '^ADMIN_PASSWORD=\K.*' "$ENV_FILE" | head -1 | tr -d '\r')"
  if [ -n "$TOKEN" ] && [ -n "$CHAT" ] && [ -n "$PASS" ]; then
    cat > "$ENV_FILE" <<EOF
BOT_TOKEN=$TOKEN
ADMIN_CHAT_ID=$CHAT
ADMIN_PASSWORD=$PASS
PUBLIC_URL=https://$DOMAIN
PORT=3000
EOF
    chmod 600 "$ENV_FILE"
    green "      Настройки в порядке: токен, ID $CHAT, пароль ✓"
  else
    red "      В настройках чего-то не хватает — запустите заново: bash /root/eb/install.sh"
  fi
else
  red "      Файл настроек не найден — запустите: bash /root/eb/install.sh"
fi

# 1. Правильный Caddyfile (без HTTP/3 — некоторые провайдеры его режут)
blue "[1/5] Восстанавливаю настройки HTTPS..."
cat > /etc/caddy/Caddyfile <<EOF
{
	servers {
		protocols h1 h2
	}
}

$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF

if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  green "      Файл настроек корректен ✓"
else
  red "      Ошибка в настройках Caddy:"
  caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -5 | sed 's/^/        /'
fi

# 2. Перезапуск служб
blue "[2/5] Перезапускаю службы..."
systemctl restart caddy 2>/dev/null
systemctl restart ebazar 2>/dev/null
sleep 4
systemctl is-active --quiet caddy  && green "      Caddy работает ✓"  || red "      Caddy не запустился — journalctl -u caddy -n 20"
systemctl is-active --quiet ebazar && green "      Магазин работает ✓" || red "      Магазин не запустился — journalctl -u ebazar -n 20"

# 3. Открываем порты в файрволе, если он включён
blue "[3/5] Проверяю файрвол..."
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null 2>&1
  ufw allow 443/tcp >/dev/null 2>&1
  green "      Порты 80 и 443 открыты ✓"
else
  green "      Файрвол не мешает ✓"
fi

# 4. Проверка сайта изнутри
blue "[4/5] Проверяю сайт..."
LOCAL="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3000/ 2>/dev/null)"
[ "$LOCAL" = "200" ] && green "      Магазин отвечает локально ✓" || red "      Магазин не отвечает (код $LOCAL)"

HTTPS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/api/products" 2>/dev/null)"
if [ "$HTTPS" = "200" ]; then
  green "      HTTPS работает ✓"
else
  warn "      HTTPS пока не отвечает (код $HTTPS) — сертификат может выпускаться, подождите минуту"
fi

# 5. Настройка бота
blue "[5/5] Перенастраиваю бота..."
SETUP="$(curl -s --max-time 25 "https://$DOMAIN/api/setup" 2>/dev/null)"
if echo "$SETUP" | grep -q '"ok":true'; then
  green "      Бот настроен ✓"
  echo "$SETUP" | sed 's/^/      /'
else
  warn "      Не удалось. Откройте в браузере: https://$DOMAIN/api/setup"
fi

echo
green "=============================================="
echo
echo "  Магазин:  https://$DOMAIN"
echo "  Админка:  https://$DOMAIN/#admin"
echo "  Проверка: https://$DOMAIN/api/diag"
echo
echo "  Напишите боту /start и нажмите кнопку магазина."
echo
