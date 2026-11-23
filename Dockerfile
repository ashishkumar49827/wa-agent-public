FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache git
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY index.js ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "index.js"]
