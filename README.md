# 📦 Комплексная сборка: Double-Take + CodeProject.AI + IPEYE Shot (HA add-on)

Этот репозиторий содержит сразу три компонента для локальной системы распознавания лиц:

- **CodeProject.AI** — детектор/нейросеть для обработки изображений.
- **Double-Take** — брокер распознавания лиц, агрегирует данные от камер и детекторов.
- **IPEYE Shot (HTTP add-on)** — аддон Home Assistant, делает скриншоты из веб-плееров (IPEYE и др.) и отправляет их в Double-Take.

---

## 🚀 Архитектура

```
Камера (iframe / MSE / WSS)
        ↓ (HTTP capture)
    IPEYE Shot (аддон HA)
        ↓ (REST API)
      Double-Take
        ↓ (детектор)
    CodeProject.AI / CompreFace / ...
```

---

## ⚙️ Как собрать и запустить

### 1. CodeProject.AI
- Работает в контейнере Docker.
- В папке `codeproject-ai/` лежит готовый Dockerfile/compose.
- Запуск:
  ```bash
  cd codeproject-ai
  docker compose up -d
  ```  
- По умолчанию слушает порт `32168`.

### 2. Double-Take
- В папке `double-take/`.
- Запуск:
  ```bash
  cd double-take
  docker compose up -d
  ```  
- По умолчанию веб-интерфейс: `http://<IP>:3000`.
- В настройках Double-Take укажите детектор **CodeProject.AI** (`http://codeproject-ai:32168`).

### 3. IPEYE Shot (аддон для Home Assistant)
- В папке `ipeye-shot/`.
- Собирается как аддон HA или как отдельный контейнер:
  ```bash
  cd ipeye-shot
  docker build -t ipeye-shot:dev .
  docker run --rm -it -p 8099:8099     -v "$(pwd)/shots:/share/ipeye_shots"     -e DT_URL=http://<HA_IP>:3000/api/recognize     ipeye-shot:dev
  ```  
- Проверка: `GET http://<HA_IP>:8099/health`.

---

## 🔗 Интеграция с Home Assistant

После установки аддона можно дергать API `/capture` из HA автоматизаций или Node-RED.  
Пример в `README.md` внутри папки `ipeye-shot`.

---

## 📁 Структура репозитория

```
.
├── codeproject-ai/   # контейнер с детектором
├── double-take/      # брокер распознавания лиц
├── ipeye-shot/       # аддон HA для захвата кадров
├── README.md         # дока по IPEYE Shot
└── ALL-IN-ONE.md     # эта инструкция
```

---

## ⚠️ Замечания
- Все компоненты можно запускать в одном Docker Compose.
- Если Home Assistant OS → IPEYE Shot ставится как аддон, а DT+CodeProject — как внешние контейнеры.
- Важно, чтобы все сервисы были в одной сети (Docker bridge или host).
- Не открывайте порты Double-Take наружу без аутентификации.  
