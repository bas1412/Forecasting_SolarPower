FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV APP_TIMEZONE=Asia/Bangkok
ENV ELASTICSEARCH_URL=http://elasticsearch:9200

COPY fastapi_service/requirements.txt /tmp/requirements.txt

RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY fastapi_service ./fastapi_service
RUN mkdir -p /app/uploaded-images /app/fastapi_service/data

EXPOSE 8010

CMD ["uvicorn", "fastapi_service.main:app", "--host", "0.0.0.0", "--port", "8010"]
