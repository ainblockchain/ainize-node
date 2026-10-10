# Runner image for `POST /api/run` with language "python" (src/run-sandbox.ts builds and tags it).
# Standard library plus `requests`; nothing else. The script runs as uid 1000 with a read-only rootfs,
# so anything it needs beyond this has to travel in the request's `files`.
FROM python:3.11-slim
RUN pip install --no-cache-dir --root-user-action=ignore requests==2.32.* \
 && useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin runner
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/work
USER runner
WORKDIR /work
