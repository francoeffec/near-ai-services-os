const { cleanText, firstNonEmpty } = require("../domain/normalize");
const { compactField, formatCallSummary, splitPoints } = require("../domain/call-summary");

const DEAL_STAGES = new Set([
  "Cancelled",
  "Call Booked",
  "Unqualified",
  "Considering",
  "Input Call",
  "Contract Signed",
  "Lost",
  "Future Need"
]);

const NEAR_SPEAKER_PATTERN = /\b(near|camila|cami|franco|hayden|kevin|codex|iphone)\b/i;
const COMMON_FIRST_NAMES = [
  "eduardo",
  "dionelis",
  "zach",
  "max",
  "bob",
  "derek",
  "erik",
  "thomas",
  "mike",
  "anthony",
  "robert",
  "chad"
];

async function extractCallFieldsWithOpenAI(config, transcriptText) {
  if (!config.ai?.apiKey) return {};

  const jsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      company: { type: "string" },
      company_domain: { type: "string" },
      contact_name: { type: "string" },
      contact_email: { type: "string" },
      deal_stage: { type: "string" },
      pricing: { type: "string" },
      hours_per_week: { type: "string" },
      engineer_type: { type: "string" },
      need: { type: "string" },
      pain_points: { type: "string" },
      key_questions: { type: "string" },
      skills_needed: { type: "string" },
      project_scope: { type: "string" },
      start_date: { type: "string" },
      next_steps: { type: "string" },
      notes: { type: "string" },
      if_lost_reason: { type: "string" }
    },
    required: [
      "company",
      "company_domain",
      "contact_name",
      "contact_email",
      "deal_stage",
      "pricing",
      "hours_per_week",
      "engineer_type",
      "need",
      "pain_points",
      "key_questions",
      "skills_needed",
      "project_scope",
      "start_date",
      "next_steps",
      "notes",
      "if_lost_reason"
    ]
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.ai.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.ai.model || "gpt-4.1-mini",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "deal_call_update",
          strict: true,
          schema: jsonSchema
        }
      },
      messages: [
        {
          role: "system",
          content: [
            "Extract NearAI Services deal fields from a sales call transcript or Fathom summary.",
            "The company and contact should be the external prospect, not Near.",
            "Prefer a Fathom summary/action-items section when present; use the transcript only to fill gaps.",
            "Use deal_stage only from: Cancelled, Call Booked, Unqualified, Considering, Input Call, Contract Signed, Lost, Future Need.",
            "Capture key_questions as the most important prospect questions asked about this AI Services deal: need, scope, pricing, timeline, implementation approach, tools, staffing model, skills, next steps, or buying process.",
            "Do not include rapport, greetings, personal check-ins, sports, jokes, weather, location, or questions unrelated to the AI Services opportunity in key_questions.",
            "Keep need, pain_points, key_questions, project_scope, skills_needed, pricing, next_steps, and notes concise. Do not paste transcript lines.",
            "notes must be a human-readable TL;DR under 1400 characters with only these sections: Need, Pain points, Key questions asked, Pricing, Scope of project, Skills needed, Next steps. Use short bullets.",
            "Use empty strings when the call does not support a field. Do not invent facts."
          ].join(" ")
        },
        {
          role: "user",
          content: transcriptText.slice(0, 60000)
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI extraction failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

function firstExternalEmail(body) {
  const emails = body.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return emails.find((email) => !/@hirewithnear\.com$/i.test(email)) || "";
}

function extractCompanyName(body) {
  const direct = body.match(/\bCompany:\s*([^\n]+)/i) || body.match(/\bProspect company:\s*([^\n]+)/i);
  if (direct) return prettyCompanyName(cleanText(direct[1]).replace(/[.,;:]+$/g, ""), extractCompanyDomain(body));

  const title = body.match(/\b(?:Call title|Title):\s*([^\n]+)/i);
  if (title) {
    const titleText = cleanText(title[1]);
    const afterSlash = titleText.includes("//") ? titleText.split("//").pop() : titleText;
    const candidate = afterSlash
      .split(/\+| with | - /i)
      .map(cleanText)
      .find((part) => part && !/^near$/i.test(part) && !/^ai automation$/i.test(part));
    if (candidate) return prettyCompanyName(candidate, extractCompanyDomain(body));
  }

  return "";
}

function extractCompanyDomain(body) {
  const direct = body.match(/\bCompany domain:\s*([a-z0-9.-]+\.[a-z]{2,})/i);
  if (direct) return direct[1].toLowerCase();
  const email = firstExternalEmail(body);
  if (email) return email.split("@").pop().toLowerCase();
  const domains = body.match(/\b[a-z0-9.-]+\.[a-z]{2,}\b/gi) || [];
  return (domains.find((domain) => !/hirewithnear\.com/i.test(domain) && !/fathom\.video/i.test(domain)) || "").toLowerCase();
}

function extractContactName(body) {
  const direct = body.match(/\bContact:\s*([^\n<]+)/i) || body.match(/\bClient\/Contact:\s*([^\n<]+)/i);
  if (direct) return titleCaseName(cleanText(direct[1]).replace(/[.,;:]+$/g, ""));

  const speakerLines = body.match(/^\d{1,2}:\d{2}\s*-\s*([^\n]+)$/gim) || [];
  for (const line of speakerLines) {
    const name = cleanText(line.replace(/^\d{1,2}:\d{2}\s*-\s*/i, ""));
    if (name && !NEAR_SPEAKER_PATTERN.test(name) && !/speaker/i.test(name)) return titleCaseName(name);
  }
  const turns = parseTranscriptTurns(body);
  const external = turns.find((turn) => !isNearSpeaker(turn.speaker));
  if (external?.speaker) return titleCaseName(splitConcatenatedName(external.speaker));
  return "";
}

function collectSkills(body) {
  const skills = [
    ["n8n", /\bn8n\b|\b8n\b/i],
    ["Make", /\bmake\.com\b|\bmake\b(?=\s*(?:,|\/|y\b|o\b|and\b|de\b))/i],
    ["Zapier", /\bzapier\b/i],
    ["Airtable", /\bairtable\b/i],
    ["Supabase", /\bsupabase\b/i],
    ["APIs", /\bapi\b|\bapis\b/i],
    ["MCP", /\bmcp\b/i],
    ["Claude", /\bclaude\b/i],
    ["Python", /\bpython\b/i],
    ["Custom GPTs", /\bcustom gpt\b|\bgpts?\b/i],
    ["Copilot", /\bcopilot\b/i],
    ["Prompt Engineering", /\bprompt engineering\b/i],
    ["AI agents", /\bagents?\b/i],
    ["systems integration", /\bintegrat(?:e|ing|ion|ions)\b|\bcrm\b|\bsystems?\b/i],
    ["workflow automation", /\bworkflow\b|\bautomatiz/i]
  ];
  return skills
    .filter(([, pattern]) => pattern.test(body))
    .map(([label]) => label)
    .join(", ");
}

function splitConcatenatedName(value) {
  const cleaned = cleanText(value);
  if (!/^[a-z]+$/i.test(cleaned)) return cleaned;
  const lower = cleaned.toLowerCase();
  const firstName = COMMON_FIRST_NAMES.find((name) => lower.startsWith(name) && lower.length > name.length + 2);
  if (!firstName) return cleaned;
  return `${firstName} ${lower.slice(firstName.length)}`;
}

function titleCaseName(value) {
  return cleanText(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function prettyCompanyName(value, domain = "") {
  const cleaned = cleanText(value);
  const normalizedDomain = cleanText(domain).toLowerCase();
  if (!cleaned) return "";
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned)) {
    const label = cleaned.split(".")[0] || cleaned;
    return label
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  if (normalizedDomain && cleaned.toLowerCase() === normalizedDomain) {
    return prettyCompanyName(normalizedDomain);
  }
  return cleaned;
}

function parseTranscriptTurns(text) {
  const lines = String(text || "")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const turns = [];
  let current = null;

  const pushCurrent = () => {
    if (current && cleanText(current.text)) {
      turns.push({ speaker: cleanText(current.speaker), text: cleanText(current.text) });
    }
  };

  for (const line of lines) {
    if (/^(?:Call title|Company|Company domain|Call date|Transcript|Fathom summary):/i.test(line)) continue;
    if (/^VIEW RECORDING\b/i.test(line)) continue;

    const fathomSpeaker = line.match(/^@?\d{1,2}:\d{2}(?::\d{2})?\s*-\s*(.+)$/i);
    if (fathomSpeaker) {
      pushCurrent();
      current = { speaker: fathomSpeaker[1], text: "" };
      continue;
    }

    const colonSpeaker = line.match(/^([^:\n]{2,60}):\s+(.+)$/);
    if (colonSpeaker && !/^https?:\/\//i.test(line)) {
      pushCurrent();
      current = { speaker: colonSpeaker[1], text: colonSpeaker[2] };
      continue;
    }

    if (current) {
      current.text = `${current.text} ${line}`.trim();
    }
  }
  pushCurrent();
  return turns;
}

function isNearSpeaker(speaker) {
  return NEAR_SPEAKER_PATTERN.test(cleanText(speaker));
}

const DEAL_CONTEXT_PATTERN = /\b(ai|automation|automatizaciones?|workflow|workflows|tool|tools|agent|agents|engineers?|engineering|desarrolladores?|desarrollo|lead|tech lead|talent|fractional|freelance|project|projects|proyectos?|scope|scoping|proposal|propuesta|costos?|pricing|cost|compensation|salary|dollars?|d[oó]lares|hours?|package|model|process|proceso|funciona|placement|profile|profiles|website|migration|github|document|doc|marketing|head of marketing|review|information|decide|calendar|calendar link|whatsapp|meeting|call|schedule|introduce|start|priority|prioritize|operating system|retreat|retreats|course|internal|department|sops?|manual|systems?|integration|integraci[oó]n|discovery|discoveries|soluci[oó]n|implementar|implementation|quick wins?|proofs? of concept|pruebas? de concepto|n8n|make|zapier|airtable|supabase|apis?|mcp|claude|cloud code|python|copilot|prompt engineering|custom gpts?|use cases?|casos de uso|socio|operaciones|producci[oó]n|partner|hiring|hire|contratan|empleados?|necesit(?:a|amos|o)|capacidad)\b/i;
const OFF_TOPIC_PATTERN = /\b(world cup|warm you up|brazil|argentina|rio|new year|bachelor|beach|uber|knicks|nba|jordan woods|kardashian|trump|purse|miami|buenos aires|olivos|flu|sick|vacation|weather|football|soccer|party|team game)\b/i;

function isDealRelevantTurnText(value) {
  const text = cleanText(value);
  if (!text) return false;
  if (!DEAL_CONTEXT_PATTERN.test(text)) return false;
  if (OFF_TOPIC_PATTERN.test(text) && !/\b(ai|automation|workflow|engineers?|engineering|website|migration|github|project|scope|proposal|profile|marketing|systems?|internal|claude|cloud code)\b/i.test(text)) {
    return false;
  }
  return true;
}

function extractionMetadataLines(raw) {
  return String(raw || "")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter((line) => /^(?:Call title|Company|Company domain|Call date):/i.test(line));
}

function extractionSummaryLines(raw) {
  const lines = String(raw || "")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const summary = [];
  let inSummary = false;
  for (const line of lines) {
    const summaryHeader = line.match(/^Fathom summary:\s*(.*)$/i);
    if (summaryHeader) {
      inSummary = true;
      const inlineSummary = cleanText(summaryHeader[1]);
      if (inlineSummary && DEAL_CONTEXT_PATTERN.test(inlineSummary) && !(OFF_TOPIC_PATTERN.test(inlineSummary) && !DEAL_CONTEXT_PATTERN.test(inlineSummary))) {
        summary.push(inlineSummary);
      }
      continue;
    }
    if (/^Transcript:/i.test(line)) {
      inSummary = false;
      continue;
    }
    if (!inSummary) continue;
    if (OFF_TOPIC_PATTERN.test(line) && !DEAL_CONTEXT_PATTERN.test(line)) continue;
    if (DEAL_CONTEXT_PATTERN.test(line)) summary.push(line);
  }
  return summary;
}

function focusTranscriptForExtraction(text) {
  const raw = String(text || "");
  const turns = parseTranscriptTurns(raw);
  if (!turns.length) return raw;

  const focused = [];
  const summary = extractionSummaryLines(raw);
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const turnText = cleanText(turn.text);
    const previousKept = focused.length > 0 && index > 0 && turns[index - 1]?.__kept;
    const bridge = previousKept
      && /^(?:yeah|yes|right|okay|ok|great|sounds good|that works|a hundred percent)\b/i.test(turnText)
      && !OFF_TOPIC_PATTERN.test(turnText);
    if (isDealRelevantTurnText(turnText) || bridge) {
      turns[index].__kept = true;
      focused.push(`${turn.speaker}: ${turnText}`);
    }
  }

  if (focused.length < 2 && !summary.length) return raw;
  const metadata = extractionMetadataLines(raw);
  return [
    ...metadata,
    summary.length ? "Fathom summary:" : "",
    ...summary,
    focused.length ? "Transcript:" : "",
    ...focused
  ].filter(Boolean).join("\n");
}

function pointList(points, max = 2) {
  return [...new Set(points.map(cleanText).filter(Boolean))].slice(0, max).join("\n");
}

function canonicalQuestion(question, company = "") {
  const text = cleanText(question).replace(/\s*\?+\s*$/g, "");
  const lower = text.toLowerCase();
  const prospect = cleanText(company) || "the prospect";
  if (!text) return "";
  if (/qu[eé] seguir[ií]a|siguiente paso|si yo decidiera|c[oó]mo funciona esa parte/.test(lower)) return `What would the next step be if ${prospect} decides to move forward?`;
  if (/empleados.*(?:freelance|pool)|pool.*freelance|son empleados/.test(lower)) return "Are the engineers Near employees or freelancers?";
  if (/way of working|modelo.*(?:c[oó]mo|funciona)|c[oó]mo es.*modelo|c[oó]mo funciona|staff augmentation|recursos humanos tecnológicos/.test(lower)) return "How does Near's working model and engagement process work?";
  if (/machine learning|ingenieros de machine|construyan en data/.test(lower)) return "Does this require machine-learning engineers or AI automation builders?";
  if (/mercado libre|500.*(?:d[oó]lares|hora)|costosos|tarifas/.test(lower)) return "How does Near's model compare on cost versus expensive AI/ML talent?";
  if (/equipos.*(?:argentina|dónde)|dónde.*equipos|colombia tienen|están en argentina/.test(lower)) return "Where are Near's engineering teams located?";
  if (/all[-\s]?in cost|cost[-\s]?in cost|\bcost\b/.test(lower)) return "What is the all-in hourly cost?";
  if (/how much.*full[-\s]?time|full[-\s]?time.*employees|rough numbers|ballpark/.test(lower)) return "What does full-time AI engineer compensation look like?";
  if (/do you hire full[-\s]?time|full[-\s]?time also/.test(lower)) return "Can Near also help hire a full-time AI engineer?";
  if (/what.*do we do|how.*do you go|get started|how.*works/.test(lower)) return "What is the process to get started with fractional AI support?";
  if (/either way|full[-\s]?time or part[-\s]?time|part[-\s]?time/.test(lower)) return "Can Near support both fractional and full-time AI talent?";
  if (/talent.*ai|ai.*talent|latest.*ai tools|workflows.*tools/.test(lower)) return "Do you have AI talent familiar with workflows and current AI tools?";
  if (/ai engineer.*(?:point guard|oversee|organize|internal projects|work in tandem)/.test(lower)) return "Can an AI engineer oversee internal projects and work in tandem with the broader team?";
  if (/how.*use ai|best way/.test(lower)) return "How should the company use AI in the highest-leverage way?";
  if (/what.*offer|fractional/.test(lower)) return "How does the fractional AI engineer model work?";
  if (text.length > 180) return "";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}?`;
}

function isDealRelevantQuestion(question) {
  const text = cleanText(question);
  if (!text || isWeakValue(text)) return false;
  if (/world cup|warm you up|how have you been|how are you|how'?s it going|what'?s up|weather|weekend|vacation|holiday|family|kids|soccer|football|f[uú]tbol|where are you calling from|what caught|how do you find your people|fathom/i.test(text)) {
    return false;
  }
  if (/roles? beyond ai|beyond ai|accounting,?\s+admin|admin,?\s+it|all kinds of different employee|everybody doing what they'?re supposed to do/i.test(text)) {
    return false;
  }
  return /\b(ai|automation|workflow|tool|tools|agent|agents|engineers?|engineering|talent|hire|hiring|employees?|freelancers?|staffing|full[-\s]?time|part[-\s]?time|fractional|cost|pricing|rate|hour|hours|compensation|salary|model|engagement|process|get started|next step|move forward|build|built|roll(?:ed)? out|scope|project|implementation|integrat|systems?|crm|employee[-\s]?facing|claude|n8n|make|zapier|airtable|supabase|api|apis|mcp|use cases?|discovery|estimate|estimating|scoping|proof of concept|poc|timeline|start date|buying process)\b/i.test(text);
}

function normalizeQuestionForSummary(value) {
  const text = cleanText(value)
    .replace(/^[-*\u2022]\s*/, "")
    .replace(/\s*\?+\s*$/g, "");
  if (!text || text.length > 220) return "";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}?`;
}

function sanitizeKeyQuestions(value, max = 5) {
  const questions = splitPoints(value, max * 3)
    .map(normalizeQuestionForSummary)
    .filter(isDealRelevantQuestion);
  return pointList(questions, max);
}

function keyQuestionsFromTurns(turns, company = "") {
  const questions = [];
  for (const turn of turns.filter((item) => !isNearSpeaker(item.speaker))) {
    const text = cleanText(turn.text);
    const explicit = text.match(/[^.!?]*\?/g) || [];
    for (const candidate of explicit) questions.push(canonicalQuestion(candidate, company));

    if (!explicit.length) {
      if (/\b(all[-\s]?in cost|cost|how much|full[-\s]?time|part[-\s]?time|talent|fractional|what kind)\b/i.test(text)) {
        questions.push(canonicalQuestion(text, company));
      }
    }
  }
  const priority = [
    /Near employees or freelancers/i,
    /working model and engagement process/i,
    /next step.*(?:move forward|decides)/i,
    /machine-learning engineers/i,
    /cost versus expensive/i,
    /all-in hourly cost/i,
    /full-time ai engineer compensation/i,
    /help hire a full-time ai engineer/i,
    /fractional and full-time ai talent/i,
    /ai talent familiar/i,
    /process to get started/i,
    /fractional ai engineer model/i
  ];
  const cleaned = questions.filter(isDealRelevantQuestion);
  const ranked = [...new Set(cleaned)].sort((a, b) => {
    const rank = (value) => {
      const index = priority.findIndex((pattern) => pattern.test(value));
      return index === -1 ? priority.length : index;
    };
    return rank(a) - rank(b);
  });
  return pointList(ranked, 5);
}

function extractPricingPoints(body) {
  const points = [];
  if (/\$70\b.{0,40}\b(hour|hr|all in)\b/i.test(body) || /\b70\b.{0,20}\b(hour|hr|la hora|por hora)\b/i.test(body)) {
    points.push("$70/hr all-in for fractional AI engineering.");
  }
  if (/as little as 10 hours|commit with as little as 10 hours|10 hours/i.test(body)) {
    points.push("Can start with as little as 10 hours.");
  }
  if (/(20,\s*40|20\s*(?:or|to|-)\s*40)\s*hours/i.test(body)) {
    points.push("20-40 hours is a typical starting package.");
  }
  if (/\$?80,?000.{0,30}\$?120,?000|80,?000.{0,20}120,?000/i.test(body)) {
    points.push("Full-time AI engineer compensation was framed around $80k-$120k/year.");
  }
  if (/month[-\s]?to[-\s]?month/i.test(body)) {
    points.push("Month-to-month commitment is available.");
  }
  return pointList(points, 4);
}

function extractNeedPoints(body) {
  const points = [];
  if (/website (?:right now|rebuild|migration|project)|website migration|recreating our new website|new website/i.test(body)) {
    points.push("Needs help finishing a time-sensitive website rebuild/migration that has been difficult for the current team to execute.");
  }
  if (/operating system.*(?:international )?wellness retreats?|international wellness retreats?.*operating system|online course|launch your own/i.test(body)) {
    points.push("Considering AI/software projects around Fit4Travel's retreat operating system and online course ideas.");
  }
  if (/ai engineer.*(?:point guard|oversees|organizes|internal projects|different teams)|department doc|sops?|manual thing|build a tool that does/i.test(body)) {
    points.push("Wants an AI engineer who can assess internal workflows and help guide automation work with the broader team.");
  }
  if (/fractional (?:ai )?(?:person|engineer)|fractional ai|package of hours/i.test(body)) {
    points.push("Exploring fractional AI engineering support and how the model works.");
  }
  if (/no nos alcanzan las manos|necesitamos para colombia|necesitando muchos proyectos|capacidad de desarrollo/i.test(body)) {
    points.push("Needs flexible AI automation/development capacity for client projects in Colombia and Latin America.");
  }
  if (/cotizar|sacar costos|pasar propuestas|propuesta de tiempos y costos|discovery|discoveries/i.test(body)) {
    points.push("Wants support estimating and scoping AI projects that come out of discovery or roadmap work.");
  }
  if (/full[-\s]?time (?:permanent )?(?:ai )?engineer|hire full[-\s]?time/i.test(body)) {
    points.push("Also considering whether a full-time AI engineer or AI architect makes sense.");
  }
  if (/how to use ai|use ai in the best way|trying to figure out.*ai/i.test(body)) {
    points.push("Trying to identify practical, high-leverage AI use cases across the business.");
  }
  if (/right information out of our systems|centralized information/i.test(body)) {
    points.push("Wants AI to access or centralize the right information from internal systems.");
  }
  if (!points.length && /create something|construct it|roll it out|web app|employees could use it/i.test(body)) {
    points.push("Considering a custom AI/software build and wants help turning the idea into a concrete project plan.");
  }
  return pointList(points, 3);
}

function extractPainPoints(body) {
  const points = [];
  if (/website migration|recreating our new website|over his head|doesn'?t have that much experience|way longer|technical standpoint/i.test(body)) {
    points.push("Website rebuild/migration is time-sensitive and may be beyond the current owner's technical experience.");
  }
  if (/manual thing|department doc|sops?|day-to-day|video recordings|build a tool that does/i.test(body)) {
    points.push("Internal processes are documented but may still include manual workflows that could be automated.");
  }
  if (/hiring.*fort wayne.*taking longer|taking longer than i thought|trying to hire.*taking longer/i.test(body)) {
    points.push("Local hiring in Fort Wayne is taking longer than expected.");
  }
  if (/no nos alcanzan las manos|no ha sido fácil conseguir|cada vez tiene menos tiempo|no estamos teniendo suficiente gente/i.test(body)) {
    points.push("Internal development capacity is constrained and good AI automation talent is hard to find.");
  }
  if (/costosos|vale más|tarifas|salarios|prefiero tener los míos en india/i.test(body)) {
    points.push("Strong AI talent can be expensive, so delivery cost and rate fit matter.");
  }
  if (/mercado.*(?:tocando el agua|empezando)|gente está entendiendo|aprendiendo|quick wins|pruebas de concepto/i.test(body)) {
    points.push("Clients are still learning AI, so quick wins and proofs of concept are easier to sell than long builds.");
  }
  if (/trying to figure out.*things|how to use ai in the best way|what we want to use it/i.test(body)) {
    points.push("They are still clarifying which AI use cases should be prioritized.");
  }
  if (/right information out of our systems|centralized information/i.test(body)) {
    points.push("Internal information is spread across systems and needs to be easier for AI/tools to use.");
  }
  if (/repetitive.*team members|employees.*time.*something else/i.test(body)) {
    points.push("Potential opportunity to reduce repetitive work so employees can focus on higher-value tasks.");
  }
  return pointList(points, 3);
}

function extractScopePoints(body, company = "") {
  const points = [];
  const prospect = cleanText(company) || "the prospect";
  if (/website (?:right now|migration|project)|website migration|recreating our new website|github|marketing team.*scope|scope of the project/i.test(body)) {
    points.push(`Start with ${prospect}'s website rebuild/migration by reviewing the existing GitHub work and marketing team's scope doc.`);
  }
  if (/engineering lead|engineer.*(?:scoping|suggesting an amount of hours)|proposal.*(?:hours|phases)|profile.*best fit|tech lead/i.test(body)) {
    points.push("Near engineering lead to scope the work, estimate hours by phase, and recommend the best-fit engineer.");
  }
  if (/head of marketing|introduce us|send them my link|meeting later this week|include the engineer/i.test(body)) {
    points.push("Schedule an engineer input call or intro with Fit4Travel's head of marketing once the scope doc is shared.");
  }
  if (/input call with an engineer|meet the engineer|walk them through/i.test(body)) {
    points.push("Run an engineer input call to define one priority workflow or bottleneck and estimate hours.");
  }
  if (/discovery|discoveries|levantar.*casos de uso|roadmaps?|propuesta de tiempos y costos/i.test(body)) {
    points.push(`Support ${prospect} across discovery, solution design, cost estimates, and implementation for client AI projects.`);
  }
  if (/quick wins|pruebas de concepto|rápidos de implementar|airtable|supabase|n8n|zapier|make\.com|\bmake\b(?=\s*(?:,|\/|y\b|o\b|and\b|de\b))/i.test(body)) {
    points.push("Build quick AI automation proofs of concept using tools like n8n, Make, Zapier, Airtable, Supabase, APIs, and agents.");
  }
  if (/ai agents|integrating your crms|different tools|repetitive processes|centralized information/i.test(body)) {
    points.push("Potential builds include AI agents, CRM/tool integrations, centralized information access, and workflow automation.");
  }
  if (!points.length && /web app|employees could use it|roll it out/i.test(body)) {
    points.push("Define the rollout path for a custom AI/software workflow or employee-facing tool.");
  }
  return pointList(points, 3);
}

function extractNextSteps(body) {
  const points = [];
  if (/send (?:you )?(?:the )?(?:doc|document)|share that.*send it to you later today|send it to you later today/i.test(body)) {
    points.push("Prospect to send the website scope doc later today.");
  }
  if (/engineering lead|review.*(?:project|doc)|best fit|tech lead|send.*profile.*(?:best|ai engineer)|profile.*(?:best|ai engineer)/i.test(body)) {
    points.push("Near to review the project with the engineering lead and send the proposed engineer profile.");
  }
  if (/head of marketing|introduce us|send them my link|meeting later this week|include the engineer/i.test(body)) {
    points.push("Schedule an engineer input call or intro with the head of marketing later this week.");
  }
  if (/send (?:you )?(?:all )?(?:the )?information|send.*different models|send profiles|send.*examples|enviamos todo|enviar.*(?:presentación|resumen|algo)|cuente quiénes son ustedes|te enviamos eso/i.test(body)) {
    points.push("Near to send information on fractional and full-time options, plus example profiles or relevant examples.");
  }
  if (/socio.*(?:operaciones|producción|project management)|(?:operaciones|producción|project management).*socio|partner.*(?:operations|production)|hablar con él/i.test(body)) {
    points.push("Prospect to share Near's information with their operations/production partner and align internally.");
  }
  if (/whatsapp|coordinar esa llamada|siguiente llamada|la semana que viene|otra semana/i.test(body)) {
    points.push("Near to coordinate the next call by WhatsApp or calendar, ideally including the prospect's partner.");
  } else if (/calendar link|calendario/i.test(body)) {
    points.push("Near to include a calendar link so the prospect can reconnect if useful.");
  }
  if (/let me look|take a look|i'll decide|decide/i.test(body)) {
    points.push("Prospect to review the information and decide whether to schedule an engineer input call.");
  }
  if (/schedule.*engineer.*next week/i.test(body) && !/let me look|i'll decide/i.test(body)) {
    points.push("Schedule an engineer input call for next week.");
  }
  return pointList(points, 3);
}

function extractDealStage(body, fallback = "") {
  if (/\b(cancelled|canceled)\b/i.test(body)) return "Cancelled";
  if (/\b(no fit|not interested|no budget|unqualified)\b/i.test(body)) return "Unqualified";
  if (/\b(not moving forward|went with|chose another)\b/i.test(body)) return "Lost";
  if (/\blost\b/i.test(body) && /\b(deal|opportunity|contract|vendor|project|client|customer|budget|moving forward)\b/i.test(body)) return "Lost";
  if (/\b(contract signed|signed the contract|agreement signed|ready to sign|send the contract)\b/i.test(body)) return "Contract Signed";
  if (/\b(input call booked|input call scheduled|engineer input call scheduled)\b/i.test(body)) return "Input Call";
  if (/\b(call booked|meeting booked|calendar invite|scheduled for)\b/i.test(body)) return "Call Booked";
  if (/\b(future need|second half|later this year|not now)\b/i.test(body)) return "Future Need";
  if (/\b(interested|send me|send information|take a look|review|decide|fractional|full-time|ai engineer|interes|interesa|me gustaria|miramos si podemos|siguiente llamada|cotizar|propuestas?)\b/i.test(body)) return "Considering";
  return DEAL_STAGES.has(fallback) ? fallback : "";
}

function extractStartDate(body) {
  const match = body.match(/\b(?:start|kick off|begin)\s+(?:on|around|by)?\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s+\d{4})?)\b/i);
  return match ? match[1] : "";
}

