FROM python:3.12-slim

# Code lives in /app; all runtime state (config.ini, tokens, logs, heartbeat)
# lives on the volume mounted at /data. Never mount anything over /app.
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV COLLECTOR_DATA_DIR=/data
RUN mkdir -p /data

# Unhealthy when the maintenance loop has not written a heartbeat for 5 minutes.
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s \
  CMD python -c "import os,sys,time; sys.exit(0 if time.time()-os.path.getmtime('/data/heartbeat') < 300 else 1)"

CMD [ "python", "-u", "collector.py", "--config", "/data/config.ini" ]
