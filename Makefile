BASE_URL ?= http://localhost:5001
ADMIN_TOKEN ?=
AUTH_TOKEN ?=

.PHONY: smoke spike seed check

smoke:
	BASE_URL=$(BASE_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) AUTH_TOKEN=$(AUTH_TOKEN) npm run perf:smoke

spike:
	BASE_URL=$(BASE_URL) ADMIN_TOKEN=$(ADMIN_TOKEN) AUTH_TOKEN=$(AUTH_TOKEN) npm run perf:spike

seed:
	npm run seed:ussd-pool

check:
	npm run check:deadcode && npm run test:e2e

