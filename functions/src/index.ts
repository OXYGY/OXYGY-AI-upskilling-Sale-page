import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { callGemini, fetchWithRetry } from "./gemini";
import { sendPitch } from "./sendPitch";

const openRouterApiKey = defineSecret("OPEN_ROUTER_API");

function getEnv() {
  const apiKey = openRouterApiKey.value();
  const model = process.env.GEMINI_MODEL || "google/gemini-3-flash-preview";
  return { apiKey, model };
}

// ═══════════════════════════════════════════════════════════════
// 1. HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

export const health = onRequest({ secrets: [openRouterApiKey] }, (_req, res) => {
  res.status(200).json({
    status: "ok",
    hasApiKey: !!openRouterApiKey.value(),
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. ENHANCE PROMPT
// ═══════════════════════════════════════════════════════════════

const ENHANCE_PROMPT_SYSTEM = `You are the OXYGY Prompt Engineering Coach — an expert in transforming raw, unstructured prompts into well-engineered, structured prompts that produce dramatically better AI outputs.

Your job is to take a user's input and produce an enhanced prompt structured into exactly 6 sections. These 6 sections are called "The Prompt Blueprint":

1. ROLE — Define who the AI should act as. Specify the expertise, perspective, seniority level, and domain knowledge the AI should adopt. Be specific (not just "act as an expert" but "act as a senior change management consultant with 15 years of experience in digital transformation for large enterprises").

2. CONTEXT — Provide the background information the AI needs. Include the situation, environment, constraints, stakeholders involved, timeline, and any relevant details that shape the response. Infer reasonable context from the user's input even if they didn't provide much.

3. TASK — State the specific instruction clearly and precisely. What exactly should the AI produce? Be explicit about the deliverable (e.g., "Write a 500-word email" not "Help me with an email"). If the user was vague, sharpen the task into something concrete and actionable.

4. FORMAT & STRUCTURE — Specify how the output should be organized. Include guidance on length, layout (bullets, tables, paragraphs, numbered lists), tone (formal, conversational, technical), and any structural requirements (e.g., "Include an executive summary at the top").

5. STEPS & PROCESS — Outline the explicit reasoning steps or methodology the AI should follow. Break down the task into a logical sequence (e.g., "First, analyze X. Then, compare with Y. Finally, recommend Z with supporting evidence"). This guides the AI to think systematically rather than jumping to conclusions.

6. QUALITY CHECKS — Define validation rules, constraints, and things the AI should avoid. Include accuracy requirements, tone guardrails, things to exclude, assumptions to avoid, and any quality standards (e.g., "Do not make up statistics. Cite specific examples where possible. Avoid generic corporate language.").

RULES FOR YOUR OUTPUT:

- You must ALWAYS produce all 6 sections, even if the user's input is minimal. Use reasonable inference to fill in sections the user didn't address.
- Each section should be substantive — at least 1-2 sentences, ideally 2-4 sentences.
- Write in a clear, professional, confident tone.
- Do NOT repeat the user's exact words — enhance, expand, and professionalize their intent.
- Do NOT add preamble, commentary, or explanation outside of the 6 sections. Just return the structured prompt.
- If the user's input is very short or vague (e.g., "help me write an email"), make reasonable assumptions and note them within the Context section (e.g., "Assuming this is a professional context...").

You must respond in the following JSON format ONLY — no markdown, no extra text, no code fences:

{
  "role": "The enhanced Role section text",
  "context": "The enhanced Context section text",
  "task": "The enhanced Task section text",
  "format": "The enhanced Format & Structure section text",
  "steps": "The enhanced Steps & Process section text",
  "quality": "The enhanced Quality Checks section text"
}`;

export const enhanceprompt = onRequest({ secrets: [openRouterApiKey] }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const { apiKey, model } = getEnv();
  if (!apiKey) { res.status(503).json({ error: "API key not configured" }); return; }

  try {
    const { mode, prompt, wizardAnswers } = req.body;
    let userMessage: string;
    if (mode === "enhance") {
      userMessage = prompt;
    } else {
      const wa = wizardAnswers;
      const formatText = [...(wa.formatChips || []), wa.formatCustom || ""].filter(Boolean).join(", ") || "Not specified";
      const qualityText = [...(wa.qualityChips || []), wa.qualityCustom || ""].filter(Boolean).join(", ") || "Not specified";
      userMessage = `The user wants to build a prompt with the following inputs:\n\nRole: ${wa.role || "Not specified"}\nContext: ${wa.context || "Not specified"}\nTask: ${wa.task || "Not specified"}\nFormat preferences: ${formatText}\nSteps: ${wa.steps || "Not specified"}\nQuality constraints: ${qualityText}\n\nPlease enhance and expand each section into a polished, comprehensive prompt following The Prompt Blueprint framework.`;
    }

    const result = await callGemini({ apiKey, model, systemPrompt: ENHANCE_PROMPT_SYSTEM, userMessage, label: "enhance-prompt" });
    if (!result.ok) { res.status(result.status).json({ error: result.message, retryable: result.retryable }); return; }
    res.status(200).json(result.data);
  } catch (err) {
    console.error("enhance-prompt error:", err);
    res.status(500).json({ error: "Internal server error", retryable: true });
  }
});

// ═══════════════════════════════════════════════════════════════
// 3. SUMMARIZE ROLE
// ═══════════════════════════════════════════════════════════════

const SUMMARIZE_ROLE_SYSTEM = `You are a concise profile summarizer. Given a user's role description, produce a short professional title (max 8 words). Return ONLY the title text, nothing else. Examples:
- Input: "I'm the Head of the AI Centre of Excellence. My goal is to improve the adoption of AI within the organisation, upscale the rest of the team..."
- Output: "Head of AI Centre of Excellence"
- Input: "I work as a marketing manager and I'm responsible for digital campaigns and brand strategy across EMEA"
- Output: "Marketing Manager — Digital & Brand Strategy"
- Input: "Software engineer focused on backend APIs and data pipelines for our analytics platform"
- Output: "Backend Engineer — Analytics Platform"`;

export const summarizerole = onRequest({ secrets: [openRouterApiKey] }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const { apiKey, model } = getEnv();
  if (!apiKey) { res.status(503).json({ error: "API key not configured" }); return; }

  try {
    const { role } = req.body;
    if (!role || typeof role !== "string" || role.trim().length < 10) {
      res.status(400).json({ error: "Role text too short to summarize" }); return;
    }

    const openRouterModel = model.startsWith("google/") ? model : `google/${model}`;
    const geminiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: openRouterModel,
        messages: [
          { role: "system", content: SUMMARIZE_ROLE_SYSTEM },
          { role: "user", content: role },
        ],
        temperature: 0.2,
        max_tokens: 30,
      }),
    });

    if (!geminiResponse.ok) {
      console.error("OpenRouter API error (summarize-role):", geminiResponse.status);
      res.status(502).json({ error: "AI service unavailable" }); return;
    }

    const data = await geminiResponse.json();
    const summary = data?.choices?.[0]?.message?.content?.trim() || "";
    res.status(200).json({ summary });
  } catch (err) {
    console.error("summarize-role error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ═══════════════════════════════════════════════════════════════
// 4. DESIGN AGENT
// ═══════════════════════════════════════════════════════════════

const DESIGN_AGENT_SYSTEM = `You are the OXYGY Agent Design Advisor — an expert in helping people design effective, reusable, and accountable AI agents for professional use.

You will receive a description of a task that a user wants to build an AI agent for, and optionally a description of the input data that agent will process.

You must respond with a JSON object containing exactly 4 sections that correspond to the 4 steps of the Agent Builder Toolkit:

SECTION 1: AGENT READINESS ASSESSMENT
Evaluate the task against 5 criteria to determine if it warrants a custom agent:
- Frequency: How often is this task likely performed? (Score 0-100)
- Consistency: Does the output need the same structure each time? (Score 0-100)
- Shareability: Would others on the team benefit from this same tool? (Score 0-100)
- Complexity: Does it require domain expertise or multi-step reasoning? (Score 0-100)
- Standardization Risk: Would variable outputs cause downstream problems? (Score 0-100)

Calculate an overall score (weighted average — Frequency 20%, Consistency 25%, Shareability 20%, Complexity 15%, Standardization Risk 20%).

Provide a verdict, a rationale paragraph, and specific bullet points for why Level 1 ad-hoc prompting might suffice vs. why a Level 2 custom agent is recommended.

SECTION 2: OUTPUT FORMAT DESIGN
Based on the task, design a structured output format in two representations:
a) A human-readable version — formatted as clean, professional output that a team member would want to read.
b) A JSON template — the exact JSON schema that the agent should produce.

SECTION 3: SYSTEM PROMPT
Generate a complete, ready-to-use system prompt for this agent that incorporates:
- A clear role definition
- Context about the task and domain
- Explicit task instructions
- The JSON output format from Section 2
- Step-by-step processing instructions
- Quality checks and constraints
- Human-in-the-loop requirements from Section 4

Mark each section with labels: [ROLE], [CONTEXT], [TASK], [OUTPUT FORMAT], [STEPS], [QUALITY CHECKS].

SECTION 4: BUILT-IN ACCOUNTABILITY FEATURES
Design 3-5 specific features built into the agent's prompt to actively support human oversight. Each must include: name, severity (critical/important/recommended), what_to_verify, why_it_matters, prompt_instruction.

RESPONSE FORMAT (JSON only, no markdown):

{
  "readiness": {
    "overall_score": 85,
    "verdict": "Strong candidate for a custom agent",
    "rationale": "...",
    "criteria": {
      "frequency": { "score": 90, "assessment": "..." },
      "consistency": { "score": 85, "assessment": "..." },
      "shareability": { "score": 80, "assessment": "..." },
      "complexity": { "score": 75, "assessment": "..." },
      "standardization_risk": { "score": 90, "assessment": "..." }
    },
    "level1_points": ["..."],
    "level2_points": ["..."]
  },
  "output_format": {
    "human_readable": "...",
    "json_template": {}
  },
  "system_prompt": "...",
  "accountability": [
    { "name": "...", "severity": "critical", "what_to_verify": "...", "why_it_matters": "...", "prompt_instruction": "..." }
  ]
}`;

export const designagent = onRequest({ secrets: [openRouterApiKey], timeoutSeconds: 120 }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const { apiKey, model } = getEnv();
  if (!apiKey) { res.status(503).json({ error: "API key not configured" }); return; }

  try {
    const { task_description, input_data_description } = req.body;
    const userMessage = `Task Description: ${task_description}\n\nInput Data Description: ${input_data_description || "Not specified"}`;

    const result = await callGemini({ apiKey, model, systemPrompt: DESIGN_AGENT_SYSTEM, userMessage, label: "design-agent" });
    if (!result.ok) { res.status(result.status).json({ error: result.message, retryable: result.retryable }); return; }
    res.status(200).json(result.data);
  } catch (err) {
    console.error("design-agent error:", err);
    res.status(500).json({ error: "Internal server error", retryable: true });
  }
});

// ═══════════════════════════════════════════════════════════════
// 5. DESIGN WORKFLOW
// ═══════════════════════════════════════════════════════════════

const WORKFLOW_PATH_A = `You are the OXYGY Workflow Architect — an expert in designing AI-powered automation workflows. You help users map their business processes into structured, multi-step workflows using a node-based system.

You will receive a description of a process the user wants to automate, and optionally a description of their existing tools and systems.

Your job is to design an optimal workflow using nodes from three layers:

LAYER 1 — DATA INPUT NODES:
input-excel, input-gsheets, input-webhook, input-api, input-form, input-email, input-schedule, input-database, input-file, input-crm, input-chat, input-transcript

LAYER 2 — PROCESSING NODES:
proc-ai-agent, proc-ai-loop, proc-text-extract, proc-code, proc-mapper, proc-filter, proc-merge, proc-sentiment, proc-classifier, proc-summarizer, proc-translate, proc-validator, proc-human-review

LAYER 3 — DATA OUTPUT NODES:
output-excel, output-gsheets, output-database, output-email, output-slack, output-pdf, output-word, output-pptx, output-api, output-crm, output-dashboard, output-notification, output-calendar, output-kb

RULES:
- Every workflow must have at least one node from each layer
- Workflows typically have 4-10 nodes total
- Include a proc-human-review node whenever AI output feeds directly into client-facing, decision-critical, or externally shared deliverables

RESPONSE FORMAT (JSON only):
{
  "workflow_name": "...",
  "workflow_description": "...",
  "nodes": [
    { "id": "node-1", "node_id": "input-form", "name": "Survey Submission", "custom_description": "...", "layer": "input" }
  ]
}`;

const WORKFLOW_PATH_B = `You are the OXYGY Workflow Reviewer — an expert in evaluating and improving AI-powered automation workflows.

You will receive the user's manually-built workflow and optionally their rationale. Review and suggest improvements (add, remove, reorder, or keep unchanged).

AVAILABLE NODES: Same as the Workflow Architect (input-*, proc-*, output-*).

RESPONSE FORMAT (JSON only):
{
  "overall_assessment": "...",
  "suggested_workflow": [
    { "id": "node-1", "node_id": "...", "name": "...", "custom_description": "...", "layer": "...", "status": "unchanged|added|removed" }
  ],
  "changes": [
    { "type": "added|removed|reordered", "node_id": "...", "node_name": "...", "rationale": "..." }
  ]
}`;

export const designworkflow = onRequest({ secrets: [openRouterApiKey], timeoutSeconds: 120 }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const { apiKey, model } = getEnv();
  if (!apiKey) { res.status(503).json({ error: "API key not configured" }); return; }

  try {
    const { mode, task_description, tools_and_systems, user_workflow, user_rationale } = req.body;
    const systemPrompt = mode === "auto_generate" ? WORKFLOW_PATH_A : WORKFLOW_PATH_B;

    let userMessage: string;
    if (mode === "auto_generate") {
      userMessage = `Process to automate: ${task_description}\n\nExisting tools and systems: ${tools_and_systems || "Not specified"}`;
    } else {
      const nodeList = (user_workflow || [])
        .map((n: { id: string; node_id: string; name: string; layer: string }) => `  ${n.id}: ${n.node_id} ("${n.name}") [${n.layer}]`)
        .join("\n");
      userMessage = `Process to automate: ${task_description}\n\nExisting tools and systems: ${tools_and_systems || "Not specified"}\n\nUser's workflow:\n${nodeList}\n\nUser's design rationale: ${user_rationale || "Not provided"}`;
    }

    const result = await callGemini({ apiKey, model, systemPrompt, userMessage, label: "design-workflow" });
    if (!result.ok) { res.status(result.status).json({ error: result.message, retryable: result.retryable }); return; }
    res.status(200).json(result.data);
  } catch (err) {
    console.error("design-workflow error:", err);
    res.status(500).json({ error: "Internal server error", retryable: true });
  }
});

