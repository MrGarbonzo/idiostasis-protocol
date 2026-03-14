#!/bin/bash
set -e

echo "=== Idiostasis Local Docker Test ==="

cd "$(dirname "$0")"

echo "--- Building images..."
docker compose -f docker-compose.local.yml build

echo "--- Starting containers..."
docker compose -f docker-compose.local.yml up -d

echo "--- Waiting for agent health check..."
sleep 15

echo "--- Checking agent /status..."
curl -sf http://localhost:3001/status | jq .

echo "--- Checking guardian logs..."
docker logs idiostasis-guardian --tail 20

echo "--- Checking agent logs..."
docker logs idiostasis-agent --tail 20

echo "--- Checking container status..."
docker compose -f docker-compose.local.yml ps

echo "=== Test complete. Run teardown? (y/n) ==="
read -r answer
if [ "$answer" = "y" ]; then
  docker compose -f docker-compose.local.yml down -v
  echo "Containers stopped and volumes removed."
fi
