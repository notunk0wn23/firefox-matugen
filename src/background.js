async function applyTheme(themeColors) {
    const themeUpdate = {
        colors: {
            frame: themeColors.background || "#FFFFFF", // Default to white if not specified
            toolbar: themeColors.primary || "#6200EE", // Default to Material purple
            textcolor: themeColors.on_primary || "#FFFFFF", // Default to white text on primary
            accentcolor: themeColors.secondary || "#03DAC6", // Default to teal for accent

            popup: themeColors.surface || "#FFFFFF", // Default surface color
            toolbar_text: themeColors.on_background || "#000000", // Text on background
            tab_background_text: themeColors.on_surface || "#000000", // Text on surface
        }
    };

    // Update theme
    await browser.theme.update(themeUpdate);
}

async function loadThemeFromFile() {
  const file = await browser.storage.sync.get('themeFile');
  const filePath = `${file.themeFile}`; 
  console.log(filePath)

  try {
    const response = await fetch(filePath);
    if (!response.ok) throw new Error("Network response was not ok");

    const themeColors = await response.json();
    applyTheme(themeColors);
  } catch (error) {
    console.error("Failed to load theme from file:", error);
  }
}

// initial load
loadThemeFromFile();

// this is terrible // setInterval(loadThemeFromFile, 5000);
// debugging
//
async function getURL() {
    return await browser.storage.sync.get('themeFile');
}
document.url = browser.storage.sync.get('themeFile');

