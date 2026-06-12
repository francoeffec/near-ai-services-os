const { google } = require("googleapis");

const DOCS_READ_SCOPES = [
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/drive.readonly"
];

function parseServiceAccount(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (_error) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
}

function cleanGoogleDocInput(value) {
  return String(value || "")
    .trim()
    .replace(/^<|>$/g, "")
    .split("|")[0];
}

function extractGoogleDocId(value) {
  const input = cleanGoogleDocInput(value);
  if (!input) return "";
  const urlMatch = input.match(/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)/i);
  if (urlMatch) return urlMatch[1];
  const driveMatch = input.match(/[?&]id=([A-Za-z0-9_-]+)/i);
  if (driveMatch) return driveMatch[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(input)) return input;
  return "";
}

function createGoogleAuth({ serviceAccountJson, scopes = DOCS_READ_SCOPES }) {
  const credentials = parseServiceAccount(serviceAccountJson);
  if (!credentials) {
    throw new Error("Google Docs reads require GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON_B64.");
  }
  return new google.auth.GoogleAuth({ credentials, scopes });
}

function paragraphText(paragraph = {}) {
  return (paragraph.elements || [])
    .map((element) => element.textRun?.content || "")
    .join("")
    .replace(/\u000b/g, "\n")
    .trimEnd();
}

function contentToLines(content = [], lines = []) {
  for (const item of content) {
    if (item.paragraph) {
      const text = paragraphText(item.paragraph).trim();
      if (text) lines.push(text);
      continue;
    }
    if (item.table) {
      for (const row of item.table.tableRows || []) {
        const cells = (row.tableCells || []).map((cell) => contentToLines(cell.content || [], []).join(" ").trim());
        const rowText = cells.filter(Boolean).join(" | ");
        if (rowText) lines.push(rowText);
      }
      continue;
    }
    if (item.tableOfContents) {
      contentToLines(item.tableOfContents.content || [], lines);
    }
  }
  return lines;
}

function collectTabs(tabs = [], collected = []) {
  for (const tab of tabs) {
    const tabId = tab.tabProperties?.tabId || "";
    const title = tab.tabProperties?.title || "";
    const lines = contentToLines(tab.documentTab?.body?.content || []);
    collected.push({
      tabId,
      title,
      text: lines.join("\n"),
      paragraphs: lines
    });
    collectTabs(tab.childTabs || [], collected);
  }
  return collected;
}

function flattenGoogleDoc(document = {}) {
  const tabs = collectTabs(document.tabs || []).filter((tab) => tab.text || tab.title);
  if (tabs.length > 0) {
    const paragraphs = tabs.flatMap((tab) => {
      if (!tab.title) return tab.paragraphs;
      return [tab.title, ...tab.paragraphs];
    });
    return {
      title: document.title || "",
      text: paragraphs.join("\n"),
      paragraphs,
      tabs
    };
  }

  const paragraphs = contentToLines(document.body?.content || []);
  return {
    title: document.title || "",
    text: paragraphs.join("\n"),
    paragraphs,
    tabs: []
  };
}

function truncateText(text, maxChars) {
  const limit = Math.max(0, Math.min(Number(maxChars || 100000), 200000));
  const value = String(text || "");
  return {
    text: value.slice(0, limit),
    truncated: value.length > limit,
    totalChars: value.length
  };
}

function truncateParagraphs(paragraphs = [], maxChars) {
  const limit = Math.max(0, Math.min(Number(maxChars || 100000), 200000));
  const result = [];
  let used = 0;
  for (const paragraph of paragraphs) {
    const value = String(paragraph || "");
    if (used + value.length > limit) break;
    result.push(value);
    used += value.length + 1;
  }
  return result;
}

function truncateTabs(tabs = [], maxChars) {
  return tabs.map((tab) => {
    const truncated = truncateText(tab.text || "", maxChars);
    return {
      ...tab,
      text: truncated.text,
      paragraphs: truncateParagraphs(tab.paragraphs || [], maxChars),
      truncated: truncated.truncated,
      totalChars: truncated.totalChars
    };
  });
}

