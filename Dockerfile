FROM node:22-alpine AS build
WORKDIR /app
COPY server/package*.json server/
COPY web/package*.json web/
RUN npm --prefix server ci && npm --prefix web ci
COPY . .
RUN npm --prefix web run build && npm --prefix server run build

FROM node:22-alpine
WORKDIR /app/server
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data WEB_DIST=/app/web/dist
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/web/dist /app/web/dist
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/index.js"]
