# IPEYE RTSP Proxy Add-on

Этот аддон преобразует HLS-потоки от IPEYE в RTSP, чтобы Home Assistant, Double-Take и другие системы могли работать с камерами локально.

## Конфигурация

В настройках аддона укажите список камер:

```yaml
cameras:
  - name: porch
    hls_url: "https://sr-.../hls/index.m3u8"
  - name: yard
    hls_url: "https://sr-.../hls/index.m3u8"