// ═══════════════════════════════════════════════════════════════
// 6. ANALYZE ARCHITECTURE
// ═══════════════════════════════════════════════════════════════

const ARCHITECTURE_SYSTEM = `You are the OXYGY AI Build Plan Advisor — an expert in helping business professionals plan AI-powered applications using a 5-tool development pipeline.

You will receive a user's project details including their app description, target users and problem, data/feature needs, and technical comfort level. Generate a personalized build plan for their specific project.

THE 5-TOOL PIPELINE:
1. Google AI Studio — Rapid prototyping
2. GitHub — Version control and collaboration
3. Claude Code — AI-powered development tool
4. Supabase — Database, authentication, and backend infrastructure
5. Vercel — Deployment platform

For each tool, generate: classification (essential/recommended/optional), forYourProject, howToApproach, tips (array of 3), levelConnection, connectedLevels.

Respond with ONLY JSON — no markdown, no extra text.`;

export const analyzearchitecture = onRequest({ secrets: [openRouterApiKey], timeoutSeconds: 120 }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const { apiKey, model } = getEnv();
  if (!apiKey) { res.status(503).json({ error: "API key not configured" }); return; }

  try {
    const { appDescription, problemAndUsers, dataAndContent, technicalLevel } = req.body;
    const techLabels: Record<string, string> = {
      "non-technical": "Non-technical (never written code, not planning to)",
      "semi-technical": "Semi-technical (comfortable with no-code tools, can follow technical instructions)",
      "technical": "Technical (some coding experience or willing to learn)",
    };
    const userMessage = [
      `APP DESCRIPTION:\n${appDescription || "Not provided"}`,
      `PROBLEM & USERS:\n${problemAndUsers || "Not provided"}`,
      `DATA & KEY FEATURES:\n${dataAndContent || "Not provided"}`,
      `TECHNICAL COMFORT LEVEL: ${techLabels[technicalLevel || ""] || technicalLevel || "Not specified"}`,
    ].join("\n\n");

    const result = await callGemini({ apiKey, model, systemPrompt: ARCHITECTURE_SYSTEM, userMessage, label: "analyze-architecture" });
    if (!result.ok) { res.status(result.status).json({ error: result.message, retryable: result.retryable }); return; }
    res.status(200).json(result.data);
  } catch (err) {
    console.error("analyze-architecture error:", err);
    res.status(500).json({ error: "Internal server error", retryable: true });
  }
});

