# Agent Development Guide

`demo` is a Rust/Bevy game development sandbox with gameplay undecided. Read [docs/architecture.md](docs/architecture.md) before changing `src/`; follow [docs/development.md](docs/development.md) for code and [docs/AGENTS.md](docs/AGENTS.md) for documentation.

## Repository layout

```text
src/                   Feature directories, each owning one project Plugin
  main.rs              Explicit plugin assembly and application entry point
  game_flow/           Application states, clocks, and cross-feature ordering
  first_person/        Player actions, pointer capture, facing, and camera
  character/           Character identity, movement, grounding, and jumping
  item_interaction/    Pickup, shared-body carrying, release, and feedback
  physics/             Avian setup, gravity, and shared collision layers
  bounds_recovery/     Water recovery and interpolation reset
  scene_assembly/      Asset loading, map collision, and entity assembly
  character_animation/ Animation binding, blending, and visual grounding
  ui/                  Menus, widgets, navigation, styling, and backdrop
  audio/               Sound contracts, mixing, playback, and device output
  settings/            Settings, drafts, shared prototype parameters, pacing
  inspector/           World inspector integration
  session_log/         Session logging, background output, and exit flush
  window_policy/       Platform-specific window behavior
art/                   Asset authoring sources and tooling
  blender/             Blender source projects
  scripts/             Asset generation, export, validation, and previews
  previews/            Rendered images and asset catalogs
  items/               Item asset manifest and guide
  *.json               Asset manifests and build/validation reports
  ASSET_GUIDE.md       Art asset guide
assets/                Runtime assets grouped by resource type
  maps/                Exported GLB maps
  models/              Character, prop, building, environment, and item models
  audio/               Sounds, metadata, and source/license records
  ui/                  UI resources
    fonts/             UI fonts, sources, and licenses
```

## Required Reading

- Before changing code, read the [Development Standards](docs/development.md), the relevant sections of the [Current Architecture](docs/architecture.md), and the [Testing Guide](docs/testing/README.md).
- When changing UI, BSN layouts, or button interactions, pay particular attention to the [UI Layout and Highlighting Standards](docs/development.md#ui-布局与高亮规范) and [Text Layout and Highlighting Regression Checks](docs/testing/README.md#文字布局与高亮回归) to prevent zero-width text and input-source confusion from recurring.
- For gameplay requirements, read the [Game Design](docs/game-design.md) and related issues. Distinguish confirmed decisions, design suggestions, and open questions. See the [Usage Guide](docs/usage.md) for currently available capabilities, controls, and configuration; the source code is authoritative for actual implementation.
- For documentation-only changes, read the affected documents and their applicable writing rules, then check content and links.

[Cargo.toml](Cargo.toml) and [Cargo.lock](Cargo.lock) are authoritative for dependency versions and build settings. Use APIs and examples that match those versions.

## Conventions

- Each first-level directory under `src/` owns exactly one project `Plugin`. Keep implementation files flat within that feature and follow the [test organization rules](docs/development.md#测试代码组织); do not hide additional project plugins in the directory or add directories without their own plugin. Compose project plugins explicitly in `main.rs`; cross-feature scheduling uses the shared contracts in [Current Architecture](docs/architecture.md).
- All new or modified game logic must follow ECS and use this project's Bevy implementation. Keep entity identity, component data, shared resources, and system behavior in their respective roles.
- Prefer BSN-style declarative code when assembling scenes, UI, and other entity hierarchies, clearly expressing component composition and child entity structure. Keep runtime behavior in ECS systems or Observers. See the [Scene and UI Assembly Standards](docs/development.md#场景与-ui-装配规范) for the full rules.
- Keep all temporary repository files under the root `tmp/` directory and do not commit them. See the [Temporary File Rules](docs/development.md#临时文件管理) for details.
- Use Conventional Commits for commit titles, with the title language determined by explicit user instructions or repository convention. Write commit bodies in Chinese and describe only changes, reasons, and necessary impact. Keep validation results, temporary record locations, and pending acceptance notes in delivery notes or the corresponding Issue/PR. Preserve fixed footer markers verbatim and write their accompanying natural-language descriptions in Chinese.
- After changing Rust code, run `cargo fmt --all -- --check` and `cargo check --locked`. Add or run targeted headless tests for behavior changes. See the [Testing Guide](docs/testing/README.md) for the full self-review and validation workflow.
- If a general engineering convention must be departed from, explain the specific reason and impact in code comments or delivery notes, and keep the exception narrowly scoped.

## Validation

Do not use computer-use to launch or operate the game.

## Delivery Requirements

Before finishing, follow the [Testing Guide](docs/testing/README.md) checklist to review ECS design, comments, system access and ordering, deferred commands, registration and lifecycle, and file logging. For ordinary documentation-only changes, checking content and links is sufficient. If architecture diagrams change, also complete their visual checks.

Delivery notes must describe the specific changes, validation actually completed, and any unverified items. For behavior that depends on gameplay, include user-performed steps, expected results, and log locations. Record execution details in the corresponding issue or PR; keep reusable guidance in long-term documentation.
