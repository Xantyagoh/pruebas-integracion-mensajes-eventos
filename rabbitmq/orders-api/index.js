// orders-api (RabbitMQ): productor de mensajes.
// Recibe pedidos por HTTP y publica el mensaje "ProcessOrder" en la cola "pedidos".
// No conoce ni llama al worker: la única comunicación con el consumidor pasa por RabbitMQ.
const http = require('http');
const { randomUUID } = require('crypto');
const amqp = require('amqplib');

const PORT = Number(process.env.PORT || 3000);
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://admin:admin@rabbitmq:5672';
const QUEUE = process.env.QUEUE_NAME || 'pedidos';

let channel = null;
let connecting = false;

const log = (msg) => console.log(`${new Date().toISOString()} [orders-api] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// depends_on no garantiza que RabbitMQ acepte conexiones: se reintenta hasta lograrlo,
// y si el broker se reinicia la conexión se restablece sola.
async function connectRabbit() {
  if (connecting) return;
  connecting = true;
  for (let attempt = 1; ; attempt++) {
    try {
      const conn = await amqp.connect(RABBITMQ_URL, { clientProperties: { connection_name: 'orders-api' } });
      conn.on('error', (err) => log(`Error en la conexión AMQP: ${err.message}`));
      conn.on('close', () => {
        channel = null;
        log('Conexión con RabbitMQ cerrada. Reintentando...');
        setTimeout(connectRabbit, 2000);
      });
      // Canal con confirmaciones del broker: el pedido se acepta cuando RabbitMQ
      // persistió el mensaje, no cuando el worker lo procesa.
      const ch = await conn.createConfirmChannel();
      await ch.assertQueue(QUEUE, { durable: true });
      channel = ch;
      log(`Conectado a RabbitMQ (${RABBITMQ_URL.replace(/\/\/.*@/, '//***@')}). Cola "${QUEUE}" declarada (durable=true)`);
      break;
    } catch (err) {
      log(`RabbitMQ no disponible (intento ${attempt}): ${err.message}`);
      await sleep(3000);
    }
  }
  connecting = false;
}

function validate(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['El cuerpo debe ser un objeto JSON'];
  if (typeof body.customerName !== 'string' || !body.customerName.trim()) errors.push('customerName es obligatorio');
  if (typeof body.product !== 'string' || !body.product.trim()) errors.push('product es obligatorio');
  if (!Number.isInteger(body.quantity) || body.quantity <= 0) errors.push('quantity debe ser un entero positivo');
  return errors;
}

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function publish(message) {
  return new Promise((resolve, reject) => {
    channel.sendToQueue(QUEUE, Buffer.from(JSON.stringify(message)), {
      persistent: true,
      contentType: 'application/json',
      type: message.type,
      appId: 'orders-api',
      messageId: message.orderId,
      correlationId: message.correlationId,
      timestamp: Math.floor(Date.now() / 1000),
    }, (err) => (err ? reject(err) : resolve()));
  });
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
  if (!channel) {
    return send(res, 503, { status: 'unavailable', message: 'RabbitMQ no está disponible, intente de nuevo' });
  }

  const orderId = `ORD-${randomUUID().slice(0, 8).toUpperCase()}`;
  const correlationId = req.headers['x-correlation-id'] || `corr-${randomUUID()}`;
  const message = {
    type: 'ProcessOrder',
    orderId,
    correlationId,
    customerName: body.customerName.trim(),
    product: body.product.trim(),
    quantity: body.quantity,
    createdAt: new Date().toISOString(),
  };

  try {
    await publish(message);
  } catch (err) {
    log(`Error publicando orderId=${orderId}: ${err.message}`);
    return send(res, 503, { status: 'unavailable', message: 'No se pudo publicar el mensaje en RabbitMQ' });
  }

  log(`Pedido recibido y publicado en cola "${QUEUE}" orderId=${orderId} correlationId=${correlationId} customer="${message.customerName}"`);
  // Respuesta inmediata: no se espera al worker.
  send(res, 202, {
    status: 'accepted',
    message: 'Pedido recibido y enviado a RabbitMQ',
    orderId,
    correlationId,
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, channel ? 200 : 503, { status: channel ? 'UP' : 'DOWN', broker: channel ? 'connected' : 'disconnected' });
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
  connectRabbit();
});