function extractHoursPoints(body) {
  if (/20,?\s*40\s*hours/i.test(body)) return "20-40 hours typical; 10-hour minimum";
  const sentences = String(body || "").match(/[^.!?]*(?:\d{1,3}\s*(?:hours|hrs|h)\s*(?:\/?\s*(?:week|wk)|a week|per week)|\d{1,3}\s*hours?)[^.!?]*/gi) || [];
  for (const sentence of sentences) {
    const text = cleanText(sentence);
    if (/replacement|replace oswaldo|oswaldo'?s role|working 40 hours a week/i.test(text)) continue;
    if (!/\b(ai engineer|fractional|package|near|model|per month|monthly|hours per|amount of hours|proposal)\b/i.test(text)) continue;
    const match = text.match(/\b\d{1,3}\s*(?:hours|hrs|h)(?:\s*(?:\/?\s*(?:week|wk)|a week|per week|per month|monthly))?\b/i);
    if (match) return match[0];
  }
  return "";
}

function hasTranscriptLeak(value) {
  const text = String(value || "");
  if (!cleanText(text)) return false;
  return /@\d{1,2}:\d{2}\s*-/i.test(text)
    || /\b(VIEW RECORDING|Transcript:|Call title:)\b/i.test(text)
    || /\b(?:Camila Bagnati|Franco|Near|Client|Speaker)\s*:/i.test(text)
    || text.length > 900;
}

function isWeakValue(value) {
  return /^(?:not captured|not discussed|not mentioned|unknown|none|n\/a|na|tbd|no notes?)\.?$/i.test(cleanText(value));
}

function isScopeLikeNeed(value) {
  const text = cleanText(value);
  return /\b(engineer input call|estimate hours|potential builds|workflow automation|project scope|rollout path)\b/i.test(text)
    && !/\b(explor|consider|trying|need|want|looking|evaluate|interested)\b/i.test(text);
}

function safeField(value, { allowLong = false, nextStep = false } = {}) {
  const text = cleanText(value);
  if (!text) return "";
  if (isWeakValue(text)) return "";
  if (hasTranscriptLeak(text)) return "";
  if (!allowLong && text.length > 700) return "";
  if (nextStep && isWeakNextStep(text)) return "";
  return text;
}

function isWeakNextStep(value) {
  const text = cleanText(value);
  if (!text) return true;
  if (/\b(they would suggest|would suggest how|suggest an amount|if you agree|if you're ready|work product|next steps? (?:are|is) unclear)\b/i.test(text)) {
    return true;
  }
  if (/\b(?:continue|touch base|circle back|follow up|keep in touch|discuss further)\b/i.test(text)
    && !/\b(?:Near|Franco|Camila|Cami|prospect|client|customer|company|lead)\b/i.test(text)) {
    return true;
  }
  if (/^(?:next steps?|follow[-\s]?up|action items?):?\s*$/i.test(text)) return true;
  if (/^(?:follow up|schedule a follow[-\s]?up|continue the conversation)\.?$/i.test(text)) return true;
  return false;
}

function chooseField(primary, fallback, options) {
  const safePrimary = safeField(primary, options);
  const safeFallback = safeField(fallback, options);
  if (options?.need && safeFallback && isScopeLikeNeed(safePrimary)) return safeFallback;
  if (options?.preferSpecific && safePrimary && safeFallback && isGenericCallField(safePrimary) && specificityScore(safeFallback) > specificityScore(safePrimary)) {
    return safeFallback;
  }
  return firstNonEmpty(safePrimary, safeFallback);
}

function isGenericCallField(value) {
  return /\b(mapped, built, and rolled out|engineer input call to define one priority workflow|best rollout path|custom AI\/software build|exploring fractional AI engineering support)\b/i.test(cleanText(value));
}

function specificityScore(value) {
  const text = cleanText(value);
  const markers = text.match(/\b(website|migration|github|marketing|scope doc|head of marketing|fit4travel|retreat|course|department|sops?|internal|oswaldo|profile|engineering lead)\b/gi) || [];
  return markers.length + Math.min(5, Math.floor(text.length / 90));
}

function chooseDealStage(primary, fallback) {
  const primaryStage = cleanText(primary);
  const fallbackStage = cleanText(fallback);
  const terminalStages = new Set(["Contract Signed", "Lost", "Unqualified", "Cancelled"]);
  if (fallbackStage && terminalStages.has(primaryStage) && primaryStage !== fallbackStage) return fallbackStage;
  if (DEAL_STAGES.has(primaryStage)) return primaryStage;
  return DEAL_STAGES.has(fallbackStage) ? fallbackStage : "";
}

function heuristicCallExtraction(text) {
  const raw = String(text || "");
  const focusedRaw = focusTranscriptForExtraction(raw);
  const body = cleanText(focusedRaw);
  const turns = parseTranscriptTurns(focusedRaw);
  const company = extractCompanyName(raw);
  const companyDomain = extractCompanyDomain(raw);
  const skills = collectSkills(body);
  const pricing = extractPricingPoints(body)
    || (body.match(/\$[0-9,]+(?:\s*\/\s*(?:month|mo|hour|hr|week))?/i) || [])[0]
    || (body.match(/\b(?:usd|us\$)?\s*[0-9]{2,4}\s*(?:d[oó]lares|usd)?\s*(?:la hora|por hora|\/\s*(?:hour|hr)|per hour)\b/i) || [])[0]
    || "";
  const hours = extractHoursPoints(body);

  return {
    company,
    company_domain: companyDomain,
    contact_name: extractContactName(raw),
    contact_email: firstExternalEmail(raw),
    deal_stage: extractDealStage(body),
    pricing,
    hours_per_week: hours,
    engineer_type: skills ? (/architect/i.test(body) ? "AI Automation Engineer / AI Architect" : "AI Automation Engineer") : "",
    need: extractNeedPoints(body),
    pain_points: extractPainPoints(body),
    key_questions: keyQuestionsFromTurns(turns, company),
    skills_needed: skills,
    project_scope: extractScopePoints(body, company),
    start_date: extractStartDate(body),
    next_steps: extractNextSteps(body),
    notes: "",
    if_lost_reason: ""
  };
}

function normalizeCallFields(fields = {}, fallbackFields = {}) {
  const keyQuestions = firstNonEmpty(
    sanitizeKeyQuestions(fields.key_questions),
    sanitizeKeyQuestions(fallbackFields.key_questions)
  );
  const normalized = {
    ...fields,
    company: chooseField(fields.company, fallbackFields.company),
    company_domain: chooseField(fields.company_domain, fallbackFields.company_domain),
    contact_name: chooseField(fields.contact_name, fallbackFields.contact_name),
    contact_email: chooseField(fields.contact_email, fallbackFields.contact_email),
    deal_stage: chooseDealStage(fields.deal_stage, fallbackFields.deal_stage),
    need: compactField(chooseField(fields.need || fields.project_scope, fallbackFields.need || fallbackFields.project_scope, { need: true, preferSpecific: true }), 3, 520),
    pain_points: compactField(chooseField(fields.pain_points, fallbackFields.pain_points), 3, 520),
    key_questions: compactField(keyQuestions, 5, 700),
    pricing: compactField(chooseField(fields.pricing, fallbackFields.pricing), 4, 520),
    hours_per_week: chooseField(fields.hours_per_week, fallbackFields.hours_per_week),
    engineer_type: chooseField(fields.engineer_type, fallbackFields.engineer_type),
    skills_needed: compactField(chooseField(fields.skills_needed, fallbackFields.skills_needed), 6, 520),
    project_scope: compactField(chooseField(fields.project_scope, fallbackFields.project_scope, { preferSpecific: true }), 3, 650),
    start_date: chooseField(fallbackFields.start_date, ""),
    next_steps: compactField(chooseField(fields.next_steps, fallbackFields.next_steps, { nextStep: true }), 3, 620),
    if_lost_reason: compactField(chooseField(fields.if_lost_reason, fallbackFields.if_lost_reason), 1, 220)
  };
  if (!normalized.deal_stage && fallbackFields.deal_stage) normalized.deal_stage = fallbackFields.deal_stage;
  normalized.notes = formatCallSummary(normalized);
  return normalized;
}

async function extractCallFields(config, transcriptText) {
  const focusedText = focusTranscriptForExtraction(transcriptText);
  const fallback = heuristicCallExtraction(transcriptText);
  try {
    const ai = await extractCallFieldsWithOpenAI(config, focusedText);
    if (Object.keys(ai).length > 0) return normalizeCallFields(ai, fallback);
  } catch (error) {
    console.warn("OpenAI extraction failed; using heuristic extraction", error.message);
  }
  return normalizeCallFields(fallback);
}

module.exports = {
  extractCallFields,
  focusTranscriptForExtraction,
  heuristicCallExtraction,
  normalizeCallFields,
  parseTranscriptTurns
};
