FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache make

COPY backend/package*.json ./

RUN npm install

COPY backend/ .

EXPOSE 3101

CMD ["tail", "-f", "/dev/null"]
