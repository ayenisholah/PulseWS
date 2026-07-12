#!/usr/bin/env bash
set -uo pipefail

readonly compose_file=/opt/pulsews/deploy/docker-compose.yml
readonly loadtest_dir=/opt/pulsews/loadtest
readonly results_dir="${1:?results directory is required}"
readonly credentials_file="${2:?credentials file is required}"
readonly expected_image="${3:?expected image is required}"
readonly k6_image=grafana/k6:2.0.0
readonly required_cap=12000
readonly capacity_url=http://127.0.0.1:8080
readonly ramp_duration="${PULSEWS_RAMP_DURATION:-5m}"
readonly hold_duration="${PULSEWS_HOLD_DURATION:-5m}"
readonly connection_seconds="${PULSEWS_CONNECTION_SECONDS:-630}"
readonly required_sustained_seconds="${PULSEWS_REQUIRED_SUSTAINED_SECONDS:-240}"
readonly require_memory_flat="${PULSEWS_REQUIRE_MEMORY_FLAT:-0}"
read -r -a tiers <<< "${PULSEWS_TIERS:-1000 2500 5000 7500 10000}"

mkdir -p "$results_dir" && chmod 700 "$results_dir"
exec > >(tee -a "$results_dir/workflow.log") 2>&1
last_passing=0
stop_reason="all configured tiers passed"
sampler_pid=''

