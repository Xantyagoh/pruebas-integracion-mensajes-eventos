#!/usr/bin/env bash
# Ejecuta los casos de prueba de integración sobre la arquitectura RabbitMQ.
# Uso: ./pruebas.sh <paso>   (entorno | CP-01 | CP-02 | CP-03 | CP-06 | CP-07 | CP-08 | CP-09 | CP-11 | CP-10 | CP-12 | todo)
# Cada paso guarda su salida en ../evidencias/rabbitmq/<paso>.txt
set -u
export MSYS_NO_PATHCONV=1 # Git Bash en Windows: no reescribir rutas de los contenedores
cd "$(dirname "$0")"

API="http://localhost:${API_PORT:-$(sed -n 's/^API_PORT=//p' .env 2>/dev/null || true)}"
[ "$API" = "http://localhost:" ] && API="http://localhost:3000"
MGMT="http://localhost:15672/api"
OUT="../evidencias/rabbitmq"
mkdir -p "$OUT"

title() { printf '\n==================== %s ====================\n' "$*"; }
note() { printf '\n# %s\n' "$*"; }
run() { printf '\n$ %s\n' "$*"; bash -c "$*"; }
stamp() { printf '# Ejecutado: %s (hora local) / %s UTC\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(date -u '+%H:%M:%S')"; }

# Estado real de la cola "pedidos" consultado al broker (rabbitmqctl, sin el retraso de las estadísticas web).
queue() {
  docker exec rabbitmq rabbitmqctl list_queues -q name durable messages_ready messages_unacknowledged messages consumers 2>/dev/null |
    awk '$1 == "pedidos" { printf "[cola %s] durable=%s Ready=%s Unacked=%s Total=%s consumers=%s\n", $1, $2, $3, $4, $5, $6 }'
}
consumers() { queue | sed -E 's/.*consumers=([0-9]+).*/\1/'; }

# POST /orders mostrando código HTTP y tiempo de respuesta.
order() { # nombre producto cantidad [correlationId]
  local hdr=()
  [ -n "${4:-}" ] && hdr=(-H "X-Correlation-Id: $4")
  curl -s -X POST "$API/orders" -H 'Content-Type: application/json' "${hdr[@]}" \
    -d "{\"customerName\":\"$1\",\"product\":\"$2\",\"quantity\":$3}" \
    -w '  -> HTTP %{http_code} en %{time_total}s\n'
}

wait_api() { for _ in $(seq 1 60); do curl -sf "$API/health" >/dev/null && return 0; sleep 1; done; echo "API no disponible"; }
wait_consumers() { for _ in $(seq 1 60); do [ "$(consumers)" = "$1" ] && return 0; sleep 1; done; }
wait_empty() { for _ in $(seq 1 90); do queue | grep -q 'Total=0 ' && return 0; sleep 1; done; }
since() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

entorno() {
  title "Montaje del entorno RabbitMQ"; stamp
  run "docker compose down -v --remove-orphans 2>&1 | tail -n 3"
  run "docker compose up -d --build 2>&1 | grep -E 'Built|Started|Healthy|Created' "
  wait_api; wait_consumers 1
  run "docker compose ps --format 'table {{.Name}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'"
  note "Puertos publicados en el host"
  run "docker port rabbitmq; docker port orders-api"
  note "Logs de arranque del broker"
  run "docker logs rabbitmq 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'Starting RabbitMQ|Server startup complete|plugins started|rabbitmq_management|rabbitmq_tracing|Management plugin: HTTP|user .admin. authenticated' | head -n 20"
  note "Logs de arranque de los servicios"
  run "docker compose logs --no-log-prefix orders-api notification-worker"
  note "Cola creada y visible en el broker"
  queue
}

cp01() {
  title "CP-01 Creación de pedido vía API"; stamp
  note "Pedido válido"
  run "curl -s -i -X POST $API/orders -H 'Content-Type: application/json' -d '{\"customerName\":\"Carlos\",\"product\":\"Libro de arquitectura\",\"quantity\":1}' -w '\n(tiempo total: %{time_total}s)\n'"
  note "Pedido inválido (validación de JSON básico)"
  run "curl -s -i -X POST $API/orders -H 'Content-Type: application/json' -d '{\"customerName\":\"\",\"quantity\":0}'"
  run "curl -s -i -X POST $API/orders -H 'Content-Type: application/json' -d 'esto no es json'"
  sleep 4
  run "docker compose logs --no-log-prefix orders-api | tail -n 4"
}

cp02() {
  title "CP-02 Envío de mensaje a RabbitMQ"; stamp
  note "Se detiene el worker para que el mensaje quede visible en la cola"
  run "docker compose stop notification-worker 2>&1"
  wait_consumers 0
  note "Estado antes de enviar"; queue
  note "Envío del pedido"; order "Pedro" "Libro de arquitectura" 1
  sleep 1
  note "Estado después de enviar: Ready aumenta en 1"; queue
  note "Contenido del mensaje en la cola (lectura sin consumir: ackmode=ack_requeue_true)"
  curl -s -u admin:admin -X POST -H 'content-type: application/json' "$MGMT/queues/%2F/pedidos/get" \
    -d '{"count":5,"ackmode":"ack_requeue_true","encoding":"auto"}' | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s).forEach(m=>console.log(JSON.stringify({routing_key:m.routing_key,redelivered:m.redelivered,properties:m.properties,payload:JSON.parse(m.payload)},null,2))))'
}

