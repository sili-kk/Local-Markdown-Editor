FROM golang:1.26-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/md-editor .

FROM alpine:3.22

LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
LABEL org.opencontainers.image.authors="sili"

RUN addgroup -S -g 1000 editor && adduser -S -u 1000 -G editor editor
WORKDIR /app
COPY --from=build /out/md-editor /app/md-editor
COPY config.docker.example.yaml /app/config.example.yaml
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
COPY LICENSE /app/LICENSE
COPY third_party /app/third_party
COPY docs/THIRD_PARTY_NOTICES.md /app/third_party/NOTICE.md
COPY web/vendor/toastui/LICENSE /app/third_party/toastui-LICENSE
COPY web/vendor/toastui-table/LICENSE /app/third_party/toastui-table-LICENSE
COPY web/vendor/diff3/LICENSE.md /app/third_party/diff3-LICENSE.md
RUN mkdir -p /data/config /data/documents /data/logs \
    && chmod +x /app/docker-entrypoint.sh \
    && chown -R editor:editor /app /data
USER editor
EXPOSE 8080
VOLUME ["/data/config", "/data/documents", "/data/logs"]
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["-config", "/data/config/config.yaml"]
