# harnesses/declarative-agent

M365 declarative agent. Not wired, and nothing is ported through the scoring seam yet.

ART's entry point is `declarative-agent\hooks\useDAReviewMutation.ts::executeDAReviewPipeline` — a
React-free pipeline covering deterministic manifest and package validation, custom-skill review and
durable workflow evaluation. Wiring it here needs a rubric registered for the harness first; the
scorer behind `art-ports.ts` holds zero declarative-agent rules, so a DA subject reaching it today
would be measured against nothing.