cp03() {
  title "CP-03 Consumo de mensaje (RabbitMQ)"; stamp
  local t; t=$(since)
  note "Se inicia el worker con el mensaje de CP-02 esperando en la cola"
  run "docker compose start notification-worker 2>&1"
  wait_consumers 1
  note "Durante el procesamiento (2-5 s): el mensaje pasa a Unacked"; queue
  sleep 4
  note "Después del ACK manual: la cola queda vacía"; queue
  run "docker compose logs --no-log-prefix --since $t notification-worker"
}

cp06() {
  title "CP-06 Trazabilidad del flujo (correlationId)"; stamp
  local corr="corr-CP06-$(date +%H%M%S)"
  note "Se activa la traza del broker (plugin rabbitmq_tracing) para registrar publicaciones y entregas"
  curl -s -u admin:admin -X DELETE "$MGMT/traces/%2F/cp06" >/dev/null
  curl -s -u admin:admin -X PUT -H 'content-type: application/json' "$MGMT/traces/%2F/cp06" \
    -d '{"format":"text","pattern":"#","tracer_connection_username":"admin","tracer_connection_password":"admin"}' -w 'PUT /api/traces/%%2F/cp06 -> HTTP %{http_code}\n'
  sleep 1
  note "Pedido con cabecera X-Correlation-Id: $corr"
  order "Laura" "Curso de QA" 2 "$corr"
  sleep 5
  note "1) Log de la API (productor)"
  run "docker compose logs --no-log-prefix orders-api | grep $corr"
  note "2) Log del broker (bitácora de tracing dentro del contenedor rabbitmq)"
  printf '\n$ docker exec rabbitmq cat /var/tmp/rabbitmq-tracing/cp06.log   (entradas que contienen %s)\n' "$corr"
  docker exec rabbitmq cat /var/tmp/rabbitmq-tracing/cp06.log | CORR="$corr" node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(
      s.split(/={20,}/).filter(b=>b.includes(process.env.CORR)).map(b=>b.trim()).join("\n----------------------------------------\n")))'
  note "3) Log del consumidor"
  run "docker compose logs --no-log-prefix notification-worker | grep $corr"
  curl -s -u admin:admin -X DELETE "$MGMT/traces/%2F/cp06" >/dev/null
}

cp07() {
  title "CP-07 Responsive: la API responde sin esperar al consumidor"; stamp
  note "El worker tarda 3 s por mensaje (PROCESSING_MS=3000). Se envían 10 pedidos seguidos."
  local start end
  start=$(date +%s%N)
  for i in $(seq 1 10); do printf 'Pedido %2d:' "$i"; order "Cliente$i" "Producto$i" 1; done
  end=$(date +%s%N)
  echo "Tiempo total de las 10 respuestas HTTP: $(( (end - start) / 1000000 )) ms"
  note "Inmediatamente después: la mayoría de los mensajes siguen pendientes en la cola"; queue
  note "El worker necesita ~30 s para terminarlos"
  local t0=$(date +%s); wait_empty; echo "Cola vacía después de $(( $(date +%s) - t0 )) s adicionales"; queue
}

cp08() {
  title "CP-08 Message-driven: no existe comunicación directa entre servicios"; stamp
  note "El worker no publica puertos; solo orders-api (${API##*:}->3000) y rabbitmq (5672, 15672)"
  run "docker compose ps --format 'table {{.Name}}\t{{.Ports}}'"
  note "Sockets en escucha dentro del worker: solo 127.0.0.11 (DNS interno de Docker), no hay servidor HTTP"
  run "docker compose exec notification-worker netstat -tln; echo '(fin de la lista)'"
  note "Conexiones TCP establecidas: API y worker solo hablan con rabbitmq:5672"
  run "docker inspect -f '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' rabbitmq orders-api \$(docker compose ps -q notification-worker)"
  run "docker compose exec orders-api netstat -tn | grep ESTABLISHED"
  run "docker compose exec notification-worker netstat -tn | grep ESTABLISHED"
  note "Intento de llamada HTTP directa de la API al worker: debe fallar"
  run "docker compose exec orders-api wget -q -T 3 -O- http://notification-worker:3000/ 2>&1 || echo 'Conexión rechazada: el worker no expone HTTP'"
  note "Conexiones registradas en el broker"
  curl -s -u admin:admin "$MGMT/connections" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s).forEach(c=>console.log(`${c.client_properties.connection_name}  ${c.peer_host}:${c.peer_port} -> ${c.host}:${c.port}  protocolo=${c.protocol}`)))'
  note "Revisión del código: ninguna llamada HTTP saliente en la API ni servidor HTTP en el worker"
  run "grep -nE 'http\\.request|[^e]fetch\\(|axios|createServer|listen\\(' orders-api/index.js notification-worker/index.js"
}

