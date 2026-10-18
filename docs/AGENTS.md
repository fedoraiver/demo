# AGENTS.md — The documentation standard

This file defines structure, ownership, writing, and validation rules for human-facing documentation. Agent Notes and postmortems are outside its scope and follow their own READMEs. Repository-wide execution rules remain in the root [AGENTS.md](../AGENTS.md).

## Document structure

A document's subject and position determine its scope. Describe that subject at appropriate detail; introduce related documents by purpose and link to their owners for details.

Classify each in-scope document as a guide or reference. Guides establish prerequisites and follow steps toward an outcome. References organize current behavior by topic. Separate substantial guide and reference content.

Before writing, choose the reader, subject, document home, and required detail. Reuse an existing owner before adding another document. Do not create placeholder documents or directories for completeness.

## The tier taxonomy: one home per fact

Each fact has one complete home. Elsewhere, summarize briefly and link there. The Agent Notes and postmortem rows identify ownership only; this file does not govern their structure or writing.

| Tier | Job | Does NOT belong there |
| --- | --- | --- |
| Root `AGENTS.md` | Repository-wide standing instructions and reading entry points | Detailed procedures, examples, historical explanations |
| Subtree `AGENTS.md` | Instructions specific to that subtree or document class | Repeated repository-wide rules |
| Root `README.md` | Project introduction, launch instructions, documentation index | Detailed architecture, configuration, and validation procedures |
| [usage.md](usage.md) | Available capabilities, controls, settings, resources, and log locations | Internal implementation details or unconfirmed gameplay |
| [game-design.md](game-design.md) | Confirmed gameplay decisions, proposals, and open questions | Claims that experiments or assets establish implemented gameplay |
| [development.md](development.md) | Engineering conventions, build setup, and development workflow | Current module inventories, detailed acceptance procedures, decision history |
| [architecture.md](architecture.md) | Current composition, ECS responsibilities, relationships, scheduling, and data flow | Historical evolution, decision debates, investigation transcripts |
| [testing/README.md](testing/README.md) | Developer check methods, headless coverage, artifact checks, and acceptance entry points | Full game walkthroughs, individual execution results, and debugging journals |
| [testing/game-acceptance.md](testing/game-acceptance.md) | User-performed game checks, expected behavior, and session-log acceptance | Headless test internals or individual execution results |
| [audio.md](audio.md) and asset guides | Their own pipeline, authoring, integration, and usage contracts | Duplicated source manifests, attribution records, or unrelated gameplay decisions |
| [diagrams/](diagrams/README.md) | Generated architecture views and their maintenance workflow | Hand-edited generated outputs or independent copies of source contracts |
| [agents/](agents/domain.md) | Issue-tracker, label, and domain-reading conventions | Task progress or a second copy of domain architecture |
| [Agent Notes](../.agents/notes/README.md) | Durable decisions, motivation, alternatives, consequences, and verification requirements | Complete runtime references or task journals |
| [postmortem/](postmortem/README.md) | Incident evidence, failure mechanisms, missed safeguards, and prevention | Feature proposals or the current runtime specification |
| Skills (`.agents/skills/`) | Reusable workflows and specialized execution guidance | Product contracts or duplicated architecture |
| Issues and PRs | Requirements discussion, task progress, investigation evidence, and individual validation results | The only copy of reusable guidance or durable decisions |

Current architecture may explain local invariants and implementation constraints. Lasting decision motivation, rejected alternatives, and trade-offs belong in Agent Notes.

## Writing rules

- Describe current mechanisms in present tense. Remove superseded designs, completed migration instructions, and historical before-and-after narration.
- Preserve necessary contracts: behavior, constraints, failure conditions, timing, ownership, lifecycle, and non-obvious consequences.
- Distinguish implemented behavior, confirmed design, suggestions, and open questions. Scenes and assets do not establish gameplay requirements.
- Use Chinese for human-facing prose. Preserve identifiers, API names, commands, paths, and necessary technical terms.
- Write directly with focused paragraphs. Omit reasoning transcripts, debugging walkthroughs, and explanations that merely restate code.
- Keep one physical line per paragraph and use editor soft-wrap. Preserve list, table, and code-block structure.
- Use relative Markdown links for repository files and anchors for sections. Label fenced code blocks with their language.
- Avoid duplicated rules, manually repeated source inventories, paragraph walls, and excessive emphasis.

## Maintenance and validation

- Update the owning documentation alongside changes to documented behavior. Check commands, parameters, paths, and examples against current source and configuration.
- When moving or deleting content, repair incoming links and remove duplicated or orphaned explanations.
- Record individual execution results in the corresponding Issue or PR, following [Issue Tracking Conventions](agents/issue-tracker.md).
- Maintain ECS diagrams through [Project Skill Maintenance](diagrams/README.md#项目-skill-维护). Update their owning inventory or generator, regenerate outputs, and complete the required structural and visual checks.
- For ordinary documentation changes, check facts, ownership, links, anchors, and formatting. Follow the [Testing Guide](testing/README.md) when additional validation is required.
