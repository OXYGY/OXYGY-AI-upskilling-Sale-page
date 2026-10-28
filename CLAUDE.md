# Oxygy AI Upskilling Website

## Project Overview
Interactive multi-section website for Oxygy's AI Centre of Excellence. Showcases a five-level AI upskilling framework. Dual audience: external clients (showcase) + internal participants (learning hub).

## Site Sections
1. Homepage / Hero
2. Five Levels (L1-L5, progressive complexity)
3. Cross-Functional Use Cases (8 functions)
4. Learning Formats
5. Skills-Based Competency Gaps
6. Using AI to Learn Better
7. Footer CTA

## Brand & Visual Guidelines

### Colors
- Dark Navy: #1A202C to #2D3748 (headings, hero bg, nav, primary text)
- Oxygy Blue: #1E3A5F to #2B4C7E (icon circles, accents)
- Teal: #38B2AC to #4FD1C5 (primary CTAs, accent borders, links)
- Lavender: #C3D0F5 to #B8C9F0
- Pale Yellow: #F7E8A4 to #FBE8A6
- Soft Peach: #F5B8A0 to #FBCEB1
- Mint: #A8F0E0 to #B2F5EA
- Ice Blue bg: #E6FFFA to #F0FFF4
- White: #FFFFFF (dominant bg)
- Light Gray: #F7FAFC to #EDF2F7 (alt section bg)
- Medium Gray: #A0AEC0 (body text)
- Body Text Gray: #4A5568 to #718096
- Border Gray: #E2E8F0

### Typography
- Font: Geometric/humanist sans-serif from Google Fonts (DM Sans, Outfit, Plus Jakarta Sans, Manrope)
- NEVER: Inter, Roboto, Arial
- Headings: Bold 700-800, dark navy #1A202C. Hero ~48-56px, section ~32-40px, card ~18-20px
- Body: Regular 400, 14-16px, gray #4A5568-#718096, line-height 1.6-1.8, max ~500-600px columns
- Teal underline decoration on key heading words (NOT colored text)

### Components
- Cards: white bg, 1px solid #E2E8F0, no shadow
- Buttons Primary: solid teal #38B2AC, white text, pill shape (border-radius 24-30px)
- Buttons Secondary: white/transparent, 1px solid dark navy, pill/rounded rect
- Card CTA: bordered rect, navy text + arrow, NOT filled

### Layout
- Alternating white / light gray section backgrounds
- 80-120px vertical padding between sections
- ~1100-1200px max-width centered
- Two-column splits: text ~45% + visual ~55%
- Full-width teal CTA band with subtle watermark

### Avoid
- No purple gradients, glassmorphism, floating abstract shapes
- No Inter/Roboto/Arial
- No drop shadows on cards
- No colored heading text (always dark navy, teal underline only)
- No heavy gradients
- No center-aligned body text
- No oversized buttons

## Git Workflow

**Repository:** https://github.com/OXYGY/OXYGY-AI-upskilling-Sale-page
**Branch:** `main`

### STRICT RULE — NO PUSHING WITHOUT USER APPROVAL

**NEVER push to `origin main` (or any remote branch) automatically.** This is a hard, non-negotiable rule that overrides all other instructions.

The required workflow is:

1. After completing a feature or change, stage the changed files with `git add` (specific files, not `git add .`)
2. Commit locally with a clear message describing the change
3. **STOP. Do NOT run `git push`.** Instead, start the local dev server (`npx vite`) so the user can visually verify the changes on localhost
4. **Wait for the user to explicitly confirm** that everything looks correct and works as expected
5. **Only after the user says to push**, run `git push origin main`

If the user has not reviewed the localhost and explicitly approved the push, **do not push under any circumstances** — even if previous instructions say to push automatically. This rule takes absolute priority.

If a task involves multiple related changes, commit them together as one logical unit. If a task involves unrelated changes, use separate commits.

Never commit `.env.local`, credentials, or large binary files.

## Firebase Hosting

**Firebase project:** `oxygy-ai-upskilling-sales-page`

This project has three Hosting sites, wired up as deploy targets in `firebase.json` / `.firebaserc`:

| Target | Site ID | URL | Status |
|--------|---------|-----|--------|
| `enablement` | `oxygy-ai-enablement` | https://oxygy-ai-enablement.web.app | **Current live site — deploy here** |
| (site-scoped, no target) | `oxygy-ai-upskilling-sales-page` | https://oxygy-ai-upskilling-sales-page.web.app | Legacy/prior site |
| `demo` | `oxygy-upskilling-demo` | https://oxygy-upskilling-demo.web.app | Demo site |

