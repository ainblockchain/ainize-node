FROM ain-cert-hf-datasets:repro-20260911
RUN /opt/runtime/bin/pip install --no-cache-dir --report /opt/runtime/lm-eval-install.json lm_eval==0.4.13 && /opt/runtime/bin/pip freeze > /opt/runtime/lm-eval-requirements.txt
ENV HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1 HF_HOME=/tmp/huggingface PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["/opt/runtime/bin/python"]
