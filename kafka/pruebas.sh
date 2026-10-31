#!/usr/bin/env bash
# Ejecuta los casos de prueba de integración sobre la arquitectura Kafka.
# Uso: ./pruebas.sh <paso>   (entorno | CP-01 | CP-04 | CP-05 | CP-06 | CP-07 | CP-08 | CP-09 | CP-11 | CP-11-posterior | CP-10 | CP-12 | todo)
# Cada paso guarda su salida en ../evidencias/kafka/<paso>.txt
set -u
export MSYS_NO_PATHCONV=1 # Git Bash en Windows: no reescribir rutas de los contenedores
cd "$(dirname "$0")"

PORT="${API_PORT:-$(sed -n 's/^API_PORT=//p' .env 2>/dev/null)}"
API="http://localhost:${PORT:-3000}"
TOPIC="orders.events"
BS="--bootstrap-server kafka:9092"
OUT="../evidencias/kafka"
mkdir -p "$OUT"

title() { printf '\n==================== %s ====================\n' "$*"; }
note() { printf '\n# %s\n' "$*"; }
run() { printf '\n$ %s\n' "$*"; bash -c "$*"; }
stamp() { printf '# Ejecutado: %s (hora local) / %s UTC\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(date -u '+%H:%M:%S')"; }
since() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# POST /orders mostrando código HTTP y tiempo de respuesta.
order() { # nombre producto cantidad precio [correlationId]
  local hdr=()
  [ -n "${5:-}" ] && hdr=(-H "X-Correlation-Id: $5")
  curl -s -X POST "$API/orders" -H 'Content-Type: application/json' "${hdr[@]}" \
    -d "{\"customerName\":\"$1\",\"product\":\"$2\",\"quantity\":$3,\"unitPrice\":$4}" \
    -w '  -> HTTP %{http_code} en %{time_total}s\n'
}

group() { # groupId: offsets y lag por partición
  docker exec kafka kafka-consumer-groups.sh $BS --describe --group "$1" 2>/dev/null | grep -v '^$'
}
members() { docker exec kafka kafka-consumer-groups.sh $BS --describe --group "$1" --members 2>/dev/null | grep -v '^$'; }
offsets() { docker exec kafka kafka-get-offsets.sh $BS --topic "$TOPIC" 2>/dev/null; }
lag() { # suma del LAG de un grupo; sin offset confirmado ("-") cuenta todo el log de la partición
  docker exec kafka kafka-consumer-groups.sh $BS --describe --group "$1" 2>/dev/null |
    awk '$2 == "orders.events" { s += ($4 == "-" ? $5 : $6) } END { print s + 0 }'
}
wait_lag0() { for _ in $(seq 1 120); do [ "$(lag "$1")" = "0" ] && return 0; sleep 1; done; echo "Timeout esperando LAG=0 en $1"; }
wait_api() { for _ in $(seq 1 90); do curl -sf "$API/health" >/dev/null && return 0; sleep 1; done; echo "API no disponible"; }
wait_log() { # servicio texto
  for _ in $(seq 1 90); do docker compose logs --no-log-prefix "$1" 2>/dev/null | grep -q "$2" && return 0; sleep 1; done
  echo "Timeout esperando '$2' en $1"
}
all_groups() { for g in inventory-service-group billing-service-group notification-service-group; do wait_lag0 "$g"; done; }

entorno() {
  title "Montaje del entorno Kafka"; stamp
  run "docker compose --profile late down -v --remove-orphans 2>&1 | tail -n 3"
  run "docker compose up -d --build 2>&1 | grep -E 'Built|Started|Healthy|Exited|Created'"
  wait_api
  for s in inventory-consumer billing-consumer notification-consumer; do wait_log $s 'Unido al consumer group'; done
  run "docker compose ps -a --format 'table {{.Name}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'"
  note "Puertos publicados en el host"
  run "docker port kafka; docker port kafka-ui; docker port orders-api"
  note "Logs de arranque del broker Kafka (modo KRaft)"
  run "docker logs kafka 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'Kafka version|Kafka Server started|Transition from STARTING to STARTED|Awaiting socket connections on' | head -n 8"
  note "Creación del tópico (contenedor kafka-init)"
  run "docker compose logs --no-log-prefix kafka-init"
  note "Kafka UI"
  run "docker compose logs --no-log-prefix kafka-ui 2>&1 | grep -E 'Started KafkaUiApplication|Netty started' | head -n 3"
  run "curl -s -o /dev/null -w 'GET http://localhost:8080 -> HTTP %{http_code}\n' http://localhost:8080"
  note "Logs de arranque de los servicios"
  run "docker compose logs --no-log-prefix orders-api inventory-consumer billing-consumer notification-consumer"
}

cp01() {
  title "CP-01 Creación de pedido vía API"; stamp
  note "Pedido válido"
  run "curl -s -i -X POST $API/orders -H 'Content-Type: application/json' -d '{\"customerName\":\"Carlos\",\"product\":\"Libro de arquitectura\",\"quantity\":1,\"unitPrice\":85000}' -w '\n(tiempo total: %{time_total}s)\n'"
  note "Pedidos inválidos (validación de JSON básico)"
  run "curl -s -i -X POST $API/orders -H 'Content-Type: application/json' -d '{\"customerName\":\"Carlos\",\"product\":\"\",\"quantity\":-1}'"
  run "curl -s -i -X POST $API/orders -H 'Content-Type: application/json' -d 'esto no es json'"
  sleep 2
  run "docker compose logs --no-log-prefix orders-api | tail -n 3"
  all_groups
}

cp04() {
  title "CP-04 Publicación de evento en Kafka"; stamp
  note "Offsets del tópico antes de publicar (topic:partición:offset final)"; offsets
  note "Pedido"
  local resp id
  resp=$(order "Pedro" "Libro de arquitectura" 1 85000); echo "$resp"
  id=$(echo "$resp" | grep -oE 'ORD-[A-F0-9]+' | head -n 1)
  sleep 1
  note "Log de orders-api: evento publicado con partición y offset"
  run "docker compose logs --no-log-prefix orders-api | grep $id"
  note "Offsets del tópico después de publicar: una partición avanzó en 1"; offsets
  note "Evento almacenado en el tópico (leído directamente del broker)"
  run "docker exec kafka kafka-console-consumer.sh $BS --topic $TOPIC --from-beginning --timeout-ms 6000 --property print.key=true --property print.partition=true --property print.offset=true 2>/dev/null | grep $id"
  echo "$id" > "$OUT/.cp04-order"
}

cp05() {
  title "CP-05 Consumo de evento (Kafka)"; stamp
  local id; id=$(cat "$OUT/.cp04-order")
  all_groups
  note "Cada consumidor, en su propio consumer group, recibió el mismo evento ($id)"
  for s in inventory-consumer billing-consumer notification-consumer; do
    run "docker compose logs --no-log-prefix $s | grep -A 3 'orderId=$id eventId' | head -n 4"
  done
  note "Consumer groups registrados en el broker"
  run "docker exec kafka kafka-consumer-groups.sh $BS --list"
  for g in inventory-service-group billing-service-group notification-service-group; do note "Grupo $g"; group "$g"; done
}

cp06() {
  title "CP-06 Trazabilidad del flujo (correlationId)"; stamp
  local corr="corr-CP06-$(date +%H%M%S)"
  note "Pedido con cabecera X-Correlation-Id: $corr"
  order "Laura" "Curso de QA" 2 120000 "$corr"
  all_groups
  note "1) Log de la API (productor)"
  run "docker compose logs --no-log-prefix orders-api | grep $corr"
  note "2) Broker: registro del evento en el log del tópico (partición, offset, headers, key y valor)"
  run "docker exec kafka kafka-console-consumer.sh $BS --topic $TOPIC --from-beginning --timeout-ms 6000 --property print.partition=true --property print.offset=true --property print.headers=true --property print.key=true 2>/dev/null | grep $corr"
  note "3) Logs de los consumidores"
  for s in inventory-consumer billing-consumer notification-consumer; do
    run "docker compose logs --no-log-prefix $s | grep -A 3 'correlationId=$corr' | head -n 4"
  done
}

cp07() {
  title "CP-07 Responsive: la API responde sin esperar a los consumidores"; stamp
  note "Cada consumidor tarda 1 s por evento (PROCESSING_MS=1000). Se envían 10 pedidos seguidos."
  local start end t0
  start=$(date +%s%N)
  for i in $(seq 1 10); do printf 'Pedido %2d:' "$i"; order "Cliente$i" "Producto$i" 1 10000; done
  end=$(date +%s%N)
  echo "Tiempo total de las 10 respuestas HTTP: $(( (end - start) / 1000000 )) ms"
  note "Inmediatamente después: los consumidores aún tienen eventos pendientes (LAG > 0)"
  for g in inventory-service-group billing-service-group notification-service-group; do echo "$g LAG=$(lag $g)"; done
  t0=$(date +%s); all_groups
  note "Todos los grupos alcanzaron LAG=0 después de $(( $(date +%s) - t0 )) s adicionales"
  for g in inventory-service-group billing-service-group notification-service-group; do echo "$g LAG=$(lag $g)"; done
}

cp08() {
  title "CP-08 Message-driven: no existe comunicación directa entre servicios"; stamp
  note "Los consumidores no publican puertos; solo orders-api (3000), kafka (29092) y kafka-ui (8080)"
  run "docker compose ps --format 'table {{.Name}}\t{{.Ports}}'"
  note "Sockets en escucha dentro de cada consumidor: solo 127.0.0.11 (DNS interno de Docker), no hay servidor HTTP"
  for s in inventory-consumer billing-consumer notification-consumer; do
    run "docker compose exec $s netstat -tln; echo '(fin de la lista de $s)'"
  done
  note "Conexiones TCP establecidas: todos hablan solo con kafka:9092"
  run "docker inspect -f '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' kafka orders-api \$(docker compose ps -q inventory-consumer billing-consumer notification-consumer)"
  run "docker compose exec orders-api netstat -tn | grep ESTABLISHED"
  for s in inventory-consumer billing-consumer notification-consumer; do run "docker compose exec $s netstat -tn | grep ESTABLISHED"; done
  note "Intento de llamada HTTP directa de la API a un consumidor: debe fallar"
  run "docker compose exec orders-api wget -q -T 3 -O- http://inventory-consumer:3000/ 2>&1 || echo 'Conexión rechazada: el consumidor no expone HTTP'"
  note "Revisión del código: sin llamadas HTTP salientes en la API ni servidores HTTP en los consumidores"
  run "grep -nE 'http\\.request|[^e]fetch\\(|axios|createServer|listen\\(' orders-api/index.js */index.js | sort -u"
}

cp09() {
  title "CP-09 Resilient: el sistema soporta la caída de un consumidor"; stamp
  local t; t=$(since)
  run "docker compose stop billing-consumer 2>&1"
  run "docker compose ps --format 'table {{.Name}}\t{{.Status}}'"
  note "Con billing-consumer caído la API sigue aceptando pedidos"
  for i in 1 2 3; do printf 'Pedido %d:' "$i"; order "SinBilling$i" "Producto offline $i" "$i" 50000; done
  run "curl -s $API/health; echo"
  wait_lag0 inventory-service-group; wait_lag0 notification-service-group
  note "Los demás consumidores siguen procesando normalmente"
  run "docker compose logs --no-log-prefix --since $t inventory-consumer notification-consumer | grep -E 'Inventario reservado|Notificación enviada' | sort"
  run "docker compose logs --no-log-prefix --since $t billing-consumer | grep -c 'Evento recibido'"
  note "El grupo de facturación no tiene miembros activos y acumula LAG (eventos pendientes en el log)"
  group billing-service-group
}

cp11() {
  title "CP-11 Desacoplamiento temporal: eventos publicados con el consumidor apagado"; stamp
  local t
  note "A) billing-consumer vuelve y procesa lo que se publicó mientras estaba apagado"
  echo "LAG antes: $(lag billing-service-group)"
  t=$(since)
  run "docker compose start billing-consumer 2>&1"
  wait_lag0 billing-service-group
  run "docker compose logs --no-log-prefix --since $t billing-consumer | grep -E 'Unido|Evento recibido|offset=|Factura'"
  group billing-service-group
}

cp11b() {
  title "CP-11 (B) Consumidor posterior: iniciado después de publicar los eventos, lee desde el log"; stamp
  local t
  note "audit-consumer (grupo audit-service-group) no existía cuando se publicaron los eventos"
  run "docker exec kafka kafka-consumer-groups.sh $BS --list"
  note "Total de eventos en el log del tópico (topic:partición:offset final):"; offsets
  t=$(since)
  run "docker compose --profile late up -d audit-consumer 2>&1 | grep -E 'Created|Started'"
  wait_log audit-consumer 'Unido al consumer group'
  wait_lag0 audit-service-group
  run "docker compose logs --no-log-prefix audit-consumer | grep -E 'Unido|offset=' "
  run "echo \"Eventos leídos por audit-consumer: \$(docker compose logs --no-log-prefix audit-consumer | grep -c 'Evento recibido')\""
  group audit-service-group
}

cp10() {
  title "CP-10 Elastic: distribución de carga con varias instancias del mismo grupo"; stamp
  local t
  run "docker compose up -d --scale inventory-consumer=2 2>&1 | grep -E 'Started|Running' | grep inventory"
  sleep 5; wait_lag0 inventory-service-group
  for _ in $(seq 1 30); do [ "$(members inventory-service-group | grep -c inventory-consumer)" = "2" ] && break; sleep 1; done
  run "docker compose ps inventory-consumer --format 'table {{.Name}}\t{{.Status}}'"
  note "Particiones repartidas entre las 2 instancias del grupo inventory-service-group"
  members inventory-service-group
  t=$(since)
  note "Se envían 9 pedidos (cada uno con su propia key = orderId)"
  for i in $(seq 1 9); do printf 'Pedido %d:' "$i"; order "Escala$i" "Producto escala $i" 1 1000; done
  wait_lag0 inventory-service-group
  note "Eventos procesados por cada instancia (instancia, partición)"
  run "docker compose logs --no-log-prefix --since $t inventory-consumer | grep 'topic=' | sed -E 's/.*\\[(inventory-consumer@[a-f0-9]+)\\].*partition=([0-9]+).*/\\1 partición \\2/' | sort | uniq -c"
  note "Los demás grupos (billing, notification) recibieron los 9 eventos completos"
  run "docker compose logs --no-log-prefix --since $t billing-consumer | grep -c 'Evento recibido'; docker compose logs --no-log-prefix --since $t notification-consumer | grep -c 'Evento recibido'"
  group inventory-service-group
}

cp12() {
  title "CP-12 Recuperación tras reinicio del consumidor y del broker"; stamp
  local t ids
  note "A) Caída abrupta (SIGKILL) de notification-consumer"
  run "docker kill \$(docker compose ps -q notification-consumer)"
  for i in 1 2 3; do printf 'Pedido %d:' "$i"; order "Recupera$i" "Producto A$i" 1 2000; done
  note "Eventos pendientes para el grupo de notificaciones"; group notification-service-group
  t=$(since)
  run "docker compose up -d notification-consumer 2>&1 | tail -n 1"
  wait_lag0 notification-service-group
  run "docker compose logs --no-log-prefix --since $t notification-consumer | grep -E 'Unido|Evento recibido|offset=' "
  group notification-service-group

  note "B) Reinicio del broker con eventos pendientes para billing-consumer"
  run "docker compose stop billing-consumer 2>&1"
  for i in 1 2 3; do printf 'Pedido %d:' "$i"; order "Broker$i" "Producto B$i" 1 3000; done
  note "Offsets del tópico antes del reinicio"; offsets
  run "docker compose restart kafka 2>&1"
  for _ in $(seq 1 90); do docker exec kafka kafka-topics.sh $BS --list >/dev/null 2>&1 && break; sleep 1; done
  note "Offsets del tópico después del reinicio: el log se conservó"; offsets
  note "Offsets confirmados del grupo de facturación tras el reinicio (eventos pendientes intactos)"; group billing-service-group
  sleep 5
  note "La API sigue publicando después del reinicio"
  for _ in $(seq 1 20); do r=$(order "Broker4" "Producto B4" 1 3000); echo "$r" | grep -q 'HTTP 202' && break; sleep 2; done
  printf 'Pedido 4:%s\n' "$r"
  t=$(since)
  run "docker compose start billing-consumer 2>&1"
  wait_lag0 billing-service-group
  run "docker compose logs --no-log-prefix --since $t billing-consumer | grep -E 'Unido|Evento recibido'"
  all_groups
  note "Estado final de todos los grupos"
  for g in inventory-service-group billing-service-group notification-service-group audit-service-group; do echo "$g LAG=$(lag $g)"; done
}

step() { "$2" 2>&1 | tee "$OUT/$1.txt"; }

case "${1:-todo}" in
  entorno) step entorno entorno ;;
  CP-01) step CP-01 cp01 ;;
  CP-04) step CP-04 cp04 ;;
  CP-05) step CP-05 cp05 ;;
  CP-06) step CP-06 cp06 ;;
  CP-07) step CP-07 cp07 ;;
  CP-08) step CP-08 cp08 ;;
  CP-09) step CP-09 cp09 ;;
  CP-11) step CP-11 cp11 ;;
  CP-11-posterior) step CP-11-posterior cp11b ;;
  CP-10) step CP-10 cp10 ;;
  CP-12) step CP-12 cp12 ;;
  todo) for s in entorno CP-01 CP-04 CP-05 CP-06 CP-07 CP-08 CP-09 CP-11 CP-11-posterior CP-10 CP-12; do "$0" "$s"; done ;;
  *) echo "Paso desconocido: $1"; exit 1 ;;
esac
