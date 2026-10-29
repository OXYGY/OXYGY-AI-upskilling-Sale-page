import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import { sendPitch } from './functions/src/sendPitch';
import react from '@vitejs/plugin-react';
import type { Plugin, Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'http';

// ─── Shared retry helper for Gemini API calls ───

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1500;

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  label: string,
): Promise<Response> {
  let lastError: Error | null = null;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, options);

      if (response.ok) return response;

      // If this is a retryable status code and we have retries left, wait and retry
      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < MAX_RETRIES) {
        const retryAfter = response.headers.get('retry-after');
        const delayMs = retryAfter
          ? Math.min(parseInt(retryAfter, 10) * 1000, 10000)
          : BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[${label}] Gemini API returned ${response.status}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        lastResponse = response;
        continue;
      }

      // Non-retryable error or no retries left
      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[${label}] Network error: ${lastError.message}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
    }
  }

  // All retries exhausted
  if (lastResponse) return lastResponse;
  throw lastError || new Error('All retries exhausted');
}

// Calls OpenRouter for a JSON answer and retries the failure modes that come
// back as HTTP 200: an upstream error body (e.g. "504 operation was aborted"),
// empty content, or syntactically malformed JSON (the model occasionally emits
// a stray brace on large nested schemas). Mirrors functions/src/gemini.ts so
// local dev behaves like production. Returns parsed JSON or { __error }.
async function callOpenRouterJSON(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  label: string,
): Promise<any> {
  const openRouterModel = model.startsWith('google/') ? model : `google/${model}`;
  const MAX_ATTEMPTS = 3;
  let lastStatus = 502;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const resp = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: openRouterModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.7,
        max_tokens: 16000,
        response_format: { type: 'json_object' },
      }),
    }, label);

    if (!resp.ok) {
      if (resp.status === 429) return { __error: 429 };
      lastStatus = 502;
      continue;
    }
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || '';
    if (data?.error || !text) {
      console.warn(`[${label}] empty/errored body (attempt ${attempt}/${MAX_ATTEMPTS}):`, data?.error ? JSON.stringify(data.error) : 'no content');
      lastStatus = 502;
      continue;
    }
    try {
      const stripped = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const jsonStart = stripped.indexOf('{');
      const jsonEnd = stripped.lastIndexOf('}');
      const cleaned = jsonStart !== -1 && jsonEnd !== -1 ? stripped.slice(jsonStart, jsonEnd + 1) : stripped;
      return JSON.parse(cleaned);
    } catch {
      console.warn(`[${label}] unparseable JSON (attempt ${attempt}/${MAX_ATTEMPTS}), finish_reason=${data?.choices?.[0]?.finish_reason}, len=${text.length}`);
      lastStatus = 502;
      continue;
    }
  }
  return { __error: lastStatus };
}

const GEMINI_SYSTEM_PROMPT = `You are the OXYGY Prompt Engineering Coach — an expert in transforming raw, unstructured prompts into well-engineered, structured prompts that produce dramatically better AI outputs.

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

function sendPitchPlugin(apiKey: string | undefined): Plugin {
  return {
    name: 'send-pitch-proxy',
    configureServer(server) {
      server.middlewares.use('/api/send-pitch', (req: Connect.IncomingMessage, res: ServerResponse) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const result = await sendPitch(apiKey, JSON.parse(body));
            res.statusCode = result.status;
            res.end(JSON.stringify(result.body));
          } catch (err) {
            console.error('send-pitch error:', err);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'The email could not be sent. Try again, or save the PDF instead.' }));
          }
        });
      });
    },
  };
}

function geminiProxyPlugin(apiKey: string, model: string): Plugin {
  return {
    name: 'gemini-proxy',
    configureServer(server) {
      server.middlewares.use('/api/enhance-prompt', (req: Connect.IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'API key not configured' }));
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { mode, prompt, wizardAnswers } = JSON.parse(body);

            let userMessage: string;
            if (mode === 'enhance') {
              userMessage = prompt;
            } else {
              // Build mode — assemble wizard answers into a structured message
              const wa = wizardAnswers;
              const formatText = [
                ...(wa.formatChips || []),
                wa.formatCustom || '',
              ].filter(Boolean).join(', ') || 'Not specified';
              const qualityText = [
                ...(wa.qualityChips || []),
                wa.qualityCustom || '',
              ].filter(Boolean).join(', ') || 'Not specified';

              userMessage = `The user wants to build a prompt with the following inputs:\n\nRole: ${wa.role || 'Not specified'}\nContext: ${wa.context || 'Not specified'}\nTask: ${wa.task || 'Not specified'}\nFormat preferences: ${formatText}\nSteps: ${wa.steps || 'Not specified'}\nQuality constraints: ${qualityText}\n\nPlease enhance and expand each section into a polished, comprehensive prompt following The Prompt Blueprint framework.`;
            }

            const parsed = await callOpenRouterJSON(apiKey, model, GEMINI_SYSTEM_PROMPT, userMessage, 'enhance-prompt');
            if (parsed?.__error) {
              res.statusCode = parsed.__error === 429 ? 429 : 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: parsed.__error === 429 ? 'The AI service is temporarily busy. Please wait a moment and try again.' : 'AI service error', retryable: true }));
              return;
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(parsed));
          } catch (err) {
            console.error('Proxy error:', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal server error', retryable: true }));
          }
        });
      });
    },
  };
}

function agentDesignProxyPlugin(apiKey: string, model: string): Plugin {
  const systemPrompt = `You are the OXYGY Agent Design Advisor — an expert in helping people design effective, reusable, and accountable AI agents for professional use.

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
a) A human-readable version — formatted as clean, professional output that a team member would want to read. Use clear headings, sections, and structure.
b) A JSON template — the exact JSON schema that the agent should produce. Include all fields, nested objects, arrays where appropriate, and use descriptive key names. Add brief comments (as string values) explaining what each field should contain.

The JSON template should be comprehensive and production-ready.

SECTION 3: SYSTEM PROMPT
Generate a complete, ready-to-use system prompt for this agent that incorporates:
- A clear role definition
- Context about the task and domain
- Explicit task instructions
- The JSON output format from Section 2 (embedded in the prompt)
- Step-by-step processing instructions
- Quality checks and constraints
- Human-in-the-loop requirements from Section 4

Mark each section of the prompt with labels: [ROLE], [CONTEXT], [TASK], [OUTPUT FORMAT], [STEPS], [QUALITY CHECKS] — so the frontend can apply color-coding.

SECTION 4: BUILT-IN ACCOUNTABILITY FEATURES
The goal here is NOT to remind humans to "review the output" — that's obvious and expected. Instead, design 3-5 specific features that are built into the agent's prompt to actively support human oversight. Each feature should describe how the agent itself is designed to make verification easy and effective.

Focus on what the agent PROVIDES to support the reviewer:
- Source citations (row numbers, timestamps, page references, speaker names)
- Confidence scores or uncertainty flags for each conclusion
- Reasoning trails that show how the agent arrived at its conclusions
- Data coverage summaries (what was analyzed vs. what was skipped)
- Alternative interpretations or dissenting patterns the agent considered

