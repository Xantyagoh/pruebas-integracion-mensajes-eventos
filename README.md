# Pruebas de integración en arquitecturas basadas en mensajes y eventos

Sistema de procesamiento de pedidos implementado dos veces:

| Carpeta | Arquitectura | Contenedores |
|---|---|---|
| `rabbitmq/` | Mensajes (RabbitMQ) | `rabbitmq`, `orders-api`, `notification-worker` |
| `kafka/` | Eventos (Apache Kafka) | `kafka`, `kafka-init`, `kafka-ui`, `orders-api`, `inventory-consumer`, `billing-consumer`, `notification-consumer`, `audit-consumer` (perfil `late`) |

Cada servicio es un programa Node.js independiente con su propio `Dockerfile`. La API nunca llama a los consumidores: la única comunicación pasa por el broker.

## Levantar

```bash
cd rabbitmq && docker compose up -d --build     # consola: http://localhost:15672 (admin/admin)
cd kafka    && docker compose up -d --build     # Kafka UI: http://localhost:8080
```

Los dos stacks usan el contenedor `orders-api` y el mismo puerto, así que se ejecutan uno a la vez (`docker compose down` antes de pasar al otro).

**Puerto de la API:** `"${API_PORT:-3000}:3000"`. El archivo `.env` de cada carpeta fija `API_PORT=3010` porque en el equipo de pruebas el 3000 estaba ocupado. Si se borra `.env`, la API queda en `http://localhost:3000`.

## Probar

```bash
curl -X POST http://localhost:3010/orders -H "Content-Type: application/json" \
     -d '{"customerName":"Pedro","product":"Libro de arquitectura","quantity":1,"unitPrice":85000}'
```

Colección de Postman: `postman/pedidos.postman_collection.json`.

## Casos de prueba automatizados

```bash
./rabbitmq/pruebas.sh todo     # entorno, CP-01, 02, 03, 06, 07, 08, 09, 11, 10, 12
./kafka/pruebas.sh todo        # entorno, CP-01, 04, 05, 06, 07, 08, 09, 11, 11-posterior, 10, 12
```

También se puede ejecutar un caso suelto (`./kafka/pruebas.sh CP-09`). La salida de cada paso queda en `evidencias/<arquitectura>/<caso>.txt`. Requiere bash (Git Bash en Windows), curl, node y Docker.

## Informe

`Informe_Pruebas_Integracion.pdf`: se genera con `node informe/generar-informe.js` (produce `informe/informe.html` con las evidencias embebidas), que luego se imprime a PDF.
