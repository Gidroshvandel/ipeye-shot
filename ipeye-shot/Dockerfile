FROM ghcr.io/puppeteer/puppeteer:22

# В этом образе puppeteer уже в /usr/src/app/node_modules
WORKDIR /home/pptruser

RUN npm install --omit=dev form-data node-fetch@3

# Кладём наши файлы рядом c node_modules puppeteer
COPY runner.js ./runner.js

USER root
RUN apt-get update && apt-get install -y acl && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
