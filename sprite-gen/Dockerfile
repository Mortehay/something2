FROM python:3.11-slim

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY sprite-gen/requirements.txt sprite-gen/requirements-dev.txt ./
# CPU-only torch wheels by default; swap the index for CUDA when a GPU lands.
# torch and torchvision MUST come from the same index and be ABI-matched
# (torch 2.3.x <-> torchvision 0.18.x) — otherwise controlnet-aux/rembg pull a
# mismatched torchvision from PyPI and every SD backend dies on import with
# "operator torchvision::nms does not exist".
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
        torch==2.3.* torchvision==0.18.* \
    && pip install --no-cache-dir -r requirements.txt

COPY sprite-gen/ .

# Bake rembg's u2net matting model (~176MB) into the image. Left out, rembg
# downloads it inside the FIRST generation job — turning that job into a
# multi-minute network wait, and failing outright on an offline host.
RUN python -c "import rembg; rembg.new_session('u2net')"

EXPOSE 8100
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
