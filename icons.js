// serverInfo.icons for the MCP handshake: the logo in Jira's own blue, sent
// twice, a deeper shade for light backgrounds and a brighter one for dark ones.
// assets/icon.svg is the Jira logo from Simple Icons v13.21.0
// (https://simpleicons.org), CC0-1.0.
const fs = require("fs");
const path = require("path");

const SVG = fs.readFileSync(path.join(__dirname, "assets", "icon.svg"), "utf8").trim();

function icon(fill, theme) {
  const svg = SVG.replace('fill="#000000"', `fill="${fill}"`);
  return {
    src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    mimeType: "image/svg+xml",
    sizes: ["any"],
    theme,
  };
}

const ICONS = [icon("#0052CC", "light"), icon("#2684FF", "dark")];

module.exports = { ICONS };
