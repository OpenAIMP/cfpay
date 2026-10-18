# Product Brief — cfpay Autopilot (working name)

**Status:** productization directive from the owner, 2026-10-17. The engineering is tracked in #242 (AutopilotAgent), the capability program in #241 (RSI), and the platform record in #192. This document is the product frame those issues execute against: who it is for, what is being sold, how success is measured, and which decisions are the owner's. It is a living document; product decisions are logged at the bottom.

## The one-liner

Give an AI agent a goal and a budget; it researches, builds, and maintains an optimized portfolio for you — reporting every step, and never trading without your approval.

## The buyer (initial ICP)

Self-directed retail investors on Public.com who run defined-risk options strategies (premium selling, spreads) and cannot watch markets all day. They already have opinions and a strategy; what they lack is continuous discovery, disciplined sizing, and follow-through. Secondary: active investors who want an always-on analyst that works to a stated objective instead of answering one question at a time.

## The problem

Building and maintaining a good portfolio is a continuous job — scanning for setups, checking them against spot and expiry, sizing them, tracking what was recommended and how it did, rebalancing as conditions change. Today's tools are either reactive (a chatbot answers the question you thought to ask) or opaque (a robo-advisor allocates by formula and cannot explain a defined-risk options book). Nobody sells an agent that works a stated goal on a schedule, shows its evidence, and asks before it trades.

## The product

**AutopilotAgent** (issue #242): a standing agent the customer endows with a goal and a budget. It runs discovery on a cadence through the fleet (ScheduledAgent), researches with the customer's own context (SearchAgent over their reports/emails/messages, ChatAgent over their conversation history), constructs portfolio recommendations with deterministic sizing and moneyness verification, delivers a recommendations report by email (EmailAgent) with lifecycle notifications (SlackAgent: research started, recommendation ready, approval needed, trade done), executes only through the human-approved trade workflow, and records every outcome in a ledger that changes the next cycle's discovery brief (the RSI loop, #241).

It is a fleet product, not a model feature: eleven specialist agents already exist; AutopilotAgent is the objective owner that puts them to work on the customer's goal.

## Why this wins (differentiation)

- **Agent-native, not chatbot-plus-tools.** A standing objective with a schedule, memory, and a budget — a different category from "ask the AI about stocks."
- **Transparency as the product.** Every figure is sourced from live tool data or shown as `n/a`; every action is attributable: goal → discovery → proposal → approval → execution → outcome. For a product that touches money, the audit trail is the pitch.
- **Defined-risk craft.** The engine hunts defined-risk structures with verified moneyness and code-computed sizing — a discipline generic allocators and chatbots do not have.
- **It improves.** The outcome ledger and strategy memory (RSI program, #241) mean cycle 50 is measurably better than cycle 1 — and the customer can read the self-review that proves it.
- **No custody change.** It works through the customer's own Public.com connection. Their account, their approvals, their kill switch.

## Packaging (hypotheses — to validate, not commitments)

| Tier | Contents | Buyer |
|---|---|---|
| Desk | The agentic desk as it exists: reactive questions, data, proposals with approval | Anyone evaluating |
| Autopilot | Standing goal + budget, scheduled discovery, recommendation reports, notifications, approval-gated execution | The ICP above |
| Autopilot Pro | Portfolio construction (multi-strategy allocation, portfolio-level caps), the learning loop with self-review reports, priority cadence | Larger budgets, power users |

Pricing model is an open owner decision (flat subscription vs tiered by budget under management). Any price points used in planning are placeholders until validated against willingness-to-pay conversations; none are asserted here.

## Metrics that define "working"

- **Activation:** a new customer sets a goal + budget and connects Public in the first session.
- **First value:** the first discovery cycle completes and a recommendations report is delivered.
- **Trust:** recommendation approval rate; zero unapproved executions, ever (a guardrail metric, not a growth metric).
- **Efficacy:** outcome-ledger performance of approved recommendations against the goal's stated benchmark, reported to the customer in the self-review.
- **Retention:** objectives still active week over week.
- **North star:** total budget under active management.

## Roadmap (product view of #242's phases)

- **P0 — Enablers.** Host desk operations over A2A; AutopilotAgent design settled (token custody: host keeps it). Customer-visible effect: today's autopilot becomes schedulable.
- **P1 — The agent.** Goal + budget intake, scheduled discovery, report + notifications. First sellable slice: "it works while you sleep, and shows you what it did."
- **P2 — Portfolio construction.** Allocation, portfolio-level caps, rebalance proposals.
- **P3 — Funding + execution integration.** Brokerage funding recorded end to end; trade-done notifications; full attribution chain.
- **P4 — The learning loop.** Outcome ledger → strategy memory → self-review. The tier-upgrade story and the moat.

Productization workstream (parallel, owned here): onboarding flow (connect → goal → budget → first cycle), billing, support and status communications, and the compliance review below.

## Risks and open owner decisions

1. **Regulatory — decide before charging.** Selling personalized portfolio recommendations can constitute investment advice (SEC / state adviser law), with registration and fiduciary implications. This needs legal review, and the product's claims, disclosures, and the advice/education line must be designed around the answer. Flagged as a launch gate, not a footnote.
2. **Brokerage scope.** Public.com only at launch (its token/API model is what the platform is built on). Expansion is a later decision.
3. **Pricing model and points.** Open (see Packaging).
4. **Name and brand.** "cfpay Autopilot" is a working name.
5. **Unit economics.** Each discovery cycle burns Workers AI neurons; cadence is the cost lever, and the account-level quota question (4006 desync, owner-side) must be resolved for predictable margins.
6. **Recommendation liability posture.** Defined-risk only in v1; disclaimers and the approval gate are part of the product, not legal boilerplate.

## Decision log

- 2026-10-17 — Productization directive: the system is to be sold as a product and managed as one (owner). This brief created; engineering continues under #242.
- 2026-10-17 — Human approval for orders stays a product invariant; any change is a separate explicit owner decision (carried from #242).
- 2026-10-17 — Token custody stays with the host agent; AutopilotAgent dispatches to it over A2A (recommended in #242, P0 to confirm).
