// inventory-consumer (Kafka): reacciona a OrderCreated reservando inventario (simulado).
// No expone puertos ni llama a la API: solo lee del tópico orders.events con su propio consumer group.
const os = require('os');
const { Kafka, logLevel } = require('kafkajs');

const SERVICE = 'inventory-consumer';
const ACTION = 'Simulando reserva de inventario';
const done = (d) => `Inventario reservado: ${d.quantity} x "${d.product}"`;

const BROKER = process.env.KAFKA_BROKER || 'kafka:9092';
const TOPIC = process.env.KAFKA_TOPIC || 'orders.events';
const GROUP_ID = process.env.KAFKA_GROUP_ID || 'inventory-service-group';
const PROCESSING_MS = Number(process.env.PROCESSING_MS || 1000);
const INSTANCE = `${SERVICE}@${os.hostname()}`;

const log = (msg) => console.log(`${new Date().toISOString()} [${INSTANCE}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kafka = new Kafka({ clientId: SERVICE, brokers: [BROKER], logLevel: logLevel.WARN });
const consumer = kafka.consumer({ groupId: GROUP_ID });

consumer.on(consumer.events.GROUP_JOIN, ({ payload }) => {
  const parts = (payload.memberAssignment[TOPIC] || []).join(',');
  log(`Unido al consumer group "${payload.groupId}". Particiones asignadas de ${TOPIC}: [${parts}]`);
});

async function start() {
  for (let attempt = 1; ; attempt++) {
    try {
      await consumer.connect();
      // fromBeginning solo aplica cuando el grupo no tiene offsets guardados:
      // un grupo nuevo lee el log completo; uno existente continúa donde quedó.
      await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
      break;
    } catch (err) {
      log(`Kafka no disponible (intento ${attempt}): ${err.message}`);
      await sleep(3000);
    }
  }
  log(`Suscrito a ${TOPIC} con groupId=${GROUP_ID}`);
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const event = JSON.parse(message.value.toString());
      if (event.eventType !== 'OrderCreated') {
        log(`Evento ${event.eventType} ignorado offset=${message.offset}`);
        return;
      }
      log(`Evento recibido: ${event.eventType} orderId=${event.data.orderId} eventId=${event.eventId} correlationId=${event.correlationId}`);
      log(`topic=${topic} partition=${partition} offset=${message.offset} key=${message.key}`);
      log(`${ACTION}...`);
      await sleep(PROCESSING_MS);
      log(`${done(event.data)} (orderId=${event.data.orderId})`);
    },
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    log(`${signal} recibido, abandonando el consumer group`);
    await consumer.disconnect().catch(() => {});
    process.exit(0);
  });
}

log('Iniciando consumidor');
start();
