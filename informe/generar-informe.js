// Genera informe/informe.html a partir de las evidencias reales en ../evidencias.
// Uso: node informe/generar-informe.js  (luego se imprime a PDF con Edge/Chrome headless)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EV = path.join(ROOT, 'evidencias');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const read = (rel) => fs.readFileSync(path.join(EV, rel), 'utf8').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
const img = (rel, caption) => {
  const b64 = fs.readFileSync(path.join(EV, rel)).toString('base64');
  return `<figure><img src="data:image/png;base64,${b64}" alt="${esc(caption)}"><figcaption>${esc(caption)} <span class="src">(${esc(rel)})</span></figcaption></figure>`;
};
// En el PDF cada sección del log (bloque que empieza con "#") se resume a sus primeras y últimas
// líneas más las que coincidan con `keep`; la salida completa queda en evidencias/ (repo y .zip).
const LOG_HEAD = 3;
const LOG_TAIL = 3;
const KEEP = /redelivered=true|Connection refused|Reintentando|\[cola pedidos\]|HTTP\/1\.1 \d{3}|^\{"status"|Message (published|received)/;
function excerpt(text, keep) {
  const out = [];
  let omitted = [];
  // Omitir 1-3 líneas no ahorra espacio (el aviso ocupa una): en ese caso se dejan.
  const flush = () => {
    if (omitted.length > 3) out.push(`   … ${omitted.length} líneas omitidas …`);
    else out.push(...omitted);
    omitted = [];
  };
  const sections = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !sections.length) sections.push([]);
    sections[sections.length - 1].push(line);
  }
  for (const sec of sections) {
    const [head, ...body] = sec[0].startsWith('#') ? sec : ['', ...sec];
    if (head) out.push(head);
    body.forEach((line, i) => {
      if (i < LOG_HEAD || i >= body.length - LOG_TAIL || KEEP.test(line) || (keep && keep.test(line))) {
        flush();
        out.push(line);
      } else omitted.push(line);
    });
    flush();
  }
  return out.join('\n');
}
const log = (rel, title, keep) => {
  const full = read(rel).trim();
  const text = excerpt(full, keep);
  const note = text === full ? '' : ' · extracto; salida completa en el archivo';
  return `<div class="log"><div class="logtitle">${esc(title || rel)} <span class="src">evidencias/${esc(rel)}${note}</span></div><pre>${esc(text)}</pre></div>`;
};
const ul = (items) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const ol = (items) => `<ol>${items.map((i) => `<li>${i}</li>`).join('')}</ol>`;

function caso(c) {
  return `
<section class="case" id="${c.anchor}">
  <h3>${c.id} · ${c.nombre} <span class="arch ${c.arq.toLowerCase()}">${c.arq}</span></h3>
  <table class="fmt">
    <tr><th>ID del caso</th><td>${c.id}</td></tr>
    <tr><th>Arquitectura</th><td>${c.arq}</td></tr>
    <tr><th>Objetivo</th><td>${c.objetivo}</td></tr>
    <tr><th>Precondiciones</th><td>${ul(c.pre)}</td></tr>
    <tr><th>Datos de entrada</th><td>${c.datos}</td></tr>
    <tr><th>Pasos ejecutados</th><td>${ol(c.pasos)}</td></tr>
    <tr><th>Resultado esperado</th><td>${c.esperado}</td></tr>
    <tr><th>Resultado obtenido</th><td>${c.obtenido}</td></tr>
    <tr><th>Estado</th><td><span class="estado ${c.estado === 'Cumple' ? 'ok' : 'ko'}">${c.estado}</span></td></tr>
    <tr><th>Análisis técnico</th><td>${c.analisis}</td></tr>
  </table>
  <h4>Evidencia</h4>
  ${(c.imgs || []).map(([f, t]) => img(f, t)).join('\n')}
  ${(c.logs || []).map(([f, t, k]) => log(f, t, k)).join('\n')}
  ${c.extra ? `<h4>Capturas complementarias (re-ejecución del 31 de octubre de 2026)</h4>
  <div class="note">${c.extra.nota}</div>
  ${c.extra.imgs.map(([f, t]) => img(f, t)).join('\n')}
  ${c.extra.logs.map(([f, t, k]) => log(f, t, k)).join('\n')}` : ''}
</section>`;
}

// Las capturas complementarias repiten los mismos pasos del caso para dejar imagen de lo que en la
// ejecución del 30 de octubre solo quedó en texto. Sus orderId son distintos y cada una tiene su propio log.
const reejec = 'Se repitieron los pasos del caso sobre el mismo stack para tomar capturas de pantalla de la terminal y de la consola. Los identificadores (orderId, correlationId) son distintos a los de la ejecución principal; cada captura tiene su log en el archivo indicado.';

