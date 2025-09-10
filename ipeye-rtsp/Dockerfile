FROM debian:bullseye-slim

RUN apt-get update && apt-get install -y ffmpeg curl jq && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
ENV MEDIAMTX_VERSION=v1.9.2

RUN curl -L https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_${TARGETARCH}.tar.gz \
    -o /tmp/mediamtx.tar.gz \
    && tar -xzf /tmp/mediamtx.tar.gz -C /tmp \
    && mv /tmp/mediamtx /usr/local/bin/ \
    && rm -rf /tmp/mediamtx*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8554

CMD ["/entrypoint.sh"]
