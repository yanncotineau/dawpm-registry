# dawpm-registry (data)

Source-of-truth plugin data for [dawpm](https://github.com/dawpm). Each plugin
is one yaml file at `src/plugins/<namespace>/<name>/index.yaml`. CI validates,
compiles to JSON, publishes to GitHub Pages, then pings the Vercel deploy hook
for the [dawpm/registry](https://github.com/dawpm/registry) frontend.

## Add a plugin

1. Create `src/plugins/<ns>/<name>/index.yaml`. See
   [`src/plugins/dsk/overture/index.yaml`](src/plugins/dsk/overture/index.yaml)
   for the canonical example.
2. Validate locally: `pnpm install && pnpm validate`.
3. Open a PR. Once merged, the workflow rebuilds and the frontend reflects it.

## Plugin schema

```yaml
slug: namespace/name          # required, matches the path
name: Display Name            # required
description: One sentence.    # required
author: Vendor                # required
license: freeware             # required (freeware, mit, proprietary, ...)
homepage: https://...         # optional
image: https://...png         # optional
tags: [synth, free]           # optional, default []
download:
  url: https://...zip         # required, .zip only for now
  sha256: 64-hex              # required
  size: 12345                 # required, bytes
install:                      # required, at least one rule
  - format: vst               # vst | vst3 | fst
    include: ['**/*.dll']     # required, micromatch globs
    exclude: []               # optional
    strip: 1                  # optional, default 0; strips N leading path components
```

## Compiled output

Pushed to `https://yanncotineau.github.io/dawpm-registry/`:

- `v1/plugins.json` — full index for search.
- `v1/plugins/<ns>/<name>.json` — single-plugin records.

The frontend at https://dawpm-registry.vercel.app reads from this.