cp09() {
  title "CP-09 Resilient: el sistema soporta la caída del consumidor"; stamp
  run "docker compose stop notification-worker 2>&1"
  wait_consumers 0
  run "docker compose ps --format 'table {{.Name}}\t{{.Status}}'"
  note "Con el worker caído la API sigue aceptando pedidos"
  for i in 1 2 3 4 5; do printf 'Pedido %d:' "$i"; order "SinWorker$i" "Producto offline $i" "$i"; done
  run "curl -s $API/health; echo"
  note "Los mensajes se acumulan en la cola (Ready sube, consumers=0)"; queue
}

cp11() {
  title "CP-11 Desacoplamiento temporal: el worker procesa al iniciarse"; stamp
  local t; t=$(since)
  note "Estado antes de iniciar el worker"; queue
  run "docker compose start notification-worker 2>&1"
  wait_empty
  note "Estado después"; queue
  run "docker compose logs --no-log-prefix --since $t notification-worker | grep -E 'Conectado|Mensaje recibido|ACK'"
}

cp10() {
  title "CP-10 Elastic: distribución de carga con múltiples consumidores"; stamp
  local t; t=$(since)
  run "docker compose up -d --scale notification-worker=3 2>&1 | grep -E 'Started|Running'"
  wait_consumers 3
  run "docker compose ps notification-worker --format 'table {{.Name}}\t{{.Status}}'"
  queue
  note "Se envían 9 pedidos"
  for i in $(seq 1 9); do printf 'Pedido %d:' "$i"; order "Escala$i" "Producto escala $i" 1; done
  sleep 1
  note "Con prefetch=1 cada worker toma un mensaje: Unacked=3"; queue
  wait_empty
  note "Pedidos procesados por cada instancia"
  run "docker compose logs --no-log-prefix --since $t notification-worker | grep 'ACK confirmado' | sed -E 's/.*\\[(notification-worker@[a-f0-9]+)\\].*orderId=(.*)/\\1 \\2/' | sort"
  run "docker compose logs --no-log-prefix --since $t notification-worker | grep 'ACK confirmado' | grep -oE 'notification-worker@[a-f0-9]+' | sort | uniq -c"
}

cp12() {
  title "CP-12 Recuperación tras reinicio del consumidor y del broker"; stamp
  local t
  run "docker compose up -d --scale notification-worker=1 2>&1 | grep -E 'Stopped|Removed|Running' | head -n 5"
  wait_consumers 1; wait_empty
  note "A) Caída abrupta del worker con un mensaje entregado y no confirmado"
  for i in 1 2 3; do printf 'Pedido %d:' "$i"; order "Recupera$i" "Producto A$i" 1; done
  sleep 1; queue
  run "docker kill \$(docker compose ps -q notification-worker)"
  sleep 2
  note "El mensaje Unacked vuelve a Ready: no se pierde"; queue
  t=$(since)
  run "docker compose up -d notification-worker 2>&1 | tail -n 1"
  wait_empty; queue
  run "docker compose logs --no-log-prefix --since $t notification-worker | grep -E 'Mensaje recibido|ACK'"

  note "B) Reinicio del broker con mensajes pendientes (cola durable + mensajes persistentes)"
  run "docker compose stop notification-worker 2>&1"
  wait_consumers 0
  for i in 1 2 3; do printf 'Pedido %d:' "$i"; order "Broker$i" "Producto B$i" 1; done
  sleep 1; queue
  run "docker compose restart rabbitmq 2>&1"
  for _ in $(seq 1 60); do curl -sf -u admin:admin "$MGMT/queues/%2F/pedidos" >/dev/null && break; sleep 1; done
  note "Tras reiniciar el broker los 3 mensajes siguen en la cola"; queue
  sleep 3
  run "docker compose logs --no-log-prefix orders-api | tail -n 4"
  note "La API se reconecta sola y sigue publicando"
  printf 'Pedido 4:'; order "Broker4" "Producto B4" 1
  t=$(since)
  run "docker compose start notification-worker 2>&1"
  wait_empty; queue
  run "docker compose logs --no-log-prefix --since $t notification-worker | grep -E 'Conectado|Mensaje recibido|ACK'"
}

step() { # nombre función
  "$2" 2>&1 | tee "$OUT/$1.txt"
}

case "${1:-todo}" in
  entorno) step entorno entorno ;;
  CP-01) step CP-01 cp01 ;;
  CP-02) step CP-02 cp02 ;;
  CP-03) step CP-03 cp03 ;;
  CP-06) step CP-06 cp06 ;;
  CP-07) step CP-07 cp07 ;;
  CP-08) step CP-08 cp08 ;;
  CP-09) step CP-09 cp09 ;;
  CP-11) step CP-11 cp11 ;;
  CP-10) step CP-10 cp10 ;;
  CP-12) step CP-12 cp12 ;;
  todo) for s in entorno CP-01 CP-02 CP-03 CP-06 CP-07 CP-08 CP-09 CP-11 CP-10 CP-12; do "$0" "$s"; done ;;
  *) echo "Paso desconocido: $1"; exit 1 ;;
esac
