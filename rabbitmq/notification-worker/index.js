// notification-worker (RabbitMQ): consumidor de la cola "pedidos".
// No expone ningún puerto HTTP; solo recibe trabajo a través del broker.
const os = require('os');
const amqp = require('amqplib');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://admin:admin@rabbitmq:5672';
const QUEUE = process.env.QUEUE_NAME || 'pedidos';
const PROCESSING_MS = Number(process.env.PROCESSING_MS || 3000);
const WORKER_ID = `notification-worker@${os.hostname()}`;

const log = (msg) => console.log(`${new Date().toISOString()} [${WORKER_ID}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start() {
  for (let attempt = 1; ; attempt++) {
    try {
      const conn = await amqp.connect(RABBITMQ_URL, { clientProperties: { connection_name: WORKER_ID } });
      conn.on('error', (err) => log(`Error en la conexión AMQP: ${err.message}`));
      conn.on('close', () => {
        log('Conexión con RabbitMQ cerrada. Reintentando...');
        setTimeout(start, 2000);
      });
      const ch = await conn.createChannel();
      await ch.assertQueue(QUEUE, { durable: true });
      // Un mensaje a la vez por worker: la carga se reparte entre instancias.
      await ch.prefetch(1);
      log(`Conectado a RabbitMQ. Escuchando la cola "${QUEUE}" (prefetch=1, ack manual, procesamiento=${PROCESSING_MS}ms)`);
      await ch.consume(QUEUE, (msg) => handle(ch, msg), { noAck: false });
      return;
    } catch (err) {
      log(`RabbitMQ no disponible (intento ${attempt}): ${err.message}`);
      await sleep(3000);
    }
  }
}

async function handle(ch, msg) {
  if (!msg) return; // la cola fue eliminada o el consumidor cancelado
  let data;
  try {
    data = JSON.parse(msg.content.toString());
  } catch (err) {
    log(`Mensaje inválido descartado deliveryTag=${msg.fields.deliveryTag}: ${err.message}`);
    ch.nack(msg, false, false);
    return;
  }
  log(`Mensaje recibido orderId=${data.orderId} correlationId=${data.correlationId} redelivered=${msg.fields.redelivered} deliveryTag=${msg.fields.deliveryTag}`);
  log(`Contenido: ${JSON.stringify(data)}`);
  log(`Simulando envío de notificación a ${data.customerName}...`);
  await sleep(PROCESSING_MS);
  ch.ack(msg);
  log(`Notificación enviada. ACK confirmado orderId=${data.orderId} correlationId=${data.correlationId}`);
}

process.on('SIGTERM', () => { log('SIGTERM recibido, deteniendo worker'); process.exit(0); });

log('Iniciando worker');
start();
