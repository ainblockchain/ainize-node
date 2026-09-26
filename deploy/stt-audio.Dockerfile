# vLLM's published image ships without the audio extra, so `/v1/audio/transcriptions` answers every upload with
# "Invalid or unsupported audio file" — a 400 that names the file rather than the missing decoder, which is why
# this is worth a Dockerfile and a comment instead of a line in a runbook.
ARG BASE=vllm/vllm-openai:latest
FROM ${BASE}
#
# `av` (PyAV) is the second half: vLLM reads WAV through soundfile and hands everything else — WebM and Ogg from a
# browser recorder, M4A from a phone, MP3 — to PyAV. Without it those fail with the same "unsupported audio file".
RUN pip install --no-cache-dir librosa soundfile av
