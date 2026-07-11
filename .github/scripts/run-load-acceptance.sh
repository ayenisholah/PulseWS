#!/usr/bin/env bash

set -uo pipefail

readonly compose_file=/opt/pulsews/deploy/docker-compose.yml
readonly loadtest_dir=/opt/pulsews/loadtest
readonly results_dir="${1:?results directory is required}"
readonly credentials_file="${2:?credentials file is required}"
readonly expected_image="${3:?expected image is required}"
readonly k6_image=grafana/k6:2.0.0

mkdir -p "$results_dir"
chmod 700 "$results_dir"
exec > >(tee -a "$results_dir/workflow.log") 2>&1

overall_status=0
scenario_status=0

record() {
  printf '%s\n' "$*" | tee -a "$results_dir/commands.txt"
}

capture() {
  local name=$1
  shift
  "$@" >"$results_dir/$name" 2>&1 || true
}

compose_health() {
  local expected running container health
  expected=$(docker compose -f "$compose_file" config --services | sort)
  running=$(docker compose -f "$compose_file" ps --status running --services | sort)
  if [[ "$running" != "$expected" ]]; then
    printf 'Not every Compose service is running.\nExpected:\n%s\nRunning:\n%s\n' "$expected" "$running"
    return 1
  fi
  while IFS= read -r container; do
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' "$container")
    if [[ "$health" != healthy && "$health" != running ]]; then
      echo "$container is $health"
      return 1
    fi
  done < <(docker compose -f "$compose_file" ps -q)
}

prometheus_up() {
  local response
  response=$(curl --fail --silent --show-error 'http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D%22pulsews%22%7D') || return 1
  printf '%s\n' "$response" >"$results_dir/prometheus-targets.json"
  [[ $(printf '%s' "$response" | grep -o '"value":\[[^]]*,"1"\]' | wc -l) -eq 2 ]]
}

prometheus_snapshot() {
  local name=$1
  capture "$name-connections.json" curl --fail --silent --show-error 'http://127.0.0.1:9090/api/v1/query?query=sum%28pulsews_connections%29'
  capture "$name-drops-by-reason.json" curl --fail --silent --show-error 'http://127.0.0.1:9090/api/v1/query?query=sum%20by%20%28reason%29%20%28pulsews_dropped_messages_total%29'
  capture "$name-rest-throttles.json" curl --fail --silent --show-error 'http://127.0.0.1:9090/api/v1/query?query=sum%28pulsews_rest_throttled_total%29'
}

