NODE ?= node

.PHONY: install test run

install:
	@echo "No dependencies. Node 20+ runs the tests."

test:
	$(NODE) --test

run:
	python3 -m http.server 8000
