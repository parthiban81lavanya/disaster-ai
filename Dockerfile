# DisasterShield AI - one container serves the API, the Control Room and the mobile PWA.
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /srv
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend backend
COPY portal portal
COPY web-dashboard web-dashboard
COPY mobile mobile
RUN useradd --create-home app && chown -R app /srv
USER app
WORKDIR /srv/backend
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/healthz')"
CMD exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'
