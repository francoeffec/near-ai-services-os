const { syncEmailOutreachPerformance, syncWeeklyMetrics } = require("../ops/metrics");

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function shouldRunMetrics(config, now, lastRunKey) {
  if (!config.scheduler.enabled) return false;
  if (now.getUTCDay() !== 1) return false;
  if (now.getUTCHours() !== config.scheduler.metricsHourUtc) return false;
  if (now.getUTCMinutes() < config.scheduler.metricsMinuteUtc) return false;
  return lastRunKey !== todayKey(now);
}

function shouldRunEmailOutreach(config, now, lastRunKey) {
  if (!config.scheduler.emailOutreachSyncEnabled) return false;
  if (now.getUTCHours() !== config.scheduler.emailOutreachSyncHourUtc) return false;
  if (now.getUTCMinutes() < config.scheduler.emailOutreachSyncMinuteUtc) return false;
  return lastRunKey !== todayKey(now);
}

function startScheduler({ config, repository, opsService, sheetsClient }) {
  const timers = [];

  let lastMetricsRun = "";
  if (config.scheduler.enabled) {
    timers.push(setInterval(async () => {
      const now = new Date();
      if (!shouldRunMetrics(config, now, lastMetricsRun)) return;
      lastMetricsRun = todayKey(now);
      try {
        await syncWeeklyMetrics({ config, repository, date: now });
        console.log(`Weekly metrics synced at ${now.toISOString()}`);
      } catch (error) {
        console.error("Weekly metrics sync failed", error);
      }
    }, 60 * 1000));
  }

  let lastEmailOutreachRun = "";
  if (config.scheduler.emailOutreachSyncEnabled && sheetsClient) {
    timers.push(setInterval(async () => {
      const now = new Date();
      if (!shouldRunEmailOutreach(config, now, lastEmailOutreachRun)) return;
      lastEmailOutreachRun = todayKey(now);
      try {
        const result = await syncEmailOutreachPerformance({ config, repository, sheetsClient });
        console.log(`Email outreach performance synced for ${result.campaigns} campaign(s) at ${now.toISOString()}`);
      } catch (error) {
        console.error("Email outreach performance sync failed", error);
      }
    }, 60 * 1000));
  }

  if (config.scheduler.handoffRecapPollingEnabled && opsService) {
    const intervalMs = Math.max(15, config.scheduler.handoffRecapPollingSeconds || 60) * 1000;
    timers.push(setInterval(async () => {
      try {
        const results = await opsService.processPendingHandoffRecaps();
        if (results.length) console.log(`Processed ${results.length} pending handoff recap request(s)`);
      } catch (error) {
        console.error("Handoff recap polling failed", error);
      }
    }, intervalMs));
  }

  return {
    stop() {
      timers.forEach((timer) => clearInterval(timer));
    }
  };
}

module.exports = { shouldRunEmailOutreach, shouldRunMetrics, startScheduler, todayKey };
