# Stage 1: build the React frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: build the Express backend
FROM node:20-alpine AS backend-build
WORKDIR /app
COPY server/package*.json ./
RUN npm ci
COPY server/ .
COPY --from=frontend-build /app/dist ./public
RUN npm run build

# Stage 3: production node_modules only
FROM node:20-alpine AS backend-deps
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev

# Stage 4: runtime image
FROM node:20-alpine
WORKDIR /app
COPY --from=backend-build /app/dist ./dist
COPY --from=backend-build /app/public ./public
COPY --from=backend-deps /app/node_modules ./node_modules
COPY --from=backend-build /app/package.json ./
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
