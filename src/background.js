/**
 * Matugen Firefox - background script
 *
 * Pulls colors from the local helper server and applies them as a Firefox
 * theme, then keeps listening on an SSE stream so a fresh `matugen` run
 * repaints the browser without a restart.
 */

const DEFAULTS = {
  port: 8000,
  scheme: "auto", // "auto" follows the OS, or force "light" / "dark"
};

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// Firefox MV3 background scripts are event pages: they can be suspended when
// idle, which quietly kills the SSE stream. An alarm wakes us back up and
// re-syncs, so the worst case is a short delay instead of a dead extension.
const KEEPALIVE_ALARM = "matugen-keepalive";
const KEEPALIVE_PERIOD_MINUTES = 1;

let eventSource = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;

/** Read settings, filling in defaults for anything unset. */
async function getSettings() {
  const stored = await browser.storage.sync.get(Object.keys(DEFAULTS));
  const port = Number.parseInt(stored.port, 10);
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULTS.port,
    scheme: ["auto", "light", "dark"].includes(stored.scheme)
      ? stored.scheme
      : DEFAULTS.scheme,
  };
}

function baseUrl(port) {
  return `http://localhost:${port}`;
}

function prefersDark() {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/**
 * matugen can hand us colors in a few shapes. Normalize them all to a flat
 * `{ primary: "#rrggbb", ... }` map.
 *
 *   1. flat, from a custom template:      { "primary": "#..." }
 *   2. `matugen --json hex` output:       { "colors": { "light": {...}, "dark": {...} } }
 *   3. scheme-keyed without the wrapper:  { "light": {...}, "dark": {...} }
 *   4. per-color scheme objects:          { "primary": { "light": "#...", "dark": "#..." } }
 */
function flattenColors(raw, scheme) {
  if (!raw || typeof raw !== "object") {
    throw new Error("colors file is not a JSON object");
  }

  const wanted = scheme === "auto" ? (prefersDark() ? "dark" : "light") : scheme;
  const other = wanted === "dark" ? "light" : "dark";

  const source = raw.colors && typeof raw.colors === "object" ? raw.colors : raw;

  // Shapes 2 and 3: the top level is keyed by scheme.
  const byScheme = source[wanted] ?? source[other] ?? source.default;
  if (byScheme && typeof byScheme === "object") {
    return pickStrings(byScheme, wanted, other);
  }

  // Shapes 1 and 4.
  return pickStrings(source, wanted, other);
}

function pickStrings(obj, wanted, other) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (value && typeof value === "object") {
      const candidate = value[wanted] ?? value.default ?? value[other];
      if (typeof candidate === "string") {
        out[key] = candidate;
      } else if (candidate && typeof candidate === "object") {
        // e.g. { primary: { default: { hex: "#..." } } }
        const hex = candidate.hex ?? candidate.hex_stripped;
        if (typeof hex === "string") out[key] = hex;
      }
    }
  }
  return out;
}

