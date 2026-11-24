FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache git
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY index.js ./
# index.js is stored base64-encoded in the repo (push error); decode at build
RUN base64 -d index.js > /tmp/index.js && mv /tmp/index.js index.js && node --check index.js
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "index.js"]
