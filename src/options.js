const DEFAULTS = {
  port: 8000,
  scheme: "auto",
};

const form = document.getElementById("settings");
const portInput = document.getElementById("port");
const schemeSelect = document.getElementById("scheme");
const statusEl = document.getElementById("status");
const testButton = document.getElementById("test");

let statusTimer = null;

function setStatus(message, state) {
  clearTimeout(statusTimer);
  statusEl.textContent = message;
  if (state) {
    statusEl.dataset.state = state;
  } else {
    delete statusEl.dataset.state;
  }
  if (message) {
    statusTimer = setTimeout(() => setStatus(""), 6000);
  }
}

async function load() {
  const stored = await browser.storage.sync.get(Object.keys(DEFAULTS));
  portInput.value = stored.port ?? DEFAULTS.port;
  schemeSelect.value = ["auto", "light", "dark"].includes(stored.scheme)
    ? stored.scheme
    : DEFAULTS.scheme;
}

function readPort() {
  const port = Number.parseInt(portInput.value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const port = readPort();
  if (port === null) {
    setStatus("Enter a port between 1 and 65535.", "error");
    portInput.focus();
    return;
  }

  await browser.storage.sync.set({ port, scheme: schemeSelect.value });
  setStatus("Saved. Theme reapplied.", "ok");
});

testButton.addEventListener("click", async () => {
  const port = readPort();
  if (port === null) {
    setStatus("Enter a port between 1 and 65535.", "error");
    portInput.focus();
    return;
  }

  // Save first so the background script tests the port you are looking at.
  await browser.storage.sync.set({ port, scheme: schemeSelect.value });
  setStatus("Testing...");

  const result = await browser.runtime.sendMessage({ type: "test-connection" });
  if (result?.ok) {
    setStatus(`Connected to localhost:${port} and applied the theme.`, "ok");
  } else {
    setStatus(result?.error ?? "Could not reach the server.", "error");
  }
});

load();
