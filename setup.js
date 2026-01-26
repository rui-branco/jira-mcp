#!/usr/bin/env node

const readline = require("readline");
const fs = require("fs");
const path = require("path");

const configDir = path.join(process.env.HOME, ".config/jira-mcp");
const configPath = path.join(configDir, "config.json");

// Check for command line arguments
let args = process.argv.slice(2);
// Skip "setup" arg if called via index.js
if (args[0] === "setup") args = args.slice(1);

if (args.length >= 3) {
  // Non-interactive mode: node setup.js <email> <token> <baseUrl>
  const [email, token, baseUrl] = args;

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  fs.writeFileSync(
    configPath,
    JSON.stringify({ email, token, baseUrl: baseUrl.replace(/\/$/, "") }, null, 2)
  );
  console.log(`Config saved to ${configPath}`);
  process.exit(0);
}

// Interactive mode
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function setup() {
  console.log("\n=== Jira MCP Setup ===\n");
  console.log("To get your Jira API token:");
  console.log("1. Go to https://id.atlassian.com/manage-profile/security/api-tokens");
  console.log("2. Click 'Create API token'");
  console.log("3. Copy the token\n");

  const email = await ask("Jira email: ");
  const token = await ask("Jira API token: ");
  const baseUrl = await ask("Jira base URL (e.g., https://company.atlassian.net): ");

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  fs.writeFileSync(
    configPath,
    JSON.stringify({ email, token, baseUrl: baseUrl.replace(/\/$/, "") }, null, 2)
  );
  console.log(`\nConfig saved to ${configPath}`);

  // Check for Figma MCP
  const figmaConfigPath = path.join(process.env.HOME, ".config/figma-mcp/config.json");
  if (fs.existsSync(figmaConfigPath)) {
    console.log("\n[OK] Figma MCP detected - Figma links in tickets will be fetched automatically");
  } else {
    console.log("\n[INFO] Figma MCP not installed - Figma links won't be fetched");
    console.log("To enable Figma integration, install figma-mcp");
  }

  console.log("\n=== Setup Complete ===");
  console.log("\nIf you haven't already, add to Claude Code with:\n");
  console.log("  claude mcp add --transport stdio jira -- npx -y @rui.branco/jira-mcp");
  console.log("\nThen restart Claude Code and run /mcp to verify.");

  rl.close();
}

setup().catch((e) => {
  console.error("Setup failed:", e.message);
  rl.close();
  process.exit(1);
});
