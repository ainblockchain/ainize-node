# Runner image for `POST /api/run` with language "python" (src/run-sandbox.ts builds and tags it).
# Standard library, `requests`, and the `ainize` SDK from this repo's sdk/python (staged into the build
# context by run-sandbox.ts; the image tag hashes it, so an SDK change rebuilds). The script runs as uid 1000
# with a read-only rootfs, so anything it needs beyond this has to travel in the request's `files`.
FROM python:3.11-slim
COPY sdk/python /opt/ainize-sdk
RUN pip install --no-cache-dir --root-user-action=ignore requests==2.32.* /opt/ainize-sdk \
 && rm -rf /opt/ainize-sdk \
 && useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin runner
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/work
USER runner
WORKDIR /work
