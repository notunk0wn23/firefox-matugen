# firefox-matugen

Theme Firefox from a [matugen](https://github.com/InioX/matugen) palette, and
repaint the browser the moment that palette changes — no restart, no reload.

A tiny local server watches your matugen-generated colors file; the extension
subscribes to it over Server-Sent Events and calls `browser.theme.update()` when
it changes. Change your wallpaper, rerun matugen, and Firefox follows along with
the rest of your desktop.

```
matugen ──writes──> colors.json ──watched by──> server/main.py ──SSE──> extension ──> browser.theme
```

## Requirements

- Firefox 115 or newer
- Python 3.9 or newer (standard library only)
- matugen

## Setup

### 1. Generate a colors file

Add a template to your matugen config so matugen writes a flat JSON palette.
Copies of both templates in this repo live in [`templates/`](templates).

```toml
# ~/.config/matugen/config.toml
[templates.firefox]
input_path = '~/.config/matugen/templates/firefox-colors.json'
output_path = '~/.config/matugen/firefox/colors.json'
```

Use [`templates/colors.json`](templates/colors.json) for a single scheme, or
[`templates/colors-light-dark.json`](templates/colors-light-dark.json) to emit
both `light` and `dark` so the extension can follow your system setting.

Then run matugen once so the file exists:

```sh
matugen image ~/wallpaper.png
```

### 2. Start the server

```sh
python3 server/main.py ~/.config/matugen/firefox/colors.json
```

It binds loopback only and serves exactly three routes:

| Route          | Purpose                                     |
| -------------- | ------------------------------------------- |
| `/colors.json` | the current palette                         |
| `/updates`     | SSE stream, emits `update` on every change  |
| `/health`      | which file is being watched, and subscribers |

Useful flags: `--port`, `--daemon`, `--log-file`, `--pidfile`, `--host`,
`--allow-origin`. `--help` lists everything.

To keep it running, drop in a user service:

```ini
# ~/.config/systemd/user/firefox-matugen.service
[Unit]
Description=Serve matugen colors to Firefox

[Service]
ExecStart=/usr/bin/python3 %h/src/firefox-matugen/server/main.py %h/.config/matugen/firefox/colors.json
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now firefox-matugen
```

### 3. Load the extension

Unsigned extensions need Firefox Developer Edition, Nightly, or ESR with
`xpinstall.signatures.required` set to `false`. On release Firefox, load it
temporarily instead:

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on**, pick `src/manifest.json`
3. Open the add-on's preferences, set the port, and hit **Test connection**

A temporary add-on is dropped when Firefox restarts. For something permanent,
sign it with [`web-ext`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/):

```sh
npx web-ext sign --source-dir=src --api-key=*** --api-secret=...
```

## Options

- **Server port** — matches the `--port` you gave the server.
- **Color scheme** — `Follow system`, `Always light`, or `Always dark`. Only
  meaningful if your colors file has both variants; with a single-scheme file
  the extension uses whatever is there.

## Accepted colors-file shapes

The extension normalizes several layouts, so most existing matugen templates
work without edits:

```jsonc
{ "primary": "#d0bcff" }                              // flat
{ "colors": { "dark": { "primary": "#d0bcff" } } }    // matugen --json
{ "light": { ... }, "dark": { ... } }                 // scheme-keyed
{ "primary": { "light": "#6750a4", "dark": "#d0bcff" } }
{ "primary": { "default": { "hex": "#d0bcff" } } }
```

`background` and `on_background` (or `surface` / `on_surface`) are required;
everything else is optional and falls back to a related role. Recognized keys:
`background`, `on_background`, `surface`, `on_surface`, `surface_variant`,
`on_surface_variant`, `primary`, `on_primary`, `primary_container`,
`on_primary_container`, `outline`, `outline_variant`.

## Security notes

- The server binds `127.0.0.1` and serves only the colors file you name. It
  does not expose the directory around it.
- `Access-Control-Allow-Origin` defaults to `*`, so any page you visit could
  read your palette from `localhost`. That is only a color scheme, but if you'd
  rather it were locked down, pass your extension's origin:
  `--allow-origin moz-extension://<uuid>` (find the UUID under
  `about:debugging`, in the extension's internal UUID field).

## Tests

```sh
python3 server/test_main.py      # runs the real server, hits every route incl. SSE
node test/background.test.mjs    # color normalization + theme building
npx web-ext lint --source-dir=src
```

## Troubleshooting

Preferences → **Test connection** reports the actual failure. Beyond that:

- **`... does not exist yet - run matugen once`** — the path is wrong or matugen
  hasn't written the file. `curl localhost:8000/health` shows what's being watched.
- **Theme doesn't change on rerun** — confirm the stream is live:
  `curl -N localhost:8000/updates` should print `: connected`, then
  `data: update` when you rerun matugen.
- **Nothing at all** — check the background script's console under
  `about:debugging#/runtime/this-firefox` → **Inspect**.

## License

MIT
