const { parseIntent } = require("../domain/intent");

async function fetchTextFile(file, botToken) {
  if (!file?.url_private || !botToken) return "";
  const mimetype = String(file.mimetype || file.filetype || "").toLowerCase();
  const name = String(file.name || file.title || "").toLowerCase();
  const likelyText = mimetype.includes("text") || mimetype.includes("json") || /transcript|fathom|\.txt|\.md|\.json/.test(name);
  if (!likelyText) return "";

  const response = await fetch(file.url_private, {
    headers: { Authorization: `Bearer ${botToken}` }
  });
  if (!response.ok) return "";
  const text = await response.text();
  return text.slice(0, 60000);
}

async function collectAttachedText(files = [], botToken) {
  const chunks = [];
  for (const file of files) {
    const text = await fetchTextFile(file, botToken);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n");
}

async function inferCompanyFromThread({ client, channel, threadTs }) {
  if (!client || !channel || !threadTs) return "";
  try {
    const response = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20
    });
    const messages = response.messages || [];
    for (const threadMessage of messages) {
      const intent = parseIntent(threadMessage.text || "");
      if (intent.company) return intent.company;
    }
  } catch (_error) {
    return "";
  }
  return "";
}

function helpText() {
  return [
    "I can update the AI Services pipeline in Google Sheets.",
    "",
    "Try:",
    "- `Add Apple as a lead. Jane Doe. jane@apple.com. Interested in RevOps automation.`",
    "- `Create a deal for Venveo.`",
    "- Drop a Fathom share URL in #ai-leads after an AI Services call.",
    "- `Update Mantra Health using this Fathom transcript: ...`",
    "- `Move CP Brands to handoff.`",
    "- `Assign Kelvin to Apple.`"
  ].join("\n");
}

function allowed(config, body) {
  const user = body.user_id || body.user;
  const channel = body.channel_id || body.channel;
  const userAllowed = config.slack.allowedUserIds.length === 0 || config.slack.allowedUserIds.includes(user);
  const channelAllowed = config.slack.allowedChannelIds.length === 0 || config.slack.allowedChannelIds.includes(channel);
  return userAllowed && channelAllowed;
}

async function handleIntent({ intent, opsService }) {
  switch (intent.type) {
    case "add_lead": {
      if (!intent.company) throw new Error("Please include the company name for the lead.");
      const result = await opsService.addLead(intent);
      return `${result.created ? "Created" : "Updated"} lead: ${result.row.Company || result.row["Entity Key"]}`;
    }
    case "create_deal": {
      if (!intent.company) throw new Error("Please include the company name for the deal.");
      const result = await opsService.createDeal(intent);
      return `${result.created ? "Created" : "Updated"} deal: ${result.row.Company || result.row["Entity Key"]}`;
    }
    case "assign_owner": {
      if (!intent.company || !intent.owner) throw new Error("Please include both the owner and company.");
      const result = await opsService.assignOwner(intent);
      return `Assigned ${result.row.Company} to ${result.row.Owner}.`;
    }
    case "set_deal_stage": {
      if (!intent.company) throw new Error("Please include the company name.");
      const result = await opsService.setDealStage(intent);
      return `Moved ${result.row.Company} to ${result.row["Deal Stage"]}.`;
    }
    case "move_to_handoff": {
      if (!intent.company) throw new Error("Please include the company name.");
      const result = await opsService.moveToHandoff(intent);
      return `Moved ${result.row.Company} to handoff and generated the handoff summary.`;
    }
    case "update_deal_from_call": {
      const result = await opsService.updateDealFromCall(intent);
      return `${result.created ? "Created" : "Updated"} ${result.row.Company} from the Fathom call. I also synced the lead row.`;
    }
    case "help":
      return helpText();
    default:
      return "I could not confidently map that to a pipeline action. Try `help` for examples, or include the company name and desired action.";
  }
}

function createSlackApp({ config, opsService }) {
  const { App, ExpressReceiver } = require("@slack/bolt");
  const receiver = new ExpressReceiver({
    signingSecret: config.slack.signingSecret,
    endpoints: "/slack/events"
  });

  const app = new App({
    token: config.slack.botToken,
    receiver
  });

  app.command("/near-ai", async ({ command, ack, respond }) => {
    await ack();
    if (!allowed(config, command)) {
      await respond({ response_type: "ephemeral", text: "This command is not enabled for this user or channel." });
      return;
    }
    const intent = parseIntent(command.text || "help");
    intent.sourceEventId = `slack-command:${command.trigger_id || command.command}:${command.channel_id}:${command.user_id}`;
    intent.slackThread = `slack://${command.channel_id}`;
    try {
      const text = await handleIntent({ intent, opsService });
      await respond({ response_type: "in_channel", text });
    } catch (error) {
      await respond({ response_type: "ephemeral", text: `I could not complete that: ${error.message}` });
    }
  });

  app.event("app_mention", async ({ event, say }) => {
    if (!allowed(config, { user: event.user, channel: event.channel })) return;
    const intent = parseIntent((event.text || "").replace(/<@[^>]+>/g, "").trim());
    intent.sourceEventId = `slack:${event.client_msg_id || event.ts}`;
    intent.slackThread = `slack://${event.channel}/${event.ts}`;
    try {
      const text = await handleIntent({ intent, opsService });
      await say({ text, thread_ts: event.ts });
    } catch (error) {
      await say({ text: `I could not complete that: ${error.message}`, thread_ts: event.ts });
    }
  });

  app.message(async ({ message, say, client }) => {
    if ((!message.text && !(message.files || []).length) || message.subtype || !allowed(config, { user: message.user, channel: message.channel })) return;
    const attachedText = await collectAttachedText(message.files || [], config.slack.botToken);
    const combinedText = [message.text, attachedText].filter(Boolean).join("\n\nAttached transcript:\n");
    if (!/(add|create|update|move|assign|handoff|fathom|transcript|positive reply|interested)/i.test(combinedText)) return;
    const intent = parseIntent(combinedText);
    if (intent.type === "unknown") return;
    if (!intent.company && intent.type === "update_deal_from_call") {
      intent.company = await inferCompanyFromThread({
        client,
        channel: message.channel,
        threadTs: message.thread_ts || message.ts
      });
    }
    if (!intent.company && ["add_lead", "create_deal", "assign_owner", "set_deal_stage", "move_to_handoff"].includes(intent.type)) return;
    intent.sourceEventId = `slack:${message.client_msg_id || message.ts}`;
    intent.slackThread = `slack://${message.channel}/${message.ts}`;
    try {
      const text = await handleIntent({ intent, opsService });
      await say({ text, thread_ts: message.ts });
    } catch (error) {
      await say({ text: `I could not complete that: ${error.message}`, thread_ts: message.ts });
    }
  });

  return { app, receiver };
}

module.exports = { collectAttachedText, createSlackApp, handleIntent, helpText, inferCompanyFromThread };
