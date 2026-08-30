#!/usr/bin/env node
/**
 * Unit tests for the color normalization in src/background.js.
 *
 * background.js is a plain background script, not a module, so we load it with
 * a stubbed `browser` global and read the functions out of the resulting scope.
 *
 *     node test/background.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "background.js"), "utf8");

/** Load background.js in a sandbox and hand back its top-level functions. */
function load({ dark = false } = {}) {
  const listeners = {};
  const sandbox = {
    console: { error() {}, log() {} },
    setTimeout,
    clearTimeout,
    fetch: async () => {
      throw new Error("no server in tests");
    },
    EventSource: class {
      constructor() {
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
      }
      close() {}
    },
    matchMedia: (query) => ({
      matches: dark && query.includes("dark"),
      addEventListener() {},
    }),
    browser: {
      storage: {
        sync: { get: async () => ({}) },
        onChanged: { addListener() {} },
      },
      theme: { update: async () => {} },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      runtime: {
        onMessage: { addListener() {} },
        onStartup: { addListener: (fn) => (listeners.startup = fn) },
        onInstalled: { addListener: (fn) => (listeners.installed = fn) },
      },
    },
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  return {
    flattenColors: vm.runInContext("flattenColors", context),
    buildTheme: vm.runInContext("buildTheme", context),
  };
}

const FLAT = {
  background: "#1c1b1f",
  on_background: "#e6e1e5",
  surface: "#2b2930",
  on_surface: "#e6e1e5",
  primary: "#d0bcff",
  on_primary: "#381e72",
  primary_container: "#4f378b",
  on_primary_container: "#eaddff",
  outline: "#938f99",
};

test("flattens a flat template", () => {
  const { flattenColors } = load();
  assert.equal(flattenColors(FLAT, "dark").primary, "#d0bcff");
});

test("picks the requested scheme from a scheme-keyed file", () => {
  const { flattenColors } = load();
  const raw = {
    light: { background: "#fffbfe", on_background: "#1c1b1f" },
    dark: { background: "#1c1b1f", on_background: "#e6e1e5" },
  };
  assert.equal(flattenColors(raw, "light").background, "#fffbfe");
  assert.equal(flattenColors(raw, "dark").background, "#1c1b1f");
});

test("unwraps the `colors` key from matugen --json output", () => {
  const { flattenColors } = load();
  const raw = { colors: { dark: { background: "#000000" } } };
  assert.equal(flattenColors(raw, "dark").background, "#000000");
});

test("handles per-color scheme objects", () => {
  const { flattenColors } = load();
  const raw = {
    primary: { light: "#6750a4", dark: "#d0bcff" },
    background: { default: "#1c1b1f" },
  };
  const out = flattenColors(raw, "dark");
  assert.equal(out.primary, "#d0bcff");
  assert.equal(out.background, "#1c1b1f");
});

test("handles nested { default: { hex } } objects", () => {
  const { flattenColors } = load();
  const raw = { primary: { default: { hex: "#d0bcff" } } };
  assert.equal(flattenColors(raw, "dark").primary, "#d0bcff");
});

test("`auto` follows the OS preference", () => {
  const raw = {
    light: { background: "#fffbfe" },
    dark: { background: "#1c1b1f" },
  };
  assert.equal(load({ dark: true }).flattenColors(raw, "auto").background, "#1c1b1f");
  assert.equal(load({ dark: false }).flattenColors(raw, "auto").background, "#fffbfe");
});

test("falls back to the other scheme when only one exists", () => {
  const { flattenColors } = load();
  const raw = { light: { background: "#fffbfe", on_background: "#1c1b1f" } };
  assert.equal(flattenColors(raw, "dark").background, "#fffbfe");
});

test("rejects non-object input", () => {
  const { flattenColors } = load();
  assert.throws(() => flattenColors(null, "dark"), /not a JSON object/);
  assert.throws(() => flattenColors("#fff", "dark"), /not a JSON object/);
});

test("builds a theme with no undefined values", () => {
  const { buildTheme } = load();
  const { colors } = buildTheme(FLAT);
  for (const [key, value] of Object.entries(colors)) {
    assert.equal(typeof value, "string", `${key} should be a string`);
  }
  assert.equal(colors.frame, FLAT.background);
  assert.equal(colors.toolbar_field_highlight, FLAT.primary);
});

test("falls back to surface when background is absent", () => {
  const { buildTheme } = load();
  const { colors } = buildTheme({ surface: "#2b2930", on_surface: "#e6e1e5" });
  assert.equal(colors.frame, "#2b2930");
});

test("throws a useful error on a palette with no usable colors", () => {
  const { buildTheme } = load();
  assert.throws(() => buildTheme({ primary: "#d0bcff" }), /missing/);
});

test("ignores blank color values", () => {
  const { buildTheme } = load();
  const { colors } = buildTheme({ ...FLAT, outline: "   " });
  assert.ok(!Object.values(colors).includes("   "));
});
