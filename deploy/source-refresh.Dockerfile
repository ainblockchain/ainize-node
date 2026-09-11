ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN rm -rf /opt/ainize/ainize-core/src /opt/ainize/ainize-core/dist /opt/ainize/ainize-node/src /opt/ainize/ainize-node/dist /opt/ainize/ainize-cli/src /opt/ainize/ainize-cli/dist
COPY core/src /opt/ainize/ainize-core/src
COPY core/package.json core/tsconfig*.json /opt/ainize/ainize-core/
COPY node/src /opt/ainize/ainize-node/src
COPY node/package.json node/tsconfig*.json /opt/ainize/ainize-node/
COPY node/trainer /opt/ainize/ainize-node/trainer
COPY cli/src /opt/ainize/ainize-cli/src
COPY cli/package.json cli/tsconfig*.json /opt/ainize/ainize-cli/
RUN cd /opt/ainize/ainize-core && npm run build && cd /opt/ainize/ainize-node && npm run build && cd /opt/ainize/ainize-cli && npm run build
WORKDIR /opt/ainize/ainize-node
ENTRYPOINT ["node"]
CMD ["/opt/ainize/ainize-node/dist/bin.js"]
