# dawpm-registry

The plugin data behind a `dawpm` registry deployment.

Each plugin is a single yaml file at `src/plugins/<ns>/<name>/index.yaml`. A GitHub Actions workflow validates them, compiles them into a static JSON index under `dist/v1/`, publishes that to GitHub Pages, and pings a Vercel deploy hook so the frontend picks up the changes.

## Add a plugin

1. Create `src/plugins/<ns>/<name>/index.yaml`. See [`src/plugins/dsk/overture/index.yaml`](src/plugins/dsk/overture/index.yaml) for the canonical example.
2. Run `pnpm validate` to check it locally.
3. Open a PR.

The `slug` in the yaml must match the path: `dsk/overture` belongs at `src/plugins/dsk/overture/index.yaml`.

## Schema

```yaml
slug: namespace/name          # required, matches the path
name: Display Name            # required
description: One sentence.    # required
author: Vendor                # required
license: freeware             # required
homepage: https://...         # optional
image: https://...png         # optional
tags: [synth, free]           # optional
download:
  url: https://...zip         # required
  sha256: 64-hex              # required
  size: 12345                 # required, bytes
install:                      # required, at least one rule
  - format: vst               # vst | vst3 | fst
    include: ['**/*.dll']
    exclude: []
    strip: 1                  # strip N leading path components, default 0
```

## Scripts

```sh
pnpm install
pnpm validate     # zod-validate every yaml
pnpm build        # write dist/v1/plugins.json
pnpm scrape:dsk   # rescrape every free DSK Music VST. See scripts/scrape-dsk.ts
```

## License

The build scripts and yaml templates are MIT. Each plugin's `index.yaml` describes data owned by its respective publisher.
