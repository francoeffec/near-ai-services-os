const { cleanText, firstNonEmpty } = require("../domain/normalize");

function transcriptToText(value) {
  if (!Array.isArray(value)) return value || "";
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const speaker = entry.speaker?.display_name || entry.speaker || "Speaker";
      return `${speaker}: ${entry.text || entry.content || ""}`;
    })
    .join("\n");
}

function firstRawNonEmpty(...values) {
  for (const value of values) {
    if (cleanText(value)) return String(value);
  }
  return "";
}

function decodeHtmlEntities(value) {
  return cleanText(value)
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function htmlTranscriptToText(html) {
  return decodeHtmlEntities(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean)
    .join("\n");
}

function normalizeCompany(value) {
  if (!value || typeof value !== "object") return cleanText(value);
  return firstNonEmpty(value.name, value.company, value.domain);
}

function normalizeCompanyDomain(value) {
  if (!value || typeof value !== "object") return "";
  return firstNonEmpty(value.domain, value.company_domain);
}

function extractSummaryText(...values) {
  for (const value of values) {
    if (!value) continue;
    if (typeof value === "string" && cleanText(value)) return value;
    if (Array.isArray(value)) {
      const lines = value
        .map((entry) => {
          if (typeof entry === "string") return entry;
          return firstNonEmpty(entry.text, entry.content, entry.title, entry.summary, entry.description);
        })
        .filter((entry) => cleanText(entry));
      if (lines.length) return lines.join("\n");
    }
    if (typeof value === "object") {
      const nested = extractSummaryText(
        value.text,
        value.content,
        value.summary,
        value.default_summary,
        value.description,
        value.body,
        value.markdown,
        value.markdown_formatted,
        value.items,
        value.action_items
      );
      if (nested) return nested;
    }
  }
  return "";
}

function parseFathomSharePage(html, sourceUrl = "") {
  const match = String(html || "").match(/<div[^>]+id=["']app["'][^>]+data-page="([^"]+)"/i);
  if (!match) return { url: sourceUrl };

  try {
    const dataPage = JSON.parse(decodeHtmlEntities(match[1]));
    const props = dataPage.props || {};
    const call = props.call || {};
    const company = call.company || {};
    return {
      sourceEventId: call.id ? `fathom:${call.id}` : "",
      recordingId: cleanText(call.id),
      url: firstNonEmpty(sourceUrl, dataPage.url),
      title: firstNonEmpty(call.title, call.topic, props.head?.title),
      company: normalizeCompany(company),
      companyDomain: normalizeCompanyDomain(company),
      callDate: firstNonEmpty(call.started_at, call.recording?.started_at),
      copyTranscriptUrl: props.copyTranscriptUrl || "",
      actionItemsUrl: props.clipboardActionItemsUrl || "",
      summaryText: extractSummaryText(
        props.summary,
        props.templatedNote,
        props.templated_note,
        props.callSummary,
        props.call_summary,
        call.summary,
        call.templatedNote,
        call.templated_note,
        call.note
      )
    };
  } catch (_error) {
    return { url: sourceUrl };
  }
}

function normalizeFathomPayload(payload) {
  const recording = payload.recording || payload.call || payload.meeting || payload;
  return {
    sourceEventId: firstNonEmpty(payload.event_id, payload.id, recording.id),
    recordingId: firstNonEmpty(recording.id, payload.recording_id),
    url: firstNonEmpty(recording.url, recording.share_url, payload.url, payload.fathom_url),
    title: firstNonEmpty(recording.title, payload.title),
    company: firstNonEmpty(normalizeCompany(payload.company), normalizeCompany(recording.company)),
    companyDomain: firstNonEmpty(payload.company_domain, payload.companyDomain, normalizeCompanyDomain(payload.company), normalizeCompanyDomain(recording.company)),
    email: firstNonEmpty(payload.email, recording.email),
    callDate: firstNonEmpty(payload.call_date, payload.callDate, recording.call_date, recording.started_at, recording.recording?.started_at),
    summaryText: extractSummaryText(
      payload.summary,
      payload.default_summary,
      payload.call_summary,
      payload.action_items,
      recording.summary,
      recording.default_summary,
      recording.action_items
    ),
    transcriptText: firstRawNonEmpty(
      transcriptToText(payload.transcript),
      payload.transcript_text,
      transcriptToText(recording.transcript),
      recording.transcript_text,
      payload.text
    )
  };
}

function recordingIdFrom(value) {
  const source = cleanText(value);
  if (!source) return "";
  const direct = source.match(/\b\d{6,}\b/);
  if (direct) return direct[0];
  try {
    const url = new URL(source);
    return (url.pathname.split("/").filter(Boolean).find((part) => /^\d{6,}$/.test(part)) || "");
  } catch (_error) {
    return "";
  }
}

async function fetchFathomApiTranscript(config, recordingIdOrUrl) {
  if (!config.fathom?.apiKey) return "";
  if (!recordingIdOrUrl) return "";

  const base = (config.fathom.baseUrl || "https://api.fathom.ai/external/v1").replace(/\/$/, "");
  const recordingId = recordingIdFrom(recordingIdOrUrl);
  if (!recordingId) return "";
  const candidates = [`${base}/recordings/${encodeURIComponent(recordingId)}/transcript`];

  for (const url of candidates) {
    const response = await fetch(url, {
      headers: {
        "X-Api-Key": config.fathom.apiKey,
        Accept: "application/json"
      }
    });
    if (!response.ok) continue;
    const data = await response.json();
    if (Array.isArray(data.transcript)) {
      return data.transcript
        .map((entry) => {
          const speaker = entry.speaker?.display_name || "Speaker";
          return `${speaker}: ${entry.text || ""}`;
        })
        .join("\n");
    }
    return firstNonEmpty(data.transcript, data.transcript_text, data.text, data.recording?.transcript);
  }

  return "";
}

async function fetchFathomApiSummary(config, recordingIdOrUrl) {
  if (!config.fathom?.apiKey) return "";
  const recordingId = recordingIdFrom(recordingIdOrUrl);
  if (!recordingId) return "";

  const base = (config.fathom.baseUrl || "https://api.fathom.ai/external/v1").replace(/\/$/, "");
  const response = await fetch(`${base}/recordings/${encodeURIComponent(recordingId)}/summary`, {
    headers: {
      "X-Api-Key": config.fathom.apiKey,
      Accept: "application/json"
    }
  });
  if (!response.ok) return "";

  const data = await response.json();
  return extractSummaryText(data.summary, data.default_summary, data.action_items, data);
}

async function fetchFathomShareRecording(config, shareUrl) {
  const pageResponse = await fetch(shareUrl, { headers: { Accept: "text/html" } });
  if (!pageResponse.ok) {
    throw new Error(`Fathom share page failed: ${pageResponse.status} ${pageResponse.statusText}`);
  }

  const html = await pageResponse.text();
  const metadata = parseFathomSharePage(html, shareUrl);
  let transcriptText = "";
  let summaryText = metadata.summaryText || "";

  if (!summaryText && metadata.recordingId) {
    summaryText = await fetchFathomApiSummary(config, metadata.recordingId);
  }

  if (metadata.copyTranscriptUrl) {
    const transcriptUrl = new URL(metadata.copyTranscriptUrl, shareUrl).toString();
    const transcriptResponse = await fetch(transcriptUrl, { headers: { Accept: "application/json" } });
    if (transcriptResponse.ok) {
      const data = await transcriptResponse.json();
      transcriptText = firstRawNonEmpty(
        data.text,
        data.transcript_text,
        transcriptToText(data.transcript),
        htmlTranscriptToText(data.html)
      );
    }
  }

  if (!summaryText && metadata.actionItemsUrl) {
    const actionItemsUrl = new URL(metadata.actionItemsUrl, shareUrl).toString();
    const actionItemsResponse = await fetch(actionItemsUrl, {
      headers: {
        Accept: "application/json",
        Referer: shareUrl
      }
    });
    if (actionItemsResponse.ok) {
      const contentType = actionItemsResponse.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await actionItemsResponse.json();
        summaryText = extractSummaryText(data.text, data.action_items, data.items, data.summary, data.html && htmlTranscriptToText(data.html));
      } else {
        summaryText = htmlTranscriptToText(await actionItemsResponse.text());
      }
    }
  }

  if (!transcriptText && metadata.recordingId) {
    transcriptText = await fetchFathomApiTranscript(config, metadata.recordingId);
  }

  return { ...metadata, summaryText, transcriptText };
}

async function fetchFathomRecording(config, recordingIdOrUrl) {
  const source = cleanText(recordingIdOrUrl);
  if (!source) return {};

  if (/^https?:\/\/(?:www\.)?fathom\.video\/share\//i.test(source)) {
    return fetchFathomShareRecording(config, source);
  }

  return {
    recordingId: source,
    summaryText: await fetchFathomApiSummary(config, source),
    transcriptText: await fetchFathomApiTranscript(config, source)
  };
}

async function fetchFathomTranscript(config, recordingIdOrUrl) {
  const recording = await fetchFathomRecording(config, recordingIdOrUrl);
  return recording.transcriptText || "";
}

module.exports = {
  fetchFathomRecording,
  fetchFathomTranscript,
  htmlTranscriptToText,
  normalizeFathomPayload,
  parseFathomSharePage,
  transcriptToText
};
