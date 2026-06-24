# MCP-сервер Yandex OCR (Streamable HTTP). Нативный TypeScript — без шага сборки.
FROM node:24-slim

WORKDIR /app

# Сначала зависимости (кэш слоёв): только прод (sdk, express, zod).
COPY package.json ./
RUN npm install --omit=dev

# Исходники (нативный TS исполняется напрямую Node 24).
COPY src ./src

ENV PORT=3000
EXPOSE 3000

# Секреты передаются через окружение (--env-file/-e), НЕ в образ:
#   YANDEX_OCR_API_KEY=…  MCP_BEARER_TOKEN=…
CMD ["node", "src/http.ts"]
