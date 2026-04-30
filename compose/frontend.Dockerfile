FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache make

COPY frontend/package*.json ./

RUN npm install

COPY frontend/ .

EXPOSE 5173

CMD ["tail", "-f", "/dev/null"]
