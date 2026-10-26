#!/usr/bin/env bash
# Instalador del puente LED Wall Pro para Raspberry Pi OS, Debian y Ubuntu.
# Se publica en la web de soporte (store/generar-instaladores.mjs reemplaza https://kenlly1998.github.io/ledwall-pro/descargas/):
#
#   curl -fsSL https://kenlly1998.github.io/ledwall-pro/descargas/instalar.sh | sudo bash                       instala, actualiza o muestra los datos
#   curl -fsSL https://kenlly1998.github.io/ledwall-pro/descargas/instalar.sh | sudo bash -s -- --uninstall     lo quita
#   curl -fsSL https://kenlly1998.github.io/ledwall-pro/descargas/instalar.sh | sudo bash -s -- --demo          procesadores simulados
set -euo pipefail

BASE="https://kenlly1998.github.io/ledwall-pro/descargas/"
PORT=8787
DIR=/opt/led-wall-bridge
SERVICE=led-wall-bridge
UNIT="/etc/systemd/system/$SERVICE.service"
DEMO=""
UNINSTALL=""

for arg in "$@"; do
  case "$arg" in
    --demo) DEMO="--demo" ;;
    --uninstall) UNINSTALL=1 ;;
    *) echo "Opción desconocida: $arg"; exit 1 ;;
  esac
done

echo
echo "  LED Wall Pro · Puente LAN"
echo
[ "$(id -u)" -eq 0 ] || { echo "  Ejecuta con sudo:  curl -fsSL ${BASE}instalar.sh | sudo bash"; exit 1; }
command -v systemctl >/dev/null || { echo "  Este sistema no usa systemd: usa Raspberry Pi OS, Debian o Ubuntu."; exit 1; }

if [ -n "$UNINSTALL" ]; then
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT" "$DIR/led-wall-bridge.mjs"
  systemctl daemon-reload
  echo "  Puente desinstalado. Tus horarios y el token quedan en $DIR por si lo vuelves a instalar."
  exit 0
fi

node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if [ "$(node_major)" -lt 20 ]; then
  echo "   - Instalando Node.js (puede tardar unos minutos)"
  { apt-get update -qq && apt-get install -y -qq nodejs; } >/dev/null 2>&1 || true
  if [ "$(node_major)" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null 2>&1
  fi
  [ "$(node_major)" -ge 20 ] || { echo "  No se pudo instalar Node.js 20 o superior. Instálalo desde https://nodejs.org y vuelve a ejecutar."; exit 1; }
fi
NODE="$(command -v node)"

echo "   - Descargando el puente"
mkdir -p "$DIR"
curl -fsSL "${BASE}led-wall-bridge.mjs" -o "$DIR/led-wall-bridge.mjs.new"
mv "$DIR/led-wall-bridge.mjs.new" "$DIR/led-wall-bridge.mjs"
# Instalaciones anteriores (zip): los horarios estaban en bridge/schedule.json.
if [ -f "$DIR/bridge/schedule.json" ] && [ ! -f "$DIR/schedule.json" ]; then mv "$DIR/bridge/schedule.json" "$DIR/schedule.json"; fi

TOKEN="$(sed -n 's/^Environment=TOKEN=//p' "$UNIT" 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  # 12 caracteres sin los que se confunden (0/O, 1/I/L), en grupos de 4: fácil de escribir en el celular.
  TOKEN="$( (tr -dc 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' </dev/urandom || true) | head -c 12 | sed 's/.\{4\}/&-/g; s/-$//')"
fi

echo "   - Registrando el servicio"
id ledbridge >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin ledbridge
chown -R ledbridge: "$DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=LED Wall Pro - puente LAN para procesadores NovaStar
After=network-online.target
Wants=network-online.target

[Service]
User=ledbridge
WorkingDirectory=$DIR
Environment=PORT=$PORT
Environment=TOKEN=$TOKEN
Environment=DATA_DIR=$DIR
ExecStart=$NODE $DIR/led-wall-bridge.mjs $DEMO
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
chmod 600 "$UNIT"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"

OK=""
for _ in $(seq 1 15); do
  sleep 1
  if curl -fsS -H "X-Bridge-Token: $TOKEN" "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then OK=1; break; fi
done

echo
if [ -n "$OK" ]; then echo "  Listo: el puente está funcionando${DEMO:+ en modo DEMO}."; else echo "  Se instaló, pero el puente no respondió. Revisa: journalctl -u $SERVICE -n 50"; fi
echo
echo "  Escribe esto en la app, en Control › Equipos › Puente LAN:"
echo
for ip in $(hostname -I); do case "$ip" in *:*) ;; *) echo "    Dirección   $ip:$PORT" ;; esac; done
echo "    Token       $TOKEN"
echo
echo "  Arranca solo con el equipo. Para ver estos datos otra vez, vuelve a ejecutar el mismo comando."
echo "  Registro en vivo: journalctl -u $SERVICE -f"
