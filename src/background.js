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
  const file = await browser.storage.sync.get('themeFile');
  const filePath = `file:///${file}`; 

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