// ═══════════════════════════════════════════════════════════════
// 7. ANALYZE INSIGHT
// ═══════════════════════════════════════════════════════════════

const INSIGHT_SYSTEM = `You are an AI Upskilling Coach for the OXYGY AI Centre of Excellence. You analyze how learners apply AI in their work and give concise, actionable feedback.

CRITICAL RULE — QUALITY GATE:
Before providing analysis, assess whether the learner has given enough meaningful information. If too vague, nonsensical, or too short (<15 words), respond with the clarification format instead.

RESPONSE FORMAT — Choose ONE:

FORMAT A (needs clarification):
{ "needsClarification": true, "clarificationMessage": "...", "useCaseSummary": "", "nextLevelTranslation": "", "considerations": [], "nextSteps": "" }

FORMAT B (full analysis):
{ "needsClarification": false, "useCaseSummary": "...", "nextLevelTranslation": "...", "considerations": ["...", "..."], "nextSteps": "..." }

RULES: Keep text concise. No filler. Be direct and useful. Respond in valid JSON only.`;

export const analyzeinsight = onRequest({ secrets: [openRouterApiKey] }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const { apiKey, model } = getEnv();
  if (!apiKey) { res.status(503).json({ error: "API key not configured" }); return; }

  try {
    const { level, topic, context, outcome, rating, userProfile } = req.body;
    const profileContext = userProfile
      ? `\n\nLearner Profile:\n- Role: ${userProfile.role || "Not specified"}\n- Function: ${userProfile.function || "Not specified"}\n- Seniority: ${userProfile.seniority || "Not specified"}\n- AI Experience Level: ${userProfile.aiExperience || "Not specified"}`
      : "";
    const userMessage = `Please analyze this AI application insight:\n\nLevel: ${level}\nTopic: ${topic}\nContext: ${context}\nOutcome: ${outcome}\nSelf-assessed Impact Rating: ${rating}/5${profileContext}`;

    const result = await callGemini({ apiKey, model, systemPrompt: INSIGHT_SYSTEM, userMessage, label: "analyze-insight" });
    if (!result.ok) { res.status(result.status).json({ error: result.message, retryable: result.retryable }); return; }
    res.status(200).json(result.data);
  } catch (err) {
    console.error("analyze-insight error:", err);
    res.status(500).json({ error: "Internal server error", retryable: true });
  }
});

