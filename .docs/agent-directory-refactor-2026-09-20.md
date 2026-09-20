# Agent directory refactor — approved implementation plan

## Authorization and constraints

The user approved this directory/migration plan on 2026-09-20 and requested implementation, existing regression tests, and manual user-scenario acceptance. Preserve behavior, protocol fields, persisted formats, tool schemas, and lightweight explicit interfaces. Do not add compatibility forwarding modules, speculative abstractions, or circular dependencies. Do not delegate to subagents. Keep prompts.py as the single prompt entry.

Work from clean main 5fca0a1 on refactor/agent-directory. Make focused local commits; pushing/merging is not requested. This document is explicitly requested for retention under .docs (normally ignored).

## Target tree and responsibilities

All __init__.py files contain only package declarations/necessary exports; move catalog/spec-building implementation out of them.

```text
agent/ — Python agent engine
  prompts.py — prompts and builtin prompt compatibility
  version.py — product version
  bootstrap/ — dependency composition
    container.py — session execution container
  domain/ — environment-independent types, events and rules
    cancellation.py — cancellation signals
    compaction.py — shared handoff constants
    errors.py — structured boundary errors
    events.py — runtime events
    goal.py — goal normalization
    message_boundary.py — model message/tool pairing validation
    models.py — provider/model/completion/usage types
    planning.py — plan structure and status normalization
    skills.py — skill metadata and markdown parsing
    tool_payload.py — tool argument parsing
    tool_result.py — common tool result contract
  application/ — orchestration through explicit interfaces
    skill_selection.py — skill invocation and activation
    usage_summary.py — historical usage aggregation
    ports/ — external dependency contracts
      auth_interaction.py — authentication interaction
      chat_client.py — model calls
      provider_service.py — provider/model selection
      session_store.py — session state/history
      tool_registry.py — tool lookup/invocation
    context/ — request context, budgets and compaction
      manager.py — context assembly
      estimator.py — context budget estimates
      compaction.py — shared manual/automatic compaction
      handoff.py — valid compaction handoff messages
      snapshot.py — context composition snapshots
      token_usage.py — sampling usage and measurement anchors
    tools/ — tool execution pipeline
      processor.py — batches, events and persistence
      executor.py — execution and failure conversion
      result_normalizer.py — model/display projections
      change_events.py — file change events
      polling_guard.py — unproductive polling guard
  runtime/ — execution and client services
    core/ — transport-independent conversation engine
      runtime.py — execution state, cancellation and input queues
      turn_runner.py — context/model/tools loop
      stream_parser.py — model stream assembly
      stream_pump.py — stream events and sampling results
    server/ — client requests and long-lived worker
      app_server.py — command-line startup
      protocol.py — methods/envelopes/validation
      dispatcher.py — common requests, subscriptions and responses
      stdio.py — JSONL stdin/stdout transport
      websocket.py — websocket transport and authentication
      worker.py — worker resources and lifecycle
      session_service.py — ID-based session access and startup draft
      execution.py — active executions, inputs and release
      workspace_files.py — client workspace file protocol
      replay_events.py — durable replay projection
      resume_preview.py — resume history preview
      commands/ — slash commands
        contracts.py — command context/info/result
        catalog.py — explicit command catalog
        router.py — command parsing/dispatch
        formatting.py — shared text formatting
        compact.py — /compact
        help.py — /help and its display
        init_rind_doc.py — /init RIND.md
        model.py — /model and model-name handling
        sessions.py — /sessions
        skill.py — /skill
        status.py — /status and its display
        team.py — /team project/member management
  infrastructure/ — filesystem/network/environment adapters
    settings.py — settings loading/validation
    credentials.py — provider credentials
    paths.py — user/workspace/session path resolution
    environment.py — host/shell/prompt environment discovery
    workspace_images.py — image loading and message promotion
    rind_docs.py — RIND.md loading
    skills.py — filesystem skill discovery/loading
    llm/ — provider integrations
      provider_service.py — model selection/client creation/SDK factory
      catalog.py — builtin providers/models/capabilities
      openai_chat.py — unified Chat Completions adapter
      openai_responses.py — Responses adapter
      anthropic_messages.py — Anthropic adapter
      google_generative_ai.py — Google adapter
      cancellation.py — request cancellation/resource release
      trace.py — raw model call traces
    persistence/ — durable state and recovery
      jsonl_session_store.py — single-session store coordination
      session_files.py — locked JSON/JSONL IO
      session_meta.py — session metadata
      session_index_repository.py — session index
      session_fork.py — historical forks
      message_repository.py — raw messages
      message_projector.py — model history projection
      tool_call_repository.py — tool audit records
      compaction_repository.py — compaction records
      tool_output_store.py — full tool output artifacts
      plan.py — session plan storage and summaries
      usage_ledger.py — user usage ledger
    team/ — Team filesystem and delegation
      models.py — Team/member/resolution types
      project.py — Team project/member management
      manifests.py — Team manifest validation and YAML codec
      workspace_lock.py — cross-process workspace lock
      delegation.py — delegation execution/results
    tools/ — model-facing tools
      catalog.py — explicit builtin catalog
      spec.py — tool function/schema binding
      schema.py — schema generation
      registry.py — registration/argument validation/invocation
      agent_create.py — member creation tool
      delegate.py — delegation tool entry
      goal.py — goal status tool
      planning.py — plan update tool
      skill.py — skill loading/creation tools
      user_question.py — user question tool
      files/ — file queries and mutations
        specs.py — file tool schema/path binding/argument compatibility
        queries.py — read_file/glob/grep
        mutations.py — write_file/edit_file
        mutation_queue.py — per-file mutation serialization
      shell/ — command/background processes
        specs.py — shell schemas/workspace binding
        tool.py — bash/bash_output entry
        policy.py — command invocation filter
        supervisor.py — process lifecycle
        process.py — process state record
        process_tree.py — cross-platform process trees
        session_pool.py — session shell state
        capture.py — bounded output capture
        result.py — shell result serialization
      web/ — search and page tools
        specs.py — tool schemas/dependency binding
        search.py — engines/results/fallback
        fetch.py — page fetching/extraction
        session_pool.py — HTTP session reuse/close
```

