FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/backend
WORKDIR /app
COPY backend/requirements*.txt /app/backend/
RUN pip install --no-cache-dir -r backend/requirements-server.txt \
    && mkdir /data && chown 10001:10001 /data && chmod 700 /data
COPY backend/duprove_backend /app/backend/duprove_backend
COPY backend/deploy/gunicorn.conf.py /app/backend/deploy/gunicorn.conf.py
COPY contracts/report.schema.json /app/contracts/report.schema.json
USER 10001:10001
CMD ["gunicorn", "--config", "backend/deploy/gunicorn.conf.py", "duprove_backend.wsgi:application"]