// ═══════════════════════════════════════════════════════════════
// 8. GENERATE PATHWAY
// ═══════════════════════════════════════════════════════════════

const PATHWAY_SYSTEM = `You are a learning pathway designer for OXYGY's AI Centre of Excellence. You generate personalized, project-based learning pathways for professionals who want to develop AI skills.

Your outputs must be:
- Practical and actionable — every project should be something the learner can start within a week
- Role-specific — projects should directly relate to the learner's stated function and challenge
- Empathetic — acknowledge where the learner is starting from and build confidence
- Connected — explicitly reference how each project relates to the learner's specific challenge

OUTPUT RULES (non-negotiable):
- Respond with a single JSON object and nothing else
- The root object MUST have exactly three top-level keys: "pathwaySummary", "totalEstimatedWeeks", "levels"
- Do NOT wrap the JSON in any outer object, array, or key (e.g. never use "pathway", "result", "data" as a wrapper)
- Do NOT include markdown, backticks, code fences, or any text before or after the JSON
- Your response must begin with { and end with }

CRITICAL: In the "challengeConnection" field for EVERY level, you MUST directly reference and quote specific details from the user's stated challenge. This is the most important personalization element — the learner should feel that this pathway was built specifically for their situation.

IMPORTANT: Level 1 and Level 2 are MANDATORY — always "full" or "fast-track", never "awareness" or "skip". Only Levels 3, 4, and 5 may be "awareness" or "skip".

Generate content ONLY for levels classified as "full" or "fast-track".

Your entire response must be a single JSON object with exactly these three top-level keys: "pathwaySummary", "totalEstimatedWeeks", "levels". No wrapper, no preamble, no markdown.

Example structure (include as many levels as applicable — L1 and L2 are always present):

{
  "pathwaySummary": "1-2 sentence personalized overview of their pathway",
  "totalEstimatedWeeks": 8,
  "levels": {
    "L1": {
      "depth": "full",
      "projectTitle": "string",
      "projectDescription": "string",
      "deliverable": "string",
      "challengeConnection": "string",
      "sessionFormat": "string",
      "resources": [{ "name": "string", "note": "string" }]
    },
    "L2": {
      "depth": "fast-track",
      "projectTitle": "string",
      "projectDescription": "string",
      "deliverable": "string",
      "challengeConnection": "string",
      "sessionFormat": "string",
      "resources": [{ "name": "string", "note": "string" }]
    },
    "L3": {
      "depth": "full",
      "projectTitle": "string",
      "projectDescription": "string",
      "deliverable": "string",
      "challengeConnection": "string",
      "sessionFormat": "string",
      "resources": [{ "name": "string", "note": "string" }]
    }
  }
}

Rules:
- Only include levels classified as "full" or "fast-track" in the "levels" object
- Omit "awareness" and "skip" levels from the JSON entirely
- Level keys must be exactly "L1", "L2", "L3", "L4", "L5" — no other keys inside "levels"
- "depth" value must be exactly "full" or "fast-track" — no other values
- Do not add any keys not shown in the example above`;

