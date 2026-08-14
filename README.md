# TodoMCP

[![CI](https://github.com/AlonTsur1601/TodoMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/AlonTsur1601/TodoMCP/actions/workflows/ci.yml)

TodoMCP is a local Model Context Protocol server that helps Codex plan genuinely complex work and verify uncertain completion claims without burdening small, deterministic tasks with planning overhead.

It uses no model API, opens no port, and has no dependency on another MCP server. State is stored outside your repositories in the operating system's user-data directory.

TodoMCP complements [CountdownMCP](https://github.com/AlonTsur1601/CountdownMCP), but both servers remain fully independent and useful on their own.

## What it does

- Creates stable source units from numbered lists, bullets, sentences, compound clauses, constraints, and success language.
- Leaves small, clear, deterministic tasks entirely to Codex with zero TodoMCP calls.
- Audits uncertain small results with one stateless call and no stored plan or task.
- Requires a validated atomic plan for larger, dependent, risky, or multi-system work.
- Maps every source unit to an explicit requirement disposition.
- Blocks tasks whose dependencies are incomplete.
- Audits the verification method as well as its result.
- Recommends zero to three bounded agent work packages without creating agents.
- Exports the neutral `WorkCandidate.v1` shape for optional CountdownMCP advice.

## Requirements

- Node.js 20 or newer
- Codex CLI/Desktop with MCP support

## Install

Clone the repository and run the installer:

```powershell
git clone https://github.com/AlonTsur1601/TodoMCP.git
Set-Location TodoMCP
node install.mjs
```

The installer builds and smoke-tests the server before atomically copying it to `CODEX_HOME/mcp/todo-mcp`. It replaces only the `todo_mcp` registration and rolls back that registration and the installed files if setup fails. Restart Codex after installation.

An installed copy is a local snapshot. New Git commits and GitHub Releases do not update it automatically. To update an existing clone, pull the newer source and rerun the installer:

```powershell
Set-Location TodoMCP
git pull --ff-only
node install.mjs
```

Restart Codex after installing or updating.

For development without installing:

```powershell
npm ci
npm run check
codex mcp add todo_mcp -- node C:\absolute\path\to\TodoMCP\dist\src\index.js
```

## Workflow

1. For an obviously small deterministic task, Codex works independently and makes no TodoMCP calls.
2. For small work with meaningful completion uncertainty, Codex works independently and may call `todo_audit_result` once at the end. This creates no persistent TodoMCP state.
3. For genuinely complex work, `todo_analyze_request` returns stable source units and recommends a plan.
4. Codex maps every unit to a requirement and submits `todo_create_plan` once.
5. `todo_audit_completion` checks a planned task and can auto-start it when its dependencies are ready, avoiding a separate start call.
6. `todo_close_plan` is called once after the final approved task.

Rejected plans are retained as drafts so Codex can repair them with `todo_revise_plan`. There is no force-complete operation.

## Small tasks and tool-call budget

Small does not mean that Codex must create a shorter TodoMCP plan. It means Codex should work without TodoMCP state. A precise edit with an immediately observable result, such as replacing one known line with exact text, needs no TodoMCP analysis, task creation, start, audit, or close call.

If a small task has meaningful uncertainty—such as runtime behavior, a bug fix, an integration boundary, or user-visible behavior—Codex may make one `todo_audit_result` call after doing the work. The caller must state why completion is uncertain. If neither the request nor the caller supplies an uncertainty reason, the tool skips the audit.

The legacy `direct` plan input remains accepted for backward compatibility, but clients should not create direct plans for ordinary small work.

## Verification quality

For planned work and uncertain independent results, each acceptance criterion declares its minimum evidence level: `static`, `build`, `unit`, `integration`, `runtime`, or `manual`. Evidence must include the target, input, expected and observed signals, substantive raw output, and an explanation of how the check detects failure.

Behavioral criteria cannot be satisfied by build-only evidence. User-visible criteria can require observation through the public interface, and criteria can require negative or boundary cases. Failure-sensitivity explanations must identify a concrete failing, changed, rejected, negative, or pre-fix signal. Explicit artifact paths are confined to the registered workspace, limited to 1 MiB, and SHA-256 checked. Artifacts declared as `test_source` are also inspected for a recognizable assertion or failure check, so a script that only prints `PASS` is rejected.

TodoMCP cannot make an uncooperative MCP client call its tools or independently understand arbitrary verification code without a model. Its state machine and evidence contract provide the strongest enforcement available inside a model-free MCP tool workflow.

## CountdownMCP interoperability

`todo_get_execution_candidates` returns:

```json
{
  "schemaVersion": "WorkCandidate.v1",
  "currentTaskId": "task-2",
  "tasks": [
    {
      "id": "task-2",
      "title": "Add runtime verification",
      "priority": 5,
      "estimatedMinutes": 45,
      "dependenciesReady": true,
      "needsUserInput": false,
      "canContinueWithoutNewMessage": true,
      "checkpointable": true
    }
  ]
}
```

Codex may pass this result to `countdown_advise_work`, then pass the returned `recommendedNow`, `deferUntilReset`, `executionOrder`, and optional `checkpoint` to `todo_apply_execution_advice`. Advice can reorder ready work but cannot bypass dependencies or verification. Either server works normally when the other is absent.

## Data and security

- Windows: `%LOCALAPPDATA%\TodoMCP\workspaces`
- macOS: `~/Library/Application Support/TodoMCP/workspaces`
- Linux: `$XDG_DATA_HOME/todo-mcp/workspaces` or `~/.local/share/todo-mcp/workspaces`

Tool input is untrusted. TodoMCP uses strict schemas, atomic state writes, per-plan locks, path containment checks, and stderr-only diagnostics. It does not execute verification commands or read another MCP server's state.

## Development

```powershell
npm run typecheck
npm test
npm run smoke
```

Live account-dependent tests are intentionally unnecessary: TodoMCP has no account or OpenAI API integration.

When a sibling CountdownMCP checkout has been built, verify the real tool contract without adding a package dependency:

```powershell
npm run contract:countdown
```

## Releases

Pushing a tag that exactly matches the version in `package.json` (for example, `v0.1.0`) runs the release workflow. It repeats the full check and publishes a GitHub Release containing a source ZIP and SHA-256 checksum. Users extract the ZIP and run `node install.mjs`; no global npm publication is required.

## License

[MIT License](LICENSE)
