async function applyTheme(tcolors) {
    const themeUpdate = {
        colors: {
            // Frame
            frame: tcolors.background,
            frame_text: tcolors.on_background,

            // Tabs
            tab_background: tcolors.surface,
            tab_background_text: tcolors.on_surface,
            tab_active_background: tcolors.primary_container,
            tab_active_background_text: tcolors.primary,

            // Toolbar
            toolbar: tcolors.surface,
            toolbar_text: tcolors.on_surface,
            toolbar_field: tcolors.primary_container,
            toolbar_field_text: tcolors.primary,
            toolbar_field_active: tcolors.primary,
            toolbar_field_text_active: tcolors.on_primary,

            // Popups
            popup: tcolors.surface,
            popup_text: tcolors.on_surface,
            
            // Menu
            menu_background: tcolors.primary_container,
            menu_text: tcolors.primary,

            // Buttons
            button_background: tcolors.primary,
            button_text: tcolors.on_primary,

            //
        }
    };

    // Update theme
    await browser.theme.update(themeUpdate);
}

async function loadThemeFromFile() {
  const file = await browser.storage.sync.get('port');
  const filePath = `http://localhost:${file.port}/colors.json`; 
 // console.log(filePath)

  try {
    const response = await fetch(filePath);
    if (!response.ok) throw new Error("Network response was not ok");

    const themeColors = await response.json();
    applyTheme(themeColors);
  } catch (error) {
    console.error("Failed to load theme from file:", error);
  }
}
// Function to connect to the SSE server
async function connectToSSE() {
  const { port } = await browser.storage.local.get('port');
  const sseUrl = `http://localhost:${port}/updates`;

  const eventSource = new EventSource(sseUrl);

  eventSource.onmessage = (event) => {
    if (event.data === 'update') {
      console.log('Theme update received from server');
      loadThemeFromFile();
    }
  };

  eventSource.onerror = (err) => {
    console.error('SSE connection error:', err);
  };
}

// initial load
connectToSSE();
loadThemeFromFile();

async function getURL() {
    return await browser.storage.sync.get('themeFile');
}
document.url = browser.storage.sync.get('themeFile');