export const generatepathway = onRequest({ secrets: [openRouterApiKey], timeoutSeconds: 120 }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const { apiKey, model } = getEnv();
  if (!apiKey) { res.status(503).json({ error: "API key not configured" }); return; }

  try {
    const { formData, levelDepths } = req.body;

    const ambitionLabels: Record<string, string> = {
      "confident-daily-use": "Confident daily AI use",
      "build-reusable-tools": "Build reusable AI tools",
      "own-ai-processes": "Design and own AI-powered processes",
      "build-full-apps": "Build full AI-powered applications",
    };
    const experienceLabels: Record<string, string> = {
      "beginner": "Beginner — rarely uses AI tools",
      "comfortable-user": "Comfortable User — uses ChatGPT or similar regularly",
      "builder": "Builder — has created custom GPTs, agents, or prompt templates",
      "integrator": "Integrator — has designed AI-powered workflows or multi-step pipelines",
    };

    const userMessage = `Generate a personalized learning pathway for the following professional.

## LEARNER PROFILE
- Role: ${formData.role || "Not specified"}
- Function: ${formData.function === "Other" ? formData.functionOther : formData.function || "Not specified"}
- Seniority: ${formData.seniority || "Not specified"}
- AI Experience: ${experienceLabels[formData.aiExperience] || formData.aiExperience || "Not specified"}
- Ambition: ${ambitionLabels[formData.ambition] || formData.ambition || "Not specified"}
- Specific Challenge: "${formData.challenge || "Not specified"}"
- Weekly Availability: ${formData.availability || "Not specified"}${formData.experienceDescription ? `\n- AI Experience Details: "${formData.experienceDescription}"` : ""}${formData.goalDescription ? `\n- Specific Goal: "${formData.goalDescription}"` : ""}

## LEVEL CLASSIFICATIONS
- Level 1: ${levelDepths.L1}
- Level 2: ${levelDepths.L2}
- Level 3: ${levelDepths.L3}
- Level 4: ${levelDepths.L4}
- Level 5: ${levelDepths.L5}`;

    const result = await callGemini({ apiKey, model, systemPrompt: PATHWAY_SYSTEM, userMessage, label: "generate-pathway" });
    if (!result.ok) { res.status(result.status).json({ error: result.message, retryable: result.retryable }); return; }
    res.status(200).json(result.data);
  } catch (err) {
    console.error("generate-pathway error:", err);
    res.status(500).json({ error: "Internal server error", retryable: true });
  }
});

