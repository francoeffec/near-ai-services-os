const { syncWeeklyMetrics } = require("../ops/metrics");

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

function startScheduler({ config, repository, opsService }) {
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

module.exports = { shouldRunMetrics, startScheduler, todayKey };
