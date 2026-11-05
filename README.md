# Client Delivery API

Production-oriented TypeScript/Node.js delivery backend for a software studio:
clients, projects, milestones, change requests, financial summaries and an
activity trail.

## Why this exists

Custom software delivery fails at the commercial seams: milestones are marked
done without approval, change requests silently move the budget, and nobody can
reconstruct who approved what. This service models the delivery ledger
explicitly.

## Stack

- TypeScript, Node.js, Fastify
- PostgreSQL (`pg`), SQL schema migration on boot
- Zod request validation
- API-key auth
- Vitest + `pg-mem` integration tests
- Multi-stage Dockerfile and docker-compose with Postgres
- GitHub Actions CI (`npm ci`, build, test)

## Features

- Clients and projects with unique codes, budgets and date validation
- Milestones with pending/approved state and idempotent approval
- Change requests with cost impact and approve/reject decisions
- Project summary: approved/pending milestones, approved change cost,
  projected total and remaining budget
- Activity trail for project creation, milestones and changes
- Health probe and consistent 401/404/422 responses

## Run locally

```bash
npm install
DATABASE_URL=postgres://delivery:delivery@localhost:5432/delivery API_KEY=dev-key npm run dev
```

Or:

```bash
docker compose up --build
```

## Test

```bash
npm test
npm run build
```

## Honest scope

This is a real, tested delivery service, not a full PSA/ERP. It does not do
invoicing, time tracking, resource scheduling, document storage or accounting
integration. The README does not claim production usage.
