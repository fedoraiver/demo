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
| [player-guide.md](player-guide.md) | Player-facing capabilities, controls, settings, resources, and log locations | Internal implementation details or unconfirmed gameplay |
| [game-design.md](game-design.md) | Confirmed gameplay decisions, proposals, and open questions | Claims that experiments or assets establish implemented gameplay |
| [development.md](development.md) | Engineering conventions, build setup, and development workflow | Current module inventories, detailed acceptance procedures, decision history |
| [architecture/README.md](architecture/README.md) | Generic Bevy App concepts, default lifecycle, and the project module index | Project-specific startup, states, clocks, scheduling, or module implementation details outside the module index |
| [architecture/game_flow.md](architecture/game_flow.md) | Project application states, clocks, session lifecycle, and cross-feature scheduling contracts | Duplicated generic Bevy explanations or other modules' internal behavior |
| [architecture/](architecture/) | Module-owned ECS responsibilities, relationships, internal scheduling, lifecycle, and failure boundaries | Duplicated shared contracts, asset authoring guides, or decision history |
| [testing/README.md](testing/README.md) | Test frameworks, unit/integration/system/acceptance levels, shared validation boundaries, and module entry points | Detailed module checklists or individual execution results |
| [testing/](testing/) | Module-specific test scenarios, commands, expected results, and user-performed acceptance | Duplicated framework rules or architecture-diagram tool tests |
| [assets/](assets/README.md) | Asset authoring, import and validation guides, event mappings, and source records | Runtime module architecture or duplicated machine-readable manifests and license evidence |
| [diagrams/](diagrams/README.md) | Generated architecture views and their maintenance workflow | Hand-edited generated outputs or independent copies of source contracts |
| [diagrams/testing.md](diagrams/testing.md) | Architecture-diagram regression coverage, export checks, and explicitly requested visual or protocol acceptance | Game-module test checklists or duplicated general validation rules |
| [domain.md](domain.md), [issue-tracker.md](issue-tracker.md), and [triage-labels.md](triage-labels.md) | Issue-tracker, label, and domain-reading conventions | Task progress or a second copy of domain architecture |
| [Agent Notes](notes/README.md) | Development designs, completed work, choices and rationale, alternatives, consequences, and verification boundaries for developer review | Raw command logs or duplicated current runtime references |
| [postmortem/](postmortem/README.md) | Incident evidence, failure mechanisms, missed safeguards, and prevention | Feature proposals or the current runtime specification |
| Skills (`.agents/skills/`) | Reusable workflows and specialized execution guidance | Product contracts or duplicated architecture |
| Issues and PRs | Requirements discussion, task progress, investigation evidence, and individual validation results | The only copy of reusable guidance or durable decisions |

The architecture overview introduces generic Bevy App mechanisms and indexes project modules. Game Flow owns project states, clocks, and cross-feature scheduling contracts; other module references own their local invariants and implementation constraints. Asset documentation lives under `docs/assets/`, while runtime resources, machine-readable metadata, and bundled license evidence remain under `assets/`. Development designs, completed work, decision motivation, rejected alternatives, and trade-offs belong in Agent Notes.

## Writing rules

- Describe current mechanisms in present tense. Remove superseded designs, completed migration instructions, and historical before-and-after narration.
- Preserve necessary contracts: behavior, constraints, failure conditions, timing, ownership, lifecycle, and non-obvious consequences.
- Distinguish implemented behavior, confirmed design, suggestions, and open questions. Scenes and assets do not establish gameplay requirements.
- Use Chinese for human-facing prose. Preserve identifiers, API names, commands, paths, and necessary technical terms.
- Write directly with focused paragraphs. Omit reasoning transcripts, debugging walkthroughs, and explanations that merely restate code.
- Keep one physical line per paragraph and use editor soft-wrap. Preserve list, table, and code-block structure.
- Use relative Markdown links for repository files and anchors for sections. Label fenced code blocks with their language.
- Avoid duplicated rules, manually repeated source inventories, paragraph walls, and excessive emphasis.
- Engineering documentation preserves required conventions, local validation requirements, and necessary maintenance interfaces. Execution platforms and their scheduling, resource, and deployment configuration are maintained in the implementation and are not repeated in documentation.

## Maintenance and validation

- Adding or changing a feature or constraint does not by itself require a documentation change. Add documentation only for information future development needs that cannot be directly and reliably inferred from the repository. Update existing documentation when a change makes it inaccurate, and check commands, parameters, paths, and examples against current source and configuration.
- When moving or deleting content, repair incoming links and remove duplicated or orphaned explanations.
- Record individual execution results in the corresponding Issue or PR, following [Issue Tracking Conventions](issue-tracker.md).
- Maintain generated ECS diagrams through [Architecture Maintenance](diagrams/maintenance.md). Update their owning inventory or generator, regenerate outputs, and follow the [validation scope](diagrams/testing.md#架构图视觉检查), including its default of no SVG visual validation. Inline Mermaid diagrams in architecture references are maintained with the prose and checked against source and Mermaid syntax.
- For ordinary documentation changes, check facts, ownership, links, anchors, and formatting. Follow the [Testing Guide](testing/README.md) when additional validation is required.
