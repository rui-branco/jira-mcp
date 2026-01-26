#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

// Load Jira config
const jiraConfigPath = path.join(process.env.HOME, ".config/jira-mcp/config.json");
const jiraConfig = JSON.parse(fs.readFileSync(jiraConfigPath, "utf8"));
const auth = Buffer.from(`${jiraConfig.email}:${jiraConfig.token}`).toString("base64");

// Load Figma config (optional)
let figmaConfig = null;
const figmaConfigPath = path.join(process.env.HOME, ".config/figma-mcp/config.json");
try {
  if (fs.existsSync(figmaConfigPath)) {
    figmaConfig = JSON.parse(fs.readFileSync(figmaConfigPath, "utf8"));
  }
} catch (e) {
  // Figma not configured, that's ok
}

// Directories
const attachmentDir = path.join(process.env.HOME, ".config/jira-mcp/attachments");
const figmaExportsDir = path.join(process.env.HOME, ".config/figma-mcp/exports");

if (!fs.existsSync(attachmentDir)) {
  fs.mkdirSync(attachmentDir, { recursive: true });
}

// ============ JIRA FUNCTIONS ============

async function fetchJira(endpoint) {
  const response = await fetch(`${jiraConfig.baseUrl}/rest/api/3${endpoint}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Jira API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function downloadAttachment(url, filename, issueKey) {
  const issueDir = path.join(attachmentDir, issueKey);
  if (!fs.existsSync(issueDir)) {
    fs.mkdirSync(issueDir, { recursive: true });
  }

  const localPath = path.join(issueDir, filename);

  if (fs.existsSync(localPath)) {
    return localPath;
  }

  const response = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${filename}: ${response.status}`);
  }

  const buffer = await response.buffer();
  fs.writeFileSync(localPath, buffer);

  return localPath;
}

function extractText(content, urls = []) {
  if (!content) return { text: "", urls };
  if (typeof content === "string") return { text: content, urls };

  let text = "";
  if (content.content) {
    for (const node of content.content) {
      if (node.type === "text") {
        text += node.text || "";
        // Check for link marks
        if (node.marks) {
          for (const mark of node.marks) {
            if (mark.type === "link" && mark.attrs?.href) {
              urls.push(mark.attrs.href);
            }
          }
        }
      } else if (node.type === "paragraph") {
        const result = extractText(node, urls);
        text += result.text + "\n";
        urls = result.urls;
      } else if (node.type === "hardBreak") {
        text += "\n";
      } else if (node.type === "mention") {
        text += `@${node.attrs?.text || "user"}`;
      } else if (node.type === "mediaGroup" || node.type === "mediaSingle") {
        text += "[image attachment]\n";
      } else if (node.type === "inlineCard" || node.type === "blockCard" || node.type === "embedCard") {
        // Smart links / embeds - extract URL
        const url = node.attrs?.url;
        if (url) {
          text += url + "\n";
          urls.push(url);
        }
      } else if (node.content) {
        const result = extractText(node, urls);
        text += result.text;
        urls = result.urls;
      }
    }
  }
  return { text, urls };
}

// Wrapper for backward compatibility
function extractTextSimple(content) {
  const result = extractText(content, []);
  return result.text;
}

// ============ FIGMA FUNCTIONS ============

function findFigmaUrls(text) {
  if (!text) return [];
  // Match Figma URLs
  const regex = /https:\/\/(?:www\.)?figma\.com\/(?:file|design|proto)\/([a-zA-Z0-9]+)\/[^\s)>\]"']*/g;
  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match[0]);
  }
  return [...new Set(matches)]; // dedupe
}

