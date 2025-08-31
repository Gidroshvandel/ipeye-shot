FROM ghcr.io/puppeteer/puppeteer:22

# В этом образе puppeteer уже в /usr/src/app/node_modules
WORKDIR /usr/src/app

# Нужные доп. зависимости для аплоада
RUN npm install --omit=dev form-data node-fetch@3

# Кладём наши файлы рядом c node_modules puppeteer
COPY capture-and-send.js ./capture-and-send.js
COPY runner.js ./runner.js

CMD ["node", "/usr/src/app/runner.js"]