Each accountability feature must include:
- name: A short, clear name for this agent behavior (e.g., "Source Citation", "Confidence Scoring", "Reasoning Trail")
- severity: "critical", "important", or "recommended"
- what_to_verify: 1-2 sentences describing what the agent provides or does (NOT what the human should check — frame it as "The agent includes...", "The agent flags...", "The agent provides...")
- why_it_matters: 1-2 sentences on how this specific agent behavior helps the reviewer do their job faster and more effectively
- prompt_instruction: The exact text to add to the agent's prompt to enforce this behavior

RESPONSE FORMAT:
You must respond with the following JSON structure ONLY — no markdown, no extra text:

{
  "readiness": {
    "overall_score": 85,
    "verdict": "Strong candidate for a custom agent",
    "rationale": "This task is performed frequently...",
    "criteria": {
      "frequency": { "score": 90, "assessment": "Weekly or more frequent task" },
      "consistency": { "score": 85, "assessment": "Output structure must be consistent for team use" },
      "shareability": { "score": 80, "assessment": "Multiple team members would benefit" },
      "complexity": { "score": 75, "assessment": "Requires domain knowledge in..." },
      "standardization_risk": { "score": 90, "assessment": "Variable outputs would cause..." }
    },
    "level1_points": ["Point about when ad-hoc prompting would suffice"],
    "level2_points": ["Point about why a custom agent is recommended"]
  },
  "output_format": {
    "human_readable": "The formatted output as a string with newlines",
    "json_template": { "example": "nested object" }
  },
  "system_prompt": "The full system prompt text with [ROLE], [CONTEXT], [TASK], [OUTPUT FORMAT], [STEPS], [QUALITY CHECKS] section markers",
  "accountability": [
    {
      "name": "Source Row References",
      "severity": "critical",
      "what_to_verify": "Description...",
      "why_it_matters": "Description...",
      "prompt_instruction": "The exact prompt text..."
    }
  ]
}`;

  return {
    name: 'agent-design-proxy',
    configureServer(server) {
      server.middlewares.use('/api/design-agent', (req: Connect.IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'API key not configured' }));
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { task_description, input_data_description } = JSON.parse(body);

            const userMessage = `Task Description: ${task_description}\n\nInput Data Description: ${input_data_description || 'Not specified'}`;

            const parsed = await callOpenRouterJSON(apiKey, model, systemPrompt, userMessage, 'agent-design');
            if (parsed?.__error) {
              res.statusCode = parsed.__error === 429 ? 429 : 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: parsed.__error === 429 ? 'The AI service is temporarily busy. Please wait a moment and try again.' : 'AI service error', retryable: true }));
              return;
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(parsed));
          } catch (err) {
            console.error('Proxy error (agent design):', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal server error', retryable: true }));
          }
        });
      });
    },
  };
}

function workflowDesignProxyPlugin(apiKey: string, model: string): Plugin {
  const pathAPrompt = `You are the OXYGY Workflow Architect — an expert in designing AI-powered automation workflows. You help users map their business processes into structured, multi-step workflows using a node-based system.

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
- Workflows typically have 4–10 nodes total
- Node order matters: the sequence should reflect a logical data flow
- Include a proc-human-review node whenever AI output feeds directly into client-facing, decision-critical, or externally shared deliverables
- Choose nodes that match the user's described tools and systems
- If the user mentions specific tools (e.g., "Microsoft Forms"), map to the closest node (e.g., input-form)
- Provide a brief description for each node explaining its specific role in THIS workflow (not a generic description)

RESPONSE FORMAT (JSON only, no markdown):

{
  "workflow_name": "A short descriptive name for this workflow",
  "workflow_description": "A 2-3 sentence summary of what this workflow does end-to-end",
  "nodes": [
    {
      "id": "node-1",
      "node_id": "input-form",
      "name": "Survey Submission",
      "custom_description": "Receives client engagement survey responses submitted via Microsoft Forms. Each submission triggers the workflow automatically.",
      "layer": "input"
    },
    {
      "id": "node-2",
      "node_id": "proc-ai-agent",
      "name": "Theme Analysis",
      "custom_description": "A Level 2 AI agent analyzes each survey response to identify recurring themes, categorize feedback by topic, and score sentiment.",
      "layer": "processing"
    }
  ]
}

The "nodes" array must be ordered sequentially — node-1 connects to node-2, node-2 connects to node-3, and so on. This order will be rendered directly as the workflow flow.

The "name" field is a SHORT custom label for the node in this specific workflow context (e.g., "Theme Analysis" not "AI Agent"). Max 20 characters.

The "node_id" must exactly match one of the node IDs listed above.`;

  const pathBPrompt = `You are the OXYGY Workflow Reviewer — an expert in evaluating and improving AI-powered automation workflows.

You will receive:
1. A description of the process being automated
2. Optionally, a description of existing tools and systems
3. The user's manually-built workflow as an ordered list of nodes
4. Optionally, the user's rationale for their design decisions

Your job is to review the user's workflow and suggest improvements. You may:
- ADD nodes that are missing (e.g., a human review step, a data validation step, a filter/router for different data types)
- REMOVE nodes that are redundant or unnecessary
- REORDER nodes if the sequence could be improved
- Keep nodes unchanged if they are well-placed

IMPORTANT PRINCIPLES:
- There is no single "right" way to build a workflow. Acknowledge the user's design decisions and explain trade-offs rather than prescribing one approach.
- Be specific about WHY each change is suggested — reference the user's context and data types.
- If the user provided a rationale, respond to it directly. Validate good decisions and gently explain where improvements could help.
- Always explain the risks of NOT making a suggested change.

AVAILABLE NODES:

LAYER 1 — DATA INPUT NODES:
input-excel, input-gsheets, input-webhook, input-api, input-form, input-email, input-schedule, input-database, input-file, input-crm, input-chat, input-transcript

LAYER 2 — PROCESSING NODES:
proc-ai-agent, proc-ai-loop, proc-text-extract, proc-code, proc-mapper, proc-filter, proc-merge, proc-sentiment, proc-classifier, proc-summarizer, proc-translate, proc-validator, proc-human-review

LAYER 3 — DATA OUTPUT NODES:
output-excel, output-gsheets, output-database, output-email, output-slack, output-pdf, output-word, output-pptx, output-api, output-crm, output-dashboard, output-notification, output-calendar, output-kb

RESPONSE FORMAT (JSON only, no markdown):

{
  "overall_assessment": "A 2-3 sentence summary of the workflow's strengths and areas for improvement",
  "suggested_workflow": [
    {
      "id": "node-1",
      "node_id": "input-form",
      "name": "Survey Submission",
      "custom_description": "Receives client engagement survey responses...",
      "layer": "input",
      "status": "unchanged"
    },
    {
      "id": "node-2",
      "node_id": "proc-validator",
      "name": "Data Quality Check",
      "custom_description": "Validates that all required fields are present...",
      "layer": "processing",
      "status": "added"
    }
  ],
  "changes": [
    {
      "type": "added",
      "node_id": "proc-validator",
      "node_name": "Data Quality Check",
      "rationale": "Adding a validation step before AI processing ensures that incomplete or malformed survey responses are flagged before analysis. Without this, the AI agent may produce unreliable theme analysis from partial data."
    }
  ]
}

