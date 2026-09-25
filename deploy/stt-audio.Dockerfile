# vLLM's published image ships without the audio extra, so `/v1/audio/transcriptions` answers every upload with
# "Invalid or unsupported audio file" — a 400 that names the file rather than the missing decoder, which is why
# this is worth a Dockerfile and a comment instead of a line in a runbook.
ARG BASE=vllm/vllm-openai:latest
FROM ${BASE}
RUN pip install --no-cache-dir librosa soundfile
