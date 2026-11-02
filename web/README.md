# MOSAIC Atlas web interface

A Next.js interface for the MOSAIC API, built with TypeScript and Tailwind.

```bash
pnpm install
NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 pnpm dev
pnpm test
```

`scripts/screenshots.mjs` captures the screenshots in `docs/screenshots` against live servers. Screens read every number from the API and show an empty state until data exist.
