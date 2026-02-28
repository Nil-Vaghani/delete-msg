const { join } = require("path");

/**
 * Puppeteer configuration
 * Sets cache directory inside the project so Chrome persists on Render
 */
module.exports = {
  cacheDirectory: join(__dirname, ".cache", "puppeteer"),
};
