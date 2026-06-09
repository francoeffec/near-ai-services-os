const { parseIntent } = require("../domain/intent");
const { cleanText } = require("../domain/normalize");
const { formatSlackCallSummary } = require("../domain/call-summary");

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
    "- `Assign Kelvin to Apple.`",
    "- `Remove this lead and deal.` in a tracker thread."
  ].join("\n");
}

function allowed(config, body) {
  const user = body.user_id || body.user;
  const channel = body.channel_id || body.channel;
  const userAllowed = config.slack.allowedUserIds.length === 0 || config.slack.allowedUserIds.includes(user);
  const channelAllowed = config.slack.allowedChannelIds.length === 0 || config.slack.allowedChannelIds.includes(channel);
  return userAllowed && channelAllowed;
}

function actionWord(result) {
  return result?.created ? "created" : "updated";
}

function readableFieldList(row) {
  const fields = [
    ["Call Had Date", "call date"],
    ["Fathom URL", "Fathom URL"],
    ["Pricing", "pricing"],
    ["Hours/Week", "hours/week"],
    ["Engineer Type", "engineer type"],
    ["Skills Needed", "skills needed"],
    ["Project Scope", "project scope"],
    ["Start Date", "start date"],
    ["Next Steps", "next steps"],
    ["Notes", "notes"]
  ];
  return fields
    .filter(([header]) => cleanText(row?.[header]))
    .map(([, label]) => label);
}

function isLeadingUserMention(text) {
  return /^\s*<@[^>]+>/.test(String(text || ""));
}

function hasContact(intent) {
  return Boolean(cleanText(intent.email) || cleanText(intent.firstName) || cleanText(intent.lastName));
}

function nextStepValue(intent) {
  return cleanText(intent.nextSteps || intent.nextStep || intent["Next Steps"] || intent["Next Step"]);
}

function clarificationQuestion(intent) {
  if (intent.type === "remove_pipeline_records") {
    if (!cleanText(intent.company) && !cleanText(intent.email) && !cleanText(intent.companyDomain)) return "Which company should I remove?";
    return "";
  }
  if (intent.type !== "create_deal" && intent.type !== "add_lead") return "";
  if (!cleanText(intent.company)) return "What's the company name?";
  if (!hasContact(intent)) return "Who's the main contact?";
  if (!cleanText(intent.source)) return "What's the source? Use Outreach, Customer, Referral, or Girdley Media.";
  if (!nextStepValue(intent)) return "What's the next step?";
  return "";
}

function clarificationText(question) {
  return `Before I update the tracker, I need one thing: ${question}`;
}

function clarificationFieldFromQuestion(text) {
  const value = cleanText(text);
  if (/company name/i.test(value)) return "company";
  if (/which company.*remove/i.test(value)) return "company";
  if (/main contact/i.test(value)) return "contact";
  if (/\bsource\b/i.test(value)) return "source";
  if (/next step/i.test(value)) return "nextStep";
  return "";
}

function answerAsInstruction(field, answer) {
  const value = cleanText(answer).replace(/[.\s]+$/g, "");
  if (!field || !value) return "";
  if (field === "company") return `Company is ${value}.`;
  if (field === "contact") return `Contact is ${value}.`;
  if (field === "source") return `Source is ${value}.`;
  if (field === "nextStep") return `The next step is ${value}.`;
  return "";
}

function isTrackerBotMessage(message = {}) {
  const text = cleanText(message.text || "");
  if (!text) return true;
  if (message.bot_id || message.subtype === "bot_message") return true;
  return /^(?:Before I update the tracker|I could not confidently map|I could not complete that|Fathom update for|Created lead:|Updated lead:|Created deal:|Updated deal:|Moved .+ to|Assigned .+ to)/i.test(text);
}

function buildClarifiedIntent(messages = [], replyText = "") {
  const replayMessages = messages.slice();
  const cleanReplyText = cleanText(replyText);
  const replyIntent = parseIntent(cleanReplyText);
  if (replyIntent.type === "help") return replyIntent;
  const lastMessageText = cleanText(replayMessages[replayMessages.length - 1]?.text);
  if (cleanReplyText && cleanReplyText !== lastMessageText) {
    replayMessages.push({ text: cleanReplyText });
  }

  const context = [];
  let pendingField = "";
  let sawClarificationQuestion = false;

  for (const message of replayMessages) {
    const text = cleanText(message.text);
    if (!text) continue;

    if (isTrackerBotMessage(message)) {
      const field = clarificationFieldFromQuestion(text);
      if (field) {
        pendingField = field;
        sawClarificationQuestion = true;
      }
      continue;
    }

    if (pendingField) {
      const instruction = answerAsInstruction(pendingField, text);
      if (instruction) {
        context.push(instruction);
        pendingField = "";
        continue;
      }
    }

    context.push(text);
  }

  if (!sawClarificationQuestion || context.length === 0) return null;
  return parseIntent(context.join("\n"));
}

async function intentFromClarificationThread({ client, channel, threadTs, replyText }) {
  if (!client || !channel || !threadTs || !replyText) return null;
  try {
    const response = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 30
    });
    return buildClarifiedIntent(response.messages || [], replyText);
  } catch (_error) {
    return null;
  }
}