## Migration checklist and risks

- [ ] Split server/stdio.py into transport and dispatcher; both stdio/WebSocket share dispatcher. HIGH: shutdown ordering, concurrent requests, auth futures, subscriptions, event sequencing.
- [ ] Rename server/web.py to websocket.py and files.py to workspace_files.py. Update main.py and tests.
- [ ] Split worker.py: SessionRepository becomes SessionService in session_service.py; ExecutionCoordinator and owned helpers move to execution.py; RuntimeWorker remains worker.py. HIGH: draft identity, ownership, steering/follow-up, background tasks.
- [ ] Flatten commands/features into commands; move catalog builder into catalog.py; rename init to init_rind_doc; merge help_view/status_view/model_control into their commands. Update private-name cross-file uses and monkeypatch targets.
- [ ] Split infrastructure/team.py into models/project/manifests/workspace_lock. Move bootstrap/delegation.py into team/delegation.py with injected runner. HIGH: manifests, paths, creation rollback, locks.
- [ ] Remove JsonlSessionStore.create_team_project; Team command calls Team project API using explicit workspace.
- [ ] Collapse config/settings_loader.py to settings.py; auth/credential_store.py to credentials.py; skills/repository.py to skills.py.
- [ ] Merge infrastructure/planning/store.py and summary.py into persistence/plan.py.
- [ ] Move application/context/usage_summary.py to application/usage_summary.py.
- [ ] Move domain/shell.py and prompts host probing into infrastructure/environment.py; explicitly supply prompt environment from callers; no import-time environment probing. Preserve one prompts.py.
- [ ] Move core/image_promotion.py to infrastructure/workspace_images.py and inject image callback at container. Preserve multimodal fallback.
- [ ] Merge openai_chat.py and openai_chat_client.py into one ChatClient-conforming adapter; SDK factory goes to provider_service.py. HIGH: normalized completion/streams, raw traces, cancellation, retries, compaction limits.
- [ ] Rename llm/providers.py to catalog.py; llm_trace.py to trace.py.
- [ ] Remove tools/builtin nesting, catalog implementation to tools/catalog.py; file/shell registration to specs.py; rename operations to queries and queue to mutation_queue.
- [ ] Split web tools into search/fetch/specs/session_pool.
- [ ] Give SessionFiles lock access a public method; update index operations without changing lock range.
- [ ] Update all ordinary/string imports, tests, README/documentation and architecture guards. No forwarding modules.

Preserve existing state boundaries in JsonlSessionStore, core runtime and compaction; do not mechanically split by line count. Existing session format, protocol and model-facing schemas remain stable. Retain protocol.py location used by gateway.

## Git and verification

Planned commits: (1) directory/naming/catalog consolidation; (2) server responsibilities; (3) explicit boundaries/Team/environment/images/OpenAI. Allow focused test corrections per commit. Record actual commits and progress below.

Run Python regression suite, CLI suite and existing web/desktop checks. Specifically cover empty draft persistence, run/send/resume, compact/auto compact and queues, Team, tools/background lifecycle, provider completions/streams. Strengthen architecture checks and scan obsolete paths. Use deterministic fake providers for regression.

User authorized manual acceptance. Follow test/manual/README.md, sessions.md, compact-input.md, context-and-goal.md, team.md, boundaries.md and user-features.md. Use configured provider/model (read secrets without printing), isolated temporary workspace and RIND_HOME. Per case limits: 10 minutes/20 calls; C10 <=1M input/20k output. Report real vs simulated vs no-model results separately; record unavailable GUI/TTY/provider/channel branches as blocked, never claim perfect coverage. External channel messaging still requires explicit target authorization.

Manual cleanup is mandatory: record owned root/PIDs, extract evidence summaries, close owned process trees, remove temporary credentials/traces/workspaces/sessions/logs/scripts and verify. Keep this requested plan only; do not retain acceptance artifacts without user request.

## Progress and continuation notes

- Initial state: clean main 5fca0a1; 133 Python files; previous read-only AST scan found no module cycles.
- Plan persisted before code changes.
