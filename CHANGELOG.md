# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-11-21
### Added
- API Gateway middleware with Token Bucket rate limiting and quota headers (`x-ratelimit-*`).
- Webhook HMAC-SHA256 signature verification endpoint with replay protection.
- Request tracing and latency telemetry headers (`x-request-id`, `x-response-time`).
- Failure-injection resilience tests and smoke check automation.

## [1.0.0] - 2026-11-10
### Added
- Initial release of Client Delivery API with Fastify and PostgreSQL.
- Milestones, projects, clients, change requests, and budget tracking.