function parseFigmaUrl(url) {
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split("/");

  let fileKey = null;
  for (let i = 0; i < pathParts.length; i++) {
    if (pathParts[i] === "file" || pathParts[i] === "design" || pathParts[i] === "proto") {
      fileKey = pathParts[i + 1];
      break;
    }
  }

  if (!fileKey) return null;

  // Get node ID and convert from hyphen to colon format
  const rawNodeId = urlObj.searchParams.get("node-id");
  const nodeId = rawNodeId ? rawNodeId.replace(/-/g, ":") : null;

  return { fileKey, nodeId };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function figmaFetchWithRetry(url, options = {}, { maxRetries = 3, maxWaitSec = 30 } = {}) {
  let attempts = 0;

  while (true) {
    const response = await fetch(url, {
      ...options,
      headers: { ...options.headers, "X-Figma-Token": figmaConfig.token },
    });

    if (response.ok) {
      return response;
    }

    if (response.status === 429) {
      const retryAfterSec = Number(response.headers.get("retry-after")) || 60;

      // Don't retry if wait is too long (monthly limit) or too many attempts
      if (retryAfterSec > maxWaitSec || attempts++ >= maxRetries) {
        const waitTime = retryAfterSec > 3600
          ? `${Math.round(retryAfterSec / 3600)} hours (monthly limit reached)`
          : `${retryAfterSec} seconds`;
        return { rateLimited: true, retryAfter: waitTime };
      }

      await sleep(retryAfterSec * 1000);
      continue;
    }

    return response;
  }
}

async function fetchFigmaDesign(url) {
  if (!figmaConfig) {
    return { error: "Figma not configured. Run: node ~/.config/figma-mcp/setup.js" };
  }

  const parsed = parseFigmaUrl(url);
  if (!parsed) {
    return { error: "Invalid Figma URL" };
  }

  const { fileKey, nodeId } = parsed;

  try {
    // Get file info
    const fileRes = await figmaFetchWithRetry(`https://api.figma.com/v1/files/${fileKey}?depth=1`);

    if (fileRes.rateLimited) {
      return { error: `Figma API rate limit exceeded. Try again in ${fileRes.retryAfter} seconds.` };
    }
    if (!fileRes.ok) {
      if (fileRes.status === 403) {
        return { error: "Figma access denied. Check your token or file permissions." };
      } else if (fileRes.status === 404) {
        return { error: "Figma file not found. Check the URL." };
      }
      return { error: `Figma API error: ${fileRes.status}` };
    }
    const fileData = await fileRes.json();

    let result = {
      name: fileData.name,
      lastModified: fileData.lastModified,
      url: url,
      nodeId: nodeId,
      nodeName: null,
      images: [], // Changed to array for multiple images
    };

    if (!fs.existsSync(figmaExportsDir)) {
      fs.mkdirSync(figmaExportsDir, { recursive: true });
    }

    // If specific node, get its info and export images
    if (nodeId) {
      // Get node info with depth=2 to see children
      const nodeRes = await figmaFetchWithRetry(
        `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=2`
      );

      if (nodeRes.ok) {
        const nodeData = await nodeRes.json();
        const node = nodeData.nodes && nodeData.nodes[nodeId];

        if (node && node.document) {
          const doc = node.document;
          result.nodeName = doc.name;

          // Check if it's a large frame with children
          const bb = doc.absoluteBoundingBox;
          const isLarge = bb && (bb.width > 1500 || bb.height > 2000);
          const exportableChildren = [];

          if (doc.children) {
            for (const child of doc.children) {
              const isExportable = ["FRAME", "COMPONENT", "GROUP", "SECTION"].includes(child.type);
              const cbb = child.absoluteBoundingBox;
              const hasSize = cbb && cbb.width >= 100 && cbb.height >= 100;
              if (isExportable && hasSize) {
                exportableChildren.push({ id: child.id, name: child.name });
              }
            }
          }

          // Export children if large frame, otherwise export whole frame
          if (isLarge && exportableChildren.length > 0) {
            const childIds = exportableChildren.slice(0, 8).map(c => c.id);
            const idsParam = childIds.join(",");

            const imgRes = await figmaFetchWithRetry(
              `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(idsParam)}&format=png&scale=2`
            );

            if (imgRes.ok) {
              const imgData = await imgRes.json();
              for (const childId of childIds) {
                const imageUrl = imgData.images && imgData.images[childId];
                if (imageUrl) {
                  try {
                    const downloadRes = await fetch(imageUrl);
                    if (downloadRes.ok) {
                      const buffer = await downloadRes.buffer();
                      const childInfo = exportableChildren.find(c => c.id === childId);
                      const sanitizedId = childId.replace(/[^a-zA-Z0-9-]/g, "_");
                      const filename = `${fileKey}_${sanitizedId}.png`;
                      const imagePath = path.join(figmaExportsDir, filename);
                      fs.writeFileSync(imagePath, buffer);
                      result.images.push({
                        buffer,
                        path: imagePath,
                        name: childInfo?.name || childId
                      });
                    }
                  } catch (e) { /* skip */ }
                }
              }
            }
          } else {
            // Export whole frame
            const imgRes = await figmaFetchWithRetry(
              `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=2`
            );

            if (imgRes.ok) {
              const imgData = await imgRes.json();
              const imageUrl = imgData.images && imgData.images[nodeId];
              if (imageUrl) {
                const downloadRes = await fetch(imageUrl);
                if (downloadRes.ok) {
                  const buffer = await downloadRes.buffer();
                  const sanitizedId = nodeId.replace(/[^a-zA-Z0-9-]/g, "_");
                  const filename = `${fileKey}_${sanitizedId}.png`;
                  const imagePath = path.join(figmaExportsDir, filename);
                  fs.writeFileSync(imagePath, buffer);
                  result.images.push({ buffer, path: imagePath, name: doc.name });
                }
              }
            }
          }
        }
      }
    }

    return result;
  } catch (e) {
    return { error: `Figma fetch failed: ${e.message}` };
  }
}

// ============ MAIN TICKET FUNCTION ============

async function getTicket(issueKey, downloadImages = true, fetchFigma = true) {
  const issue = await fetchJira(`/issue/${issueKey}?expand=renderedFields`);
  const fields = issue.fields;

  let output = `# ${issueKey}: ${fields.summary}\n\n`;
  output += `**Status:** ${fields.status?.name || "Unknown"}\n`;
  output += `**Type:** ${fields.issuetype?.name || "Unknown"}\n`;
  output += `**Priority:** ${fields.priority?.name || "None"}\n`;
  output += `**Assignee:** ${fields.assignee?.displayName || "Unassigned"}\n`;
  output += `**Reporter:** ${fields.reporter?.displayName || "Unknown"}\n`;

  if (fields.sprint) {
    output += `**Sprint:** ${fields.sprint.name}\n`;
  }

  if (fields.parent) {
    output += `**Parent:** ${fields.parent.key} - ${fields.parent.fields?.summary || ""}\n`;
  }

  // Subtasks
  if (fields.subtasks?.length > 0) {
    output += `**Subtasks:** ${fields.subtasks.length}\n`;
  }

  // Extract description text and embedded URLs
  const descResult = extractText(fields.description, []);
  output += `\n## Description\n\n`;
  output += descResult.text || "_No description_";
  output += "\n";

  // Collect all URLs found in the ticket
  let allUrls = [...descResult.urls];
  let allText = descResult.text;

  // Get comments
  if (fields.comment?.comments?.length > 0) {
    output += `\n## Comments (${fields.comment.comments.length})\n\n`;
    for (const comment of fields.comment.comments) {
      const author = comment.author?.displayName || "Unknown";
      const created = new Date(comment.created).toLocaleString();
      const commentResult = extractText(comment.body, []);
      output += `### ${author} - ${created}\n`;
      output += commentResult.text + "\n\n";
      allText += " " + commentResult.text;
      allUrls = allUrls.concat(commentResult.urls);
    }
  }

  // Get attachments
  const downloadedImages = [];
  if (fields.attachment?.length > 0) {
    output += `\n## Attachments (${fields.attachment.length})\n\n`;
    for (const att of fields.attachment) {
      const isImage = att.mimeType?.startsWith("image/");
      output += `- **${att.filename}** (${att.mimeType}, ${Math.round(att.size / 1024)}KB)\n`;

      if (downloadImages && isImage) {
        try {
          const localPath = await downloadAttachment(att.content, att.filename, issueKey);
          output += `  Local: ${localPath}\n`;
          downloadedImages.push(localPath);
        } catch (e) {
          output += `  Download failed: ${e.message}\n`;
        }
      } else {
        output += `  URL: ${att.content}\n`;
      }
    }
  }

  // Subtasks - fetch full details
  if (fields.subtasks?.length > 0) {
    output += `\n## Subtasks (${fields.subtasks.length})\n\n`;

    for (const subtask of fields.subtasks) {
      output += `### ${subtask.key}: ${subtask.fields?.summary || ""}\n`;
      output += `Status: ${subtask.fields?.status?.name || "Unknown"} | `;
      output += `Type: ${subtask.fields?.issuetype?.name || "Subtask"}\n`;

      try {
        const subtaskDetails = await fetchJira(`/issue/${subtask.key}`);
        const sf = subtaskDetails.fields;

        if (sf.assignee) {
          output += `Assignee: ${sf.assignee.displayName}\n`;
        }

        const subtaskDesc = extractText(sf.description, []);
        if (subtaskDesc.text && subtaskDesc.text.trim()) {
          const desc = subtaskDesc.text.length > 300
            ? subtaskDesc.text.substring(0, 300) + "..."
            : subtaskDesc.text;
          output += `\n${desc}\n`;
        }
        output += "\n";
      } catch (e) {
        output += "\n";
      }
    }
  }

  // Linked issues - fetch full details
  if (fields.issuelinks?.length > 0) {
    output += `\n## Linked Issues (${fields.issuelinks.length})\n\n`;

    // Collect linked issue keys
    const linkedIssues = [];
    for (const link of fields.issuelinks) {
      if (link.outwardIssue) {
        linkedIssues.push({
          key: link.outwardIssue.key,
          relation: link.type.outward,
          summary: link.outwardIssue.fields?.summary || ""
        });
      }
      if (link.inwardIssue) {
        linkedIssues.push({
          key: link.inwardIssue.key,
          relation: link.type.inward,
          summary: link.inwardIssue.fields?.summary || ""
        });
      }
    }

    // Fetch full details for each linked issue (max 5 to avoid too many API calls)
    const maxLinkedToFetch = 5;
    for (let i = 0; i < Math.min(linkedIssues.length, maxLinkedToFetch); i++) {
      const linked = linkedIssues[i];
      output += `### ${linked.relation}: ${linked.key}\n`;
      output += `**${linked.summary}**\n\n`;

      try {
        const linkedIssue = await fetchJira(`/issue/${linked.key}`);
        const lf = linkedIssue.fields;

        output += `Status: ${lf.status?.name || "Unknown"} | `;
        output += `Type: ${lf.issuetype?.name || "Unknown"} | `;
        output += `Priority: ${lf.priority?.name || "None"}\n`;
        output += `Assignee: ${lf.assignee?.displayName || "Unassigned"}\n\n`;

        // Get description
        const linkedDesc = extractText(lf.description, []);
        if (linkedDesc.text && linkedDesc.text.trim()) {
          // Truncate long descriptions
          const desc = linkedDesc.text.length > 500
            ? linkedDesc.text.substring(0, 500) + "...\n_(truncated)_"
            : linkedDesc.text;
          output += `${desc}\n`;
        }
        output += "\n";
      } catch (e) {
        output += `_Could not fetch details: ${e.message}_\n\n`;
      }
    }

    if (linkedIssues.length > maxLinkedToFetch) {
      output += `\n_...and ${linkedIssues.length - maxLinkedToFetch} more linked issues_\n`;
    }
  }

  // Find and fetch Figma designs
  const figmaDesigns = [];
  if (fetchFigma && figmaConfig) {
    // Combine URLs from regex search AND embedded links
    const textUrls = findFigmaUrls(allText);
    const embeddedFigmaUrls = allUrls.filter(u => u && u.includes("figma.com"));
    const allFigmaUrls = [...new Set([...textUrls, ...embeddedFigmaUrls])]; // dedupe

    if (allFigmaUrls.length > 0) {
      output += `\n## Figma Designs (${allFigmaUrls.length})\n\n`;

      for (const url of allFigmaUrls) {
        const design = await fetchFigmaDesign(url);
        if (design && design.error) {
          output += `- ${url}\n`;
          output += `  **Error:** ${design.error}\n\n`;
        } else if (design && design.name) {
          output += `### ${design.name}${design.nodeName ? ` - ${design.nodeName}` : ""}\n`;
          output += `- URL: ${url}\n`;
          output += `- Last Modified: ${design.lastModified}\n`;
          if (design.images && design.images.length > 0) {
            output += `- Exported ${design.images.length} image(s):\n`;
            for (const img of design.images) {
              output += `  - ${img.name}: ${img.path}\n`;
            }
            figmaDesigns.push(design);
          }
          output += "\n";
        } else {
          output += `- ${url} (could not fetch)\n\n`;
        }
      }
    }
  }

  return { text: output, jiraImages: downloadedImages, figmaDesigns };
}

async function searchTickets(jql, maxResults = 10) {
  const data = await fetchJira(`/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}`);

  let output = `# Search Results (${data.total} total, showing ${data.issues.length})\n\n`;

  for (const issue of data.issues) {
    const f = issue.fields;
    output += `- **${issue.key}**: ${f.summary}\n`;
    output += `  Status: ${f.status?.name} | Assignee: ${f.assignee?.displayName || "Unassigned"}\n\n`;
  }

  return output;
}

// ============ MCP SERVER ============

const server = new Server(
  { name: "jira-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "jira_get_ticket",
        description: "Fetch a Jira ticket by its key (e.g., MODS-12115). Returns full details including description, comments, attachments, and linked Figma designs.",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: {
              type: "string",
              description: "The Jira issue key (e.g., MODS-12115)",
            },
            downloadImages: {
              type: "boolean",
              description: "Download image attachments (default: true)",
            },
            fetchFigma: {
              type: "boolean",
              description: "Fetch linked Figma designs and export images (default: true)",
            },
          },
          required: ["issueKey"],
        },
      },
      {
        name: "jira_search",
        description: "Search Jira tickets using JQL. Examples: 'project = MODS AND status = Open'",
        inputSchema: {
          type: "object",
          properties: {
            jql: { type: "string", description: "JQL query string" },
            maxResults: { type: "number", description: "Max results (default 10)" },
          },
          required: ["jql"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "jira_get_ticket") {
      const downloadImages = args.downloadImages !== false;
      const fetchFigma = args.fetchFigma !== false;
      const result = await getTicket(args.issueKey, downloadImages, fetchFigma);

      const content = [{ type: "text", text: result.text }];

      // Add Jira images
      for (const imagePath of result.jiraImages) {
        try {
          const imageData = fs.readFileSync(imagePath);
          const ext = path.extname(imagePath).toLowerCase();
          const mimeType = ext === ".png" ? "image/png" :
                          ext === ".gif" ? "image/gif" :
                          ext === ".webp" ? "image/webp" : "image/jpeg";
          content.push({
            type: "image",
            data: imageData.toString("base64"),
            mimeType: mimeType,
          });
        } catch (e) { /* skip */ }
      }

      // Add Figma images (now supports multiple images per design)
      for (const design of result.figmaDesigns) {
        if (design.images && design.images.length > 0) {
          for (const img of design.images) {
            if (img.buffer) {
              content.push({
                type: "image",
                data: img.buffer.toString("base64"),
                mimeType: "image/png",
              });
            }
          }
        }
      }

      return { content };
    } else if (name === "jira_search") {
      const result = await searchTickets(args.jql, args.maxResults || 10);
      return { content: [{ type: "text", text: result }] };
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
