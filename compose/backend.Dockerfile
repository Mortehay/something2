FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache make

COPY backend/package*.json ./

RUN npm install

COPY backend/ .

EXPOSE 3001

CMD ["tail", "-f", "/dev/null"]
