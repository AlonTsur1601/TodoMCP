# Changelog

## 0.1.0 - Unreleased

- Small deterministic work now uses zero TodoMCP calls and creates no plan state.
- Small uncertain work can use one stateless `todo_audit_result` call after execution.
- Planned completion audits can auto-start ready tasks, reducing per-task tool calls.
- Initial local STDIO MCP server.
- Deterministic request analysis and direct/plan work contracts.
- Persistent atomic plan state and evidence-quality completion gate.
- Bounded delegation recommendations and WorkCandidate v1 interoperability.
- Cross-platform installer, tests, and GitHub Actions workflow.
