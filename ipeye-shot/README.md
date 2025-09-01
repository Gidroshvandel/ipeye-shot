# 📸 IPEYE Shot → Double-Take (HTTP add-on)

**Аддон Home Assistant**: принимает URL iframe (IPEYE и другие веб-плееры), делает скриншот кадра через headless Chromium и отправляет его в [Double-Take](https://github.com/jakowenko/double-take) для распознавания лиц.  

- ❌ **Без RTSP/HLS** — работает даже с веб-плеерами (MSE/WSS).  
- 🌍 **Универсально** — можно дергать для любой камеры, в любое время.  
- 🔌 **Интеграция с HA** — через `rest_command`, Scripts, Automations, Node-RED.  

---

## 🚀 Установка
1. В Home Assistant:  
   `Настройки → Аддоны → Магазин аддонов → ⋮ → Репозитории → Добавить`  
   Вставьте URL репозитория:  
   ```
   https://github.com/<YOUR_GH_USERNAME>/<YOUR_REPO_NAME>
   ```
2. Установите **IPEYE Shot → Double-Take (HTTP service)**.  
3. В настройках аддона укажите:
   - `dt_url` — адрес Double-Take, обычно  
     `http://<HA_IP>:3000/api/recognize` (если DT аддоном на той же машине).  
   - (опц.) `public_base_url` — как HA доступен в вашей сети (например, `http://192.168.50.50:8099`).  
   - Остальное можно оставить по умолчанию.  
4. Нажмите **Start**. Аддон поднимет HTTP-сервис (по умолчанию порт `8099`).  

---

## ✅ Проверка

```
GET http://<HA_IP>:8099/health
→ {"ok":true}
```

Снимки и JSON-ответы сохраняются в `/share/ipeye-shots`  
(через Samba: `\\homeassistant\share\ipeye-shots`).  

---

## ⚡ Быстрый старт

Отправьте URL iframe камеры IPEYE:

```bash
curl -X GET "http://<HA_IP>:8099/capture?camera=porch&player_url=https://ipeye.ru/ipeye_service/api/iframe.php?iframe_player=0&dev=DF1...&autoplay=1"
```

В логах аддона будет `SAVE ... -> http://<HA_IP>:8099/shots/porch-YYYY.jpg`,  
а в `/share/ipeye-shots/` появятся `porch-YYYY.jpg|.json`.  

---

## 🔗 Интеграция в Home Assistant

### Вариант A — `rest_command` + Script (рекомендуется)

```yaml
# configuration.yaml
rest_command:
  ipeye_shot_capture:
    url: "http://<HA_IP>:8099/capture?camera={{ camera }}&player_url={{ url }}"
    method: GET

script:
  ipeye_capture_now:
    alias: IPEYE → Double-Take capture
    fields:
      url:
        description: Полный URL iframe (IPEYE)
      camera:
        description: Имя камеры (идентификатор в Double-Take)
    sequence:
      - service: rest_command.ipeye_shot_capture
        data:
          url: "{{ url }}"
          camera: "{{ camera|default('porch') }}"
```

Теперь можно вызывать `script.ipeye_capture_now` из UI, автоматизаций или Node-RED.  

### Вариант B — Автоматизация

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

---

## ⚙️ Опции аддона

- `dt_url` — URL Double-Take API (`/api/recognize`).  
- `public_base_url` — внешний адрес HA для формирования публичных ссылок.  
- `public_prefix` — путь публикации снимков (по умолчанию `/shots`).  
- `save_dir` — каталог для JPG/JSON (по умолчанию `/share/ipeye-shots`).  
- `view_w`, `view_h` — размер окна Chromium.  
- `play_wait_ms` — задержка перед снимком (чтобы видео успело отрисоваться).  
- `max_concurrent_per_cam` — сколько параллельных задач можно обрабатывать на одну камеру (обычно 1).  
- `capture_timeout_ms` — таймаут ожидания задачи в очереди.  
- `browser_idle_minutes` — через сколько минут бездействия закрывать Chromium.  
- `file_ttl_hours` — сколько часов хранить снимки/JSON.  

---

## ⚠️ Ограничения
- Аддон **не тянет поток** — только делает скриншот текущего кадра.  
- Для распознавания нужно, чтобы в Double-Take был настроен детектор (CompreFace, CodeProject.AI и др.) и коллекции лиц.  
- Сервис **без аутентификации**: держите порт доступным только внутри вашей LAN.  
