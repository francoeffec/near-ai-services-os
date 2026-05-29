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

function startScheduler({ config, repository }) {
  if (!config.scheduler.enabled) return { stop() {} };

  let lastMetricsRun = "";
  const timer = setInterval(async () => {
    const now = new Date();
    if (!shouldRunMetrics(config, now, lastMetricsRun)) return;
    lastMetricsRun = todayKey(now);
    try {
      await syncWeeklyMetrics({ config, repository, date: now });
      console.log(`Weekly metrics synced at ${now.toISOString()}`);
    } catch (error) {
      console.error("Weekly metrics sync failed", error);
    }
  }, 60 * 1000);

  return {
    stop() {
      clearInterval(timer);
    }
  };
}

module.exports = { shouldRunMetrics, startScheduler, todayKey };