// ═══════════════════════════════════════════════════════════════
// 9. DESIGN DASHBOARD
// ═══════════════════════════════════════════════════════════════

const DASHBOARD_HTML_FALLBACK = `You are an elite UI designer AND data strategist creating stunning, modern dashboard mockups. Your dashboards should look like they belong on Dribbble or Behance.

METRIC REQUIREMENTS: Include EVERY metric the user listed. Infer 3-5 additional relevant metrics.

DESIGN AESTHETIC: MINIMAL and AIRY. Font: 'DM Sans'. Background: #F8FAFC. Cards: white, border-radius: 16px, border: 1px solid #E2E8F0. Colors: Primary #38B2AC, Secondary #5B6DC2, Accent #D47B5A. NO sidebars, NO navigation menus, NO buttons.

RESPONSE FORMAT (JSON only):
{ "image_url": "", "image_prompt": "...", "html_content": "<!DOCTYPE html><html>...</html>" }

The html_content MUST fit inside a 1100x700px iframe WITHOUT scrolling.`;

const DASHBOARD_INSPIRATION = `You are an expert UI/UX analyst specializing in dashboard design. Analyze the provided dashboard screenshot(s) and extract the key design patterns. Output a concise paragraph (3-5 sentences) describing these patterns as design instructions.`;

const DASHBOARD_REFINEMENT = `You are an expert at refining image generation prompts for dashboard mockups. Produce a NEW, complete prompt that incorporates user feedback while keeping all good parts of the original. Output ONLY the refined prompt text.`;

function parseInspirationImage(img: string): { inlineData: { mimeType: string; data: string } } | null {
  if (!img.startsWith("data:")) return null;
  const commaIdx = img.indexOf(",");
  if (commaIdx === -1) return null;
  const header = img.slice(5, commaIdx);
  const semiIdx = header.indexOf(";");
  if (semiIdx === -1) return null;
  const mimeType = header.slice(0, semiIdx);
  const data = img.slice(commaIdx + 1);
  if (!mimeType.startsWith("image/") || !data) return null;
  return { inlineData: { mimeType, data } };
}

