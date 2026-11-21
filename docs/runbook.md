# Operations Runbook: Client Delivery API

## Service Architecture
The Client Delivery API provides project lifecycle ledger operations, client budget governance, Fastify API gateway middleware, and cryptographic webhook verification.

## Health and Monitoring
- Health endpoint: `GET /health` returns `{"status": "ok"}`
- Port: 3000 (configurable via `PORT` environment variable)
- Target Latency SLO: p95 latency < 20ms under 500 req/s throughput
- Error budget: 5xx error rate < 0.05%

## Incident Response
1. Alert triggers on high latency (>50ms p95) or 5xx error rate (>0.1%).
2. On-call engineer acknowledges alert within 15 minutes.
3. Check container logs via `docker logs client-delivery-api`.
4. Inspect database connection pool health and migration state.

## Rollback Procedure
If a deployment degrades or health checks fail in production:
1. Identify the last known stable release tag or commit SHA (`git tag -l` or release registry).
2. Stop the degraded container: `docker stop client-delivery-api`.
3. Roll back by deploying the previous verified container image:
   ```bash
   docker run -d --name client-delivery-api -p 3000:3000 client-delivery-api:previous-tag
   ```
4. Verify the rollback immediately using the smoke test:
   ```bash
   bash scripts/smoke.sh
   ```
5. Confirm `/health` answers 200 OK with latency < 15ms.
6. Record incident details in the post-mortem tracker and initiate blameless review.
