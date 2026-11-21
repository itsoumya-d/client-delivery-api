#!/usr/bin/env bash
set -euo pipefail

TARGET_URL="${1:-http://127.0.0.1:3000}"

echo "Starting smoke test against ${TARGET_URL}..."

# 1. Health check
echo "Checking /health endpoint..."
HEALTH_RES=$(curl -fsS "${TARGET_URL}/health")
if [[ "${HEALTH_RES}" != *'"status":"ok"'* ]]; then
  echo "FAIL: Unexpected health response: ${HEALTH_RES}"
  exit 1
fi
echo "PASS: /health returned status:ok"

echo "All smoke tests PASSED!"