The "status" field for each node in suggested_workflow must be one of: "unchanged", "added", or "removed" (removed nodes are still included in the array for rendering purposes, but with status "removed").

For the user's original workflow, you will receive nodes with IDs like "user-node-1", "user-node-2", etc. In your suggested_workflow, keep the same IDs for unchanged nodes and use new IDs for added nodes.`;

  return {
    name: 'workflow-design-proxy',
    configureServer(server) {
      server.middlewares.use('/api/design-workflow', (req: Connect.IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'API key not configured' }));
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { mode, task_description, tools_and_systems, user_workflow, user_rationale } = JSON.parse(body);

            const systemPrompt = mode === 'auto_generate' ? pathAPrompt : pathBPrompt;

            let userMessage: string;
            if (mode === 'auto_generate') {
              userMessage = `Process to automate: ${task_description}\n\nExisting tools and systems: ${tools_and_systems || 'Not specified'}`;
            } else {
              const nodeList = (user_workflow || [])
                .map((n: { id: string; node_id: string; name: string; layer: string }) => `  ${n.id}: ${n.node_id} ("${n.name}") [${n.layer}]`)
                .join('\n');
              userMessage = `Process to automate: ${task_description}\n\nExisting tools and systems: ${tools_and_systems || 'Not specified'}\n\nUser's workflow:\n${nodeList}\n\nUser's design rationale: ${user_rationale || 'Not provided'}`;
            }

            const parsed = await callOpenRouterJSON(apiKey, model, systemPrompt, userMessage, 'workflow-design');
            if (parsed?.__error) {
              res.statusCode = parsed.__error === 429 ? 429 : 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: parsed.__error === 429 ? 'The AI service is temporarily busy. Please wait a moment and try again.' : 'AI service error', retryable: true }));
              return;
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(parsed));
          } catch (err) {
            console.error('Proxy error (workflow design):', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal server error', retryable: true }));
          }
        });
      });
    },
  };
}

function architectureProxyPlugin(apiKey: string, model: string): Plugin {
  const systemPrompt = `You are the OXYGY AI Build Plan Advisor — an expert in helping business professionals plan AI-powered applications using a 5-tool development pipeline.

You will receive a user's project details including their app description, target users and problem, data/feature needs, and technical comfort level. Generate a personalized build plan for their specific project.

THE OXYGY AI UPSKILLING FRAMEWORK (5 Levels):
- Level 1 (Fundamentals & Awareness): Prompt engineering basics — writing clear, structured instructions for AI
- Level 2 (Applied Capability): Designing reusable AI agents with system prompts, structured outputs, and accountability
- Level 3 (Systemic Integration): Workflow architecture — connecting multiple AI tools and agents into automated pipelines
- Level 4 (Strategic Oversight): Design thinking for AI outputs — dashboards, user experiences, and stakeholder-ready deliverables
- Level 5 (Full-Stack AI Development): Building complete AI-powered applications using the 5 tools below

THE 5-TOOL PIPELINE:

1. Google AI Studio — Rapid prototyping. Turn ideas into working first drafts. "Like your Word — where the first draft comes to life."
   - Always essential for every project
   - Connects to Level 1 (Prompt Engineering) and Level 4 (Design Thinking)

2. GitHub — Version control and collaboration. "Like your SharePoint — where code lives and teams collaborate."
   - Essential for most projects; recommended for very simple non-technical projects
   - Connects to Level 3 (Systemic Integration / Workflow Architecture)

3. Claude Code — AI-powered development tool for sophisticated features, integrations, and polish. "Like hiring a specialist contractor — called in for the complex work."
   - Essential for complex projects (user accounts + heavy data + technical users); recommended for medium complexity; optional for simple projects
   - Connects to Level 1 (Prompting), Level 2 (Agent/Instruction Design), Level 3 (Workflow Architecture)

4. Supabase — Database, authentication, and backend infrastructure. "Like your Excel — where all your data lives, organized in tables."
   - Essential if user accounts or heavy data are needed; recommended for moderate data needs; optional for simple stateless tools
   - Connects to Level 3 (Workflow Architecture) and optionally Level 4 (Design Thinking)

5. Vercel — Deployment platform that makes the app live and accessible. "Like your PowerPoint — where the final work is presented to the audience."
   - Always essential for any project that needs real users to access it
   - Connects to all levels (Level 1 through Level 4) as the culmination of the full framework

CLASSIFICATION RULES:
- "essential": The project cannot succeed without this tool
- "recommended": The project would benefit significantly, but could work without it
- "optional": Nice to have, but the project works fine without it

For each tool, generate:
- classification: "essential", "recommended", or "optional"
- forYourProject: 2-3 sentences explaining how this specific tool applies to THEIR project. Be specific — reference features, screens, or use cases they described.
- howToApproach: 2-3 sentences with concrete first steps for getting started with this tool for their project.
- tips: Array of exactly 3 specific, actionable tips tailored to their project.
- levelConnection: 2-3 sentences explaining how skills from earlier levels connect to this tool. IMPORTANT: When referencing earlier levels, always use the exact format "Level 1", "Level 2", "Level 3", or "Level 4" — the frontend will parse these into clickable links.
- connectedLevels: Array of level numbers this tool connects to (e.g., [1, 4])

IMPORTANT GUIDELINES:
- Be SPECIFIC to the user's actual project — not generic. Reference specific features, screens, user types, or data they described.
- Keep language accessible for business professionals, not developers.
- Be encouraging but honest about complexity.
- When mentioning levels, ALWAYS use "Level 1", "Level 2", "Level 3", "Level 4" format.
- For tips, give concrete actionable steps, not abstract advice.

Respond with ONLY this JSON structure — no markdown, no extra text:

{
  "google-ai-studio": {
    "classification": "essential",
    "forYourProject": "...",
    "howToApproach": "...",
    "tips": ["...", "...", "..."],
    "levelConnection": "...",
    "connectedLevels": [1, 4]
  },
  "github": {
    "classification": "essential",
    "forYourProject": "...",
    "howToApproach": "...",
    "tips": ["...", "...", "..."],
    "levelConnection": "...",
    "connectedLevels": [3]
  },
  "claude-code": {
    "classification": "essential|recommended|optional",
    "forYourProject": "...",
    "howToApproach": "...",
    "tips": ["...", "...", "..."],
    "levelConnection": "...",
    "connectedLevels": [1, 2, 3]
  },
  "supabase": {
    "classification": "essential|recommended|optional",
    "forYourProject": "...",
    "howToApproach": "...",
    "tips": ["...", "...", "..."],
    "levelConnection": "...",
    "connectedLevels": [3]
  },
  "vercel": {
    "classification": "essential",
    "forYourProject": "...",
    "howToApproach": "...",
    "tips": ["...", "...", "..."],
    "levelConnection": "...",
    "connectedLevels": [1, 2, 3, 4]
  }
}`;

  return {
    name: 'architecture-proxy',
    configureServer(server) {
      server.middlewares.use('/api/analyze-architecture', (req: Connect.IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'API key not configured' }));
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { appDescription, problemAndUsers, dataAndContent, technicalLevel } = JSON.parse(body);

            const techLabels: Record<string, string> = {
              'non-technical': 'Non-technical (never written code, not planning to)',
              'semi-technical': 'Semi-technical (comfortable with no-code tools, can follow technical instructions)',
              'technical': 'Technical (some coding experience or willing to learn)',
            };

            const userMessage = [
              `APP DESCRIPTION:\n${appDescription || 'Not provided'}`,
              `PROBLEM & USERS:\n${problemAndUsers || 'Not provided'}`,
              `DATA & KEY FEATURES:\n${dataAndContent || 'Not provided'}`,
              `TECHNICAL COMFORT LEVEL: ${techLabels[technicalLevel || ''] || technicalLevel || 'Not specified'}`,
            ].join('\n\n');

            const parsed = await callOpenRouterJSON(apiKey, model, systemPrompt, userMessage, 'architecture');
            if (parsed?.__error) {
              res.statusCode = parsed.__error === 429 ? 429 : 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: parsed.__error === 429 ? 'The AI service is temporarily busy. Please wait a moment and try again.' : 'AI service error', retryable: true }));
              return;
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(parsed));
          } catch (err) {
            console.error('Proxy error (architecture):', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal server error', retryable: true }));
          }
        });
      });
    },
  };
}