function fathomUpdateText(result) {
  const company = result.row.Company || result.row["Entity Key"] || "the company";
  const dealAction = actionWord(result);
  const leadAction = result.leadResult ? actionWord(result.leadResult) : "synced";
  const fieldLabels = readableFieldList(result.row).slice(0, 6);
  const fieldText = fieldLabels.length ? ` Filled/confirmed: ${fieldLabels.join(", ")}.` : "";
  return [
    `Fathom update for ${company}: ${dealAction} the deal and ${leadAction} the lead.${fieldText}`,
    "",
    formatSlackCallSummary(result.callSummary || result.row)
  ].join("\n");
}

function needsThreadCompany(intent) {
  return !cleanText(intent.company) && [
    "update_deal_from_call",
    "remove_pipeline_records",
    "assign_owner",
    "set_deal_stage",
    "move_to_handoff"
  ].includes(intent.type);
}

async function fillThreadCompany(intent, { client, channel, threadTs }) {
  if (!needsThreadCompany(intent)) return intent;
  intent.company = await inferCompanyFromThread({ client, channel, threadTs });
  return intent;
}

async function handleIntent({ intent, opsService }) {
  switch (intent.type) {
    case "add_lead": {
      const question = clarificationQuestion(intent);
      if (question) return clarificationText(question);
      if (!intent.company) throw new Error("Please include the company name for the lead.");
      const result = await opsService.addLead(intent);
      return `${result.created ? "Created" : "Updated"} lead: ${result.row.Company || result.row["Entity Key"]}`;
    }
    case "create_deal": {
      const question = clarificationQuestion(intent);
      if (question) return clarificationText(question);
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
    case "remove_pipeline_records": {
      const question = clarificationQuestion(intent);
      if (question) return clarificationText(question);
      const result = await opsService.removePipelineRecords(intent);
      const removedText = result.removed.length ? result.removed.join(" and ") : "records";
      const missingText = result.missing.length ? ` I did not find a matching ${result.missing.join(" or ")}.` : "";
      return `Removed ${removedText} for ${result.company}.${missingText}`;
    }
    case "move_to_handoff": {
      if (!intent.company) throw new Error("Please include the company name.");
      const result = await opsService.moveToHandoff(intent);
      if (result.slackLink) {
        return `Moved ${result.row.Company} to handoff and posted the handoff summary.`;
      }
      return `Moved ${result.row.Company} to handoff and created the Handoff row, but I could not post a Slack summary.`;
    }
    case "update_deal_from_call": {
      const result = await opsService.updateDealFromCall(intent);
      return fathomUpdateText(result);
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

  app.event("app_mention", async ({ event, say, client }) => {
    if (!allowed(config, { user: event.user, channel: event.channel })) return;
    const intent = parseIntent((event.text || "").replace(/<@[^>]+>/g, "").trim());
    intent.sourceEventId = `slack:${event.client_msg_id || event.ts}`;
    const threadTs = event.thread_ts || event.ts;
    intent.slackThread = `slack://${event.channel}/${threadTs}`;
    try {
      await fillThreadCompany(intent, { client, channel: event.channel, threadTs });
      const text = await handleIntent({ intent, opsService });
      await say({ text, thread_ts: threadTs });
    } catch (error) {
      await say({ text: `I could not complete that: ${error.message}`, thread_ts: threadTs });
    }
  });

  app.message(async ({ message, say, client }) => {
    if ((!message.text && !(message.files || []).length) || message.subtype || !allowed(config, { user: message.user, channel: message.channel })) return;
    const attachedText = await collectAttachedText(message.files || [], config.slack.botToken);
    const combinedText = [message.text, attachedText].filter(Boolean).join("\n\nAttached transcript:\n");
    if (isLeadingUserMention(combinedText)) return;
    const threadTs = message.thread_ts || message.ts;
    const directIntent = parseIntent(combinedText);
    if (directIntent.type === "help") {
      await say({ text: helpText(), thread_ts: threadTs });
      return;
    }
    const clarificationIntent = message.thread_ts
      ? await intentFromClarificationThread({
        client,
        channel: message.channel,
        threadTs,
        replyText: message.text || ""
      })
      : null;
    if (!clarificationIntent && !/(add|create|update|move|assign|handoff|fathom|transcript|positive reply|interested)/i.test(combinedText)) return;
    const intent = clarificationIntent || directIntent;
    if (intent.type === "unknown") return;
    await fillThreadCompany(intent, { client, channel: message.channel, threadTs });
    if (!intent.company && ["add_lead", "create_deal", "assign_owner", "set_deal_stage", "move_to_handoff"].includes(intent.type)) return;
    intent.sourceEventId = `slack:${message.client_msg_id || message.ts}`;
    intent.slackThread = `slack://${message.channel}/${threadTs}`;
    try {
      const text = await handleIntent({ intent, opsService });
      await say({ text, thread_ts: threadTs });
    } catch (error) {
      await say({ text: `I could not complete that: ${error.message}`, thread_ts: threadTs });
    }
  });

  return { app, receiver };
}

module.exports = {
  buildClarifiedIntent,
  clarificationQuestion,
  collectAttachedText,
  createSlackApp,
  fathomUpdateText,
  handleIntent,
  helpText,
  inferCompanyFromThread,
  isLeadingUserMention
};
