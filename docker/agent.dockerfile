FROM node:22-slim

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY docker/agent-stub/ /app/

RUN npm install

EXPOSE 3001

CMD ["node", "index.js"]
