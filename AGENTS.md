# Repository Guidelines

## Project Structure & Module Organization

`llm_api_proxy_recorder/` contains the Python application. Keep HTTP forwarding in `proxy/`, persistence and parsing in `recording/`, management endpoints in `admin/`, terminal support in `terminal/`, and browser assets in `web/static/`. Tests live in `tests/` and mirror these responsibilities through files such as `test_router.py` and `test_store.py`.

The desktop shell is split across `src-tauri/` (Rust/Tauri), `desktop/` (startup page), `packaging/` (PyInstaller spec), and `scripts/` (platform build helpers). Generated data belongs in `.runtime/`; build outputs under `build/`, `dist/`, and `src-tauri/target/` must remain untracked.

## Build, Test, and Development Commands

- `python3.12 -m venv .venv && .venv/bin/pip install -e ".[dev]"` installs the Python app and test dependencies.
- `.venv/bin/python -m llm_api_proxy_recorder --config .runtime/config.json` starts the local proxy and admin UI.
- `.venv/bin/python -m pytest tests/ -q` runs the full test suite.
- `npm ci` installs the pinned Tauri CLI dependencies.
- `npm run desktop:build` builds the macOS sidecar, `.app`, and `.dmg`.
- `npm run desktop:build:windows` builds the Windows sidecar and NSIS installer on Windows.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` verifies Rust formatting.

## Coding Style & Naming Conventions

Use four spaces in Python and follow PEP 8: `snake_case` functions/modules, `PascalCase` classes, and explicit type hints for public APIs. Keep JavaScript dependency-free and consistent with existing two-space indentation and `camelCase` names. Format Rust with `cargo fmt`; prefer small functions with explicit error propagation. Preserve the proxy's byte-transparent forwarding behavior and keep parsing or disk writes off the response hot path.

## Testing Guidelines

Pytest and `pytest-asyncio` are configured in `pyproject.toml`. Name files `test_*.py`, classes `Test...`, and functions `test_*`. Add regression coverage for routing, SSE streaming, redaction, persistence, and platform-specific terminal behavior. Run all tests before pushing; `main` also builds the Windows installer in GitHub Actions.

## Commit & Pull Request Guidelines

History uses short imperative summaries in Chinese or English, sometimes Conventional Commit style (`feat(terminal): ...`). Prefer `type(scope): summary` when practical and keep each commit focused. Pull requests should explain behavior changes, list verification commands, link relevant issues, and include screenshots for Web UI changes. Call out platform-specific packaging effects.

## Security & Configuration Tips

Never commit `.runtime/`, API keys, call recordings, generated sidecars, or local demo captures. Use masked example credentials and verify header-redaction tests when touching proxy or recording code.