// ---------------------------------------------------------------- RabbitMQ
const R = 'RabbitMQ';
const rabbitPre = 'Stack <code>rabbitmq/docker-compose.yml</code> en ejecución (rabbitmq, orders-api, notification-worker).';
const casosRabbit = [
  {
    id: 'CP-01', anchor: 'r-cp01', nombre: 'Creación de pedido vía API', arq: R,
    objetivo: 'Validar que el endpoint <code>POST /orders</code> recibe el pedido, lo valida y responde correctamente.',
    pre: [rabbitPre, 'API conectada a RabbitMQ (log "Conectado a RabbitMQ").'],
    datos: '<code>{"customerName":"Carlos","product":"Libro de arquitectura","quantity":1}</code>; casos negativos: <code>{"customerName":"","quantity":0}</code> y el texto <code>esto no es json</code>.',
    pasos: ['Enviar el pedido válido con curl a <code>http://localhost:3010/orders</code>.', 'Enviar dos pedidos inválidos.', 'Revisar el log de orders-api.'],
    esperado: 'Pedido válido: HTTP 202 con <code>status: accepted</code>, mensaje y <code>orderId</code>. Pedidos inválidos: HTTP 400 con la lista de errores.',
    obtenido: 'HTTP 202 Accepted en 0,0105 s con <code>orderId=ORD-5575850C</code>. Los pedidos inválidos devolvieron HTTP 400 con los errores de validación. El log registra la publicación y el rechazo.',
    estado: 'Cumple',
    analisis: 'Se usa 202 (Accepted) porque el pedido queda aceptado para procesamiento asíncrono, no procesado. La API valida la entrada antes de publicar: un pedido inválido nunca llega a la cola. Además de lo pedido, la respuesta incluye un <code>correlationId</code>.',
    logs: [['rabbitmq/CP-01.txt', 'Ejecución CP-01']],
    extra: {
      nota: `${reejec} Pedido válido <code>ORD-47977D81</code>: HTTP 202 en 0,062 s; los dos pedidos inválidos devolvieron HTTP 400. El log de orders-api registra la publicación y el rechazo, y el del worker la recepción y el ACK del mismo pedido.`,
      imgs: [['rabbitmq/img/16-cp01-terminal-api.png', 'Terminal: POST /orders válido (202 Accepted), dos pedidos inválidos (400) y el pedido ORD-47977D81 en los logs de orders-api y del worker']],
      logs: [['rabbitmq/CP-01-capturas.txt', 'Re-ejecución CP-01']],
    },
  },
  {
    id: 'CP-02', anchor: 'r-cp02', nombre: 'Envío de mensaje a RabbitMQ', arq: R,
    objetivo: 'Verificar que cada pedido genera un mensaje persistente en la cola <code>pedidos</code>.',
    pre: [rabbitPre, 'Worker detenido para que el mensaje permanezca visible en la cola.'],
    datos: '<code>{"customerName":"Pedro","product":"Libro de arquitectura","quantity":1}</code>',
    pasos: ['<code>docker compose stop notification-worker</code>.', 'Consultar la cola (Ready=0).', 'Enviar el pedido.', 'Consultar la cola de nuevo (rabbitmqctl) y leer el mensaje sin consumirlo (API de administración, <code>ack_requeue_true</code>).', 'Revisar la cola en la consola web y usar "Get messages".'],
    esperado: 'Ready pasa de 0 a 1. El mensaje contiene <code>type=ProcessOrder</code>, el <code>orderId</code> y el <code>correlationId</code>, con <code>delivery_mode=2</code> (persistente).',
    obtenido: 'Ready 0 → 1 (Total=1, consumers=0). El mensaje leído tiene <code>message_id=ORD-480AC32D</code>, <code>correlation_id</code>, <code>app_id=orders-api</code>, <code>delivery_mode=2</code> y el payload JSON completo. La consola muestra la cola <code>pedidos</code> (durable, D) con Ready=1.',
    estado: 'Cumple',
    analisis: 'La cola es durable y el mensaje persistente, de modo que sobrevive a reinicios del broker (ver CP-12). La API publica con <em>publisher confirms</em>: solo responde 202 cuando RabbitMQ confirmó que recibió el mensaje, lo que evita aceptar pedidos que no llegaron al broker.',
    imgs: [['rabbitmq/img/03-cp02-cola-pedidos-ready1.png', 'Consola RabbitMQ: cola pedidos con Ready=1 y worker detenido'], ['rabbitmq/img/04-cp02-contenido-mensaje.png', 'Consola RabbitMQ: detalle de la cola y contenido del mensaje (Get messages)']],
    logs: [['rabbitmq/CP-02.txt', 'Ejecución CP-02', /delivery_mode|message_id|correlation_id|app_id|"type"|"payload"/]],
  },
  {
    id: 'CP-03', anchor: 'r-cp03', nombre: 'Consumo de mensaje (RabbitMQ)', arq: R,
    objetivo: 'Validar que el consumidor recibe, procesa y confirma (ACK manual) el mensaje.',
    pre: [rabbitPre, 'Mensaje de CP-02 pendiente en la cola (Ready=1).'],
    datos: 'Mensaje <code>ORD-480AC32D</code> publicado en CP-02.',
    pasos: ['<code>docker compose start notification-worker</code>.', 'Consultar la cola durante el procesamiento (3 s simulados).', 'Consultar la cola después del ACK.', 'Revisar el log del worker.'],
    esperado: 'Durante el procesamiento el mensaje pasa a Unacked=1; tras el ACK la cola queda en 0. El log muestra recepción, contenido, simulación y confirmación.',
    obtenido: 'Durante el procesamiento: Ready=0, Unacked=1. Tras el ACK: Total=0. El worker registró "Mensaje recibido", el contenido JSON, "Simulando envío de notificación a Pedro..." y "ACK confirmado" 3 s después.',
    estado: 'Cumple',
    analisis: 'El estado Unacked demuestra el ACK manual: RabbitMQ no borra el mensaje hasta que el worker lo confirma. El campo <code>redelivered=true</code> se explica porque la lectura de inspección de CP-02 (consola y API) devolvió el mensaje a la cola; RabbitMQ lo marca como reentregado aunque ningún consumidor lo haya procesado.',
    logs: [['rabbitmq/CP-03.txt', 'Ejecución CP-03']],
    extra: {
      nota: `${reejec} Para que el estado Unacked se pudiera capturar en la consola se dejaron 3 mensajes en la cola (Consumo1…3) antes de iniciar el worker: con <code>prefetch=1</code> y 3 s por mensaje, la cola pasó por Ready=2 / Unacked=1 y terminó en 0. El worker procesó los tres con <code>redelivered=false</code> y ACK 3 s después de cada recepción.`,
      imgs: [['rabbitmq/img/10-cp03-unacked1.png', 'Consola RabbitMQ durante el procesamiento: Ready=2, Unacked=1, un consumidor, tasas Deliver (manual ack) y Consumer ack'], ['rabbitmq/img/09-cp03-terminal-consumo.png', 'Terminal: cola antes (Ready=3), durante (Unacked=1) y después (Total=0), y log completo del worker']],
      logs: [['rabbitmq/CP-03-capturas.txt', 'Re-ejecución CP-03']],
    },
  },
  {
    id: 'CP-06', anchor: 'r-cp06', nombre: 'Trazabilidad del flujo', arq: R,
    objetivo: 'Seguir un mismo pedido (orderId / correlationId) en los logs de la API, del broker y del consumidor.',
    pre: [rabbitPre, 'Plugin <code>rabbitmq_tracing</code> habilitado (archivo <code>enabled_plugins</code>).'],
    datos: 'Cabecera <code>X-Correlation-Id: corr-CP06-124228</code>; body <code>{"customerName":"Laura","product":"Curso de QA","quantity":2}</code>.',
    pasos: ['Crear una traza del broker con la API de administración (<code>PUT /api/traces/%2F/cp06</code>).', 'Enviar el pedido con el correlationId.', 'Buscar el correlationId en el log de orders-api, en la bitácora de tracing del contenedor rabbitmq y en el log del worker.'],
    esperado: 'El mismo orderId y correlationId aparecen en los tres puntos del flujo, con marcas de tiempo coherentes.',
    obtenido: '<code>ORD-E4B0124F</code> / <code>corr-CP06-124228</code>: API 17:42:29.500 "publicado en cola"; broker 17:42:29.499 "Message published" (conexión de orders-api, cola enrutada <code>pedidos</code>) y 17:42:29.500 "Message received" (conexión del worker); worker 17:42:29.500 "Mensaje recibido" y 17:42:32.505 "ACK confirmado".',
    estado: 'Cumple',
    analisis: 'La bitácora del broker es evidencia independiente del código propio: muestra quién publicó (IP 172.20.0.4 = orders-api) y a quién se entregó (172.20.0.3 = worker), con las propiedades AMQP <code>message_id</code> y <code>correlation_id</code>. El correlationId puede venir del cliente (cabecera) o lo genera la API.',
    logs: [['rabbitmq/CP-06.txt', 'Ejecución CP-06']],
    extra: {
      nota: `${reejec} <code>ORD-7E5D3A5B</code> / <code>corr-CP06-captura-165501</code>: API 21:55:03.758 "publicado en cola"; broker 21:55:03.756 "Message published" y 21:55:03.757 "Message received", con <code>message_id</code> y <code>correlation_id</code>; worker 21:55:03.758 "Mensaje recibido" y 21:55:06.759 "ACK confirmado" (UTC).`,
      imgs: [['rabbitmq/img/11-cp06-trazabilidad.png', 'Terminal: el mismo correlationId en el log de orders-api, en la bitácora rabbitmq_tracing del broker y en el log del worker']],
      logs: [['rabbitmq/CP-06-capturas.txt', 'Re-ejecución CP-06']],
    },
  },
  {
    id: 'CP-07', anchor: 'r-cp07', nombre: 'Responsive: la API responde sin esperar al consumidor', arq: R,
    objetivo: 'Demostrar que el tiempo de respuesta HTTP no depende del tiempo de procesamiento del consumidor.',
    pre: [rabbitPre, 'Worker con <code>PROCESSING_MS=3000</code> (3 s por mensaje).'],
    datos: '10 pedidos (Cliente1…Cliente10) enviados seguidos.',
    pasos: ['Enviar 10 pedidos y medir cada respuesta (<code>%{time_total}</code> de curl).', 'Consultar la cola inmediatamente.', 'Esperar a que la cola se vacíe y medir el tiempo.'],
    esperado: 'Cada respuesta en milisegundos; la cola acumula mensajes que el worker procesa después (~30 s).',
    obtenido: 'Las 10 respuestas HTTP 202 tardaron entre 4 y 6 ms (428 ms en total, incluido el arranque de curl). Justo después la cola tenía Ready=9 y Unacked=1. El worker necesitó 30 s más para vaciarla.',
    estado: 'Cumple',
    analisis: 'Si la API esperara al consumidor, cada respuesta tardaría al menos 3 s (30 s en total). La diferencia de tres órdenes de magnitud prueba que la respuesta es independiente del procesamiento. La captura de la consola muestra la cola acumulando (Ready 8, Unacked 1) mientras la API ya había respondido.',
    imgs: [['rabbitmq/img/05-cp07-cola-acumulando.png', 'Consola RabbitMQ durante CP-07: Ready=8, Unacked=1, Total=9']],
    logs: [['rabbitmq/CP-07.txt', 'Ejecución CP-07']],
  },
  {
    id: 'CP-08', anchor: 'r-cp08', nombre: 'Message-driven: no existe comunicación directa', arq: R,
    objetivo: 'Comprobar que la API y el worker solo se comunican a través de RabbitMQ.',
    pre: [rabbitPre],
    datos: 'No aplica (inspección de red, puertos y código).',
    pasos: ['Listar los puertos publicados (<code>docker compose ps</code>).', 'Listar los sockets en escucha dentro del worker (<code>netstat -tln</code>).', 'Listar las conexiones TCP establecidas de la API y del worker.', 'Intentar una llamada HTTP de la API al worker.', 'Listar las conexiones registradas en el broker.', 'Buscar en el código llamadas HTTP salientes o servidores HTTP.'],
    esperado: 'El worker no publica ni escucha puertos; ambos servicios solo tienen conexiones hacia rabbitmq:5672; la llamada HTTP directa falla.',
    obtenido: 'El worker no publica puertos y solo escucha en 127.0.0.11 (resolvedor DNS interno de Docker). La API (172.20.0.4) y el worker (172.20.0.3) solo tienen una conexión ESTABLISHED cada uno, hacia 172.20.0.2:5672 (rabbitmq). <code>wget http://notification-worker:3000</code> desde la API: "Connection refused". El broker lista las conexiones AMQP <code>orders-api</code> y <code>notification-worker@…</code>. En el código, el único servidor HTTP es el de orders-api.',
    estado: 'Cumple',
    analisis: 'La comunicación es exclusivamente AMQP a través del broker. El worker ni siquiera tiene un servidor HTTP que la API pudiera llamar. Los nombres de conexión (<code>connection_name</code>) hacen visible en la consola qué servicio abrió cada conexión.',
    imgs: [['rabbitmq/img/02-conexiones.png', 'Consola RabbitMQ: conexión de orders-api (worker detenido en ese momento)'], ['rabbitmq/img/08-cp10-conexiones-3-workers.png', 'Consola RabbitMQ: solo existen conexiones AMQP de orders-api y de los workers hacia el broker']],
    logs: [['rabbitmq/CP-08.txt', 'Ejecución CP-08']],
  },
  {
    id: 'CP-09', anchor: 'r-cp09', nombre: 'Resilient: el sistema soporta la caída del consumidor', arq: R,
    objetivo: 'Verificar que con el consumidor caído la API sigue aceptando pedidos y los mensajes se conservan.',
    pre: [rabbitPre],
    datos: '5 pedidos (SinWorker1…SinWorker5).',
    pasos: ['<code>docker compose stop notification-worker</code>.', 'Enviar 5 pedidos.', 'Consultar <code>/health</code> de la API.', 'Consultar la cola.'],
    esperado: 'Las 5 respuestas son HTTP 202; la API sigue UP; la cola acumula Ready=5 con consumers=0.',
    obtenido: '5 × HTTP 202 (4–6 ms). <code>/health</code> = <code>{"status":"UP","broker":"connected"}</code>. Cola: Ready=5, Unacked=0, consumers=0. La consola muestra lo mismo.',
    estado: 'Cumple',
    analisis: 'La caída del consumidor no se propaga al productor: el broker absorbe la carga en la cola. El fallo queda contenido en un solo componente.',
    imgs: [['rabbitmq/img/06-cp09-worker-apagado-ready5.png', 'Consola RabbitMQ: 5 mensajes en Ready con el worker apagado']],
    logs: [['rabbitmq/CP-09.txt', 'Ejecución CP-09']],
  },
  {
    id: 'CP-11', anchor: 'r-cp11', nombre: 'Desacoplamiento temporal', arq: R,
    objetivo: 'Verificar que los mensajes publicados con el consumidor apagado se procesan cuando este se inicia.',
    pre: [rabbitPre, '5 mensajes pendientes de CP-09 y worker detenido.'],
    datos: 'Los 5 mensajes de CP-09.',
    pasos: ['Consultar la cola (Ready=5).', '<code>docker compose start notification-worker</code>.', 'Esperar a que la cola se vacíe y revisar el log del worker.'],
    esperado: 'El worker procesa los 5 mensajes en orden FIFO y la cola queda en 0.',
    obtenido: 'El worker se conectó a las 17:44:49.897 y procesó los 5 pedidos (ORD-64D9F560 … ORD-C208AFA0), uno cada 3 s, en el mismo orden de publicación. Cola final: Total=0.',
    estado: 'Cumple',
    analisis: 'Productor y consumidor no necesitan estar activos al mismo tiempo: la cola desacopla en el tiempo. Con <code>prefetch=1</code> los mensajes se procesan uno a uno.',
    logs: [['rabbitmq/CP-11.txt', 'Ejecución CP-11', /Mensaje recibido|Conectado a RabbitMQ/]],
    extra: {
      nota: `${reejec} Con el worker detenido se publicaron 5 pedidos (SinWorker1…5; Ready=5, consumers=0). Al iniciarlo, procesó ORD-464A8196, ORD-6BECF6C8, ORD-43F8F84E, ORD-2BFAB021 y ORD-38323700 en el orden de publicación (deliveryTag 1…5), uno cada 3 s. El gráfico de la consola muestra la cola subiendo a 5 y vaciándose.`,
      imgs: [['rabbitmq/img/12-cp11-terminal-fifo.png', 'Terminal: 5 pedidos con el worker apagado (Ready=5) y procesamiento en orden al iniciarlo'], ['rabbitmq/img/13-cp11-cola-vaciada.png', 'Consola RabbitMQ: la cola pedidos sube a 5 mensajes con el worker apagado y se vacía cuando este arranca']],
      logs: [['rabbitmq/CP-11-capturas.txt', 'Re-ejecución CP-11', /Mensaje recibido/]],
    },
  },
  {
    id: 'CP-10', anchor: 'r-cp10', nombre: 'Elastic: distribución de carga con múltiples consumidores', arq: R,
    objetivo: 'Comprobar que varias instancias del worker se reparten los mensajes de la cola.',
    pre: [rabbitPre],
    datos: '9 pedidos (Escala1…Escala9).',
    pasos: ['<code>docker compose up -d --scale notification-worker=3</code>.', 'Verificar consumers=3.', 'Enviar 9 pedidos.', 'Contar en los logs qué instancia procesó cada pedido.'],
    esperado: 'Los 9 mensajes se reparten entre las 3 instancias; ninguno se procesa dos veces.',
    obtenido: 'consumers=3; durante el procesamiento Unacked=3 (uno por worker). Reparto final: 3 / 3 / 3 mensajes (instancias 3bc4f9724cd0, 6d42aa18b06f, c5e91622592e), sin duplicados.',
    estado: 'Cumple',
    analisis: 'RabbitMQ entrega en <em>round-robin</em> entre consumidores de la misma cola. Con <code>prefetch(1)</code> ningún worker acapara mensajes: cada uno recibe el siguiente solo después de confirmar el anterior. Escalar no requirió cambios de código porque el servicio no declara <code>container_name</code>.',
    imgs: [['rabbitmq/img/07-cp10-tres-consumidores.png', 'Consola RabbitMQ: 3 consumidores con prefetch 1 y Unacked=3'], ['rabbitmq/img/08-cp10-conexiones-3-workers.png', 'Consola RabbitMQ: conexiones de las 3 instancias del worker']],
    logs: [['rabbitmq/CP-10.txt', 'Ejecución CP-10']],
  },
  {
    id: 'CP-12', anchor: 'r-cp12', nombre: 'Recuperación tras reinicio del consumidor y del broker', arq: R,
    objetivo: 'Verificar que los mensajes no confirmados (consumidor) y los pendientes (broker) se procesan sin pérdida tras un reinicio.',
    pre: [rabbitPre, 'Una sola instancia del worker.'],
    datos: 'A) 3 pedidos (Recupera1…3). B) 3 pedidos (Broker1…3) + 1 pedido tras el reinicio (Broker4).',
    pasos: ['A) Enviar 3 pedidos; con uno en Unacked, matar el worker con <code>docker kill</code> (SIGKILL).', 'A) Consultar la cola y volver a levantar el worker.', 'B) Detener el worker, enviar 3 pedidos y reiniciar el broker (<code>docker compose restart rabbitmq</code>).', 'B) Consultar la cola tras el reinicio, enviar un pedido nuevo y levantar el worker.'],
    esperado: 'A) El mensaje Unacked vuelve a Ready y se reprocesa (redelivered=true). B) Los 3 mensajes persisten tras reiniciar el broker, la API se reconecta sola y el worker procesa los 4.',
    obtenido: 'A) Antes del kill: Ready=2, Unacked=1. Después: Ready=3, Unacked=0. Al volver, el worker procesó ORD-B867DF6A con <code>redelivered=true</code> y luego los otros 2. B) Ready=3 antes y después del reinicio del broker. La API registró "Conexión con RabbitMQ cerrada. Reintentando..." y se reconectó 8 s después; el pedido Broker4 fue aceptado (202). El worker procesó los 4 mensajes.',
    estado: 'Cumple',
    analisis: 'El ACK manual garantiza entrega <em>al menos una vez</em>: si el consumidor muere sin confirmar, el broker reentrega el mensaje. La cola durable, los mensajes persistentes, el volumen de datos y el <code>hostname</code> fijo del broker hacen que los mensajes sobrevivan a un reinicio. La reconexión automática de la API evita reiniciarla manualmente. Riesgo observado: el mensaje reentregado se procesa dos veces (aquí, notificación duplicada), por lo que en producción el consumidor debería ser idempotente.',
    logs: [['rabbitmq/CP-12.txt', 'Ejecución CP-12']],
    extra: {
      nota: `${reejec} A) Recupera1 (ORD-E3E32A33) ya estaba confirmado cuando se ejecutó <code>docker kill</code>; Recupera2 (ORD-A35EF288) estaba en proceso sin ACK. Tras el kill la cola quedó en Ready=2 (Recupera2 + Recupera3) y, al levantar el worker, ORD-A35EF288 se reentregó con <code>redelivered=true</code>. B) Ready=3 antes y después de <code>docker compose restart rabbitmq</code>; la consola, recargada después del reinicio, muestra los 3 mensajes como persistentes. La API se reconectó sola, Broker4 fue aceptado (202) y el worker procesó los 4. En un primer intento de esta re-ejecución el worker alcanzó a confirmar el mensaje antes del <code>kill</code> y no hubo nada que reentregar; se ajustó el momento del <code>kill</code> y se repitió el caso completo (es la corrida que se muestra). La ventana de terminal no alcanzó a mostrar las dos primeras líneas; el registro completo está en el archivo de texto.`,
      imgs: [['rabbitmq/img/14-cp12-terminal-recuperacion.png', 'Terminal: A) kill del worker con un mensaje sin ACK y reentrega con redelivered=true; B) reinicio del broker con 3 mensajes pendientes, reconexión de la API y procesamiento de los 4'], ['rabbitmq/img/15-cp12-cola-tras-reinicio-broker.png', 'Consola RabbitMQ después de reiniciar el broker: cola pedidos durable con Ready=3 y Persistent=3']],
      logs: [['rabbitmq/CP-12-capturas.txt', 'Re-ejecución CP-12']],
    },
  },
];

