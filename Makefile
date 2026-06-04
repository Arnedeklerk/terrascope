# Terranova — developer Makefile
# Targets: install, lint, type, test, ui-dev, ui-build, deploy, package, clean

PLUGIN_NAME := terranova
SRC := src/$(PLUGIN_NAME)
PROFILE ?= default
# Major version of the QGIS profile directory.  QGIS 3.x uses "QGIS3";
# QGIS 4.x uses "QGIS4".  Override with QGIS_MAJOR=3 if you're still on LTR.
QGIS_MAJOR ?= 4
# Resolve QGIS plugins dir per OS (override the whole thing with PROFILE_DIR=...)
ifeq ($(OS),Windows_NT)
    PROFILE_DIR := $(APPDATA)/QGIS/QGIS$(QGIS_MAJOR)/profiles/$(PROFILE)/python/plugins
else
    UNAME := $(shell uname -s)
    ifeq ($(UNAME),Darwin)
        PROFILE_DIR := $(HOME)/Library/Application Support/QGIS/QGIS$(QGIS_MAJOR)/profiles/$(PROFILE)/python/plugins
    else
        PROFILE_DIR := $(HOME)/.local/share/QGIS/QGIS$(QGIS_MAJOR)/profiles/$(PROFILE)/python/plugins
    endif
endif

.PHONY: install lint type test ui-dev ui-build deploy undeploy package clean

install:
	uv sync --all-extras --dev

lint:
	ruff check .
	ruff format --check .

type:
	mypy $(SRC)

test:
	pytest -m "not gpu" tests/

ui-dev:
	cd $(SRC)/ui_web && npm install && npm run dev

ui-build:
	cd $(SRC)/ui_web && npm install && npm run build

deploy: ui-build
	@echo "Deploying to $(PROFILE_DIR)"
	@mkdir -p "$(PROFILE_DIR)"
	@rm -rf "$(PROFILE_DIR)/$(PLUGIN_NAME)"
	@cp -r $(SRC) "$(PROFILE_DIR)/$(PLUGIN_NAME)"
	@cp metadata.txt "$(PROFILE_DIR)/$(PLUGIN_NAME)/metadata.txt"

undeploy:
	@rm -rf "$(PROFILE_DIR)/$(PLUGIN_NAME)"

package: ui-build
	@mkdir -p dist
	@rm -rf dist/$(PLUGIN_NAME)
	@cp -r $(SRC) dist/$(PLUGIN_NAME)
	@cp metadata.txt dist/$(PLUGIN_NAME)/metadata.txt
	# Strip dev/build-only cruft — QGIS only loads the .py files, the
	# built ui_web/dist bundle, and resources at runtime.  Without this
	# the zip would carry node_modules (hundreds of MB) + the TS source.
	@rm -rf dist/$(PLUGIN_NAME)/ui_web/node_modules
	@rm -rf dist/$(PLUGIN_NAME)/ui_web/src
	@rm -f  dist/$(PLUGIN_NAME)/ui_web/package.json \
	        dist/$(PLUGIN_NAME)/ui_web/package-lock.json \
	        dist/$(PLUGIN_NAME)/ui_web/tsconfig.json \
	        dist/$(PLUGIN_NAME)/ui_web/vite.config.ts \
	        dist/$(PLUGIN_NAME)/ui_web/tailwind.config.ts \
	        dist/$(PLUGIN_NAME)/ui_web/postcss.config.js \
	        dist/$(PLUGIN_NAME)/ui_web/.eslintrc.json \
	        dist/$(PLUGIN_NAME)/ui_web/index.html \
	        dist/$(PLUGIN_NAME)/ui_web/vite-env.d.ts \
	        dist/$(PLUGIN_NAME)/ui_web/serve.bat \
	        dist/$(PLUGIN_NAME)/ui_web/serve.ps1 \
	        dist/$(PLUGIN_NAME)/ui_web/README.md \
	        dist/$(PLUGIN_NAME)/ui_web/tsconfig.tsbuildinfo
	@find dist/$(PLUGIN_NAME) -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	@find dist/$(PLUGIN_NAME) -type f -name '*.pyc' -delete 2>/dev/null || true
	@cd dist && rm -f $(PLUGIN_NAME)-*.zip && zip -rq $(PLUGIN_NAME)-$$(grep '^version=' ../metadata.txt | cut -d= -f2).zip $(PLUGIN_NAME)
	@echo "Packaged dist/$(PLUGIN_NAME)-$$(grep '^version=' metadata.txt | cut -d= -f2).zip"

clean:
	rm -rf build dist *.egg-info .pytest_cache .mypy_cache .ruff_cache
	rm -rf $(SRC)/ui_web/dist $(SRC)/ui_web/node_modules
	find . -type d -name __pycache__ -exec rm -rf {} +
