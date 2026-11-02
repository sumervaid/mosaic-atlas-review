# Contributing

## Setup

```bash
./scripts/install.sh
.venv/bin/python -m pytest -q -m "not slow"
cd web && pnpm test
```

## Standards

- Every number on a screen originates in a real or recorded session. Screens show an empty state until data exist.
- Every experiment is reproducible from a YAML config and seeds, and each record stores the git commit.
- Changes to the engine keep control branches identical token by token. `tests/test_m2.py` checks this property.
- Departures from the design brief go in [docs/decisions.md](docs/decisions.md) with the reason.
- Pull requests include tests and pass continuous integration before merging.

## Credentials

Keys and tokens stay out of the repository. See [SECURITY.md](SECURITY.md).
