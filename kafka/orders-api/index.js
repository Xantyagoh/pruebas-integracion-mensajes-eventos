// orders-api (Kafka): productor de eventos.
// Recibe pedidos por HTTP y publica el hecho "OrderCreated" en el tópico orders.events.
// No conoce a los consumidores: inventario, facturación y notificaciones reaccionan por su cuenta.
const http = require('http');
const { randomUUID } = require('crypto');
const { Kafka, Partitioners, logLevel } = require('kafkajs');

const PORT = Number(process.env.PORT || 3000);
const BROKER = process.env.KAFKA_BROKER || 'kafka:9092';
const TOPIC = process.env.KAFKA_TOPIC || 'orders.events';

const kafka = new Kafka({
  clientId: 'orders-api',
  brokers: [BROKER],
  logLevel: logLevel.WARN,
  retry: { initialRetryTime: 300, retries: 10 },
});
const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
let connected = false;

const log = (msg) => console.log(`${new Date().toISOString()} [orders-api] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

producer.on(producer.events.CONNECT, () => { connected = true; });
producer.on(producer.events.DISCONNECT, () => { connected = false; });

// depends_on no garantiza que Kafka acepte conexiones: se reintenta hasta lograrlo.
async function connectKafka() {
  for (let attempt = 1; ; attempt++) {
    try {
      await producer.connect();
      log(`Productor conectado a Kafka (${BROKER}). Tópico de publicación: ${TOPIC}`);
      return;
    } catch (err) {
      log(`Kafka no disponible (intento ${attempt}): ${err.message}`);
      await sleep(3000);
    }
  }
}

function validate(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['El cuerpo debe ser un objeto JSON'];
  if (typeof body.customerName !== 'string' || !body.customerName.trim()) errors.push('customerName es obligatorio');
  if (typeof body.product !== 'string' || !body.product.trim()) errors.push('product es obligatorio');
  if (!Number.isInteger(body.quantity) || body.quantity <= 0) errors.push('quantity debe ser un entero positivo');
  if (typeof body.unitPrice !== 'number' || !(body.unitPrice >= 0)) errors.push('unitPrice debe ser un número >= 0');
  return errors;
}

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function handleCreateOrder(req, res, rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return send(res, 400, { status: 'rejected', errors: ['JSON inválido'] });
  }
  const errors = validate(body);
  if (errors.length) {
    log(`Pedido rechazado: ${errors.join('; ')}`);
    return send(res, 400, { status: 'rejected', errors });
  }

  const orderId = `ORD-${randomUUID().slice(0, 8).toUpperCase()}`;
  const correlationId = req.headers['x-correlation-id'] || `corr-${randomUUID()}`;
  const event = {
    eventId: `evt-${randomUUID()}`,
    eventType: 'OrderCreated',
    eventVersion: '1.0',
    occurredAt: new Date().toISOString(),
    source: 'orders-api',
    correlationId,
    data: {
      orderId,
      customerName: body.customerName.trim(),
      product: body.product.trim(),
      quantity: body.quantity,
      unitPrice: body.unitPrice,
      total: body.quantity * body.unitPrice,
    },
  };

  let metadata;
  try {
    [metadata] = await producer.send({
      topic: TOPIC,
      messages: [{
        key: orderId, // mismo pedido -> misma partición
        value: JSON.stringify(event),
        headers: { eventType: event.eventType, correlationId },
      }],
    });
  } catch (err) {
    log(`Error publicando orderId=${orderId}: ${err.message}`);
    return send(res, 503, { status: 'unavailable', message: 'No se pudo publicar el evento en Kafka' });
  }

  log(`Evento OrderCreated publicado topic=${TOPIC} partition=${metadata.partition} offset=${metadata.baseOffset} orderId=${orderId} eventId=${event.eventId} correlationId=${correlationId}`);
  // Respuesta inmediata: no se espera a los consumidores.
  send(res, 202, {
    status: 'accepted',
    message: 'Pedido recibido y evento OrderCreated publicado en Kafka',
    orderId,
    eventId: event.eventId,
    correlationId,
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, connected ? 200 : 503, { status: connected ? 'UP' : 'DOWN', broker: connected ? 'connected' : 'disconnected' });
  }
  if (req.method === 'POST' && req.url === '/orders') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => handleCreateOrder(req, res, raw));
    return;
  }
  send(res, 404, { status: 'not_found' });
});

server.listen(PORT, () => {
  log(`API REST escuchando en el puerto ${PORT} (POST /orders)`);
  connectKafka();
});

process.on('SIGTERM', async () => {
  await producer.disconnect().catch(() => {});
  process.exit(0);
});
