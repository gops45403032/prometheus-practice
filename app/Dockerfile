# Pinned tag, not `latest` -- reproducible builds
FROM node:20.11-slim

WORKDIR /app
COPY package.json ./
COPY index.js ./

EXPOSE 80
CMD ["node", "index.js"]