/** Build a theme, skipping any color matugen did not give us. */
function buildTheme(c) {
  // Prefer the Material You role, fall back to something sensible.
  const pick = (...names) => {
    for (const name of names) {
      const value = c[name];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };

  const background = pick("background", "surface");
  const onBackground = pick("on_background", "on_surface");
  const surface = pick("surface", "surface_container", "background");
  const onSurface = pick("on_surface", "on_background");
  const primary = pick("primary");
  const onPrimary = pick("on_primary");
  const primaryContainer = pick("primary_container", "surface_variant", "surface");
  const onPrimaryContainer = pick("on_primary_container", "primary");
  const outline = pick("outline", "outline_variant", "surface_variant");

  const colors = {
    // Window frame
    frame: background,
    frame_inactive: background,
    frame_text: onBackground,

    // Tab strip
    tab_background: surface,
    tab_background_text: onSurface,
    tab_selected: primaryContainer,
    tab_text: onPrimaryContainer,
    tab_line: primary,
    tab_loading: primary,
    tab_background_separator: outline,

    // Toolbar
    toolbar: surface,
    toolbar_text: onSurface,
    toolbar_top_separator: outline,
    toolbar_bottom_separator: outline,
    toolbar_vertical_separator: outline,

    // Address bar
    toolbar_field: primaryContainer,
    toolbar_field_text: onPrimaryContainer,
    toolbar_field_border: outline,
    toolbar_field_focus: primaryContainer,
    toolbar_field_text_focus: onPrimaryContainer,
    toolbar_field_border_focus: primary,
    toolbar_field_highlight: primary,
    toolbar_field_highlight_text: onPrimary,

    // Icons
    icons: onSurface,
    icons_attention: primary,

    // Popups and menus
    popup: surface,
    popup_text: onSurface,
    popup_border: outline,
    popup_highlight: primaryContainer,
    popup_highlight_text: onPrimaryContainer,

    // Sidebar
    sidebar: surface,
    sidebar_text: onSurface,
    sidebar_border: outline,
    sidebar_highlight: primaryContainer,
    sidebar_highlight_text: onPrimaryContainer,

    // New tab page
    ntp_background: background,
    ntp_text: onBackground,

    // Bookmarks / findbar
    bookmark_text: onSurface,
    button_background_hover: primaryContainer,
    button_background_active: primary,
  };

  // browser.theme.update rejects undefined values, so drop the gaps.
  for (const key of Object.keys(colors)) {
    if (colors[key] === undefined) delete colors[key];
  }

  if (colors.frame === undefined || colors.tab_background_text === undefined) {
    throw new Error(
      "colors file is missing `background`/`on_background` (or `surface`/`on_surface`)"
    );
  }

  return { colors };
}

async function applyTheme() {
  const { port, scheme } = await getSettings();
  const url = `${baseUrl(port)}/colors.json`;

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`server returned ${response.status} for ${url}`);
  }

  const theme = buildTheme(flattenColors(await response.json(), scheme));
  await browser.theme.update(theme);
  return theme;
}

async function applyThemeSafely() {
  try {
    await applyTheme();
  } catch (error) {
    console.error("Matugen Firefox: could not apply theme -", error.message);
  }
}

/** (Re)connect the SSE stream, backing off when the server is down. */
async function connect() {
  clearTimeout(reconnectTimer);
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  const { port } = await getSettings();
  const source = new EventSource(`${baseUrl(port)}/updates`);
  eventSource = source;

  source.onopen = () => {
    reconnectDelay = RECONNECT_MIN_MS;
  };

  source.onmessage = (event) => {
    if (event.data === "update") applyThemeSafely();
  };

  source.onerror = () => {
    // EventSource retries on its own, but only while the page lives and only on
    // a fixed interval. Own the lifecycle so a stopped server does not spin.
    source.close();
    if (eventSource === source) eventSource = null;
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  };
}

// Re-read settings when the options page saves.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.port || changes.scheme) {
    reconnectDelay = RECONNECT_MIN_MS;
    connect();
    applyThemeSafely();
  }
});

// Follow the OS light/dark switch while `scheme` is "auto".
if (typeof matchMedia === "function") {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", async () => {
    const { scheme } = await getSettings();
    if (scheme === "auto") applyThemeSafely();
  });
}

// Let the options page trigger a check without duplicating the fetch logic.
browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "test-connection") {
    return applyTheme().then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error: error.message })
    );
  }
  return undefined;
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (eventSource) return; // Stream is live; it will tell us about changes.
  // Stream died while we were suspended, or the server was down. Reconnect and
  // resync, since any change during the gap was missed.
  reconnectDelay = RECONNECT_MIN_MS;
  connect();
  applyThemeSafely();
});

function start() {
  browser.alarms.create(KEEPALIVE_ALARM, {
    periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
  });
  connect();
  applyThemeSafely();
}

browser.runtime.onStartup.addListener(start);
browser.runtime.onInstalled.addListener(start);

start();
