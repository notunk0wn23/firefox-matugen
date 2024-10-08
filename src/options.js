document.addEventListener('DOMContentLoaded', () => {
    const directoryInput = document.getElementById('directory');

    browser.storage.sync.get('themeFile').then(result => {
        if (result.port) {
            directoryInput.value = result.port;
        }
    });

    document.getElementById('save').addEventListener('click', () => {
        const directory = directoryInput.value;
        browser.storage.sync.set({ port: directory }).then(() => {
            alert('File saved, if you havent already, regenerate your matugen themes real quick.');
        });
    });
});
