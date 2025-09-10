#!/bin/sh
set -e

CONFIG_PATH=/data/options.json

cat > /mediamtx.yml <<EOF
protocols: [tcp]

paths:
EOF

for cam in $(jq -c '.cameras[]' $CONFIG_PATH); do
  name=$(echo $cam | jq -r '.name')
  url=$(echo $cam | jq -r '.hls_url')
  cat >> /mediamtx.yml <<EOC
  $name:
    runOnInit: >
      ffmpeg -hide_banner -loglevel info -i $url -c copy -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/$name
    runOnInitRestart: yes
EOC
done

echo "[INFO] Starting mediamtx with config:"
cat /mediamtx.yml

exec mediamtx /mediamtx.yml