export const designdashboard = onRequest({ secrets: [openRouterApiKey], timeoutSeconds: 120 }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const { apiKey, model: textModel } = getEnv();
  const imageModel = process.env.DASHBOARD_MODEL || "google/gemini-3.1-flash-image-preview";
  if (!apiKey) { res.status(503).json({ error: "API key not configured", use_fallback: true }); return; }

  try {
    const {
      user_needs, target_audience, key_metrics, data_sources,
      dashboard_type, visual_style, inspiration_url,
      refinement_feedback, previous_prompt, inspiration_images,
    } = req.body;

    const styleDesc = visual_style === "data-dense" ? "data-dense with maximum information density"
      : visual_style === "executive-polished" ? "executive and polished with large KPI cards"
      : visual_style === "colorful-visual" ? "colorful and visual with bold infographic style"
      : "clean and minimal with lots of whitespace";

    // Analyze inspiration images if provided
    let inspirationPatterns = "";
    if (inspiration_images && Array.isArray(inspiration_images) && inspiration_images.length > 0) {
      try {
        const imageParts = inspiration_images.map(parseInspirationImage).filter(Boolean);
        const openRouterModel = textModel.startsWith("google/") ? textModel : `google/${textModel}`;
        if (imageParts.length > 0) {
          const imageUrls = imageParts.map((p: any) => ({
            type: "image_url",
            image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` },
          }));
          const analyzeResponse = await fetchWithRetry("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: openRouterModel,
              messages: [
                { role: "system", content: DASHBOARD_INSPIRATION },
                {
                  role: "user",
                  content: [
                    { type: "text", text: "Analyze these dashboard screenshot(s) and extract the key design patterns:" },
                    ...imageUrls,
                  ],
                },
              ],
              temperature: 0.3,
            }),
          }, "dashboard-inspiration");
          if (analyzeResponse.ok) {
            const analyzeData = await analyzeResponse.json();
            const patterns = analyzeData?.choices?.[0]?.message?.content || "";
            if (patterns.trim()) inspirationPatterns = patterns.trim();
          }
        }
      } catch (analyzeErr) {
        console.log("Inspiration analysis error, continuing without it:", analyzeErr);
      }
    }

    // Build image generation prompt
    let imagePrompt: string;
    if (refinement_feedback && previous_prompt) {
      const refinementModel = textModel.startsWith("google/") ? textModel : `google/${textModel}`;
      const inspirationContext = inspirationPatterns ? `\n\nDESIGN REFERENCE: ${inspirationPatterns}` : "";
      const refinementResponse = await fetchWithRetry("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: refinementModel,
          messages: [
            { role: "system", content: DASHBOARD_REFINEMENT },
            { role: "user", content: `ORIGINAL PROMPT:\n${previous_prompt}\n\nUSER FEEDBACK:\n${refinement_feedback}${inspirationContext}\n\nGenerate the refined prompt:` },
          ],
          temperature: 0.4,
        }),
      }, "dashboard-refinement");

      if (refinementResponse.ok) {
        const refinementData = await refinementResponse.json();
        const refinedText = refinementData?.choices?.[0]?.message?.content || "";
        imagePrompt = refinedText.trim() || `${previous_prompt} IMPORTANT CHANGES REQUESTED: ${refinement_feedback}`;
      } else {
        imagePrompt = `${previous_prompt} IMPORTANT CHANGES REQUESTED: ${refinement_feedback}`;
      }
    } else {
      imagePrompt = `Generate a high-fidelity professional dashboard UI screenshot mockup for ${target_audience || "business users"}. The dashboard shows: ${key_metrics || "key business metrics"}. Purpose: ${user_needs}. Style: ${styleDesc}. ${dashboard_type ? `Type: ${dashboard_type}.` : ""} Modern flat design, white background with subtle gray borders, teal and navy color scheme. DM Sans font. Make ALL text crisp and readable. 16:9 aspect ratio.${inspirationPatterns ? `\n\nDESIGN REFERENCE: ${inspirationPatterns}` : ""}`;
    }

    // Strategy 1: Try image generation with Nano Banana 2
    const imgModel = imageModel.startsWith("google/") ? imageModel : `google/${imageModel}`;
    console.log("Strategy 1: Attempting image generation with", imgModel);

    try {
      const imageResponse = await fetchWithRetry("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: imgModel,
          messages: [{ role: "user", content: imagePrompt }],
          temperature: 0.7,
        }),
      }, "dashboard-image");

      if (imageResponse.ok) {
        const imageData = await imageResponse.json();
        const message = imageData?.choices?.[0]?.message;

        // OpenRouter returns images in message.images array
        const images = message?.images;
        if (Array.isArray(images) && images.length > 0) {
          const imagePart = images.find((p: any) => p.type === "image_url" && p.image_url?.url);
          if (imagePart) {
            console.log("Image generated successfully via Nano Banana 2");
            res.status(200).json({ image_url: imagePart.image_url.url, image_prompt: imagePrompt, generation_method: "gemini-image" });
            return;
          }
        }

        // Also check content array (alternative format)
        const content = message?.content;
        if (Array.isArray(content)) {
          const contentImg = content.find((p: any) => p.type === "image_url" && p.image_url?.url);
          if (contentImg) {
            res.status(200).json({ image_url: contentImg.image_url.url, image_prompt: imagePrompt, generation_method: "gemini-image" });
            return;
          }
        }

        console.log("Image model responded but no image found, falling back to HTML");
      } else {
        console.log("Image generation failed with status", imageResponse.status, ", falling back to HTML");
      }
    } catch (imgErr) {
      console.log("Image generation error, falling back to HTML:", imgErr);
    }

    // Strategy 2: Fall back to HTML dashboard generation
    console.log("Strategy 2: Generating HTML dashboard with", textModel);
    const userMessage = [
      `DASHBOARD PURPOSE: ${user_needs}`,
      target_audience ? `TARGET AUDIENCE: ${target_audience}` : "",
      key_metrics ? `KEY METRICS: ${key_metrics}` : "",
      data_sources ? `DATA SOURCES: ${data_sources}` : "",
      dashboard_type ? `DASHBOARD TYPE: ${dashboard_type}` : "",
      visual_style ? `VISUAL STYLE: ${visual_style}` : "",
      inspiration_url ? `INSPIRATION URL: ${inspiration_url}` : "",
    ].filter(Boolean).join("\n");

    const result = await callGemini({ apiKey, model: textModel, systemPrompt: DASHBOARD_HTML_FALLBACK, userMessage, label: "dashboard-html" });
    if (!result.ok) { res.status(result.status).json({ error: result.message, use_fallback: true, retryable: result.retryable }); return; }
    result.data.generation_method = "html";
    res.status(200).json(result.data);
  } catch (err) {
    console.error("design-dashboard error:", err);
    res.status(500).json({ error: "Internal server error", use_fallback: true, retryable: true });
  }
});

// ═══════════════════════════════════════════════════════════════
// 10. GENERATE PRD
// ═══════════════════════════════════════════════════════════════

const PRD_SYSTEM = `You are a senior product manager and technical writer specializing in dashboard and data visualization products. You create production-grade Product Requirements Documents (PRDs).

You will receive details about a dashboard project. Generate a comprehensive, detailed, and actionable PRD.

OUTPUT RULES (non-negotiable):
- Respond with a single JSON object and nothing else
- The root object MUST have exactly two top-level keys: "prd_content" and "sections"
- Do NOT wrap the JSON in any outer object, array, or key (e.g. never use "prd", "result", "data", "document" as a wrapper)
- Do NOT include markdown, backticks, code fences, or any text before or after the JSON
- Your response must begin with { and end with }

CRITICAL: Every section value MUST be a plain text STRING, not a JSON object. Use formatted text with newlines and bullets within the string.

RESPONSE FORMAT — your entire response must be exactly this structure:
{
  "prd_content": "PRD: [Dashboard name]",
  "sections": {
    "dashboard_overview": "...",
    "target_users": "...",
    "information_architecture": "...",
    "widget_specifications": "...",
    "visual_design": "...",
    "tech_stack": "...",
    "data_integration": "...",
    "interactions_filtering": "...",
    "responsive_behavior": "...",
    "human_checkpoints": "...",
    "acceptance_criteria": "..."
  }
}

Rules:
- The "sections" object must contain exactly these 11 keys — no additions, no omissions
- All values must be strings (never nested objects or arrays)
- Do not add any keys outside of "prd_content" and "sections" at the root level`;

export const generateprd = onRequest({ secrets: [openRouterApiKey] }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const { apiKey, model } = getEnv();
  if (!apiKey) { res.status(503).json({ error: "API key not configured" }); return; }

  try {
    const { user_needs, image_prompt, target_audience, key_metrics, data_sources, dashboard_type, visual_style, color_scheme, update_frequency } = req.body;
    const userMessage = [
      `DASHBOARD PURPOSE: ${user_needs}`,
      `DASHBOARD DESIGN: ${image_prompt}`,
      target_audience ? `TARGET AUDIENCE: ${target_audience}` : "",
      key_metrics ? `KEY METRICS: ${key_metrics}` : "",
      data_sources ? `DATA SOURCES: ${data_sources}` : "",
      dashboard_type ? `DASHBOARD TYPE: ${dashboard_type}` : "",
      visual_style ? `VISUAL STYLE: ${visual_style}` : "",
      color_scheme ? `COLOR SCHEME: ${color_scheme}` : "",
      update_frequency ? `UPDATE FREQUENCY: ${update_frequency}` : "",
    ].filter(Boolean).join("\n");

    const result = await callGemini({ apiKey, model, systemPrompt: PRD_SYSTEM, userMessage, label: "generate-prd" });
    if (!result.ok) { res.status(result.status).json({ error: result.message, retryable: result.retryable }); return; }
    res.status(200).json(result.data);
  } catch (err) {
    console.error("generate-prd error:", err);
    res.status(500).json({ error: "Internal server error", retryable: true });
  }
});

// ═══════════════════════════════════════════════════════════════
// 11. SEND PITCH CARD (Innovation Sandbox demo)
// ═══════════════════════════════════════════════════════════════

// Best-effort brake on repeat sends from one address; resets when the instance recycles.
const recentSends = new Map<string, number[]>();
function tooManySends(ip: string): boolean {
  const now = Date.now();
  const hits = (recentSends.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  hits.push(now);
  recentSends.set(ip, hits);
  return hits.length > 5;
}

// No secret is bound yet, so this deploys before Resend is set up and replies "not set up" until then.
// To turn email on: run `firebase functions:secrets:set RESEND_API_KEY`, then change the options below to { secrets: ["RESEND_API_KEY"] }.
export const sendpitch = onRequest({}, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  if (tooManySends(req.ip || "unknown")) { res.status(429).json({ error: "Too many sends. Wait a few minutes, or save the PDF instead." }); return; }

  try {
    const result = await sendPitch(process.env.RESEND_API_KEY, req.body);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("send-pitch error:", err);
    res.status(500).json({ error: "The email could not be sent. Try again, or save the PDF instead." });
  }
});
