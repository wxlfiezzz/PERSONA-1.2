#!/usr/bin/env bash
# Run as root on the existing Persona VPS. No volume is deleted by this script.
set -Eeuo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
[[ $(id -u) = 0 ]] || { echo 'Run with sudo bash deploy.sh'; exit 1; }
command -v flock >/dev/null
exec 9>/var/lock/persona-deploy.lock
flock -n 9 || { echo 'Another Persona deployment is already running'; exit 1; }
command -v docker >/dev/null
command -v python3 >/dev/null
command -v curl >/dev/null
docker inspect persona >/dev/null
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="/root/persona-backups/patch-$STAMP"
STAGE="persona-stage-$STAMP"
PREVIOUS="persona-before-$STAMP"
NEW_IMAGE="persona:1.3.0-$STAMP"
mkdir -p "$BACKUP"
docker inspect persona > "$BACKUP/container.json"
# This script is intentionally specific to the known VPS configuration.
python3 - "$BACKUP" <<'PY'
import json,sys,pathlib
p=pathlib.Path(sys.argv[1]);c=json.loads((p/'container.json').read_text())[0]
assert c['State']['Running'], 'Existing persona container must be running'
mounts=c['Mounts']
assert len(mounts)==1 and mounts[0]['Type']=='volume' and mounts[0]['Name']=='persona-data' and mounts[0]['Destination']=='/app/data', 'Unexpected mounts; review manually before deployment'
ports=c['HostConfig']['PortBindings']
assert ports=={'3000/tcp':[{'HostIp':'127.0.0.1','HostPort':'3000'}]}, 'Unexpected port mapping; review manually'
env=c['Config']['Env']
assert all('\n' not in e and '\r' not in e for e in env), 'Multiline environment cannot be exported safely'
assert any(e.startswith('APP_ORIGIN=https://') for e in env), 'Set the current HTTPS APP_ORIGIN on the existing container first'
(p/'persona.env').write_text('\n'.join(env)+'\n')
PY
OLD_IMAGE=$(docker inspect -f '{{.Image}}' persona)
docker tag "$OLD_IMAGE" "persona:rollback-$STAMP"
docker image save "persona:rollback-$STAMP" | gzip > "$BACKUP/previous-image.tar.gz"
tar --exclude='./data' --exclude='./node_modules' -czf "$BACKUP/source-before.tar.gz" -C /opt/persona .
echo 'Building the new image; the existing service is still running.'
docker build -t "$NEW_IMAGE" .
STOPPED=0
SWITCHED=0
recover() {
  result=$?
  trap - EXIT
  if [[ $result != 0 ]]; then
    echo "Deployment failed. Backup: $BACKUP"
    docker stop "$STAGE" >/dev/null 2>&1 || true
    if [[ $SWITCHED = 1 ]]; then
      docker stop persona >/dev/null 2>&1 || true
      if docker inspect persona >/dev/null 2>&1; then docker rename persona "persona-failed-$STAMP"; fi
      if ! docker run --rm --network none --user 0 --entrypoint node --mount type=volume,src=persona-data,dst=/app/data,readonly "$NEW_IMAGE" rollback-guard.mjs; then
        echo 'Automatic rollback paused to preserve archive protection. Keep the backups and use an archive-aware recovery image.'
        exit "$result"
      fi
      docker rename "$PREVIOUS" persona
      docker start persona
    elif [[ $STOPPED = 1 ]]; then
      docker start persona
    fi
  fi
  exit "$result"
}
trap recover EXIT
STOPPED=1
docker stop -t 30 persona
echo 'Saving the entire stopped volume, including SQLite WAL and attachments.'
docker run --rm --network none --user 0 --entrypoint sh \
  --mount type=volume,src=persona-data,dst=/snapshot,readonly \
  --mount "type=bind,src=$BACKUP,dst=/backup" \
  "$OLD_IMAGE" -c 'tar -czf /backup/persona-data.tar.gz -C /snapshot .'
gzip -t "$BACKUP/persona-data.tar.gz"
tar -tzf "$BACKUP/persona-data.tar.gz" > "$BACKUP/volume-files.txt"
grep -q '^./persona.sqlite$' "$BACKUP/volume-files.txt"
docker volume create "$STAGE" >/dev/null
docker run --rm --network none --user 0 --entrypoint sh \
  --mount "type=volume,src=$STAGE,dst=/restore" \
  --mount "type=bind,src=$BACKUP,dst=/backup,readonly" \
  "$OLD_IMAGE" -c 'tar -xzf /backup/persona-data.tar.gz -C /restore'
echo 'Checking the new version on a private volume copy.'
docker run -d --name "$STAGE" --network none \
  --env-file "$BACKUP/persona.env" -e HOST=0.0.0.0 -e PORT=3000 -e DATA_DIR=/app/data \
  -e REALTIME_TRANSPORT=poll -e NEWS_AUTO_PUBLISH=1 \
  -e CHECKINS_EXPIRY=0 --mount "type=volume,src=$STAGE,dst=/app/data" "$NEW_IMAGE" >/dev/null
wait_inside() {
  local container=$1
  for i in {1..30}; do
    if docker exec "$container" node -e "fetch('http://127.0.0.1:3000/health').then(async r=>{if(!r.ok||(await r.json()).version!=='1.3.0')process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  docker logs --tail 60 "$container"
  return 1
}
wait_inside "$STAGE"
docker stop -t 30 "$STAGE" >/dev/null
docker run --rm --network none --user 0 --entrypoint node \
  --mount type=volume,src=persona-data,dst=/baseline,readonly \
  --mount "type=volume,src=$STAGE,dst=/candidate,readonly" \
  "$NEW_IMAGE" verify-upgrade.mjs /baseline/persona.sqlite /candidate/persona.sqlite | tee "$BACKUP/verification.txt"
docker rename persona "$PREVIOUS"
SWITCHED=1
docker run -d --name persona --restart unless-stopped \
  --env-file "$BACKUP/persona.env" -e HOST=0.0.0.0 -e PORT=3000 -e DATA_DIR=/app/data \
  -e REALTIME_TRANSPORT=poll -e NEWS_AUTO_PUBLISH=1 \
  -e CHECKINS_EXPIRY=1 -p 127.0.0.1:3000:3000 \
  --mount type=volume,src=persona-data,dst=/app/data "$NEW_IMAGE" >/dev/null
wait_inside persona
curl --fail --silent --show-error http://127.0.0.1:3000/health
printf '\nPrevious container: %s\nBackup: %s\nStaging copy: %s\n' "$PREVIOUS" "$BACKUP" "$STAGE"
cat > "$BACKUP/rollback.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec 9>/var/lock/persona-deploy.lock
flock -n 9
docker stop -t 30 persona
if ! docker run --rm --network none --user 0 --entrypoint node --mount type=volume,src=persona-data,dst=/app/data,readonly "$NEW_IMAGE" rollback-guard.mjs; then
  docker start persona
  echo 'Rollback refused; the current version was restarted to preserve archive protection.'
  exit 1
fi
docker rename persona persona-1.3-stopped-$STAMP
docker rename $PREVIOUS persona
docker start persona
curl --fail --silent --show-error http://127.0.0.1:3000/health
EOF
chmod 700 "$BACKUP/rollback.sh"
echo "Deployment complete. Rollback: sudo bash $BACKUP/rollback.sh"
echo 'Check the external URL, an existing login, two-way messaging and an old attachment.'
