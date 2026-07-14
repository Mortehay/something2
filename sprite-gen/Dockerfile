FROM python:3.11-slim

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY sprite-gen/requirements.txt sprite-gen/requirements-dev.txt ./
# CPU-only torch wheels by default; swap the index for CUDA when a GPU lands.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.3.* \
    && pip install --no-cache-dir -r requirements.txt

COPY sprite-gen/ .

EXPOSE 8100
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
