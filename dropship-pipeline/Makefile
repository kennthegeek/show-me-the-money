PY ?= .venv/bin/python

.PHONY: install test lint demo check status run
install:
	python3 -m venv .venv && $(PY) -m pip install -q -e ".[dev]"
test:
	$(PY) -m pytest -q
lint:
	$(PY) -m ruff check dropship tests
check:
	$(PY) -m dropship check
status:
	$(PY) -m dropship status
run:
	$(PY) -m dropship run
# Full offline walkthrough against the mock supplier/storefront (no keys, no network).
demo:
	DRY_RUN=false ENABLE_SUPPLIER_PAYMENTS=true SUPPLIER=mock STOREFRONT=mock \
	DATABASE_URL=sqlite:///data/demo.db LOG_FILE= EMAIL_MODE=none \
	$(PY) -m dropship --env-file /dev/null import -k "pet hair" -k "desk lamp"
	DRY_RUN=false ENABLE_SUPPLIER_PAYMENTS=true SUPPLIER=mock STOREFRONT=mock \
	DATABASE_URL=sqlite:///data/demo.db LOG_FILE= EMAIL_MODE=none \
	$(PY) -m dropship --env-file /dev/null ingest-order examples/order.json
	DATABASE_URL=sqlite:///data/demo.db LOG_FILE= $(PY) -m dropship --env-file /dev/null status
