# The image backend. vLLM cannot serve diffusion models, so this is the one serving process in the design that
# is not vLLM — kept as small as a thing that loads a 54 GB pipeline can be.
ARG BASE=vllm/vllm-openai:latest
FROM ${BASE}
RUN pip install --no-cache-dir diffusers accelerate fastapi uvicorn
COPY server.py /app/server.py
WORKDIR /app
ENTRYPOINT ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