// ---------------------------------------------------------------- Kafka
const K = 'Kafka';
const kafkaPre = 'Stack <code>kafka/docker-compose.yml</code> en ejecución (kafka, kafka-init, kafka-ui, orders-api, inventory/billing/notification-consumer).';
const casosKafka = [
  {
    id: 'CP-01', anchor: 'k-cp01', nombre: 'Creación de pedido vía API', arq: K,
    objetivo: 'Validar que el endpoint <code>POST /orders</code> recibe el pedido, lo valida y responde correctamente.',
    pre: [kafkaPre, 'Productor conectado a Kafka.'],
    datos: '<code>{"customerName":"Carlos","product":"Libro de arquitectura","quantity":1,"unitPrice":85000}</code>; casos negativos con <code>product</code> vacío y <code>quantity:-1</code>, y texto no JSON.',
    pasos: ['Enviar el pedido válido con curl.', 'Enviar los pedidos inválidos.', 'Revisar el log de orders-api.', 'Repetir el pedido válido desde Postman (<code>POST http://localhost:3010/orders</code>, body raw JSON) y buscar su <code>orderId</code> en los logs de orders-api y de los consumidores.'],
    esperado: 'HTTP 202 con <code>status: accepted</code> y el mensaje "Pedido recibido y evento OrderCreated publicado en Kafka"; HTTP 400 para los inválidos.',
    obtenido: 'HTTP 202 en 0,034 s (primer envío, incluye la obtención de metadatos del tópico) con <code>orderId=ORD-702E978A</code>, <code>eventId</code> y <code>correlationId</code>. Los inválidos: HTTP 400 con los errores (incluido <code>unitPrice</code> faltante). Desde Postman: <code>202 Accepted</code> con <code>orderId=ORD-6DF5C20B</code>; orders-api registró la publicación en <code>partition=0 offset=15</code> y los tres consumidores reaccionaron al mismo evento.',
    estado: 'Cumple',
    analisis: 'La API valida también <code>unitPrice</code>, que en Kafka es obligatorio para calcular el <code>total</code> del evento. El primer envío es más lento porque el productor descarga los metadatos de particiones; los siguientes tardan 5–8 ms (ver CP-07). El pedido de Postman se envió en una ejecución posterior (31 de octubre) sobre el mismo volumen de Kafka, por eso su offset continúa desde los eventos anteriores.',
    imgs: [['kafka/img/00-cp01-postman-202-accepted.png', 'Postman: POST /orders responde 202 Accepted con orderId, eventId y correlationId']],
    logs: [['kafka/CP-01.txt', 'Ejecución CP-01'], ['kafka/CP-01-postman.txt', 'Pedido de Postman en los logs de orders-api y de los consumidores']],
  },
  {
    id: 'CP-04', anchor: 'k-cp04', nombre: 'Publicación de evento en Kafka', arq: K,
    objetivo: 'Verificar que cada pedido genera un evento <code>OrderCreated</code> con los metadatos mínimos en el tópico <code>orders.events</code>.',
    pre: [kafkaPre, 'Tópico <code>orders.events</code> creado con 3 particiones por <code>kafka-init</code>.'],
    datos: '<code>{"customerName":"Pedro","product":"Libro de arquitectura","quantity":1,"unitPrice":85000}</code>',
    pasos: ['Consultar los offsets finales del tópico.', 'Enviar el pedido.', 'Revisar el log de orders-api (partición y offset asignados).', 'Consultar de nuevo los offsets.', 'Leer el evento directamente del broker con <code>kafka-console-consumer.sh</code> y en Kafka UI.'],
    esperado: 'Una partición avanza en 1. El evento tiene <code>eventId</code>, <code>eventType=OrderCreated</code>, <code>eventVersion</code>, <code>occurredAt</code>, <code>source</code>, <code>correlationId</code> y <code>data</code>, con key = orderId.',
    obtenido: 'Offsets 0:1 / 1:0 / 2:0 → 0:1 / 1:0 / 2:1. La API registró <code>partition=2 offset=0 orderId=ORD-D640D38E</code>. El evento leído del broker (Partition:2 Offset:0, key ORD-D640D38E) y en Kafka UI contiene todos los campos, con <code>total=85000</code>.',
    estado: 'Cumple',
    analisis: 'El nombre en pasado (<code>OrderCreated</code>) expresa un hecho ocurrido, no una orden. Usar el orderId como key garantiza que los eventos de un mismo pedido vayan a la misma partición y conserven su orden. Las cabeceras Kafka también llevan <code>eventType</code> y <code>correlationId</code>.',
    imgs: [['kafka/img/03-topicos.png', 'Kafka UI: tópico orders.events'], ['kafka/img/04-topico-particiones.png', 'Kafka UI: 3 particiones y mensajes por partición'], ['kafka/img/05-cp04-mensajes.png', 'Kafka UI: mensajes del tópico con offset, partición y key'], ['kafka/img/05-cp04-contenido-evento.png', 'Kafka UI: contenido JSON del evento OrderCreated']],
    logs: [['kafka/CP-04.txt', 'Ejecución CP-04']],
  },
  {
    id: 'CP-05', anchor: 'k-cp05', nombre: 'Consumo de evento (Kafka)', arq: K,
    objetivo: 'Validar que cada consumidor, en su propio consumer group, recibe el mismo evento.',
    pre: [kafkaPre, 'Evento ORD-D640D38E publicado en CP-04.'],
    datos: 'Evento <code>ORD-D640D38E</code> (partición 2, offset 0).',
    pasos: ['Esperar LAG=0 en los tres grupos.', 'Buscar el orderId en el log de inventory, billing y notification.', 'Listar y describir los consumer groups en el broker y en Kafka UI.'],
    esperado: 'Los tres consumidores registran el mismo eventId con topic/partition/offset y ejecutan su acción; existen tres grupos distintos con LAG 0.',
    obtenido: 'inventory: "Inventario reservado: 1 x Libro de arquitectura"; billing: "Factura generada por $85000"; notification: "Notificación enviada a Pedro". Los tres registran <code>partition=2 offset=0</code> y el mismo eventId. Grupos inventory-, billing- y notification-service-group en estado STABLE con LAG 0.',
    estado: 'Cumple',
    analisis: 'Cada grupo mantiene su propio offset, así que un evento se entrega una vez a cada grupo (publicación/suscripción). El grupo <code>console-consumer-68130</code> lo creó la herramienta de inspección usada en CP-04; no pertenece al sistema.',
    imgs: [['kafka/img/06-cp05-consumer-groups.png', 'Kafka UI: tres consumer groups distintos'], ['kafka/img/07-cp05-grupo-billing-offsets.png', 'Kafka UI: billing-service-group, 3 particiones asignadas y LAG 0']],
    logs: [['kafka/CP-05.txt', 'Ejecución CP-05', /topic=orders\.events partition/]],
    extra: {
      nota: `${reejec} Pedido <code>ORD-904F113A</code> (Valentina, 2 × 85000) publicado en <code>partition=1 offset=11</code>. Cada consumidor registró el mismo eventId y ejecutó su acción: inventory "Inventario reservado: 2 x Libro de arquitectura", billing "Factura generada por $170000", notification "Notificación enviada a Valentina". Debajo de cada log se ve su consumer group con LAG 0.`,
      imgs: [['kafka/img/14-cp05-log-inventory-consumer.png', 'Terminal: log de inventory-consumer para ORD-904F113A y estado de inventory-service-group'], ['kafka/img/15-cp05-log-billing-consumer.png', 'Terminal: log de billing-consumer para ORD-904F113A y estado de billing-service-group'], ['kafka/img/16-cp05-log-notification-consumer.png', 'Terminal: log de notification-consumer para ORD-904F113A y estado de notification-service-group']],
      logs: [['kafka/CP-05-capturas.txt', 'Re-ejecución CP-05']],
    },
  },
  {
    id: 'CP-06', anchor: 'k-cp06', nombre: 'Trazabilidad del flujo', arq: K,
    objetivo: 'Seguir un mismo pedido (orderId / correlationId) en los logs de la API, en el broker y en los consumidores.',
    pre: [kafkaPre],
    datos: 'Cabecera <code>X-Correlation-Id: corr-CP06-124929</code>; pedido de Laura, 2 × Curso de QA a 120000.',
    pasos: ['Enviar el pedido con el correlationId.', 'Buscarlo en el log de orders-api.', 'Leer del broker el registro con partición, offset, cabeceras, key y valor.', 'Buscarlo en el log de los tres consumidores.'],
    esperado: 'El mismo orderId/correlationId en la API, en el log del tópico y en los tres consumidores, con la misma partición y offset.',
    obtenido: '<code>ORD-296E793F</code>: API "publicado partition=1 offset=0" (17:49:29.271); broker Partition:1 Offset:0 con cabeceras <code>eventType:OrderCreated,correlationId:corr-CP06-124929</code>; inventory, billing y notification lo recibieron en partition=1 offset=0 (17:49:29.273–.274) y completaron su acción 1 s después.',
    estado: 'Cumple',
    analisis: 'La pareja (partición, offset) identifica de forma única el registro en el broker y coincide en los cuatro servicios. Junto con el correlationId permite reconstruir el flujo completo y ver que los tres consumidores reaccionaron en paralelo e independientemente.',
    logs: [['kafka/CP-06.txt', 'Ejecución CP-06']],
    extra: {
      nota: `${reejec} <code>ORD-BDD2A01A</code> / <code>corr-CP06-captura-164914</code>: API "publicado partition=0 offset=16" (21:49:14.574 UTC); broker Partition:0 Offset:16 con cabeceras <code>eventType:OrderCreated,correlationId:corr-CP06-captura-164914</code>; inventory, billing y notification lo recibieron en partition=0 offset=16 (21:49:14.578–.580) y completaron su acción 1 s después.`,
      imgs: [['kafka/img/17-cp06-trazabilidad.png', 'Terminal: el mismo correlationId en orders-api, en el registro del tópico (partición, offset, cabeceras, key) y en los tres consumidores']],
      logs: [['kafka/CP-06-capturas.txt', 'Re-ejecución CP-06', /Evento recibido/]],
    },
  },
  {
    id: 'CP-07', anchor: 'k-cp07', nombre: 'Responsive: la API responde sin esperar a los consumidores', arq: K,
    objetivo: 'Demostrar que la respuesta HTTP no depende del procesamiento de los consumidores.',
    pre: [kafkaPre, 'Consumidores con <code>PROCESSING_MS=1000</code>.'],
    datos: '10 pedidos (Cliente1…Cliente10).',
    pasos: ['Enviar 10 pedidos midiendo cada respuesta.', 'Consultar el LAG de los tres grupos inmediatamente.', 'Esperar LAG=0 y medir el tiempo.'],
    esperado: 'Respuestas en milisegundos con LAG > 0 justo después; los consumidores terminan segundos más tarde.',
    obtenido: '10 × HTTP 202 (463 ms en total). LAG inmediato: inventory 9, billing 9, notification 6. Los tres grupos llegaron a LAG 0 11 s después.',
    estado: 'Cumple',
    analisis: 'El LAG mide cuántos eventos publicados aún no procesó cada grupo: que sea mayor que 0 después de responder demuestra que la API no esperó. Cada grupo avanza a su propio ritmo (notification iba algo más adelantado).',
    logs: [['kafka/CP-07.txt', 'Ejecución CP-07']],
    extra: {
      nota: `${reejec} Las 10 respuestas fueron HTTP 202 en 7–21 ms. Justo después el LAG era 9 en inventory (4 + 1 + 4), 8 en billing y 5 en notification; Kafka UI, abierto en ese momento, muestra <em>Total lag 9</em> para inventory-service-group. Los tres grupos llegaron a LAG 0 7 s después.`,
      imgs: [['kafka/img/18-cp07-terminal-lag.png', 'Terminal: 10 pedidos respondidos en milisegundos, LAG por partición inmediatamente después y LAG 0 a los 7 s'], ['kafka/img/19-cp07-kafka-ui-lag.png', 'Kafka UI justo después de los 10 pedidos: inventory-service-group con Total lag 9']],
      logs: [['kafka/CP-07-capturas.txt', 'Re-ejecución CP-07']],
    },
  },
  {
    id: 'CP-08', anchor: 'k-cp08', nombre: 'Message-driven: no existe comunicación directa', arq: K,
    objetivo: 'Comprobar que la API y los consumidores solo se comunican a través de Kafka.',
    pre: [kafkaPre],
    datos: 'No aplica (inspección de red, puertos y código).',
    pasos: ['Listar los puertos publicados.', 'Listar los sockets en escucha en cada consumidor.', 'Listar las conexiones establecidas de la API y de los consumidores.', 'Intentar una llamada HTTP de la API a inventory-consumer.', 'Buscar en el código llamadas HTTP salientes o servidores HTTP.'],
    esperado: 'Los consumidores no publican ni escuchan puertos y solo se conectan a kafka:9092; la llamada HTTP directa falla.',
    obtenido: 'Solo publican puertos kafka (29092), kafka-ui (8080) y orders-api (3010→3000). Los consumidores solo escuchan en 127.0.0.11 (DNS de Docker). Todas las conexiones ESTABLISHED van a 172.20.0.2:9092 (kafka). <code>wget http://inventory-consumer:3000</code>: "Connection refused". El único servidor HTTP del código es el de orders-api.',
    estado: 'Cumple',
    analisis: 'El productor no conoce a los consumidores: solo conoce el tópico. Por eso se pudo agregar un consumidor nuevo (audit-consumer, CP-11) sin tocar la API.',
    imgs: [['kafka/img/02-broker-activo.png', 'Kafka UI: broker activo (id 1, puerto 9092)']],
    logs: [['kafka/CP-08.txt', 'Ejecución CP-08']],
  },
  {
    id: 'CP-09', anchor: 'k-cp09', nombre: 'Resilient: el sistema soporta la caída de un consumidor', arq: K,
    objetivo: 'Verificar que con un consumidor caído la API y los demás consumidores siguen funcionando.',
    pre: [kafkaPre],
    datos: '3 pedidos (SinBilling1…3).',
    pasos: ['<code>docker compose stop billing-consumer</code>.', 'Enviar 3 pedidos.', 'Consultar <code>/health</code>.', 'Verificar que inventory y notification los procesaron.', 'Describir el grupo billing-service-group.'],
    esperado: 'Las 3 respuestas son 202; inventory y notification procesan los 3 eventos; billing acumula LAG=3 sin miembros activos.',
    obtenido: '3 × HTTP 202; API UP. inventory reservó y notification notificó los 3 pedidos; billing registró 0 eventos. Grupo billing: LAG 1 + 0 + 2 = 3, sin CONSUMER-ID (estado EMPTY en Kafka UI).',
    estado: 'Cumple',
    analisis: 'La caída de un consumidor solo afecta a su propio grupo. Los eventos no se pierden: quedan en el log y el offset confirmado del grupo marca dónde retomar.',
    imgs: [['kafka/img/08-cp09-grupos-billing-sin-miembros.png', 'Kafka UI: billing-service-group con 0 miembros (EMPTY)'], ['kafka/img/09-cp09-billing-lag3.png', 'Kafka UI: billing-service-group con LAG total 3']],
    logs: [['kafka/CP-09.txt', 'Ejecución CP-09']],
  },
  {
    id: 'CP-11', anchor: 'k-cp11', nombre: 'Desacoplamiento temporal y consumidor posterior', arq: K,
    objetivo: 'Verificar que los eventos publicados con un consumidor apagado se procesan al iniciarlo, y que un consumidor creado después de publicar los eventos los lee desde el log.',
    pre: [kafkaPre, 'A) 3 eventos pendientes para billing (CP-09). B) El grupo audit-service-group no existe.'],
    datos: 'A) Eventos SinBilling1…3. B) Todo el log del tópico (19 eventos: 8 + 5 + 6 por partición).',
    pasos: ['A) <code>docker compose start billing-consumer</code> y esperar LAG=0.', 'B) Listar los grupos existentes y los offsets finales del tópico.', 'B) <code>docker compose --profile late up -d audit-consumer</code> (grupo nuevo, <code>fromBeginning: true</code>).', 'B) Contar los eventos leídos y describir el grupo.'],
    esperado: 'A) billing procesa los 3 eventos pendientes desde su último offset. B) audit-consumer lee los 19 eventos desde el offset 0 de cada partición.',
    obtenido: 'A) billing se unió al grupo y facturó ORD-40AECA0F (p0 o7), ORD-41652E7F (p2 o4) y ORD-2BAF2935 (p2 o5); LAG final 0. B) audit-consumer leyó las particiones 2 (offsets 0–5), 1 (0–4) y 0 (0–7): 19 eventos, LAG final 0.',
    estado: 'Cumple',
    analisis: 'Kafka conserva los eventos aunque ya los hayan leído otros grupos (log persistente con retención), a diferencia de una cola. Un grupo nuevo puede reconstruir toda la historia. Nota de ejecución: la primera corrida de la parte B se detuvo antes de tiempo por un error en la función <code>lag()</code> del script (no contaba el LAG de un grupo sin offsets confirmados); se corrigió, se eliminó el grupo de auditoría y la parte B se repitió completa (archivo <code>CP-11-posterior.txt</code>).',
    imgs: [['kafka/img/10-cp10-cp11-grupos.png', 'Kafka UI: aparece audit-service-group junto a los grupos funcionales']],
    logs: [['kafka/CP-11.txt', 'Ejecución CP-11 (A): billing retoma los eventos pendientes', /Evento recibido/], ['kafka/CP-11-posterior.txt', 'Ejecución CP-11 (B): consumidor posterior lee el log desde el inicio', /key=ORD-(40AECA0F|41652E7F|2BAF2935)/]],
  },
  {
    id: 'CP-10', anchor: 'k-cp10', nombre: 'Elastic: distribución de carga con varias instancias del mismo grupo', arq: K,
    objetivo: 'Comprobar que dos instancias del mismo consumidor (mismo grupo) se reparten las particiones.',
    pre: [kafkaPre, 'Tópico con 3 particiones.'],
    datos: '9 pedidos (Escala1…9), cada uno con su orderId como key.',
    pasos: ['<code>docker compose up -d --scale inventory-consumer=2</code>.', 'Describir los miembros del grupo.', 'Enviar 9 pedidos.', 'Contar los eventos procesados por cada instancia y partición.', 'Verificar que billing y notification recibieron los 9.'],
    esperado: 'Las 3 particiones se reparten entre las 2 instancias; cada evento lo procesa una sola instancia del grupo; los demás grupos reciben los 9.',
    obtenido: 'Miembros: una instancia con 2 particiones (0 y 2) y otra con 1 (partición 1). Reparto: a2c481ced28e procesó 4 eventos de la partición 0 y 1 de la partición 2; d5d9dfbc2cc6 procesó 4 de la partición 1. Total 9, sin duplicados. billing y notification: 9 cada uno.',
    estado: 'Cumple',
    analisis: 'En Kafka el paralelismo de un grupo está limitado por el número de particiones (por eso el tópico tiene 3). El reparto es por partición, no por mensaje: depende del hash de la key, por lo que no es exactamente equitativo (5 frente a 4).',
    imgs: [['kafka/img/11-cp10-inventory-2-miembros.png', 'Kafka UI: inventory-service-group con 2 miembros y las particiones repartidas']],
    logs: [['kafka/CP-10.txt', 'Ejecución CP-10']],
  },
  {
    id: 'CP-12', anchor: 'k-cp12', nombre: 'Recuperación tras reinicio del consumidor y del broker', arq: K,
    objetivo: 'Verificar que tras una caída abrupta del consumidor o un reinicio del broker los eventos pendientes se procesan sin pérdida.',
    pre: [kafkaPre, 'inventory-consumer escalado a 2 instancias (CP-10).'],
    datos: 'A) 3 pedidos (Recupera1…3). B) 3 pedidos (Broker1…3) + 1 tras el reinicio (Broker4).',
    pasos: ['A) <code>docker kill</code> de notification-consumer, enviar 3 pedidos, describir el grupo y volver a levantarlo.', 'B) Detener billing-consumer, enviar 3 pedidos, guardar los offsets y reiniciar el broker (<code>docker compose restart kafka</code>).', 'B) Comparar los offsets antes y después, enviar un pedido nuevo y levantar billing.', 'C) Analizar el LAG residual de inventory-service-group.'],
    esperado: 'A) notification procesa los 3 eventos al volver. B) El log y los offsets confirmados se conservan; billing procesa los 4 eventos. Ningún evento se pierde.',
    obtenido: 'A) LAG 3 mientras estaba caído; al volver procesó los 3 (p2 o7, p2 o8, p0 o12). Tardó ~26 s en unirse porque el broker esperó a que expirara la sesión del miembro anterior, que murió sin despedirse. B) Offsets 15/10/9 antes y después del reinicio; el grupo billing conservó sus offsets confirmados (LAG 3); la API publicó Broker4 tras el reinicio; billing procesó los 4. C) Una instancia de inventario procesó el evento p0 o14 (ORD-05CEDD1E) 0,2 s antes de que el broker se detuviera, pero el commit de su offset no llegó: el grupo quedó con LAG=1. Al reiniciar esa instancia, el evento se volvió a entregar y procesar (duplicado) y el LAG quedó en 0.',
    estado: 'Cumple',
    analisis: 'No hubo pérdida de eventos: el log es persistente (volumen <code>kafka-data</code>) y cada grupo retoma desde su último offset confirmado. La parte C muestra la semántica <em>al menos una vez</em> de Kafka con commit posterior al procesamiento: si el commit se pierde, el evento se reprocesa. Es un hallazgo relevante de QA: los consumidores deben ser idempotentes (por ejemplo, registrando los <code>eventId</code> ya procesados) para que un duplicado no reserve inventario dos veces.',
    imgs: [['kafka/img/13-cp12-topico-tras-reinicio.png', 'Kafka UI: el tópico conserva sus mensajes tras el reinicio del broker']],
    logs: [['kafka/CP-12.txt', 'Ejecución CP-12 (A y B)'], ['kafka/CP-12-analisis-lag.txt', 'CP-12 (C): análisis del LAG residual y reentrega']],
    extra: {
      nota: `${reejec} Se repitió la parte B. Con billing-consumer detenido se publicaron Broker1…3; los offsets del tópico (25/13/13) y el offset confirmado del grupo billing (22 en la partición 0, LAG 3) fueron los mismos antes y después de <code>docker compose restart kafka</code>. La API publicó Broker4 tras el reinicio y billing, al volver, facturó los 4 pedidos (ORD-C50C7B78, ORD-B5A0F0B9, ORD-11EF65D2, ORD-EF8487B9): LAG final 0. Observación: billing-consumer no terminó dentro de los 10 s de gracia de <code>docker compose stop</code> (salida 137), así que su sesión siguió registrada en el grupo hasta expirar; por eso la captura con LAG 3 muestra Members=1 aunque el contenedor estaba detenido.`,
      imgs: [['kafka/img/20-cp12-terminal-reinicio-broker.png', 'Terminal: offsets del tópico y del grupo billing antes y después del reinicio del broker, y recuperación de billing'], ['kafka/img/21-cp12-billing-lag3-tras-reinicio.png', 'Kafka UI después del reinicio del broker: billing-service-group conserva su offset (22) con LAG 3 en la partición 0'], ['kafka/img/22-cp12-billing-lag0-recuperado.png', 'Kafka UI: billing-service-group con LAG 0 después de procesar los 4 eventos']],
      logs: [['kafka/CP-12-capturas.txt', 'Re-ejecución CP-12 (B)', /Factura generada/]],
    },
  },
];