function pathwayProxyPlugin(apiKey: string, model: string): Plugin {
  const systemPrompt = `You are a learning pathway designer for OXYGY's AI Centre of Excellence. You generate personalized, project-based learning pathways for professionals who want to develop AI skills.

Your outputs must be:
- Practical and actionable — every project should be something the learner can start within a week
- Role-specific — projects should directly relate to the learner's stated function and challenge
- Empathetic — acknowledge where the learner is starting from and build confidence
- Connected — explicitly reference how each project relates to the learner's specific challenge from their questionnaire input

OUTPUT RULES (non-negotiable):
- Respond with a single JSON object and nothing else
- The root object MUST have exactly three top-level keys: "pathwaySummary", "totalEstimatedWeeks", "levels"
- Do NOT wrap the JSON in any outer object, array, or key (e.g. never use "pathway", "result", "data" as a wrapper)
- Do NOT include markdown, backticks, code fences, or any text before or after the JSON
- Your response must begin with { and end with }

CRITICAL: In the "challengeConnection" field for EVERY level, you MUST directly reference and quote specific details from the user's stated challenge. This is the most important personalization element — the learner should feel that this pathway was built specifically for their situation.`;

  return {
    name: 'pathway-proxy',
    configureServer(server) {
      server.middlewares.use('/api/generate-pathway', (req: Connect.IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'API key not configured' }));
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { formData, levelDepths } = JSON.parse(body);

            const ambitionLabels: Record<string, string> = {
              'confident-daily-use': 'Confident daily AI use',
              'build-reusable-tools': 'Build reusable AI tools',
              'own-ai-processes': 'Design and own AI-powered processes',
              'build-full-apps': 'Build full AI-powered applications',
            };

            const experienceLabels: Record<string, string> = {
              'beginner': 'Beginner — rarely uses AI tools',
              'comfortable-user': 'Comfortable User — uses ChatGPT or similar regularly for basic tasks',
              'builder': 'Builder — has created custom GPTs, agents, or prompt templates',
              'integrator': 'Integrator — has designed AI-powered workflows or multi-step pipelines',
            };

            const userMessage = `Generate a personalized learning pathway for the following professional.

## LEARNER PROFILE
- Role: ${formData.role || 'Not specified'}
- Function: ${formData.function === 'Other' ? formData.functionOther : formData.function || 'Not specified'}
- Seniority: ${formData.seniority || 'Not specified'}
- AI Experience: ${experienceLabels[formData.aiExperience] || formData.aiExperience || 'Not specified'}
- Ambition: ${ambitionLabels[formData.ambition] || formData.ambition || 'Not specified'}
- Specific Challenge: "${(formData.challenge || 'Not specified').slice(0, 500)}"
- Weekly Availability: ${formData.availability || 'Not specified'}${formData.experienceDescription ? `\n- AI Experience Details: "${formData.experienceDescription.slice(0, 500)}"` : ''}${formData.goalDescription ? `\n- Specific Goal: "${formData.goalDescription.slice(0, 500)}"` : ''}

## LEVEL CLASSIFICATIONS (pre-determined, do not change)
- Level 1 (Fundamentals): ${levelDepths.L1}
- Level 2 (Applied Capability): ${levelDepths.L2}
- Level 3 (Systemic Integration): ${levelDepths.L3}
- Level 4 (Dashboards & Front-Ends): ${levelDepths.L4}
- Level 5 (Full AI Applications): ${levelDepths.L5}

## FRAMEWORK CONTEXT

### Level 1: Fundamentals of AI for Everyday Use
Topics: What is an LLM, Prompting Basics, Everyday Use Cases, Intro to Creative AI, Responsible Use, Prompt Library Creation
Tools: ChatGPT, DALL-E, Opus Clip, Snipd, Descript
Objective: Build comfort, curiosity, and foundational confidence

### Level 2: Applied Capability
Topics: What Are AI Agents?, Custom GPTs, Instruction Design, Human-in-the-Loop, Ethical Framing, Agent Templates
Tools: ChatGPT Custom GPT Builder, Claude Projects & Skills, Microsoft Copilot Agents, Google Gems
Objective: Empower individuals to design AI assistants tailored to their work

### Level 3: Systemic Integration
Topics: AI Workflow Mapping, Agent Chaining, Input Logic & Role Mapping, Automated Output Generation, Process Use Cases, Performance & Feedback Loops
Tools: Make, Zapier, n8n, API integrations, Airtable
Objective: Scale AI usage through integrated, automated pipelines

### Level 4: Interactive Dashboards & Tailored Front-Ends
Topics: Application Architecture, User-Centered Dashboard Design, Data Visualization, Role-Based Views, Prototype Testing, Stakeholder Feedback
Tools: Figma, V0, Google AI Studio, Cursor, dashboard prototyping tools
Objective: Shift from data-in-a-sheet to tailored experiences built for specific end users

### Level 5: Full AI-Powered Applications
Topics: Application Architecture, Personalization Engines, Knowledge Base Applications, Custom Learning Platforms, Full-Stack AI Integration, User Testing & Scaling
Tools: Google AI Studio, GitHub, Claude Code, Supabase, Vercel
Objective: Full-stack AI applications where different users get different experiences

### Cross-Functional Use Cases
- Consulting & Delivery: Create tailored client insights from notes and transcripts
- Proposal & BD: Generate draft proposals from templates and client inputs
- Project Management: Summarize risks, status updates, and meeting notes
- L&D / Training: Match individual skill gaps to existing learning modules
- Analytics & Insights: Process survey results and tag responses by role & sentiment
- Ops & SOP Management: Convert conversations into visual SOPs or step-by-step guides
- Comms & Change: Draft announcements or FAQs adapted to persona groups
- IT & Knowledge Management: Set up internal AI chatbots to retrieve documents or SOPs

## INSTRUCTIONS

Generate content ONLY for levels classified as "full" or "fast-track". Do NOT generate content for "awareness" or "skip" levels.

For each applicable level, generate:
1. A project title — action-oriented, specific to the learner's role and function
2. A project description — 2-3 sentences explaining what they'll build
3. A deliverable — one concrete, tangible output
4. A challengeConnection — 2-3 sentences that DIRECTLY reference the learner's stated challenge. Quote their exact words. This is the most important personalization element.
5. A recommended session format — based on their seniority level
6. 2-4 suggested resources — real tools, platforms, guides relevant to the project

For "fast-track" levels, frame as "validate and sharpen" rather than "learn from scratch."

## OUTPUT FORMAT

Your entire response must be a single JSON object with exactly these three top-level keys: "pathwaySummary", "totalEstimatedWeeks", "levels". No wrapper, no preamble, no markdown.

Example structure (include as many levels as applicable — L1 and L2 are always present):

{
  "pathwaySummary": "1-2 sentence personalized overview",
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

            const parsed = await callOpenRouterJSON(apiKey, model, systemPrompt, userMessage, 'pathway');
            if (parsed?.__error) {
              res.statusCode = parsed.__error === 429 ? 429 : 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: parsed.__error === 429 ? 'The AI service is temporarily busy. Please wait a moment and try again.' : 'AI service error', retryable: true }));
              return;
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(parsed));
          } catch (err) {
            console.error('Proxy error (pathway):', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal server error', retryable: true }));
          }
        });
      });
    },
  };
}

function dashboardDesignProxyPlugin(apiKey: string, model: string, textModel?: string): Plugin {
  const htmlModel = textModel || 'google/gemini-3-flash-preview';
  // System prompt for Gemini HTML fallback (used when Imagen is unavailable)
  const htmlFallbackPrompt = `You are an elite UI designer creating stunning, modern dashboard mockups. Generate a complete HTML dashboard.

METRIC REQUIREMENTS: Include EVERY metric the user listed. Infer 3-5 additional relevant metrics. Use realistic sample data with % change indicators.

DESIGN AESTHETIC: MINIMAL and AIRY. Font: 'DM Sans'. Background: #F8FAFC. Cards: white, border-radius: 16px, border: 1px solid #E2E8F0. Colors: Primary #38B2AC, Secondary #5B6DC2, Accent #D47B5A. NO sidebars, NO navigation menus, NO buttons. Content only.

RESPONSE FORMAT (JSON only, no markdown):
{
  "image_url": "",
  "image_prompt": "A description of the dashboard",
  "html_content": "<!DOCTYPE html><html>...</html>"
}

The html_content MUST fit inside a 1100x700px iframe WITHOUT scrolling. Add "html, body { margin: 0; padding: 24px; overflow: hidden; height: 100%; box-sizing: border-box; }" to CSS. Use viewBox for SVG charts. Keep compact: max 4-5 KPI cards, max 2 charts side by side.`;

  return {
    name: 'dashboard-design-proxy',
    configureServer(server) {
      server.middlewares.use('/api/design-dashboard', (req: Connect.IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'API key not configured', use_fallback: true }));
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const {
              user_needs, target_audience, key_metrics, data_sources,
              dashboard_type, visual_style, inspiration_url,
              refinement_feedback, previous_prompt,
              inspiration_images,
            } = JSON.parse(body);

            // Build a descriptive prompt for Gemini image generation
            const styleDesc = visual_style === 'data-dense' ? 'data-dense with maximum information density'
              : visual_style === 'executive-polished' ? 'executive and polished with large KPI cards'
              : visual_style === 'colorful-visual' ? 'colorful and visual with bold infographic style'
              : 'clean and minimal with lots of whitespace';

            // ─── Analyze inspiration images if provided ───
            let inspirationPatterns = '';
            if (inspiration_images && Array.isArray(inspiration_images) && inspiration_images.length > 0) {
              console.log(`Analyzing ${inspiration_images.length} inspiration image(s)...`);
              try {
                const inspModel = htmlModel.startsWith('google/') ? htmlModel : `google/${htmlModel}`;
                const imageParts = inspiration_images.map((img: string) => {
                  if (!img.startsWith('data:')) return null;
                  const commaIdx = img.indexOf(',');
                  if (commaIdx === -1) return null;
                  const header = img.slice(5, commaIdx);
                  const semiIdx = header.indexOf(';');
                  if (semiIdx === -1) return null;
                  const mimeType = header.slice(0, semiIdx);
                  const data = img.slice(commaIdx + 1);
                  if (!mimeType.startsWith('image/') || !data) return null;
                  return { mimeType, data };
                }).filter(Boolean);

                if (imageParts.length > 0) {
                  const imageUrls = imageParts.map((p: any) => ({
                    type: 'image_url',
                    image_url: { url: `data:${p.mimeType};base64,${p.data}` },
                  }));
                  const analyzeResponse = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({
                      model: inspModel,
                      messages: [
                        { role: 'system', content: `You are an expert UI/UX analyst specializing in dashboard design. Analyze the provided dashboard screenshot(s) and extract the key design patterns. Focus on layout structure, color scheme, chart types, information density, typography, card design, and special elements. Output a concise paragraph (3-5 sentences) describing these patterns as design instructions. Be specific about colors, layout ratios, and widget types. Do NOT describe the data — only the visual design patterns.` },
                        {
                          role: 'user',
                          content: [
                            { type: 'text', text: 'Analyze these dashboard screenshot(s) and extract the key design patterns:' },
                            ...imageUrls,
                          ],
                        },
                      ],
                      temperature: 0.3,
                    }),
                  }, 'dashboard-analyze');

                  if (analyzeResponse.ok) {
                    const analyzeData = await analyzeResponse.json();
                    const patterns = analyzeData?.choices?.[0]?.message?.content || '';
                    if (patterns.trim()) {
                      inspirationPatterns = patterns.trim();
                      console.log('✅ Inspiration image analysis complete');
                    }
                  } else {
                    console.log('Inspiration analysis failed, continuing without it');
                  }
                }
              } catch (analyzeErr) {
                console.log('Inspiration analysis error, continuing without it:', analyzeErr);
              }
            }

            let imagePrompt: string;

            // ─── If refinement feedback is provided, use Gemini text model to refine the prompt ───
            if (refinement_feedback && previous_prompt) {
              console.log('Refining image prompt based on user feedback...');
              const refModel = htmlModel.startsWith('google/') ? htmlModel : `google/${htmlModel}`;

              const inspirationContext = inspirationPatterns
                ? `\n\nDESIGN REFERENCE FROM INSPIRATION IMAGES (must be maintained in the refined prompt): ${inspirationPatterns}`
                : '';

              const refinementResponse = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({
                  model: refModel,
                  messages: [
                    { role: 'system', content: `You are an expert at refining image generation prompts for dashboard mockups. Produce a NEW, complete prompt that incorporates user feedback while keeping all good parts of the original. Output ONLY the refined prompt text. Keep all formatting instructions from the original. If design reference patterns are provided, incorporate them.` },
                    { role: 'user', content: `ORIGINAL PROMPT:\n${previous_prompt}\n\nUSER FEEDBACK:\n${refinement_feedback}${inspirationContext}\n\nGenerate the refined prompt:` },
                  ],
                  temperature: 0.4,
                }),
              }, 'dashboard-refine');

              if (refinementResponse.ok) {
                const refinementData = await refinementResponse.json();
                const refinedText = refinementData?.choices?.[0]?.message?.content || '';
                if (refinedText.trim()) {
                  imagePrompt = refinedText.trim();
                  console.log('✅ Prompt refined successfully (with inspiration:', !!inspirationPatterns, ')');
                } else {
                  imagePrompt = `${previous_prompt} IMPORTANT CHANGES REQUESTED: ${refinement_feedback}${inspirationPatterns ? ` DESIGN REFERENCE: ${inspirationPatterns}` : ''}`;
                }
              } else {
                imagePrompt = `${previous_prompt} IMPORTANT CHANGES REQUESTED: ${refinement_feedback}${inspirationPatterns ? ` DESIGN REFERENCE: ${inspirationPatterns}` : ''}`;
              }
            } else {
              imagePrompt = `Generate a high-fidelity professional dashboard UI screenshot mockup for ${target_audience || 'business users'}. The dashboard shows: ${key_metrics || 'key business metrics'}. Purpose: ${user_needs}. Style: ${styleDesc}. ${dashboard_type ? `Type: ${dashboard_type}.` : ''} The dashboard has KPI metric cards at the top showing exact numbers with percentage change indicators, followed by line charts and bar charts below with clearly labeled axes. Modern flat design, white background with subtle gray borders, teal and navy color scheme. DM Sans font. Make ALL text, numbers, labels, and axis values crisp, sharp, and perfectly readable. 16:9 aspect ratio. This should look like a real production web application screenshot.${inspirationPatterns ? `\n\nIMPORTANT DESIGN REFERENCE — The user provided inspiration images. Match these design patterns closely: ${inspirationPatterns}` : ''}`;
            }

            console.log('Generating dashboard via OpenRouter...');
            console.log('  → Prompt length:', imagePrompt.length, 'chars');

            // ─── Strategy 1: Try image generation with Nano Banana 2 ───
            const imgModel = model.startsWith('google/') ? model : `google/${model}`;
            console.log('Strategy 1: Attempting image generation with', imgModel);

            try {
              const imageResponse = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({
                  model: imgModel,
                  messages: [
                    { role: 'user', content: imagePrompt },
                  ],
                  temperature: 0.7,
                }),
              }, 'dashboard-image');

              if (imageResponse.ok) {
                const imageData = await imageResponse.json();
                const message = imageData?.choices?.[0]?.message;

                // OpenRouter returns images in message.images array
                const images = message?.images;
                if (Array.isArray(images) && images.length > 0) {
                  const imagePart = images.find((p: any) => p.type === 'image_url' && p.image_url?.url);
                  if (imagePart) {
                    console.log('Image generated successfully via Nano Banana 2');
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({
                      image_url: imagePart.image_url.url,
                      image_prompt: imagePrompt,
                      generation_method: 'gemini-image',
                    }));
                    return;
                  }
                }

                // Also check content array (alternative format)
                const content = message?.content;
                if (Array.isArray(content)) {
                  const contentImg = content.find((p: any) => p.type === 'image_url' && p.image_url?.url);
                  if (contentImg) {
                    console.log('Image generated successfully via Nano Banana 2 (content array)');
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({
                      image_url: contentImg.image_url.url,
                      image_prompt: imagePrompt,
                      generation_method: 'gemini-image',
                    }));
                    return;
                  }
                }

                console.log('Image model responded but no image found, falling back to HTML');
              } else {
                console.log('Image generation failed with status', imageResponse.status, ', falling back to HTML');
              }
            } catch (imgErr) {
              console.log('Image generation error, falling back to HTML:', imgErr);
            }

            // ─── Strategy 2: Fall back to HTML dashboard generation ───
            const htmlModelId = htmlModel.startsWith('google/') ? htmlModel : `google/${htmlModel}`;
            console.log('Strategy 2: Generating HTML dashboard with', htmlModelId);
            const userMessage = [
              `DASHBOARD PURPOSE: ${user_needs}`,
              target_audience ? `TARGET AUDIENCE: ${target_audience}` : '',
              key_metrics ? `KEY METRICS: ${key_metrics}` : '',
              data_sources ? `DATA SOURCES: ${data_sources}` : '',
              dashboard_type ? `DASHBOARD TYPE: ${dashboard_type}` : '',
              visual_style ? `VISUAL STYLE: ${visual_style}` : '',
              inspiration_url ? `INSPIRATION URL: ${inspiration_url}` : '',
            ].filter(Boolean).join('\n');

            const geminiResponse = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
              body: JSON.stringify({
                model: htmlModelId,
                messages: [
                  { role: 'system', content: htmlFallbackPrompt },
                  { role: 'user', content: userMessage },
                ],
                temperature: 0.7,
                max_tokens: 16000,
                response_format: { type: 'json_object' },
              }),
            }, 'dashboard-html');

            if (!geminiResponse.ok) {
              const errText = await geminiResponse.text();
              console.error('OpenRouter API error (dashboard):', errText);
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'AI service error', use_fallback: true, retryable: true }));
              return;
            }

            const data = await geminiResponse.json();
            const text = data?.choices?.[0]?.message?.content || '';

            let parsed;
            try {
              const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
              parsed = JSON.parse(cleaned);
              parsed.generation_method = 'html';
            } catch {
              console.error('Failed to parse response (dashboard):', text);
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Failed to parse AI response', use_fallback: true, retryable: true }));
              return;
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(parsed));
          } catch (err) {
            console.error('Proxy error (dashboard):', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal server error', use_fallback: true, retryable: true }));
          }
        });
      });
    },
  };
}

function prdProxyPlugin(apiKey: string, model: string): Plugin {
  const systemPrompt = `You are a senior product manager and technical writer specializing in dashboard and data visualization products. You create production-grade Product Requirements Documents (PRDs) that development teams can use to build real dashboards.

You will receive details about a dashboard project including: purpose, target audience, key metrics, data sources, visual style preferences, and a description of the mockup design. Your job is to generate a comprehensive, detailed, and actionable PRD that a real development team or AI coding tool could use to build this dashboard.

CRITICAL RULES:
- Every section must be SPECIFIC to the user's actual project — reference their exact metrics, audience, data sources, and use case throughout.
- Write at a professional level — this should read like a real PRD from a product team at a tech company.
- Be quantitative wherever possible — specify pixel sizes, grid ratios, refresh intervals, loading times, character limits.
- Include edge cases, error states, and fallback behaviors.
- Use concrete examples that reference the user's specific metrics and data.
- IMPORTANT: Every section value MUST be a plain text STRING, not a JSON object. Use formatted text with newlines, bullets (using * or -), and headers (using plain text) within the string. Never nest JSON objects inside section values.

OUTPUT RULES (non-negotiable):
- Respond with a single JSON object and nothing else
- The root object MUST have exactly two top-level keys: "prd_content" and "sections"
- Do NOT wrap the JSON in any outer object, array, or key (e.g. never use "prd", "result", "data", "document" as a wrapper)
- Do NOT include markdown, backticks, code fences, or any text before or after the JSON
- Your response must begin with { and end with }

RESPONSE FORMAT — your entire response must be exactly this structure:

{
  "prd_content": "PRD: [Descriptive dashboard name based on the user's purpose]",
  "sections": {
    "dashboard_overview": "SECTION CONTENT — see requirements below",
    "target_users": "SECTION CONTENT",
    "information_architecture": "SECTION CONTENT",
    "widget_specifications": "SECTION CONTENT",
    "visual_design": "SECTION CONTENT",
    "tech_stack": "SECTION CONTENT",
    "data_integration": "SECTION CONTENT",
    "interactions_filtering": "SECTION CONTENT",
    "responsive_behavior": "SECTION CONTENT",
    "human_checkpoints": "SECTION CONTENT",
    "acceptance_criteria": "SECTION CONTENT"
  }
}

Rules:
- The "sections" object must contain exactly these 11 keys — no additions, no omissions
- All values must be strings (never nested objects or arrays)
- Do not add any keys outside of "prd_content" and "sections" at the root level

SECTION REQUIREMENTS (each section must be comprehensive):

1. DASHBOARD OVERVIEW (15-25 sentences — this is the most important section):
- Dashboard name and one-line elevator pitch
- The specific business problem this dashboard solves — be very specific about the pain points
- Who requested it and why existing tools (spreadsheets, manual reports, existing dashboards) are insufficient
- 3-5 key success metrics for the dashboard itself (adoption rate >X%, time-to-insight <Xs, decision turnaround improvement)
- Scope boundaries: what this dashboard covers AND what it explicitly does not cover
- Expected launch timeline and iteration plan
- VISUAL DESCRIPTION: Provide an extremely detailed description of what the dashboard should look like when built. Describe the overall layout (e.g., "A top navigation bar with the dashboard title and date filters, followed by a row of 4-5 KPI summary cards, then a 2-column section with a line chart on the left and a bar chart on the right, and a full-width data table at the bottom"). Reference specific widget types, their approximate sizes, positions, and how they relate to each other.
- COLOR AND STYLE DIRECTION: Describe the intended visual tone — modern and minimal? Data-dense and enterprise? Colorful and engaging? Specify the primary color palette direction.
- KEY USER FLOWS: Describe the 2-3 most important things a user does when they open this dashboard (e.g., "1. Glance at KPI cards to see today's numbers. 2. Check the trend chart to see if metrics are improving. 3. Filter by region to compare performance.")
- This section should be comprehensive enough that an AI coding tool (like Cursor, Bolt, or Lovable) or a developer could read ONLY this section and understand exactly what to build

2. TARGET USERS & USER STORIES (10-15 sentences):
- 2-3 distinct user personas with their roles, goals, technical comfort, and typical usage patterns
- 5-8 user stories in 'As a [specific role], I want to [concrete action on the dashboard] so that [specific business outcome]' format
- Frequency of use per persona (daily, weekly, on-demand)
- Key decisions each persona needs to make using this dashboard

3. INFORMATION ARCHITECTURE (8-12 sentences):
- Page layout description: header region, navigation, main content zones, sidebar (if applicable)
- Section hierarchy with specific regions (e.g., "Top banner: 4 KPI summary cards. Middle: 2-column chart area. Bottom: data table with pagination")
- Content priority ordering — what the user sees first, second, third
- Navigation patterns (tabs, filters, drill-down paths)
- State management: default view, filtered view, detail view, empty state, error state

4. WIDGET SPECIFICATIONS (create a detailed spec for EACH metric):
For each key metric, specify:
- Widget type (KPI card, line chart, bar chart, donut chart, data table, sparkline, gauge, heatmap)
- Data displayed: primary value, comparison value (vs. previous period), trend direction, percentage change
- Visualization details: chart type, axis labels, legend, tooltip content, color coding rules
- Size: grid position (e.g., "Row 1, spans 3 of 12 columns")
- Interaction: hover behavior, click-through destination, drill-down capability
- Update frequency and loading state behavior
- Create at least one additional derived widget (e.g., trend chart combining multiple metrics, ranking table, distribution chart)

5. VISUAL DESIGN REQUIREMENTS (8-12 sentences):
- Color palette: primary, secondary, accent, success/warning/error states — with hex codes
- Typography: font family, heading sizes (H1-H4), body text size, line height, font weights
- Spacing system: padding, margins, gap between cards (use 4px/8px grid system)
- Card component spec: background color, border radius, border color, shadow, padding
- Chart color sequences for multi-series data
- Dark mode support (if applicable) or explanation of why single-mode
- Accessibility: contrast ratios, focus states, screen reader considerations

6. RECOMMENDED TECH STACK (8-12 sentences):
- Frontend framework recommendation with rationale (e.g., React + TypeScript for component reusability, or Next.js for SSR)
- Charting/visualization library (e.g., Recharts, Tremor, D3.js, Chart.js) with rationale based on the dashboard's complexity
- Backend/API layer (e.g., Node.js + Express, Supabase Edge Functions, serverless functions) based on data sources
- Database recommendation if persistent storage is needed (e.g., PostgreSQL via Supabase, MongoDB)
- Authentication approach (e.g., Clerk, Supabase Auth, Auth0) if role-based access is needed
- Hosting/deployment platform (e.g., Vercel, Netlify, AWS Amplify) with rationale
- Key dependencies and libraries (e.g., date-fns for date handling, tanstack-query for data fetching)
- Development tools (e.g., ESLint, Prettier, Storybook for component development)
- This section should be written so a non-technical stakeholder can understand WHY each technology is chosen — use analogies and plain language alongside the technical names

7. DATA INTEGRATION (8-12 sentences):
- List each data source with: connection method (API, database query, file import, webhook)
- Data refresh strategy: real-time, polling interval, scheduled batch, on-demand
- Data transformation pipeline: raw data → cleaned data → aggregated metrics → display-ready values
- Caching strategy: what gets cached, TTL, invalidation triggers
- Error handling: what happens when a data source is unavailable, stale data indicators
- Data volume estimates: expected row counts, query performance requirements
- Authentication and access control for each data source

8. INTERACTIONS & FILTERING (8-12 sentences):
- Global filters: date range picker (presets: Today, 7D, 30D, 90D, Custom), refresh button
- Dimension filters: dropdowns for each categorical dimension (e.g., region, product, team)
- Cross-filtering: clicking one widget filters others (specify which widgets are linked)
- Drill-down paths: what happens when a user clicks a KPI card, chart data point, or table row
- Search functionality: where applicable, what fields are searchable
- Sort behavior: default sort order, sortable columns, multi-column sort
- Export options: CSV, PDF, screenshot, email scheduled report

9. RESPONSIVE BEHAVIOR (6-10 sentences):
- Desktop (>1200px): full layout with all widgets visible, specific column grid (e.g., 12-column)
- Tablet (768-1200px): reorganized grid, specify which widgets stack or collapse
- Mobile (<768px): single-column stack, specify order priority, which widgets are hidden or collapsed
- Touch interactions: swipe between tabs, pinch-to-zoom on charts
- Performance: lazy loading for below-fold content, skeleton loading states

10. HUMAN-IN-THE-LOOP CHECKPOINTS (6-10 sentences):
- Data accuracy review: who verifies metric calculations before dashboard goes live
- Metric definition sign-off: stakeholder approval of how each metric is calculated
- Threshold configuration: who sets alert thresholds and how they are updated
- Access control review: who approves user permissions for sensitive data views
- Change management: process for updating metric definitions, adding new widgets, or modifying data sources
- Anomaly escalation: when the dashboard flags unusual data, who gets notified and what is the review process

11. ACCEPTANCE CRITERIA (12-20 numbered items):
- Specific, testable criteria covering: data accuracy, performance (load time <2s), responsive behavior, filter functionality, export functionality, error handling, accessibility (WCAG 2.1 AA), cross-browser compatibility
- Include edge cases: empty data states, single data point, maximum data volume, concurrent users
- Each criterion must be binary pass/fail testable`;

  return {
    name: 'prd-proxy',
    configureServer(server) {
      server.middlewares.use('/api/generate-prd', (req: Connect.IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'API key not configured' }));
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { user_needs, image_prompt, target_audience, key_metrics, data_sources, dashboard_type, visual_style, color_scheme, update_frequency } = JSON.parse(body);

            const userMessage = [
              `DASHBOARD PURPOSE: ${user_needs}`,
              `DASHBOARD DESIGN: ${image_prompt}`,
              target_audience ? `TARGET AUDIENCE: ${target_audience}` : '',
              key_metrics ? `KEY METRICS: ${key_metrics}` : '',
              data_sources ? `DATA SOURCES: ${data_sources}` : '',
              dashboard_type ? `DASHBOARD TYPE: ${dashboard_type}` : '',
              visual_style ? `VISUAL STYLE: ${visual_style}` : '',
              color_scheme ? `COLOR SCHEME: ${color_scheme}` : '',
              update_frequency ? `UPDATE FREQUENCY: ${update_frequency}` : '',
            ].filter(Boolean).join('\n');

            const parsed = await callOpenRouterJSON(apiKey, model, systemPrompt, userMessage, 'prd');
            if (parsed?.__error) {
              res.statusCode = parsed.__error === 429 ? 429 : 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: parsed.__error === 429 ? 'The AI service is temporarily busy. Please wait a moment and try again.' : 'AI service error', retryable: true }));
              return;
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(parsed));
          } catch (err) {
            console.error('Proxy error (PRD):', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal server error', retryable: true }));
          }
        });
      });
    },
  };
}

// ─── Insight Analysis Proxy ───

function insightAnalysisProxyPlugin(apiKey: string, model: string): Plugin {
  const systemPrompt = `You are an AI Upskilling Coach for the OXYGY AI Centre of Excellence. You analyze how learners apply AI in their work and give concise, actionable feedback.

CRITICAL RULE — QUALITY GATE:
Before providing analysis, assess whether the learner has given enough meaningful information. If the context or outcome is:
- Too vague (e.g., "used AI for something", "it was good")
- Nonsensical or irrelevant (e.g., random text, off-topic content)
- Too short to meaningfully analyze (fewer than ~15 words across both fields)

Then you MUST respond with the clarification format instead of the analysis format.

The five levels of the OXYGY AI upskilling framework are:
- Level 1: AI Fundamentals & Awareness — Basic prompting, everyday use cases, understanding LLMs
- Level 2: Applied Capability — Custom GPTs, AI agents, system prompt design
- Level 3: Systemic Integration — Workflow mapping, agent chaining, automated processes
- Level 4: Interactive Dashboards & Front-Ends — UX design for AI, dashboard prototyping, data visualization
- Level 5: Full AI-Powered Applications — Application architecture, personalization engines, full-stack AI

RESPONSE FORMAT — Choose ONE of the two formats below:

FORMAT A — When the insight lacks sufficient detail:
{
  "needsClarification": true,
  "clarificationMessage": "A friendly 1-2 sentence message explaining what additional detail would help. Be specific about what's missing.",
  "useCaseSummary": "",
  "nextLevelTranslation": "",
  "considerations": [],
  "nextSteps": ""
}

FORMAT B — When the insight has enough detail to analyze:
{
  "needsClarification": false,
  "useCaseSummary": "A concise 2-3 sentence summary of what they built or applied. Start with what they did, then acknowledge the outcome. Keep it factual and encouraging.",
  "nextLevelTranslation": "1-2 sentences explaining how this use case could be evolved into the NEXT level of the framework. Be specific — e.g., if they built a Level 2 custom GPT, describe what a Level 3 workflow integration version would look like.",
  "considerations": [
    "A practical consideration about data privacy, security, or governance",
    "A consideration about reliability, testing, or user adoption"
  ],
  "nextSteps": "1 sentence with a specific, actionable next step for their learning journey."
}

RULES:
- Keep all text concise. No filler phrases.
- Be direct and useful. Every sentence should contain actionable information.
- The nextLevelTranslation is the most important field — make it specific and practical.
- You must respond in valid JSON only.`;

  return {
    name: 'insight-analysis-proxy',
    configureServer(server) {
      server.middlewares.use('/api/analyze-insight', (req: Connect.IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'API key not configured' }));
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { level, topic, context, outcome, rating, userProfile } = JSON.parse(body);

            const profileContext = userProfile
              ? `\n\nLearner Profile:\n- Role: ${userProfile.role || 'Not specified'}\n- Function: ${userProfile.function || 'Not specified'}\n- Seniority: ${userProfile.seniority || 'Not specified'}\n- AI Experience Level: ${userProfile.aiExperience || 'Not specified'}`
              : '';

            const userMessage = `Please analyze this AI application insight:

Level: ${level}
Topic: ${topic}
Context: ${context}
Outcome: ${outcome}
Self-assessed Impact Rating: ${rating}/5${profileContext}`;

            const parsed = await callOpenRouterJSON(apiKey, model, systemPrompt, userMessage, 'insight');
            if (parsed?.__error) {
              res.statusCode = parsed.__error === 429 ? 429 : 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: parsed.__error === 429 ? 'The AI service is temporarily busy. Please wait a moment and try again.' : 'AI service error', retryable: true }));
              return;
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(parsed));
          } catch (err) {
            console.error('Proxy error (Insight):', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal server error', retryable: true }));
          }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const geminiModel = env.GEMINI_MODEL || 'google/gemini-3-flash-preview';
  const dashboardModel = env.DASHBOARD_MODEL || 'google/gemini-3.1-flash-image-preview';

  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [
      react(),
      geminiProxyPlugin(env.OpenRouter_API, geminiModel),
      agentDesignProxyPlugin(env.OpenRouter_API, geminiModel),
      workflowDesignProxyPlugin(env.OpenRouter_API, geminiModel),
      architectureProxyPlugin(env.OpenRouter_API, geminiModel),
      pathwayProxyPlugin(env.OpenRouter_API, geminiModel),
      dashboardDesignProxyPlugin(env.OpenRouter_API, dashboardModel, geminiModel),
      prdProxyPlugin(env.OpenRouter_API, geminiModel),
      insightAnalysisProxyPlugin(env.OpenRouter_API, geminiModel),
      sendPitchPlugin(env.RESEND_API_KEY),
    ],
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          barcelona: path.resolve(__dirname, 'barcelona.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
  };
});
