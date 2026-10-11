# Build stage: full dependencies, bundles the React config app into dist/ui.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build:ui

# Runtime stage: production dependencies, the TypeScript sources Node runs directly, and the built UI.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY --from=build /app/dist/ui ./dist/ui
USER node
EXPOSE 3100
CMD ["node", "src/index.ts"]