function searchKeywords(value) {
  return Array.from(new Set(String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !["the", "and", "for", "with", "review"].includes(word))))
    .slice(0, 6);
}

function escapeDriveQueryValue(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function buildDocumentSearchQuery(query) {
  const keywords = searchKeywords(query);
  if (keywords.length === 0) return "";
  const conditions = keywords
    .map((word) => {
      const escaped = escapeDriveQueryValue(word);
      return `(name contains '${escaped}' or fullText contains '${escaped}')`;
    })
    .join(" and ");
  return `mimeType = 'application/vnd.google-apps.document' and trashed = false and ${conditions}`;
}

async function searchGoogleDocs({ drive, query, top = 5 }) {
  const q = buildDocumentSearchQuery(query);
  if (!q) return [];
  const response = await drive.files.list({
    q,
    pageSize: top,
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,webViewLink,modifiedTime)"
  });
  return response.data.files || [];
}

function googleApiErrorMessage(error) {
  const status = error.response?.status || error.code || "";
  const reason = error.errors?.[0]?.reason || error.response?.data?.error || "";
  const message = error.errors?.[0]?.message || error.response?.data?.error_description || error.message;
  return [status && `HTTP ${status}`, reason, message].filter(Boolean).join(": ");
}

async function getDocumentById({ docs, documentId }) {
  const response = await docs.documents.get({
    documentId,
    includeTabsContent: true
  });
  return response.data;
}

async function fetchGoogleDocContent(config, input = {}) {
  const documentUrl = input.documentUrl || input.document_url || input.url || "";
  const query = input.query || input.title || "";
  const explicitId = input.documentId || input.document_id || extractGoogleDocId(documentUrl);
  const auth = createGoogleAuth({
    serviceAccountJson: config.serviceAccountJson
  });
  const docs = google.docs({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });

  let documentId = explicitId;
  let searchResults = [];
  let firstError = null;

  if (documentId) {
    try {
      const document = await getDocumentById({ docs, documentId });
      const flattened = flattenGoogleDoc(document);
      const maxChars = input.maxChars || input.max_chars;
      const truncated = truncateText(flattened.text, maxChars);
      return {
        documentId,
        documentUrl: `https://docs.google.com/document/d/${documentId}`,
        title: flattened.title,
        text: truncated.text,
        paragraphs: truncateParagraphs(flattened.paragraphs, maxChars),
        tabs: truncateTabs(flattened.tabs, maxChars),
        truncated: truncated.truncated,
        totalChars: truncated.totalChars,
        searchResults
      };
    } catch (error) {
      firstError = error;
      if (!query) throw new Error(`Google Doc read failed for ${documentId}: ${googleApiErrorMessage(error)}`);
    }
  }

  if (query) {
    searchResults = await searchGoogleDocs({ drive, query, top: input.top || 5 });
    if (searchResults.length > 0) {
      documentId = searchResults[0].id;
      const document = await getDocumentById({ docs, documentId });
      const flattened = flattenGoogleDoc(document);
      const maxChars = input.maxChars || input.max_chars;
      const truncated = truncateText(flattened.text, maxChars);
      return {
        documentId,
        documentUrl: searchResults[0].webViewLink || `https://docs.google.com/document/d/${documentId}`,
        title: flattened.title || searchResults[0].name,
        text: truncated.text,
        paragraphs: truncateParagraphs(flattened.paragraphs, maxChars),
        tabs: truncateTabs(flattened.tabs, maxChars),
        truncated: truncated.truncated,
        totalChars: truncated.totalChars,
        searchResults
      };
    }
  }

  if (firstError) {
    throw new Error(`Google Doc read failed for ${explicitId}: ${googleApiErrorMessage(firstError)}. Fallback search found no accessible document.`);
  }
  throw new Error("Provide a Google Doc URL, document ID, or search query/title.");
}

module.exports = {
  DOCS_READ_SCOPES,
  buildDocumentSearchQuery,
  extractGoogleDocId,
  fetchGoogleDocContent,
  flattenGoogleDoc,
  searchKeywords
};
