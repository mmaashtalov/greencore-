FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    STATE_FILE=/app/data/state.json \
    SIMULATION_STATE_FILE=/app/data/simulations.json

WORKDIR /app

COPY --chown=node:node package.json ./package.json
COPY --chown=node:node contracts ./contracts
COPY --chown=node:node rules ./rules
COPY --chown=node:node src ./src

RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
