# Privacy Policy

TodoMCP is a local STDIO server. It does not send requests, task data, evidence, workspace contents, telemetry, or credentials to the developer or to any third party.

## Data processed

TodoMCP receives only the values supplied by the connected MCP client. Depending on the tool used, these values can include request text, task definitions, workspace paths, completion evidence, and explicit evidence-file paths.

TodoMCP reads an evidence file only when the caller explicitly supplies its path. Evidence paths must resolve inside the declared workspace, and accepted files are size-limited and hashed for verification.

## Local storage

Plans, revisions, execution advice, and audit attempts are stored on the user's device under the platform-specific TodoMCP data directory documented in the README. TodoMCP does not store state inside the user's repository unless the user explicitly configures `TODO_MCP_DATA_DIR` to do so.

## Network access and sharing

The TodoMCP server does not make network requests and does not call other MCP servers. Optional coordination with CountdownMCP happens through neutral data that the MCP client chooses to pass between the two independent servers.

## Retention and deletion

Local state remains until the user deletes the relevant TodoMCP data directory. Uninstalling the executable does not automatically delete plan history, so users can choose whether to retain or remove it.

## Security

TodoMCP uses strict input schemas, path-containment checks, atomic state writes, per-plan locks, bounded evidence-file reads, and stderr-only diagnostics. It does not require an OpenAI API key or any other credential.

## Changes

Material privacy changes will be documented in the repository changelog.
