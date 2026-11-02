FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY pyproject.toml requirements.txt ./
COPY dropship ./dropship
RUN pip install --no-cache-dir . \
 && useradd --create-home --uid 10001 dropship \
 && mkdir -p /app/data && chown dropship /app/data

USER dropship
VOLUME ["/app/data"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4)" || exit 1

# Webhook listener + scheduled loops in one process (prevents double-processing by design).
CMD ["dropship", "--env-file", "/app/.env", "run"]