**After pushing to GitHub, deploys do NOT happen automatically** — there's no CI/CD hookup. To publish a change to the live site:

```
npm run build
firebase deploy --only hosting:enablement --project oxygy-ai-upskilling-sales-page
```

Ask the user for confirmation before deploying, same as before pushing to GitHub — it publishes immediately to a public URL.

## Artifact Page Design Standards

Every Level artifact page (L1 Playground, L2 Agent Builder, L3 Workflow Designer, etc.) MUST follow this consistent layout pattern. These rules are non-negotiable for visual consistency across all artifact pages.

### Page Structure (top to bottom)

1. **Outermost container**: `min-h-screen bg-white pt-24 pb-16`
2. **Content wrapper**: `max-w-7xl mx-auto px-6` — full-width (1280px), NOT narrow (never use max-w-3xl for the main wrapper)
3. **Breadcrumb**: `← Back to Level N` link at top-left, `text-[14px] text-[#718096]`, hover changes to level accent color
4. **Centered Title**: `text-center`, `text-[36px] md:text-[48px] font-bold text-[#1A202C] leading-[1.15]` with a `<br />` between two lines. One keyword gets an accent-colored underline (`absolute left-0 -bottom-1 w-full h-[4px] opacity-80 rounded-full`). NEVER use colored text — always dark navy with underline decoration only.
5. **Fun Fact Card**: Full-width `rounded-2xl` card with:
   - Subtle gradient background using the level's accent color at low opacity
   - Border: `1.5px solid [accent color]`
   - Three decorative dots top-left (`absolute top-3 left-4`, 2x2 rounded-full circles in accent colors)
   - "Did you know?" label: `text-[11px] font-bold uppercase tracking-[0.1em]` in accent color
   - Main fact: `text-[17px] md:text-[19px] font-medium text-[#2D3748] leading-[1.6]` with a key stat bolded in accent color
   - Supporting text: `text-[15px] text-[#718096] leading-[1.6]`
   - Text centered (`text-center`)
6. **Input Section**: Wrapped in a visually distinct colored card:
   - Background: subtle gradient using the level's accent color (e.g., lavender for L2, pale yellow for L3)
   - Border: `1.5px solid [accent color]`
   - Rounded: `rounded-2xl`
   - Padding: `p-6 sm:p-8`
   - Contains: example pills, labeled textareas, CTA button, optional callout
   - Textarea border color matches accent color (`border-2 border-[accent]`)
   - Focus state: `focus:border-[darker accent] focus:ring-[3px]`
7. **Results/Output Section**: Full-width cards, accordions, or canvas depending on the level
8. **Bottom Actions**: `Start Over` button + link to next level

### Level Accent Colors (for artifact pages)

| Level | Accent Light | Accent Dark | Use For |
|-------|-------------|-------------|---------|
| L1 | `#38B2AC` (Teal) | `#2C9A94` | Underline, fun fact, buttons, focus |
| L2 | `#C3D0F5` (Lavender) | `#5B6DC2` | Underline, fun fact, input card bg, buttons |
| L3 | `#FBE8A6` (Pale Yellow) | `#C4A934` | Underline, fun fact, input card bg, buttons |
| L4 | `#FBCEB1` (Soft Peach) | `#D97B4A` | Underline, fun fact, input card bg, buttons |
| L5 | `#38B2AC` (Teal) | `#2C9A94` | Underline, fun fact, input card bg, buttons |

### Rules

- Title is ALWAYS centered (`text-center`), NEVER left-aligned
- Fun fact card is ALWAYS present, NEVER omitted
- Input section ALWAYS has a colored background card, NEVER plain white
- Content uses `max-w-7xl` (full-width layout), NOT `max-w-3xl` or narrower
- Every artifact page has a breadcrumb, centered title, fun fact, input section, and results section in that order
- Toast notifications: fixed bottom-center, dark navy bg, white text
- Example pills are inline flex-wrap, styled with the level's accent border/bg
- CTA buttons use the level's dark accent color as background with white text

## Cross-Page Standards
- See `ARTIFACT_PAGE_STANDARDS.md` for mandatory design specifications for all artifact pages
- All new artifact pages MUST follow these standards
- Shared closing component: `components/ArtifactClosing.tsx`

## Reference
- Full content spec: OXYGY_AI_UPSKILLING_SYSTEM_PROMPT.md
- PDF content source: OXYGY_AI_Upskilling.pdf

## Skills

Before building any e-learning page or learning module, read and follow:
`PRD/SKILL-Elearning-Page.md`

This file defines the mandatory template, brand tokens, component specs, slide types, and quality rules for all e-learning pages on this site. Do not deviate from it.
