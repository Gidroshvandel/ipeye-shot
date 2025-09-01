# IPEYE Shot → Double-Take (HTTP add-on)

Аддон Home Assistant: принимает **URL iframe** (IPEYE и др.), делает **скрин кадра** через headless Chromium и отправляет снимок в **Double-Take** для распознавания лиц.  
Вызов — HTTP `POST /capture` (или через `hassio.addon_stdin`). Снимки и ответы сохраняются на диск.

- Без RTSP/HLS: работает даже с веб-плеерами (wss/MSE).
- Универсально: можно дергать для **любой камеры, в любое время**, хоть по тысяче раз.
- Легкая интеграция с HA: `rest_command`, Scripts, Automations, Node-RED.

---

## Установка

1) В Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories → Add**  
   Вставьте URL репозитория:  
   `https://github.com/<YOUR_GH_USERNAME>/<YOUR_REPO_NAME>`

2) Установите **IPEYE Shot to Double-Take (HTTP service)** и откройте настройки.

3) В конфиге аддона укажите:
   - **`dt_url`** — адрес Double-Take, обычно  
     `http://<IP_вашего_HA>:3000/api/recognize/upload`  
     (если Double-Take аддоном на той же машине).
   - (Опц.) `default_player_url`, `default_camera` — дефолты на случай, если в запросе URL не передадут.
   - Остальные параметры можно оставить по умолчанию.

4) Нажмите **Start**. Аддон поднимет HTTP сервис (по умолчанию `:8099`).  
   Проверка:  
   ```
   GET http://<HA_IP>:8099/health
   → {"ok":true,"busy":false,"q":0}
   ```

> Снимки и JSON-ответы сохраняются в папку **/share/ipeye_shots** (Samba: `\\homeassistant\share\ipeye_shots`).

---

## Быстрый старт: один вызов

Отправьте URL плеера IPEYE (замените `dev=...` своим UUID):

```bash
curl -X POST http://<HA_IP>:8099/capture   -H 'Content-Type: application/json'   -d '{"player_url":"https://ipeye.ru/ipeye_service/api/iframe.php?iframe_player=0&dev=DF1...&autoplay=1","camera":"porch"}'
```

В логах аддона увидите `OK (...)`, а в `/share/ipeye_shots/` появятся `porch-YYYY...jpg|.json`.

---

## Как использовать в Home Assistant

### Вариант A — `rest_command` + Script (рекомендуется)

```yaml
# configuration.yaml
rest_command:
  ipeye_shot_capture:
    url: "http://<HA_IP>:8099/capture"
    method: POST
    content_type: "application/json"
    payload: >
      {"player_url":"{{ url }}","camera":"{{ camera|default('porch') }}"}

script:
  ipeye_capture_now:
    alias: IPEYE → Double-Take capture
    fields:
      url:
        description: Полный URL iframe (IPEYE) с dev/autoplay
      camera:
        description: Имя камеры (идентификатор в Double-Take)
    sequence:
      - service: rest_command.ipeye_shot_capture
        data:
          url: "{{ url }}"
          camera: "{{ camera }}"
```

Теперь можно вызывать **`script.ipeye_capture_now`** с любым URL — из UI, автоматизаций или Node-RED.

### Вариант B — Автоматизация (пример)

```yaml
alias: Распознать лицо у двери (IPEYE → DT)
trigger:
  - platform: state
    entity_id: binary_sensor.entrance_motion
    to: "on"
action:
  - service: rest_command.ipeye_shot_capture
    data:
      url: "https://ipeye.ru/ipeye_service/api/iframe.php?iframe_player=0&dev={{ states('input_text.ipeye_uuid') }}&autoplay=1"
      camera: "porch"
mode: single
```

### Вариант C — через Supervisor stdin (без HTTP)

```yaml
service: hassio.addon_stdin
data:
  addon: local_ipeye_shot
  input: >
    {"player_url":"https://.../iframe.php?dev=UUID&autoplay=1","camera":"porch"}
```

> ID аддона можно посмотреть на странице аддона. Для локальных обычно `local_<slug>`.

---

## Опции аддона (коротко)

- `dt_url` — URL аплоада Double-Take (`/api/recognize/upload`).  
- `default_player_url`, `default_camera` — дефолты, если не передали в запросе.  
- `save_dir` — куда сохранять JPG/JSON (по умолчанию `/share/ipeye_shots`).  
- `save_always` — сохранять кадр всегда (если `false` — только JSON/при ошибке).  
- `play_wait_ms` — задержка перед снимком, чтобы плеер успел отрисовать кадр.  
- `view_w`, `view_h` — размер окна headless Chromium.  
- `headless` — режим Chromium (`new`/`true`/`false`), рекомендуем `new`.  
- `iframe_selector` — CSS-селектор `iframe`, если их несколько на странице.  
- `http_port` — порт HTTP-сервиса (по умолчанию 8099).  
- `retries`, `retry_delay_ms` — повторы попыток захвата кадра и задержка между ними.

Полные описания выводятся в UI (см. переводы `translations/en.yaml`, `ru.yaml`).

---

## Требования и ограничения

- Аддон **не тянет видеопоток**; он делает **скриншот** видимого кадра из веб-плеера (MSE/wss) и отправляет в Double-Take.  
- Для распознавания в Double-Take должен быть настроен детектор (например, CompreFace/CodeProject.AI) и коллекции лиц.  
- Сервис **без аутентификации**: держите порт доступным только из вашей LAN. Не пробрасывайте наружу без защиты.

---

## Локальное тестирование (как обычный контейнер)

```bash
# в папке ipeye-shot
docker build -t ipeye-shot:dev .
mkdir -p ./shots

# временные опции (как /data/options.dev.json в HA)
cat > ../options.dev.json <<'JSON'
{
  "dt_url": "http://host.docker.internal:3000/api/recognize/upload",
  "save_dir": "/share/ipeye_shots",
  "save_always": true,
  "play_wait_ms": 1200,
  "view_w": 1280,
  "view_h": 720,
  "headless": "new",
  "iframe_selector": "iframe",
  "http_port": 8099,
  "retries": 1,
  "retry_delay_ms": 500
}
JSON

docker run --rm -it -p 8099:8099   --shm-size=512m   -v "$(pwd)/../options.json:/data/options.json:ro"   -v "$(pwd)/shots:/share/ipeye_shots"   --add-host=host.docker.internal:host-gateway   ipeye-shot:dev

# затем в другом терминале:
curl -X POST http://localhost:8099/capture   -H 'Content-Type: application/json'   -d '{"player_url":"https://ipeye.ru/ipeye_service/api/iframe.php?iframe_player=0&dev=DF1...&autoplay=1","camera":"porch"}'
```
