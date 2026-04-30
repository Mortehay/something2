.PHONY: start dev

start:
	npm start

dev:
	npm run dev

migrate-up:
	DATABASE_URL=$(DATABASE_URL) npm run migrate:up -- --dir migrations
