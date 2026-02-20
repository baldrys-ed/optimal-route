# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A **Symfony 8.0** proof-of-concept tool for pedestrian route safety analysis. It proxies 2GIS geospatial API calls (solving CORS and injecting API keys server-side), then uses OpenAI (text + vision) to score walking routes by safety and comfort.

## Common Commands

```bash
# Install dependencies
composer install

# Clear Symfony cache
php bin/console cache:clear

# CLI route test: build a route and get AI safety score
php bin/console app:test-route
php bin/console app:test-route --from="37.582591,55.775364" --to="37.656625,55.765036" --transport=walking

# CLI crossing test: detect traffic lights near coordinates
php bin/console app:test-crossing
php bin/console app:test-crossing --lon=37.583 --lat=55.775 --radius=80

# Inspect registered HTTP routes
php bin/console debug:router
```

No automated test suite or linter is configured.

## Architecture

### Request Flow

```
HTTP Client / Browser
    ↓
ProxyController   →  TwogisApiService  →  2GIS API (routing, catalog, geocode, suggest)
AnalyzeController →  OpenAiService     →  OpenAI chat completion (text scoring)
VisionController  →  OpenAiService     →  OpenAI vision API (image analysis)
```

### Controllers (`src/Controller/`)

| Controller | Purpose | Key Routes |
|---|---|---|
| `ProxyController` | Server-side proxy for 2GIS APIs | `POST /api/routing`, `GET /api/suggest`, `GET /api/geocode`, `GET /api/catalog`, `GET /api/crossing` |
| `AnalyzeController` | ChatGPT route safety scoring (text) | `POST /api/analyze` |
| `VisionController` | OpenAI Vision analysis of map screenshots | `POST /api/analyze-vision` |

### Services (`src/Service/`)

- **`TwogisApiService`** — wraps all 2GIS API calls: `buildRoute()`, `searchCatalog()`, `geocode()`, `suggest()`, `hasTrafficLight()`
- **`OpenAiService`** — wraps OpenAI: `chat()`, `scoreRoute()` (returns JSON score 1–10), `analyzeMapImage()` (Vision API)

### Commands (`src/Command/`)

- **`TestRouteCommand`** — builds a route via `TwogisApiService`, then calls `OpenAiService::scoreRoute()`
- **`TestCrossingCommand`** — calls `TwogisApiService::hasTrafficLight()` to check for traffic lights

### Frontend (`public/`)

Static HTML pages for manual testing:
- `index.html` — main UI
- `demo.html` — uses local `response_simple.json` mock data
- `test-crossing.html` / `test-rubrics.html` — feature-specific test pages

## Environment & Configuration

API keys and external endpoints are configured in `.env`:
- `TWOGIS_API_KEY` — 2GIS API key
- `OPENAI_API_KEY` — OpenAI key (routed through a reverse proxy at `31.220.107.17:5007`)
- Optional SOCKS5 proxy support in `TwogisApiService` (empty by default)

OpenAI model used: `gpt-4o-mini`. Coordinate format throughout is **`lon,lat`** (not `lat,lon`).

## Code Conventions

- PHP 8.4+, attribute-based routing (`#[Route(...)]`), full autowiring
- All HTTP endpoints return `JsonResponse`; errors include an `error` key
- Indentation: 4 spaces; line endings: LF; charset: UTF-8 (enforced by `.editorconfig`)
