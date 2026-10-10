# Clef decision-model sidecar.
#
# CUDA 11.8 base on purpose: the DGX serving host is on driver 525, which supports the CUDA 12.0
# runtime at most, and the cu118 torch build runs on it. transformers 5.10.2 (the only release
# with Qwen3_5ForConditionalGeneration, Clef's backbone) needs torch >= 2.7 for the
# float8_e8m0fnu dtype, so torch 2.5.x-cu121 will NOT load the model. The combination below —
# torch 2.7.1+cu118, torchvision 0.22.1+cu118, transformers 5.10.2 — is the one verified on the
# box loading Cloudflare/clef-flash and answering /v1/systemone (19 GB VRAM on one A100).
#
# Do not "upgrade" to a cu124/cu128 base without first upgrading the host GPU driver, or the
# container will not see the GPU. torchvision is required even for text-only use: AutoProcessor
# pulls in the Qwen3VL video processor at load time.
FROM nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04

ENV PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive \
    HF_HOME=/hf \
    SERVED_MODEL_NAME=clef-flash \
    MODEL_PATH=/model \
    MAX_LENGTH=16384

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/python3 /usr/local/bin/python

# torch/torchvision from the cu118 index, pinned to the verified versions.
RUN pip install --index-url https://download.pytorch.org/whl/cu118 \
      torch==2.7.1+cu118 torchvision==0.22.1+cu118

COPY requirements.txt /tmp/requirements.txt
RUN printf 'torch==2.7.1+cu118\ntorchvision==0.22.1+cu118\n' > /constraints.txt \
 && pip install -c /constraints.txt -r /tmp/requirements.txt

COPY server.py /app/server.py
WORKDIR /app
EXPOSE 8000

# The model snapshot (weights + joint_schema_model.py) is mounted at /model read-only by
# serve-clef.sh; server.py imports joint_schema_model from there (trust_remote_code).
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