prometheus_scalar() {
  local query=$1 response value
  response=$(curl --fail --silent --show-error "http://127.0.0.1:9090/api/v1/query?query=$query") || return 1
  [[ "$response" == *'"status":"success"'* ]] || return 1
  if [[ "$response" =~ \"result\"[[:space:]]*:[[:space:]]*\[\] ]]; then
    printf '0\n'
    return 0
  fi
  value=$(printf '%s' "$response" | grep -o '"value":\[[^]]*\]' | tail -1 | grep -o '"[0-9.eE+-]*"' | tail -1 | tr -d '"')
  [[ "$value" =~ ^[0-9.eE+-]+$ ]] || return 1
  printf '%s\n' "$value"
}

connection_headroom() {
  local app_id max_connections reserved prometheus_connections
  app_id=$(sed -n 's/^PULSEWS_APP_ID=//p' "$credentials_file")
  [[ -n "$app_id" ]] || return 1
  max_connections=$(docker compose -f "$compose_file" exec -T pulsews-a node -e \
    'const fs=require("node:fs");const config=JSON.parse(fs.readFileSync(process.env.PULSEWS_CONFIG,"utf8"));const app=config.apps.find((item)=>item.id===process.argv[1]);if(!app)process.exit(2);process.stdout.write(String(app.maxConnections));' "$app_id") || return 1
  reserved=$(docker compose -f "$compose_file" exec -T redis redis-cli --raw GET "pulsews:app:$app_id:connections") || return 1
  reserved=${reserved:-0}
  prometheus_connections=$(prometheus_scalar 'sum%28pulsews_connections%29') || return 1
  printf 'app_id=%s\nmax_connections=%s\nreserved_connections=%s\nprometheus_connections=%s\nrequired_headroom=500\n' \
    "$app_id" "$max_connections" "$reserved" "$prometheus_connections" >"$results_dir/connection-headroom.txt"
  [[ "$max_connections" =~ ^[0-9]+$ && "$reserved" =~ ^[0-9]+$ && "$prometheus_connections" =~ ^[0-9.eE+-]+$ ]] || return 1
  (( max_connections - reserved >= 500 )) || {
    echo "Insufficient connection headroom: max=$max_connections reserved=$reserved required=500"
    return 1
  }
}

wait_for_recovery() {
  local scenario=$1 baseline_reserved=$2 app_id current current_connections baseline_connections
  local previous_drops current_drops previous_throttles current_throttles stable=0
  app_id=$(sed -n 's/^PULSEWS_APP_ID=//p' "$credentials_file")
  baseline_connections=$(sed -n 's/^prometheus_connections=//p' "$results_dir/connection-headroom.txt")
  previous_drops=''
  previous_throttles=''
  for _ in $(seq 1 30); do
    current=$(docker compose -f "$compose_file" exec -T redis redis-cli --raw GET "pulsews:app:$app_id:connections") || current=''
    current=${current:-0}
    current_connections=$(prometheus_scalar 'sum%28pulsews_connections%29' || true)
    current_drops=$(prometheus_scalar 'sum%28pulsews_dropped_messages_total%29' || true)
    current_throttles=$(prometheus_scalar 'sum%28pulsews_rest_throttled_total%29' || true)
    if [[ "$current" =~ ^[0-9]+$ && "$current_connections" =~ ^[0-9.eE+-]+$ ]] \
      && (( current <= baseline_reserved )) \
      && awk "BEGIN { exit !($current_connections <= $baseline_connections) }" \
      && [[ -n "$current_drops" && "$current_drops" == "$previous_drops" ]] \
      && [[ -n "$current_throttles" && "$current_throttles" == "$previous_throttles" ]]; then
      stable=$((stable + 1))
      (( stable >= 3 )) && {
        # Allow both per-node REST token buckets to refill completely.
        sleep 3
        prometheus_snapshot "$scenario-recovered"
        return 0
      }
    else
      stable=0
    fi
    previous_drops=$current_drops
    previous_throttles=$current_throttles
    sleep 1
  done
  echo "Recovery timed out after $scenario (reserved=$current baseline=$baseline_reserved)."
  return 1
}

preflight() {
  compose_health || return 1
  curl --fail --silent --show-error http://127.0.0.1:6002/health >/dev/null || return 1
  curl --fail --silent --show-error http://127.0.0.1:6003/health >/dev/null || return 1
  [[ $(docker compose -f "$compose_file" exec -T redis redis-cli ping) == PONG ]] || return 1
  prometheus_up || return 1
  connection_headroom || return 1

  local service container configured_image
  for service in pulsews-a pulsews-b; do
    container=$(docker compose -f "$compose_file" ps -q "$service")
    configured_image=$(docker inspect --format '{{.Config.Image}}' "$container")
    [[ "$configured_image" == "$expected_image" ]] || {
      echo "$service uses $configured_image, expected $expected_image"
      return 1
    }
  done
}

run_k6() {
  local name=$1
  shift
  local command=(docker run --rm --network host --user "$(id -u):$(id -g)" --env-file "$credentials_file" -v "$loadtest_dir:/loadtest:ro" -v "$results_dir:/results" "$k6_image" run --summary-export="/results/$name-summary.json" "$@")
  printf '%q ' "${command[@]}" >>"$results_dir/commands.txt"
  printf '\n' >>"$results_dir/commands.txt"
  "${command[@]}" 2>&1 | tee "$results_dir/$name.log"
  local status=${PIPESTATUS[0]}
  printf '%s=%s\n' "$name" "$status" >>"$results_dir/scenario-status.txt"
  prometheus_snapshot "$name-post"
  if (( status != 0 )); then
    scenario_status=1
  fi
}

postflight() {
  local status=0 post_state dropped_before dropped_after
  capture compose-postflight.txt docker compose -f "$compose_file" ps
  capture docker-stats-postflight.txt docker stats --no-stream
  capture redis-memory-postflight.txt docker compose -f "$compose_file" exec -T redis redis-cli INFO memory
  capture redis-clients-postflight.txt docker compose -f "$compose_file" exec -T redis redis-cli INFO clients
  capture redis-errors-postflight.txt docker compose -f "$compose_file" logs --since "${run_started_at:-10m}" redis
  capture container-state-postflight.txt docker inspect --format '{{.Name}} restart={{.RestartCount}} oom={{.State.OOMKilled}} status={{.State.Status}}' $(docker compose -f "$compose_file" ps -q)
  capture dropped-messages-postflight.txt curl --fail --silent --show-error 'http://127.0.0.1:9090/api/v1/query?query=sum%28pulsews_dropped_messages_total%29'
  post_state=$(sort "$results_dir/container-state-postflight.txt")
  [[ "$post_state" == "$(sort "$results_dir/container-state-preflight.txt")" ]] || {
    echo 'Container restart, OOM, or status changed during acceptance.'
    status=1
  }
  if grep -Eiq '(^|[^[:alpha:]])(error|fatal|panic)([^[:alpha:]]|$)' "$results_dir/redis-errors-postflight.txt"; then
    echo 'Redis emitted an error during acceptance.'
    status=1
  fi
  dropped_before=$(grep -o '"value":\[[^]]*\]' "$results_dir/dropped-messages-preflight.txt" | tail -1 | grep -o '"[0-9.eE+-]*"' | tail -1 || true)
  dropped_after=$(grep -o '"value":\[[^]]*\]' "$results_dir/dropped-messages-postflight.txt" | tail -1 | grep -o '"[0-9.eE+-]*"' | tail -1 || true)
  if [[ -z "$dropped_before" || "$dropped_before" != "$dropped_after" ]]; then
    echo "Dropped-message counter changed or could not be compared (before=$dropped_before after=$dropped_after)."
    status=1
  fi
  prometheus_up || status=1
  compose_health || status=1
  return "$status"
}

run_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
{
  echo 'Acceptance tier: fixed 500 concurrent connections'
  echo 'Contention disclosure: k6 and PulseWS ran on the same VPS; results include load-generator contention.'
  echo "UTC start: $run_started_at"
  echo "Commit: ${GITHUB_SHA:-unknown}"
  echo "PulseWS image: $expected_image"
  echo "k6 image: $k6_image"
} >"$results_dir/metadata.txt"

capture host-uname.txt uname -a
capture host-cpu.txt lscpu
capture host-memory.txt free -h
capture host-os.txt sh -c 'cat /etc/os-release'
capture compose-preflight.txt docker compose -f "$compose_file" ps
capture docker-stats-preflight.txt docker stats --no-stream
capture redis-memory-preflight.txt docker compose -f "$compose_file" exec -T redis redis-cli INFO memory
capture redis-clients-preflight.txt docker compose -f "$compose_file" exec -T redis redis-cli INFO clients
capture container-state-preflight.txt docker inspect --format '{{.Name}} restart={{.RestartCount}} oom={{.State.OOMKilled}} status={{.State.Status}}' $(docker compose -f "$compose_file" ps -q)
capture dropped-messages-preflight.txt curl --fail --silent --show-error 'http://127.0.0.1:9090/api/v1/query?query=sum%28pulsews_dropped_messages_total%29'
prometheus_snapshot preflight

record "docker pull $k6_image"
docker pull "$k6_image" || overall_status=1
capture k6-image-digest.txt docker image inspect --format '{{json .RepoDigests}}' "$k6_image"

if ! preflight; then
  echo 'Preflight failed; k6 scenarios were not started.'
  overall_status=1
else
  baseline_reserved=$(sed -n 's/^reserved_connections=//p' "$results_dir/connection-headroom.txt")
  run_k6 connection-500 -e PULSEWS_VUS=500 -e PULSEWS_RAMP_DURATION=30s -e PULSEWS_DURATION=60s -e PULSEWS_HOLD_SECONDS=120 -e PULSEWS_RAMP_DOWN_DURATION=15s -e PULSEWS_SCENARIO_SECONDS=105 /loadtest/connection-ramp.js
  wait_for_recovery connection-500 "$baseline_reserved" || overall_status=1
  run_k6 rest-500 -e PULSEWS_RATE=50 -e PULSEWS_DURATION=5m -e PULSEWS_CHANNELS=32 -e PULSEWS_CONSUMER_SECONDS=310 -e PULSEWS_NODE_A_URL=http://127.0.0.1:6002 -e PULSEWS_NODE_B_URL=http://127.0.0.1:6003 -e "PULSEWS_CHANNEL_PREFIX=acceptance-${GITHUB_SHA:-unknown}-rest" /loadtest/rest-latency.js
  wait_for_recovery rest-500 "$baseline_reserved" || overall_status=1
  run_k6 same-node-500 -e PULSEWS_VUS=10 -e PULSEWS_ITERATIONS=100 -e PULSEWS_PUBLISH_DELAY_MS=250 -e "PULSEWS_CHANNEL_PREFIX=acceptance-${GITHUB_SHA:-unknown}-same" -e PULSEWS_EXPECT_SCOPE=same_node -e PULSEWS_NODE_A_URL=http://127.0.0.1:6002 -e PULSEWS_NODE_B_URL=http://127.0.0.1:6002 /loadtest/cross-node.js
  wait_for_recovery same-node-500 "$baseline_reserved" || overall_status=1
  run_k6 cross-node-500 -e PULSEWS_VUS=10 -e PULSEWS_ITERATIONS=100 -e PULSEWS_PUBLISH_DELAY_MS=250 -e "PULSEWS_CHANNEL_PREFIX=acceptance-${GITHUB_SHA:-unknown}-cross" -e PULSEWS_EXPECT_SCOPE=cross_node -e PULSEWS_NODE_A_URL=http://127.0.0.1:6002 -e PULSEWS_NODE_B_URL=http://127.0.0.1:6003 /loadtest/cross-node.js
fi

(( scenario_status == 0 )) || overall_status=1
postflight || overall_status=1
run_finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf 'UTC end: %s\nOverall status: %s\n' "$run_finished_at" "$overall_status" >>"$results_dir/metadata.txt"
exit "$overall_status"
