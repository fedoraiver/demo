# Agent Development Guide

`demo` is a Rust/Bevy game development sandbox with gameplay undecided. Read the [Bevy App overview](docs/architecture/README.md) and its linked module references before changing `src/`; follow [docs/development.md](docs/development.md) for code and [docs/AGENTS.md](docs/AGENTS.md) for documentation.

## Repository layout

```text
apps/                  Independent executable packages for game, acceptance, inspection, and schedule export
src/                   Shared feature source compiled into the executable packages
  game_flow/           Application states, clocks, and cross-feature ordering
  first_person/        Player actions, pointer capture, facing, and camera
  character/           Character identity, movement, grounding, and jumping
  item_interaction/    Pickup, shared-body carrying, and release
  physics/             Avian setup, gravity, and shared collision layers
  scene_assembly/      Procedural grey-box floor, player, and test blocks
  ui/                  Menus, widgets, navigation, styling, and backdrop
  audio/               Sound contracts, mixing, playback, and device output
  settings/            Settings, drafts, shared prototype parameters, pacing
  inspector/           World inspector integration
  session_log/         Session logging, background output, and exit flush
  window_policy/       Platform-specific window behavior
scripts/               Python acceptance and asset tooling
assets/                Runtime resources
  audio/               Sounds, machine-readable metadata, and license evidence
  ui/                  UI resources
    fonts/             UI fonts and bundled licenses
```

## Required Reading

- Before changing code, read the [Development Standards](docs/development.md), [Bevy App and Project Modules](docs/architecture/README.md), the relevant module references, and the [Testing Guide](docs/testing/README.md). Project states, clocks, and cross-feature scheduling are maintained in [Game Flow](docs/architecture/game_flow.md).
- When investigating a regression or changing a previously affected path, consult relevant [incident records](docs/postmortem/README.md) for failure conditions and regression checks.
- For gameplay requirements, read the [Game Design](docs/game-design.md) and related issues. Distinguish confirmed decisions, design suggestions, and open questions. See the [Player Guide](docs/player-guide.md) for currently available capabilities, controls, and configuration; the source code is authoritative for actual implementation.
- For documentation-only changes, read the affected documents and their applicable writing rules, then check content and links.
- For asset maintenance, read the [asset documentation](docs/assets/README.md); authoring, import, event mappings, and source records belong there, while runtime module architecture has its own references.

[Cargo.toml](Cargo.toml) and [Cargo.lock](Cargo.lock) are authoritative for dependency versions and build settings. Use APIs and examples that match those versions.

## Conventions

- Each feature directory under `src/` owns exactly one project `Plugin`. Keep implementation files flat within that feature and follow the [test organization rules](docs/development.md#测试代码组织); do not hide additional project plugins in the directory. Each entry point in `apps/` imports its source modules, constructs its Bevy App, and registers its gameplay plugins, backends, and diagnostics. Cross-feature scheduling uses the shared contracts in [Game Flow](docs/architecture/game_flow.md#调度与模拟边界).
- All new or modified game logic must follow ECS and use this project's Bevy implementation. Keep entity identity, component data, shared resources, and system behavior in their respective roles.
- Prefer BSN-style declarative code when assembling scenes, UI, and other entity hierarchies, clearly expressing component composition and child entity structure. Keep runtime behavior in ECS systems or Observers. See the [Scene and UI Assembly Standards](docs/development.md#场景与-ui-装配规范) for the full rules.
- Keep all temporary repository files under the root `tmp/` directory and do not commit them. See the [Temporary File Rules](docs/development.md#临时文件管理) for details.
- During development, create or update [Agent Notes](docs/notes/README.md) so developers can review the design, work completed, choices made, and their reasons. Keep the note current as work progresses and before delivery, following its recording and lifecycle rules.
- Use Conventional Commits for commit titles, with the title language determined by explicit user instructions or repository convention. Write commit bodies in Chinese and describe only changes, reasons, and necessary impact. Keep validation results, temporary record locations, and pending acceptance notes in delivery notes or the corresponding Issue/PR. Preserve fixed footer markers verbatim and write their accompanying natural-language descriptions in Chinese.
- After changing Rust code, run `cargo fmt --all -- --check` and `cargo check --locked`. Add or run targeted headless tests for behavior changes. See the [Testing Guide](docs/testing/README.md) for the full self-review and validation workflow.
- If a general engineering convention must be departed from, explain the specific reason and impact in code comments or delivery notes, and keep the exception narrowly scoped.

## Validation

Do not use computer-use to launch or operate the game.

Automate acceptance checks wherever inputs can be driven and results observed. Follow the [Agent execution boundaries](docs/testing/README.md#agent-验证边界) and [acceptance guidance](docs/testing/README.md#验收测试).

## Delivery Requirements

Before finishing, follow the [Testing Guide](docs/testing/README.md) checklist to review ECS design, comments, system access and ordering, deferred commands, registration and lifecycle, and file logging. For ordinary documentation-only changes, checking content and links is sufficient.

Delivery notes must describe the specific changes, validation actually completed, and any unverified items. For gameplay behavior, report the scenarios exercised, expected results, observations, artifacts, and log locations. Record execution details in the corresponding issue or PR; keep reusable guidance in long-term documentation.
