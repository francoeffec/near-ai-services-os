const express = require("express");
const { extractionStatus } = require("./config");
const { bootstrapSpreadsheet } = require("./sheets/bootstrap");
const { bookingIncluded, normalizeBooking, normalizeHubSpotMeeting } = require("./integrations/booking");
const { normalizeFathomPayload, fetchFathomTranscript } = require("./integrations/fathom");
const { verifyFathomWebhookSignature } = require("./integrations/fathom-webhook");
const { fetchGoogleDocContent } = require("./integrations/google-docs");
const { campaignIncluded, isPositiveReply, normalizeSmartleadReply } = require("./integrations/smartlead");
const { syncWeeklyMetrics } = require("./ops/metrics");

function requireSecret(config, req, res) {
  const supplied = req.query.secret || req.get("x-near-ai-secret");
  if (!config.webhookSharedSecret || supplied !== config.webhookSharedSecret) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

function requireFathomWebhook(config, req, res) {
  if (config.fathom?.webhookSecret) {
    const verified = verifyFathomWebhookSignature({
      secret: config.fathom.webhookSecret,
      headers: req.headers,
      rawBody: req.rawBody || JSON.stringify(req.body || {})
    });
    if (!verified) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return false;
    }
    return true;
  }
  return requireSecret(config, req, res);
}

function requireAdmin(config, req, res) {
  const supplied = req.query.token || req.get("x-admin-token");
  if (!config.adminToken || supplied !== config.adminToken) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

async function duplicateEvent(repository, eventId) {
  if (!eventId || !repository.findEventById) return false;
  return Boolean(await repository.findEventById(eventId));
}

function attachRoutes({ receiver, config, opsService, repository, sheetsClient }) {
  const app = receiver.app;
  app.use(express.json({
    limit: "5mb",
    verify: (req, _res, buffer) => {
      req.rawBody = buffer.toString("utf8");
    }
  }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "nearai-services" });
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
      res.json({
        ok: true,
        sheet: "ready",
        extraction: extractionStatus(config),
        googleDocs: {
          configured: Boolean(config.google.serviceAccountJson),
          auth: config.google.serviceAccountJson ? "service_account" : "unavailable"
        }
      });
    } catch (error) {
      res.status(503).json({ ok: false, error: error.message });
    }
  });

  app.post("/admin/google-docs/fetch", async (req, res) => {
    if (!requireAdmin(config, req, res)) return;
    try {
      const result = await fetchGoogleDocContent(config.google, req.body || {});
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/webhooks/smartlead", async (req, res) => {
    if (!requireSecret(config, req, res)) return;
    try {
      const lead = normalizeSmartleadReply(req.body);
      const eventId = lead.sourceEventId;
      if (await duplicateEvent(repository, eventId)) {
        res.json({ ok: true, duplicate: true });
        return;
      }
      const assumePositive = ["true", "1", "yes"].includes(String(req.query.positive || "").toLowerCase());
      if (!isPositiveReply(req.body, { assumePositive })) {
        await repository.addEvent({
          eventId,
          source: "Smartlead",
          eventType: "ignored_reply",
          status: "ignored",
          summary: "Smartlead reply was not classified as positive",
          rawPayload: req.body
        });
        res.json({ ok: true, ignored: true });
        return;
      }
      const campaign = req.body.campaign || {};
      const campaignForFilter = {
        name: lead.campaign,
        campaign_name: lead.campaign,
        id: lead.campaignId,
        campaign_id: lead.campaignId,
        status: campaign.status || campaign.campaign_status || req.body.campaign_status
      };
      if (!campaignIncluded(config, campaignForFilter)) {
        await repository.addEvent({
          eventId: lead.sourceEventId,
          source: "Smartlead",
          eventType: "ignored_campaign",
          status: "ignored",
          summary: `Smartlead positive reply ignored because campaign is not included: ${lead.campaign || lead.campaignId || "unknown campaign"}`,
          rawPayload: req.body
        });
        res.json({ ok: true, ignored: true, reason: "campaign_not_included" });
        return;
      }
      const result = await opsService.addLead(lead);
      await opsService.notifySmartleadLead(result, lead);
      res.json({ ok: true, created: result.created, lead: result.row });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/webhooks/chili-piper", async (req, res) => {
    if (!requireSecret(config, req, res)) return;
    try {
      const eventId = req.body.event_id || req.body.id || req.body.booking?.id || req.body.event?.id || req.body.meeting?.id;
      if (await duplicateEvent(repository, eventId)) {
        res.json({ ok: true, duplicate: true });
        return;
      }
      const deal = normalizeBooking(req.body);
      if (!bookingIncluded(config, deal)) {
        await repository.addEvent({
          eventId: deal.sourceEventId,
          source: "Chili Piper",
          eventType: "ignored_booking",
          status: "ignored",
          summary: `Chili Piper booking ignored because meeting is not included: ${deal.campaign || "unknown meeting"}`,
          rawPayload: req.body
        });
        res.json({ ok: true, ignored: true, reason: "booking_not_included" });
        return;
      }
      if (!deal.callBookedOn) deal.callBookedOn = new Date().toISOString();
      const result = await opsService.createDeal(deal);
      await opsService.notifyChiliPiperDeal(result, deal);
      res.json({ ok: true, created: result.created, deal: result.row });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/webhooks/hubspot-meeting", async (req, res) => {
    if (!requireSecret(config, req, res)) return;
    try {
      const deal = normalizeHubSpotMeeting(req.body);
      if (await duplicateEvent(repository, deal.sourceEventId)) {
        res.json({ ok: true, duplicate: true });
        return;
      }
      if (!bookingIncluded(config, deal)) {
        await repository.addEvent({
          eventId: deal.sourceEventId,
          source: "HubSpot",
          eventType: "ignored_booking",
          status: "ignored",
          summary: `HubSpot meeting ignored because meeting is not included: ${deal.campaign || "unknown meeting"}`,
          rawPayload: req.body
        });
        res.json({ ok: true, ignored: true, reason: "booking_not_included" });
        return;
      }
      if (!deal.callBookedOn) deal.callBookedOn = new Date().toISOString();
      const result = await opsService.createDeal(deal);
      await opsService.notifyBookingDeal(result, "HubSpot");
      res.json({ ok: true, created: result.created, deal: result.row });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/webhooks/fathom", async (req, res) => {
    if (!requireFathomWebhook(config, req, res)) return;
    try {
      const payload = normalizeFathomPayload(req.body);
      const transcriptText = payload.transcriptText || await fetchFathomTranscript(config, payload.recordingId || payload.url);
      const result = await opsService.updateDealFromCall({
        company: payload.company,
        companyDomain: payload.companyDomain,
        contactName: payload.contactName,
        email: payload.email,
        callDate: payload.callDate,
        summaryText: payload.summaryText,
        fathomUrl: payload.url,
        transcriptText,
        sourceEventId: payload.sourceEventId,
        autoCreateDeal: true
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

  app.post("/jobs/handoff-recaps", async (req, res) => {
    if (!requireAdmin(config, req, res)) return;
    try {
      const result = await opsService.processPendingHandoffRecaps();
      res.json({ ok: true, result });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { attachRoutes };
