# Clef Teach trainer — the persistent container the node `docker exec`s into for a decision lesson.
#
# Same verified CUDA stack as the sidecar (torch 2.7.1+cu118 on the DGX's driver 525). The container
# stays alive (tail -f) so the node can `docker inspect` it as Running and exec the trainer per job:
#
#   docker exec -i -e CUDA_VISIBLE_DEVICES=<uuids> <name> python3 /work/train/clef_teach.py \
#       --job /work/.teach/<id>/job.json --devices cuda:0,...
#
# /work is the node's repo/data dir (holds train/clef_teach.py and the .teach/<id>/ job dirs), mounted by
# run-clef-trainer.sh. The model snapshot + HF cache are mounted too so the backbone loads without a download.
FROM nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04

ENV PIP_NO_CACHE_DIR=1 DEBIAN_FRONTEND=noninteractive HF_HOME=/hf

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip procps \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/python3 /usr/local/bin/python

RUN pip install --index-url https://download.pytorch.org/whl/cu118 \
      torch==2.7.1+cu118 torchvision==0.22.1+cu118
RUN printf 'torch==2.7.1+cu118\ntorchvision==0.22.1+cu118\n' > /constraints.txt \
 && pip install -c /constraints.txt \
      transformers==5.10.2 accelerate safetensors huggingface_hub pillow einops sentencepiece 'numpy<2'

# A copy for standalone use; run-clef-trainer.sh also bind-mounts the live train/ over it so edits apply
# to the next job without a rebuild (the resident PLE trainer works the same way).
COPY train /opt/clef-trainer/train
WORKDIR /work
CMD ["tail", "-f", "/dev/null"]