const resumen = [
  ['CP-01', 'Creación de pedido vía API', 'Cumple', 'Cumple'],
  ['CP-02', 'Envío de mensaje a RabbitMQ', 'Cumple', '—'],
  ['CP-03', 'Consumo de mensaje (RabbitMQ)', 'Cumple', '—'],
  ['CP-04', 'Publicación de evento en Kafka', '—', 'Cumple'],
  ['CP-05', 'Consumo de evento (Kafka)', '—', 'Cumple'],
  ['CP-06', 'Trazabilidad del flujo', 'Cumple', 'Cumple'],
  ['CP-07', 'Responsive', 'Cumple', 'Cumple'],
  ['CP-08', 'Message-driven', 'Cumple', 'Cumple'],
  ['CP-09', 'Resilient', 'Cumple', 'Cumple'],
  ['CP-10', 'Elastic', 'Cumple', 'Cumple'],
  ['CP-11', 'Desacoplamiento temporal', 'Cumple', 'Cumple'],
  ['CP-12', 'Recuperación', 'Cumple', 'Cumple*'],
];

const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>Pruebas de Integración en Arquitecturas Basadas en Mensajes y Eventos</title>
<style>
  @page { size: Letter; margin: 16mm 14mm 16mm 14mm; }
  :root { --ink:#1b2430; --muted:#5b6675; --line:#d6dbe2; --accent:#1f4e79; --rabbit:#c25b12; --kafka:#2f3e9e; --ok:#1d7a3a; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Calibri, Arial, sans-serif; color: var(--ink); font-size: 10.5pt; line-height: 1.45; margin: 0; }
  h1 { font-size: 22pt; color: var(--accent); margin: 0 0 6px; line-height: 1.2; }
  h2 { font-size: 15pt; color: var(--accent); border-bottom: 2px solid var(--accent); padding-bottom: 4px; margin: 26px 0 10px; break-after: avoid; }
  h3 { font-size: 12.5pt; margin: 22px 0 8px; break-after: avoid; }
  h4 { font-size: 11pt; margin: 14px 0 6px; color: var(--muted); break-after: avoid; }
  p { margin: 6px 0; }
  code { font-family: Consolas, "Cascadia Mono", monospace; font-size: 9pt; background: #f1f3f6; padding: 0 3px; border-radius: 3px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; }
  th, td { border: 1px solid var(--line); padding: 5px 7px; vertical-align: top; text-align: left; }
  thead th, table.grid th { background: #eef2f7; }
  table.fmt th { width: 22%; background: #f5f7fa; font-weight: 600; }
  table.fmt ul, table.fmt ol { margin: 0; padding-left: 18px; }
  .cover { min-height: 245mm; display: flex; flex-direction: column; justify-content: space-between; break-after: page; }
  .cover .inst { color: var(--muted); font-weight: 600; letter-spacing: .04em; }
  .cover .sub { font-size: 13pt; color: var(--muted); margin-bottom: 30px; }
  .cover table { width: auto; min-width: 60%; }
  .arch { font-size: 8.5pt; color: #fff; padding: 2px 8px; border-radius: 10px; vertical-align: middle; margin-left: 6px; }
  .arch.rabbitmq { background: var(--rabbit); } .arch.kafka { background: var(--kafka); }
  .estado { font-weight: 700; } .estado.ok { color: var(--ok); } .estado.ko { color: #b00020; }
  .case { margin-top: 28px; padding-top: 6px; border-top: 3px solid var(--line); }
  .fmt { break-inside: auto; }
  figure { margin: 10px 0; break-inside: avoid; }
  figure img { display: block; max-width: 100%; max-height: 100mm; margin: 0 auto; border: 1px solid var(--line); }
  figcaption { text-align: center; }
  figcaption { font-size: 9pt; color: var(--muted); margin-top: 3px; }
  .src { font-family: Consolas, monospace; font-size: 8pt; color: #8a94a3; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .log { margin: 10px 0; border: 1px solid #b9c2ce; border-radius: 4px; }
  .logtitle { background: #e6ebf1; color: #1b2430; font-size: 9pt; font-weight: 600; padding: 4px 8px; border-bottom: 1px solid #b9c2ce; break-after: avoid; }
  .logtitle .src { color: #5b6675; font-weight: 400; float: right; }
  pre { margin: 0; padding: 8px; background: #f8f9fb; color: #111820; font-family: Consolas, "Cascadia Mono", monospace; font-size: 7.4pt; line-height: 1.35; white-space: pre-wrap; word-break: break-all; }
  .note { background: #f6f8fb; border-left: 4px solid var(--accent); padding: 8px 12px; margin: 10px 0; }
  .warn { background: #fff8ec; border-left: 4px solid #d18b00; padding: 8px 12px; margin: 10px 0; }
  .toc a { color: var(--ink); text-decoration: none; }
  .toc li { margin: 2px 0; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .cmp td:first-child { font-weight: 600; width: 22%; }
  .pagebreak { break-before: page; }
</style></head>
<body>

<div class="cover">
  <div>
    <div class="inst">INSTITUCIÓN UNIVERSITARIA ITM · INGENIERÍA DE SISTEMAS · ASEGURAMIENTO DE LA CALIDAD</div>
    <h1 style="margin-top:60px">Pruebas de Integración en Arquitecturas Basadas en Mensajes y Eventos</h1>
    <div class="sub">Sistema de procesamiento de pedidos con RabbitMQ y Apache Kafka: montaje, ejecución de los casos CP-01 a CP-12 y evidencia técnica</div>
    <table>
      <tr><th>Integrantes</th><td>Santiago Betancur<br>Diego Alzate<br>Carlos Mendez<br>Heyner Mena</td></tr>
      <tr><th>Fecha de ejecución de las pruebas</th><td>30 de octubre de 2026 (capturas complementarias: 31 de octubre de 2026)</td></tr>
      <tr><th>Fecha de entrega</th><td>1 de noviembre de 2026</td></tr>
      <tr><th>Código fuente</th><td><a href="https://github.com/Xantyagoh/pruebas-integracion-mensajes-eventos">https://github.com/Xantyagoh/pruebas-integracion-mensajes-eventos</a> · también se entrega <code>pruebas-integracion-mensajes-eventos.zip</code> (código fuente y <code>docker-compose.yml</code> de cada arquitectura)</td></tr>
    </table>
  </div>
  <div>
    <table class="grid">
      <thead><tr><th>Entorno de ejecución</th><th>Versión</th></tr></thead>
      <tr><td>Sistema operativo</td><td>Windows 11 Pro 10.0.26200</td></tr>
      <tr><td>Docker Engine / Docker Compose</td><td>29.4.0 / v5.1.1 (Docker Desktop)</td></tr>
      <tr><td>RabbitMQ (imagen <code>rabbitmq:4-management</code>)</td><td>4.4.0 sobre Erlang 29.1.2</td></tr>
      <tr><td>Kafka (imagen <code>bitnamilegacy/kafka:3.7</code>, modo KRaft)</td><td>3.7.1</td></tr>
      <tr><td>Kafka UI (imagen <code>provectuslabs/kafka-ui</code>)</td><td>v0.7.2</td></tr>
      <tr><td>Servicios (API y consumidores)</td><td>Node.js 22 (node:22-alpine), amqplib 0.10.9, kafkajs 2.2.4</td></tr>
    </table>
  </div>
</div>

<h2>Contenido</h2>
<ol class="toc">
  <li><a href="#resumen">Resumen de resultados</a></li>
  <li><a href="#impl">Implementación mínima</a></li>
  <li><a href="#entorno">Montaje del entorno y evidencias de arranque</a></li>
  <li><a href="#rabbit">Ejecución de pruebas: RabbitMQ</a></li>
  <li><a href="#kafka">Ejecución de pruebas: Kafka</a></li>
  <li><a href="#conclusiones">Conclusiones</a></li>
  <li><a href="#anexo">Anexo: reproducción y archivos de evidencia</a></li>
</ol>

<h2 id="resumen">1. Resumen de resultados</h2>
<p>Se implementaron dos sistemas independientes de procesamiento de pedidos, uno basado en mensajes (RabbitMQ) y otro basado en eventos (Kafka). Cada componente corre en su propio contenedor y se levanta con Docker Compose. Los casos se ejecutaron con los scripts <code>rabbitmq/pruebas.sh</code> y <code>kafka/pruebas.sh</code>, que guardan la salida real de cada paso en <code>evidencias/</code>. Las capturas de la consola de RabbitMQ y de Kafka UI se tomaron con el navegador durante esa misma ejecución. Los casos que en esa ejecución solo dejaron evidencia en texto se repitieron el 31 de octubre sobre el mismo stack para tomar capturas de la terminal y de las consolas; cada caso las muestra en un apartado "Capturas complementarias", con su propio log (<code>evidencias/&lt;arquitectura&gt;/CP-XX-capturas.txt</code>). Todas las horas citadas en el informe son las de los logs de los contenedores, en UTC (hora de Colombia = UTC−5).</p>
<table class="grid">
  <thead><tr><th>ID</th><th>Caso / propiedad</th><th>RabbitMQ</th><th>Kafka</th></tr></thead>
  ${resumen.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td class="estado ${r[2].startsWith('Cumple') ? 'ok' : ''}">${r[2]}</td><td class="estado ${r[3].startsWith('Cumple') ? 'ok' : ''}">${r[3]}</td></tr>`).join('')}
</table>
<p>* En Kafka CP-12 no se perdió ningún evento, pero se observó un evento procesado dos veces después del reinicio del broker (entrega <em>al menos una vez</em>). Se documenta como hallazgo en el caso. En RabbitMQ CP-12 también hubo un mensaje procesado dos veces, pero ahí la reentrega (<code>redelivered=true</code>) era el resultado esperado del caso.</p>
<div class="note"><strong>Nota sobre el puerto de la API.</strong> En el equipo de pruebas el puerto 3000 ya estaba ocupado por otro proyecto. El puerto publicado de orders-api es configurable (<code>"\${API_PORT:-3000}:3000"</code>): por defecto es 3000, como pide la guía, y en esta ejecución se fijó en 3010 mediante el archivo <code>.env</code>. Dentro de Docker la API sigue escuchando en el 3000. Para usar el 3000 basta con borrar el <code>.env</code>.</div>

<h2 id="impl">2. Implementación mínima</h2>
<h3>2.1 Arquitectura basada en mensajes (RabbitMQ)</h3>
<table class="grid">
  <thead><tr><th>Contenedor</th><th>Rol</th><th>Puertos</th><th>Detalles de implementación</th></tr></thead>
  <tr><td>orders-api</td><td>Productor</td><td>3010→3000 (HTTP)</td><td><code>POST /orders</code>: valida el JSON, genera <code>orderId</code> (ORD-XXXXXXXX) y <code>correlationId</code> (cabecera <code>X-Correlation-Id</code> o generado), publica <code>ProcessOrder</code> en la cola <code>pedidos</code> (durable, mensaje persistente) con <em>publisher confirms</em> y responde 202 de inmediato. Reintenta la conexión al broker y se reconecta si se cae. <code>GET /health</code>.</td></tr>
  <tr><td>rabbitmq</td><td>Broker</td><td>5672 (AMQP), 15672 (consola)</td><td><code>rabbitmq:4-management</code>, usuario admin/admin, volumen de datos, <code>hostname</code> fijo, healthcheck, plugin <code>rabbitmq_tracing</code> para la bitácora de mensajes (CP-06) y estadísticas cada 1 s.</td></tr>
  <tr><td>notification-worker</td><td>Consumidor</td><td>ninguno</td><td>Consume <code>pedidos</code> con <code>prefetch(1)</code> y ACK manual, simula el envío de la notificación (3 s) y confirma. Sin <code>container_name</code>, para poder escalarlo con <code>--scale</code>.</td></tr>
</table>
<h3>2.2 Arquitectura basada en eventos (Kafka)</h3>
<table class="grid">
  <thead><tr><th>Contenedor</th><th>Rol</th><th>Puertos</th><th>Detalles de implementación</th></tr></thead>
  <tr><td>orders-api</td><td>Productor de eventos</td><td>3010→3000 (HTTP)</td><td><code>POST /orders</code>: valida, construye <code>OrderCreated</code> (eventId, eventType, eventVersion, occurredAt, source, correlationId, data con total) y lo publica en <code>orders.events</code> con key = orderId; responde 202. Registra la partición y el offset asignados.</td></tr>
  <tr><td>kafka</td><td>Broker / log</td><td>9092 (interno), 29092 (host)</td><td>KRaft de un nodo; autocreación de tópicos desactivada; volumen <code>kafka-data</code>; healthcheck.</td></tr>
  <tr><td>kafka-init</td><td>Inicialización</td><td>—</td><td>Contenedor de un solo uso que crea <code>orders.events</code> con 3 particiones (requisito para repartir carga) y termina.</td></tr>
  <tr><td>kafka-ui</td><td>Observación</td><td>8080</td><td>Tópicos, particiones, mensajes y consumer groups.</td></tr>
  <tr><td>inventory-consumer</td><td>Consumidor</td><td>ninguno</td><td>Grupo <code>inventory-service-group</code>: simula la reserva de inventario.</td></tr>
  <tr><td>billing-consumer</td><td>Consumidor</td><td>ninguno</td><td>Grupo <code>billing-service-group</code>: simula la factura (quantity × unitPrice).</td></tr>
  <tr><td>notification-consumer</td><td>Consumidor</td><td>ninguno</td><td>Grupo <code>notification-service-group</code>: simula la notificación al cliente.</td></tr>
  <tr><td>audit-consumer</td><td>Consumidor posterior</td><td>ninguno</td><td>Perfil <code>late</code> (no arranca con el resto). Grupo <code>audit-service-group</code>; se usa para demostrar la lectura del log desde el inicio.</td></tr>
</table>
<p>En ambas arquitecturas el productor no conoce a los consumidores, ningún consumidor expone HTTP y los servicios se conectan al broker por el nombre de servicio de Docker (<code>rabbitmq:5672</code>, <code>kafka:9092</code>), nunca por <code>localhost</code>. Como <code>depends_on</code> no garantiza que el broker esté listo, se combinan healthchecks con reintentos de conexión en el código.</p>

<h2 id="entorno" class="pagebreak">3. Montaje del entorno y evidencias de arranque</h2>
<h3>3.1 RabbitMQ</h3>
<p>Comando: <code>docker compose up -d --build</code> en <code>rabbitmq/</code>. Contenedores en ejecución, puertos expuestos, logs de arranque del broker (RabbitMQ 4.4.0, plugins y conexiones autenticadas de orders-api y del worker) y de los servicios, y cola <code>pedidos</code> creada:</p>
${log('rabbitmq/entorno.txt', 'Montaje del entorno RabbitMQ')}
${img('rabbitmq/img/01-overview.png', 'Consola de administración de RabbitMQ (http://localhost:15672), pestaña Overview')}
<h3 class="pagebreak">3.2 Kafka</h3>
<p>Comando: <code>docker compose up -d --build</code> en <code>kafka/</code>. Contenedores, puertos, arranque del broker (Kafka 3.7.1 en modo KRaft), creación del tópico con 3 particiones, arranque de Kafka UI (HTTP 200 en el puerto 8080) y de los servicios. Los errores <code>The group coordinator is not available</code> del arranque son transitorios: Kafka todavía estaba creando su tópico interno <code>__consumer_offsets</code>, kafkajs reintentó y los consumidores se unieron a sus grupos 2–3 s después.</p>
${log('kafka/entorno.txt', 'Montaje del entorno Kafka')}
${img('kafka/img/01-kafka-ui-dashboard.png', 'Kafka UI (http://localhost:8080): clúster local en línea')}
${img('kafka/img/02-broker-activo.png', 'Kafka UI: broker activo')}

<h2 id="rabbit" class="pagebreak">4. Ejecución de pruebas: RabbitMQ</h2>
<p>Evidencias requeridas por la guía: <strong>cola creada</strong> (sección 3.1 y CP-02), <strong>mensaje enviado</strong> (CP-01, CP-02), <strong>mensaje visible en la cola</strong> (CP-02, CP-07, CP-09), <strong>consumidor procesando</strong> (CP-03, CP-11). Pruebas obligatorias: <strong>consumidor apagado</strong> (CP-09, CP-11), <strong>múltiples consumidores</strong> (CP-10) e <strong>independencia productor-consumidor</strong> (CP-07, CP-08).</p>
<p>Los estados de la cola se consultaron con <code>rabbitmqctl list_queues</code>, que lee el estado real del broker en ese momento; la consola web puede mostrar los contadores con algunos segundos de retraso.</p>
${casosRabbit.map(caso).join('\n')}

<h2 id="kafka" class="pagebreak">5. Ejecución de pruebas: Kafka</h2>
<p>Evidencias requeridas por la guía: <strong>tópico creado</strong> (sección 3.2 y CP-04), <strong>evento publicado</strong> (CP-04), <strong>evento consumido</strong> (CP-05). Pruebas obligatorias: <strong>consumidor posterior</strong> (CP-11 parte B), <strong>múltiples consumidores</strong> (CP-05 con grupos distintos y CP-10 con instancias del mismo grupo) y <strong>desacoplamiento total</strong> (CP-07, CP-08, CP-09, CP-11).</p>
${casosKafka.map(caso).join('\n')}

<h2 id="conclusiones" class="pagebreak">6. Conclusiones</h2>
<h3>¿Qué arquitectura es más robusta desde QA?</h3>
<p>Para este caso de estudio, <strong>Kafka</strong> resultó más robusta desde la perspectiva de QA, con un matiz importante. Lo que la hace más robusta:</p>
<ul>
  <li><strong>Los datos no se consumen al leerlos.</strong> Los 19 eventos seguían disponibles después de que los procesaran tres grupos, y un consumidor creado después los leyó todos (CP-11 B). En RabbitMQ, un mensaje confirmado desaparece: si un consumidor tiene un error de lógica, no hay forma de volver a procesar lo ya confirmado.</li>
  <li><strong>Aislamiento de fallos por grupo.</strong> La caída de billing no afectó a inventory ni a notification (CP-09). Cada responsabilidad avanza a su ritmo con su propio offset.</li>
  <li><strong>Más observable para pruebas.</strong> La pareja (partición, offset) identifica cada evento de forma única en la API, el broker y los consumidores (CP-06), y el LAG por grupo es una métrica directa de "cuánto falta por procesar" (CP-07, CP-09).</li>
</ul>
<p>El matiz es que <strong>RabbitMQ fue más predecible en la recuperación</strong>: el mensaje no confirmado volvió a la cola al instante y se reentregó marcado como <code>redelivered=true</code> (CP-12). En Kafka, el consumidor que murió sin despedirse tardó ~26 s en recuperar sus particiones (expiración de la sesión), y el reinicio del broker dejó un commit perdido que produjo un evento procesado dos veces. Ambas arquitecturas garantizaron <em>cero pérdida</em> en todas las pruebas, pero ninguna garantiza <em>exactamente una vez</em>: en las dos el consumidor debe ser idempotente.</p>

<h3>¿Qué dificultades se presentaron en pruebas?</h3>
<ul>
  <li><strong>Las métricas de la consola web de RabbitMQ llegan con retraso.</strong> En la primera corrida, CP-02 mostró Ready=0 justo después de publicar, aunque el mensaje sí estaba en la cola. Se redujo el intervalo de estadísticas a 1 s y, para la evidencia textual, se usó <code>rabbitmqctl list_queues</code>, que consulta el estado real. Lección: en QA no se debe asumir que un panel muestra el estado instantáneo.</li>
  <li><strong>Las aserciones sobre sistemas asíncronos necesitan esperas explícitas.</strong> No basta un <code>sleep</code> fijo: los scripts esperan condiciones (consumers=N, Total=0, LAG=0) con tiempo límite. Un error en la función que calculaba el LAG (trataba como 0 un grupo sin offsets confirmados) hizo que la primera corrida del consumidor posterior terminara antes de tiempo; se detectó porque el conteo de eventos no cuadraba con el tamaño del log, se corrigió y se repitió la prueba.</li>
  <li><strong>Las propias herramientas de inspección alteran lo observado.</strong> Leer un mensaje desde la consola de RabbitMQ lo devuelve a la cola marcado como <code>redelivered</code> (CP-03), y <code>kafka-console-consumer</code> crea un consumer group temporal que aparece en Kafka UI (CP-05).</li>
  <li><strong>Los tiempos de rebalanceo de Kafka</strong> (unión al grupo, expiración de sesión de un miembro caído) hacen que las pruebas de Kafka sean más lentas y menos deterministas que las de RabbitMQ.</li>
  <li><strong>Capturar un estado transitorio exige controlar los tiempos.</strong> Al repetir los casos para tomar capturas, el estado Unacked de RabbitMQ dura solo los 3 s de procesamiento de un mensaje, y el LAG de Kafka entre 7 y 11 s (CP-07). En el primer intento de CP-12 A el worker alcanzó a confirmar el mensaje antes del <code>docker kill</code>, así que no hubo nada que reentregar y la prueba no ejercitó lo que debía; se ajustó el momento del <code>kill</code> y se repitió. Lección: un resultado "sin pérdidas" solo vale si se comprueba que el escenario de fallo realmente ocurrió.</li>
  <li><strong>El apagado ordenado de un consumidor no siempre termina a tiempo.</strong> En la re-ejecución de CP-12 B, billing-consumer recibió SIGTERM pero no salió del grupo dentro de los 10 s de gracia de Docker (salida 137); su sesión quedó registrada hasta expirar y Kafka UI siguió mostrando un miembro con el contenedor detenido.</li>
  <li><strong>El orden de arranque.</strong> <code>depends_on</code> no espera a que el broker esté listo: fueron necesarios healthchecks, el contenedor <code>kafka-init</code> para crear el tópico antes que los consumidores, y reintentos de conexión en el código.</li>
  <li><strong>Entorno:</strong> el puerto 3000 estaba ocupado en el equipo; se hizo configurable (sección 1). En Windows, Git Bash reescribía las rutas de los contenedores (<code>/var/tmp</code>), lo que se resolvió con <code>MSYS_NO_PATHCONV=1</code>.</li>
</ul>

<h3>¿Qué diferencias reales se evidenciaron?</h3>
<table class="grid cmp">
  <thead><tr><th>Aspecto</th><th>RabbitMQ (evidencia)</th><th>Kafka (evidencia)</th></tr></thead>
  <tr><td>Modelo de entrega</td><td>Cola de trabajo: cada mensaje lo procesa un solo worker y se elimina con el ACK (CP-03, CP-10).</td><td>Log de eventos: cada grupo recibe todos los eventos; el mismo OrderCreated lo procesaron inventory, billing y notification (CP-05).</td></tr>
  <tr><td>Reparto de carga</td><td>Por mensaje, en round-robin: 3/3/3 con 3 workers (CP-10).</td><td>Por partición: 5/4 con 2 instancias y 3 particiones; el paralelismo máximo es el número de particiones (CP-10).</td></tr>
  <tr><td>Consumidor apagado</td><td>Los mensajes se acumulan como Ready (CP-09).</td><td>Los eventos ya están en el log; lo que crece es el LAG del grupo (CP-09).</td></tr>
  <tr><td>Consumidor nuevo</td><td>Solo recibe lo que entre a la cola desde ese momento.</td><td>Puede leer toda la historia desde el offset 0 (CP-11 B).</td></tr>
  <tr><td>Recuperación de un consumidor caído</td><td>Inmediata: el mensaje Unacked vuelve a Ready al cerrarse la conexión (CP-12 A).</td><td>Retardada ~26 s por la expiración de la sesión del miembro anterior (CP-12 A).</td></tr>
  <tr><td>Duplicados observados</td><td>Mensaje reentregado tras matar el worker (redelivered=true).</td><td>Evento reprocesado tras perderse un commit durante el reinicio del broker (CP-12 C).</td></tr>
  <tr><td>Observabilidad</td><td>Contadores Ready/Unacked/Total; la traza de mensajes requiere el plugin de tracing.</td><td>Offsets, particiones y LAG por grupo de forma nativa; contenido de los eventos en Kafka UI.</td></tr>
  <tr><td>Tiempo de respuesta de la API</td><td>4–6 ms por pedido (CP-07).</td><td>5–8 ms por pedido (CP-07).</td></tr>
</table>
<p>En resumen: RabbitMQ es adecuado para repartir <em>trabajo</em> (comandos como "procesar pedido") entre workers; Kafka es adecuado para difundir <em>hechos</em> (OrderCreated) a varios servicios que reaccionan de forma independiente y que pueden necesitar volver a leer la historia. En ambos casos la API respondió en milisegundos sin depender de los consumidores, que es la propiedad reactiva central evaluada.</p>

<h2 id="anexo" class="pagebreak">7. Anexo: reproducción y archivos de evidencia</h2>
<h3>7.1 Cómo reproducir</h3>
<pre style="background:#f4f6f9;color:#1b2430;font-size:8.5pt">
# RabbitMQ
cd rabbitmq
docker compose up -d --build
./pruebas.sh todo            # o un caso: ./pruebas.sh CP-07
# consola: http://localhost:15672 (admin / admin)
docker compose down -v

# Kafka
cd kafka
docker compose up -d --build
./pruebas.sh todo            # incluye CP-11-posterior
# Kafka UI: http://localhost:8080
docker compose --profile late down -v

# Pedido manual (Postman o curl); usar 3000 si no existe el archivo .env
curl -X POST http://localhost:3010/orders -H "Content-Type: application/json" \\
     -d '{"customerName":"Pedro","product":"Libro de arquitectura","quantity":1,"unitPrice":85000}'
</pre>
<p>Los scripts necesitan bash (Git Bash en Windows), curl, node y Docker. También se incluye la colección de Postman <code>postman/pedidos.postman_collection.json</code>.</p>
<h3>7.2 Archivos de evidencia</h3>
<table class="grid">
  <thead><tr><th>Ruta</th><th>Contenido</th></tr></thead>
  <tr><td><code>evidencias/rabbitmq/*.txt</code></td><td>Salida de cada caso (entorno, CP-01…CP-12), logs completos de orders-api, notification-worker y rabbitmq, y logs de las re-ejecuciones con capturas (<code>CP-01/03/06/11/12-capturas.txt</code>).</td></tr>
  <tr><td><code>evidencias/rabbitmq/img/</code></td><td>Capturas de la consola de administración de RabbitMQ y de la terminal.</td></tr>
  <tr><td><code>evidencias/kafka/*.txt</code></td><td>Salida de cada caso (entorno, CP-01…CP-12, CP-11-posterior, CP-12-analisis-lag, CP-01-postman), logs completos de todos los servicios y del broker, y logs de las re-ejecuciones con capturas (<code>CP-05/06/07/12-capturas.txt</code>).</td></tr>
  <tr><td><code>evidencias/kafka/img/</code></td><td>Capturas de Kafka UI, de Postman (CP-01) y de la terminal.</td></tr>
</table>
<p>Cada archivo de caso empieza con la fecha y hora de ejecución. Los <code>orderId</code>, <code>eventId</code> y <code>correlationId</code> citados en este documento pueden buscarse en los logs completos para verificar la trazabilidad.</p>
</body></html>`;

fs.writeFileSync(path.join(__dirname, 'informe.html'), html);
console.log('informe.html generado:', (html.length / 1024 / 1024).toFixed(1), 'MB');
