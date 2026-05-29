const express = require("express");
const { bootstrapSpreadsheet } = require("./sheets/bootstrap");
const { normalizeBooking } = require("./integrations/booking");
const { normalizeFathomPayload, fetchFathomTranscript } = require("./integrations/fathom");
const { isPositiveReply, normalizeSmartleadReply } = require("./integrations/smartlead");
const { syncWeeklyMetrics } = require("./ops/metrics");

function requireSecret(config, req, res) {
  const supplied = req.query.secret || req.get("x-near-ai-secret");
  if (!config.webhookSharedSecret || supplied !== config.webhookSharedSecret) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

function requireAdmin(config, req, res) {
  const supplied = req.query.token || req.get("x-admin-token");
  if (!config.adminToken || supplied !== config.adminToken) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

function attachRoutes({ receiver, config, opsService, repository, sheetsClient }) {
  const app = receiver.app;
  app.use(express.json({ limit: "5mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "near-ai-services-os" });
  });

  app.get("/readyz", async (_req, res) => {
    try {
      await Promise.all([
        repository.read("Leads"),
        repository.read("Deals"),
        repository.read("Handoff"),
        repository.read("Events"),
        repository.read("Config")
      ]);
      res.json({ ok: true, sheet: "ready" });
    } catch (error) {
      res.status(503).json({ ok: false, error: error.message });
    }
  });

  app.post("/webhooks/smartlead", async (req, res) => {
    if (!requireSecret(config, req, res)) return;
    try {
      if (!isPositiveReply(req.body)) {
        await repository.addEvent({
          source: "Smartlead",
          eventType: "ignored_reply",
          status: "ignored",
          summary: "Smartlead reply was not classified as positive",
          rawPayload: req.body
        });
        res.json({ ok: true, ignored: true });
        return;
      }
      const lead = normalizeSmartleadReply(req.body);
      const result = await opsService.addLead(lead);
      res.json({ ok: true, created: result.created, lead: result.row });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/webhooks/chili-piper", async (req, res) => {
    if (!requireSecret(config, req, res)) return;
    try {
      const deal = normalizeBooking(req.body);
      const result = await opsService.createDeal(deal);
      res.json({ ok: true, created: result.created, deal: result.row });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/webhooks/fathom", async (req, res) => {
    if (!requireSecret(config, req, res)) return;
    try {
      const payload = normalizeFathomPayload(req.body);
      const transcriptText = payload.transcriptText || await fetchFathomTranscript(config, payload.recordingId || payload.url);
      const result = await opsService.updateDealFromCall({
        company: payload.company,
        email: payload.email,
        fathomUrl: payload.url,
        transcriptText,
        sourceEventId: payload.sourceEventId
      });
      res.json({ ok: true, deal: result.row });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/admin/bootstrap-sheet", async (req, res) => {
    if (!requireAdmin(config, req, res)) return;
    try {
      const result = await bootstrapSpreadsheet(sheetsClient);
      res.json({ ok: true, result });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/jobs/weekly-metrics", async (req, res) => {
    if (!requireAdmin(config, req, res)) return;
    try {
      const result = await syncWeeklyMetrics({ config, repository });
      res.json({ ok: true, result });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { attachRoutes };
