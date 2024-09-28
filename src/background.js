function applyTheme(themeColors) {
  browser.theme.update({
    colors: {
      frame: themeColors.frame,
      toolbar: themeColors.toolbar,
      textcolor: themeColors.textcolor
    }
  });
}

async function loadThemeFromFile() {
  // Update this path to point to your local JSON file
  const filePath = "file:///path/to/your/theme.json"; 

  try {
    const response = await fetch(filePath);
    if (!response.ok) throw new Error("Network response was not ok");

    const themeColors = await response.json();
    applyTheme(themeColors);
  } catch (error) {
    console.error("Failed to load theme from file:", error);
  }
}

// Load theme initially
loadThemeFromFile();

// Set an interval to check for updates (every 5 seconds for example)
setInterval(loadThemeFromFile, 5000);
