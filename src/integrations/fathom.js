const { firstNonEmpty } = require("../domain/normalize");

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

function normalizeFathomPayload(payload) {
  const recording = payload.recording || payload.call || payload.meeting || payload;
  return {
    sourceEventId: firstNonEmpty(payload.event_id, payload.id, recording.id),
    recordingId: firstNonEmpty(recording.id, payload.recording_id),
    url: firstNonEmpty(recording.url, recording.share_url, payload.url, payload.fathom_url),
    title: firstNonEmpty(recording.title, payload.title),
    company: firstNonEmpty(payload.company, recording.company),
    email: firstNonEmpty(payload.email, recording.email),
    transcriptText: firstNonEmpty(
      transcriptToText(payload.transcript),
      payload.transcript_text,
      transcriptToText(recording.transcript),
      recording.transcript_text,
      payload.text
    )
  };
}

async function fetchFathomTranscript(config, recordingIdOrUrl) {
  if (!config.fathom.apiKey) return "";
  if (!recordingIdOrUrl) return "";

  const base = config.fathom.baseUrl.replace(/\/$/, "");
  const recordingId = String(recordingIdOrUrl).split("/").filter(Boolean).pop();
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

module.exports = { fetchFathomTranscript, normalizeFathomPayload, transcriptToText };