capture() { local file=$1; shift; "$@" >"$file" 2>&1 || true; }
scalar() {
  local response value
  response=$(curl -fsS "http://127.0.0.1:9090/api/v1/query?query=$1") || return 1
  [[ "$response" != *'"result":[]'* ]] || { echo 0; return; }
  value=$(printf '%s' "$response" | grep -o '"value":\[[^]]*\]' | tail -1 | grep -o '"[0-9.eE+-]*"' | tail -1 | tr -d '"')
  [[ "$value" =~ ^[0-9.eE+-]+$ ]] && printf '%s\n' "$value"
}
state() {
  docker inspect --format '{{.Name}} restart={{.RestartCount}} oom={{.State.OOMKilled}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}} image={{.Image}}' $(docker compose -f "$compose_file" ps -q) | sort
}
snapshot() {
  local dir=$1 label=$2
  capture "$dir/$label-connections.json" curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=sum%28pulsews_connections%29'
  capture "$dir/$label-subscriptions.json" curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=sum%28pulsews_subscriptions%7Bchannel_type%3D%22public%22%7D%29'
  capture "$dir/$label-delivery-scope.json" curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=sum%20by%20%28scope%29%20%28pulsews_delivery_latency_seconds_count%29'
  capture "$dir/$label-drops.json" curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=sum%28pulsews_dropped_messages_total%7Breason%21%3D%22no_local_subscribers%22%7D%29%20or%20vector%280%29'
  capture "$dir/$label-throttles.json" curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=sum%28pulsews_rest_throttled_total%29%20or%20vector%280%29'
}
compose_healthy() {
  local expected running
  expected=$(docker compose -f "$compose_file" config --services | sort)
  running=$(docker compose -f "$compose_file" ps --status running --services | sort)
  [[ "$running" == "$expected" ]] && ! state | grep -Eq 'oom=true|health=(unhealthy|exited|dead)'
}
wait_for_recovery() {
  local baseline_reserved=$1 baseline_connections=$2 app_id=$3 stable=0 reserved connections
  for _ in $(seq 1 60); do
    reserved=$(docker compose -f "$compose_file" exec -T redis redis-cli --raw GET "pulsews:app:$app_id:connections" || true); reserved=${reserved:-0}
    connections=$(scalar 'sum%28pulsews_connections%29' || true)
    if [[ "$reserved" =~ ^[0-9]+$ && "$connections" =~ ^[0-9.eE+-]+$ ]] && (( reserved <= baseline_reserved )) && awk "BEGIN {exit !($connections <= $baseline_connections)}"; then
      stable=$((stable+1)); (( stable >= 3 )) && return 0
    else stable=0; fi
    sleep 1
  done
  return 1
}
sample_resources() {
  local dir=$1 app_id=$2 previous_total='' previous_idle='' overload=0 peak_cpu=0 peak_mem=0
  printf 'timestamp,host_cpu_percent,host_used_bytes\n' >"$dir/host-samples.csv"
  printf 'timestamp,container,cpu_percent,memory_usage\n' >"$dir/container-samples.csv"
  printf 'timestamp,connections,subscriptions,same_node_deliveries,cross_node_deliveries,actionable_drops,rest_throttles,redis_reservations,pulsews_rss_bytes,pulsews_heap_bytes,eventloop_lag_p99_seconds,epoch_seconds\n' >"$dir/prometheus-samples.csv"
  while :; do
    read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat
    local total=$((user+nice+system+idle+iowait+irq+softirq+steal)) idle_all=$((idle+iowait)) cpu=0
    if [[ -n "$previous_total" ]]; then cpu=$(awk "BEGIN {printf \"%.2f\", 100*(1-($idle_all-$previous_idle)/($total-$previous_total))}"); fi
    previous_total=$total; previous_idle=$idle_all
    local used; used=$(awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{print (t-a)*1024}' /proc/meminfo)
    printf '%s,%s,%s\n' "$(date -u +%FT%TZ)" "$cpu" "$used" >>"$dir/host-samples.csv"
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' >>"$dir/container-samples.csv" 2>/dev/null || true
    local connections subscriptions same cross drops throttles reservations rss heap eventloop
    connections=$(scalar 'sum%28pulsews_connections%29' || echo invalid)
    subscriptions=$(scalar 'sum%28pulsews_subscriptions%7Bchannel_type%3D%22public%22%7D%29' || echo invalid)
    same=$(scalar 'sum%28pulsews_delivery_latency_seconds_count%7Bscope%3D%22same_node%22%7D%29%20or%20vector%280%29' || echo invalid)
    cross=$(scalar 'sum%28pulsews_delivery_latency_seconds_count%7Bscope%3D%22cross_node%22%7D%29%20or%20vector%280%29' || echo invalid)
    drops=$(scalar 'sum%28pulsews_dropped_messages_total%7Breason%21%3D%22no_local_subscribers%22%7D%29%20or%20vector%280%29' || echo invalid)
    throttles=$(scalar 'sum%28pulsews_rest_throttled_total%29%20or%20vector%280%29' || echo invalid)
    reservations=$(docker compose -f "$compose_file" exec -T redis redis-cli --raw GET "pulsews:app:$app_id:connections" 2>/dev/null || echo invalid); reservations=${reservations:-0}
    rss=$(scalar 'sum%28pulsews_process_resident_memory_bytes%29' || echo invalid)
    heap=$(scalar 'sum%28pulsews_nodejs_heap_size_used_bytes%29' || echo invalid)
    eventloop=$(scalar 'max%28pulsews_nodejs_eventloop_lag_p99_seconds%29' || echo invalid)
    sample_epoch=$(date +%s)
    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' "$(date -u +%FT%TZ)" "$connections" "$subscriptions" "$same" "$cross" "$drops" "$throttles" "$reservations" "$rss" "$heap" "$eventloop" "$sample_epoch" >>"$dir/prometheus-samples.csv"
    awk "BEGIN {exit !($cpu>$peak_cpu)}" && peak_cpu=$cpu
    (( used > peak_mem )) && peak_mem=$used
    if awk "BEGIN {exit !($cpu>90)}"; then overload=$((overload+1)); else overload=0; fi
    printf 'peak_host_cpu_percent=%s\npeak_host_used_bytes=%s\nconsecutive_cpu_over_90=%s\n' "$peak_cpu" "$peak_mem" "$overload" >"$dir/peaks.txt"
    (( overload < 12 )) || touch "$dir/sustained-overload.failed"
    sleep 5
  done
}
stop_sampler() { [[ -z "$sampler_pid" ]] || { kill "$sampler_pid" 2>/dev/null || true; wait "$sampler_pid" 2>/dev/null || true; sampler_pid=''; }; }
trap 'stop_sampler; rm -f "$credentials_file"' EXIT

app_id=$(sed -n 's/^PULSEWS_APP_ID=//p' "$credentials_file")
run_started_at=$(date -u +%FT%TZ)
capture "$results_dir/host.txt" sh -c 'uname -a; lscpu; free -h; ulimit -n'
capture "$results_dir/host-network-limits.txt" sh -c 'df -h; sysctl fs.file-max net.core.somaxconn net.ipv4.ip_local_port_range net.netfilter.nf_conntrack_count net.netfilter.nf_conntrack_max 2>&1'
capture "$results_dir/compose.txt" docker compose -f "$compose_file" ps
capture "$results_dir/container-limits.txt" docker inspect --format '{{.Name}} nofile={{json .HostConfig.Ulimits}} pids={{.HostConfig.PidsLimit}} memory={{.HostConfig.Memory}}' $(docker compose -f "$compose_file" ps -q)
printf 'capacity_endpoint=%s\nexternal_smoke_endpoint=from PULSEWS_URL in credential environment\n' "$capacity_url" >"$results_dir/endpoints.txt"
capture "$results_dir/redis-memory-preflight.txt" docker compose -f "$compose_file" exec -T redis redis-cli INFO memory
capture "$results_dir/redis-clients-preflight.txt" docker compose -f "$compose_file" exec -T redis redis-cli INFO clients
docker pull "$k6_image" || { stop_reason="k6 image pull failed"; exit 1; }
capture "$results_dir/image-digests.txt" docker image inspect --format '{{json .RepoDigests}}' "$expected_image" "$k6_image"

max_connections=$(docker compose -f "$compose_file" exec -T pulsews-a node -e 'const fs=require("node:fs"),c=JSON.parse(fs.readFileSync(process.env.PULSEWS_CONFIG));const a=c.apps.find(x=>x.id===process.argv[1]);process.stdout.write(String(a?.maxConnections||0))' "$app_id" || echo 0)
baseline_reserved=$(docker compose -f "$compose_file" exec -T redis redis-cli --raw GET "pulsews:app:$app_id:connections" || echo 0); baseline_reserved=${baseline_reserved:-0}
baseline_connections=$(scalar 'sum%28pulsews_connections%29' || echo 0)
required_headroom=0; for tier in "${tiers[@]}"; do (( tier > required_headroom )) && required_headroom=$tier; done
printf 'app_id=%s\nmax_connections=%s\nreserved_connections=%s\nprometheus_connections=%s\nrequired_cap=%s\nrequired_headroom=%s\n' "$app_id" "$max_connections" "$baseline_reserved" "$baseline_connections" "$required_cap" "$required_headroom" >"$results_dir/connection-headroom.txt"

preflight_ok=1
[[ -n "$app_id" && "$max_connections" == "$required_cap" ]] || { stop_reason="deployed app cap is not exactly 12000"; preflight_ok=0; }
[[ "$baseline_reserved" =~ ^[0-9]+$ ]] && (( required_cap - baseline_reserved >= required_headroom )) || { stop_reason="insufficient headroom for $required_headroom clients"; preflight_ok=0; }
compose_healthy || { stop_reason="Compose health preflight failed"; preflight_ok=0; }
[[ $(docker compose -f "$compose_file" exec -T redis redis-cli ping) == PONG ]] || { stop_reason="Redis preflight failed"; preflight_ok=0; }
[[ $(ulimit -n) -ge 65535 ]] || { stop_reason="host file-descriptor limit below 65535"; preflight_ok=0; }
for service in pulsews-a pulsews-b; do
  container=$(docker compose -f "$compose_file" ps -q "$service")
  [[ $(docker inspect --format '{{.Config.Image}}' "$container") == "$expected_image" ]] || { stop_reason="deployed image mismatch"; preflight_ok=0; }
done

if (( preflight_ok )); then
  for tier in "${tiers[@]}"; do
    tier_dir="$results_dir/tier-$tier"; mkdir -p "$tier_dir"
    tier_started=$(date -u +%FT%TZ)
    state >"$tier_dir/container-state-before.txt"
    snapshot "$tier_dir" before
    same_before=$(scalar 'sum%28pulsews_delivery_latency_seconds_count%7Bscope%3D%22same_node%22%7D%29%20or%20vector%280%29' || echo x)
    cross_before=$(scalar 'sum%28pulsews_delivery_latency_seconds_count%7Bscope%3D%22cross_node%22%7D%29%20or%20vector%280%29' || echo x)
    drops_before=$(scalar 'sum%28pulsews_dropped_messages_total%7Breason%21%3D%22no_local_subscribers%22%7D%29%20or%20vector%280%29' || echo x)
    throttles_before=$(scalar 'sum%28pulsews_rest_throttled_total%29%20or%20vector%280%29' || echo x)
    baseline_subscriptions=$(scalar 'sum%28pulsews_subscriptions%7Bchannel_type%3D%22public%22%7D%29' || echo 0)
    sample_resources "$tier_dir" "$app_id" & sampler_pid=$!
    command=(docker run --rm --network host --user "$(id -u):$(id -g)" --env-file "$credentials_file" -v "$loadtest_dir:/loadtest:ro" -v "$tier_dir:/results" "$k6_image" run --summary-export=/results/k6-summary.json -e "PULSEWS_URL=$capacity_url" -e "PULSEWS_VUS=$tier" -e PULSEWS_CHANNELS=100 -e PULSEWS_RATE=50 -e "PULSEWS_RAMP_DURATION=$ramp_duration" -e "PULSEWS_HOLD_DURATION=$hold_duration" -e "PULSEWS_CONNECTION_SECONDS=$connection_seconds" -e "PULSEWS_CHANNEL_PREFIX=capacity-${GITHUB_SHA:-unknown}-$tier" /loadtest/capacity.js)
    printf '%q ' "${command[@]}" >"$tier_dir/command.txt"; printf '\n' >>"$tier_dir/command.txt"
    "${command[@]}" 2>&1 | tee "$tier_dir/k6.log"; k6_status=${PIPESTATUS[0]}
    stop_sampler
    snapshot "$tier_dir" after
    state >"$tier_dir/container-state-after.txt"
    capture "$tier_dir/redis-memory.txt" docker compose -f "$compose_file" exec -T redis redis-cli INFO memory
    capture "$tier_dir/redis-clients.txt" docker compose -f "$compose_file" exec -T redis redis-cli INFO clients
    capture "$tier_dir/redis-errors.txt" docker compose -f "$compose_file" logs --since "$tier_started" redis
    capture "$tier_dir/nginx.log" docker compose -f "$compose_file" logs --since "$tier_started" nginx
    capture "$tier_dir/pulsews-a.log" docker compose -f "$compose_file" logs --since "$tier_started" pulsews-a
    capture "$tier_dir/pulsews-b.log" docker compose -f "$compose_file" logs --since "$tier_started" pulsews-b
    same_after=$(scalar 'sum%28pulsews_delivery_latency_seconds_count%7Bscope%3D%22same_node%22%7D%29%20or%20vector%280%29' || echo x)
    cross_after=$(scalar 'sum%28pulsews_delivery_latency_seconds_count%7Bscope%3D%22cross_node%22%7D%29%20or%20vector%280%29' || echo x)
    drops_after=$(scalar 'sum%28pulsews_dropped_messages_total%7Breason%21%3D%22no_local_subscribers%22%7D%29%20or%20vector%280%29' || echo x)
    throttles_after=$(scalar 'sum%28pulsews_rest_throttled_total%29%20or%20vector%280%29' || echo x)
    peak_connections=$(awk -F, 'NR>1 && $2 ~ /^[0-9.]+$/ && $2>m {m=$2} END{print m+0}' "$tier_dir/prometheus-samples.csv")
    peak_subscriptions=$(awk -F, 'NR>1 && $3 ~ /^[0-9.]+$/ && $3>m {m=$3} END{print m+0}' "$tier_dir/prometheus-samples.csv")
    target_connections=$tier
    target_subscriptions=$tier
    sustained_target_seconds=$(awk -F, -v c="$target_connections" -v s="$target_subscriptions" 'NR>1 {if ($2+0>=c && $3+0>=s) {if(!start)start=$12; duration=$12-start; if(duration>max)max=duration} else start=0} END{print max+0}' "$tier_dir/prometheus-samples.csv")
    memory_values=$(awk -F, -v c="$target_connections" -v s="$target_subscriptions" 'NR>1 && $2+0>=c && $3+0>=s && $9 ~ /^[0-9.]+$/ {if(!start)start=$12; last=$12; value[$12]=$9} END {for(t in value){if(t>=start+600 && t<start+1200){a+=value[t];an++} if(t>last-600){b+=value[t];bn++}} printf "%.0f %.0f", (an?a/an:0), (bn?b/bn:0)}' "$tier_dir/prometheus-samples.csv")
    read -r memory_early memory_late <<< "$memory_values"
    memory_growth_bytes=$((memory_late-memory_early))
    printf 'peak_connections=%s\npeak_subscriptions=%s\nsustained_target_seconds=%s\nmemory_early_window_bytes=%s\nmemory_late_window_bytes=%s\nmemory_growth_bytes=%s\n' "$peak_connections" "$peak_subscriptions" "$sustained_target_seconds" "$memory_early" "$memory_late" "$memory_growth_bytes" >>"$tier_dir/peaks.txt"
    reasons=()
    (( k6_status == 0 )) || reasons+=("k6 threshold or scenario failure")
    cmp -s "$tier_dir/container-state-before.txt" "$tier_dir/container-state-after.txt" || reasons+=("container restart, OOM, health, or image changed")
    grep -Eiq '(^|[^[:alpha:]])(error|fatal|panic)([^[:alpha:]]|$)' "$tier_dir/redis-errors.txt" && reasons+=("Redis emitted an error")
    [[ ! -e "$tier_dir/sustained-overload.failed" ]] || reasons+=("host CPU exceeded 90% for 12 consecutive samples")
    [[ "$drops_before" == "$drops_after" ]] || reasons+=("actionable drop counter increased")
    [[ "$throttles_before" == "$throttles_after" ]] || reasons+=("REST throttle counter increased")
    awk "BEGIN{exit !($peak_connections >= $target_connections)}" || reasons+=("not every intended WebSocket upgrade was observed")
    awk "BEGIN{exit !($peak_subscriptions >= $target_subscriptions)}" || reasons+=("not every intended public subscription was observed")
    (( sustained_target_seconds >= required_sustained_seconds )) || reasons+=("target connections and subscriptions did not meet the sustained-duration requirement")
    if [[ "$require_memory_flat" == 1 ]]; then
      (( memory_early > 0 && memory_late > 0 )) || reasons+=("PulseWS memory windows could not be measured")
      (( memory_growth_bytes <= 134217728 )) || reasons+=("PulseWS RSS grew by more than 128 MiB")
      awk "BEGIN{exit !($memory_late <= $memory_early * 1.10)}" || reasons+=("PulseWS RSS grew by more than 10 percent")
    fi
    [[ "$same_before" != x && "$cross_before" != x ]] && awk "BEGIN{exit !($same_after>$same_before && $cross_after>$cross_before)}" || reasons+=("same-node and cross-node delivery series did not both increase")
    compose_healthy || reasons+=("Compose health postflight failed")
    if (( ${#reasons[@]} )); then
      printf 'failed\n' >"$tier_dir/result.txt"
      printf '%s\n' "${reasons[@]}" | tee -a "$tier_dir/result.txt" >"$tier_dir/failure-reasons.txt"
      reason_text=$(IFS='; '; echo "${reasons[*]}")
      stop_reason="tier $tier failed: $reason_text"
      break
    fi
    printf 'passed\n' >"$tier_dir/result.txt"; last_passing=$tier
    wait_for_recovery "$baseline_reserved" "$baseline_connections" "$app_id" || { stop_reason="recovery after tier $tier timed out"; break; }
  done
fi

printf '{"lastPassingTier":%s,"stopReason":"%s","startedAt":"%s","finishedAt":"%s","commit":"%s","contention":"k6 and PulseWS shared the VPS"}\n' "$last_passing" "${stop_reason//\"/\\\"}" "$run_started_at" "$(date -u +%FT%TZ)" "${GITHUB_SHA:-unknown}" >"$results_dir/result.json"
[[ "$stop_reason" == "all configured tiers passed" ]] || exit 1
