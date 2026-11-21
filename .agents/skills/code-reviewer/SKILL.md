---
name: code-reviewer
description: >-
  Use this skill when the user asks to review, audit, or inspect code for quality,
  security vulnerabilities, performance bottlenecks, and adherence to project conventions.
---

# Code Reviewer Skill

This skill guides the agent in conducting thorough, constructive, and actionable code reviews across the project.

## Review Workflow

1. **Identify Scope & Changed Files**
   - Check git status / diff using `git status` or `git diff HEAD~1` (or the target branch/commit).
   - Review only relevant files, prioritizing security-sensitive areas (auth, database queries, WebSocket handlers).

2. **Run Static Checks & Linters (if available)**
   - Check if project linters or type checkers are configured (e.g., `npm run build`, `npx tsc --noEmit`, or oxlint).
   - Address any syntax errors or type violations first.

3. **Multi-Angle Evaluation Checklist**

   ### 🔒 Security
   - **SQL Injection**: Ensure all SQLite / database operations use parameterized queries (`db.prepare(...).run/all/get(...)`) and never string interpolation with raw inputs.
   - **Auth & RBAC**: Verify permission checks and JWT/session tokens on sensitive API routes.
   - **Input Validation**: Check that request bodies, query params, and route parameters are validated and sanitized before processing.
   - **Secrets & Credentials**: Ensure no API keys, private tokens, or passwords are hardcoded in source files.

   ### ⚙️ Correctness & Error Handling
   - **Async/Await**: Ensure Promises are properly awaited and wrapped in `try/catch` or error middleware.
   - **Edge Cases**: Check boundary conditions, empty lists, null/undefined references, and invalid state transitions.
   - **WebSocket Safety**: Verify connection lifecycle management, heartbeat/ping-pong, and cleanup on disconnect to avoid memory leaks.

   ### 🚀 Performance & Resource Management
   - Avoid N+1 queries by joining or batching database calls where feasible.
   - Check for heavy re-renders or unnecessary state updates in client React components.
   - Ensure file handles, database connections, and sockets are gracefully closed or recycled.

   ### 🧹 Maintainability & Code Style
   - **TypeScript Types**: Prefer strict typing; avoid unwarranted use of `any`.
   - **Consistency**: Follow existing conventions, file organization, and naming schemes across `server/` and `client/`.

4. **Format the Review Output**
   Structure findings clearly using severity levels:
   - 🔴 **Critical / Security Issue**: Must fix immediately before merging/running (data loss, auth bypass, injection).
   - 🟡 **Warning / Potential Bug**: Edge cases, race conditions, or unhandled errors.
   - 🟢 **Suggestion / Best Practice**: Code readability, minor optimizations, or refactoring ideas.
   - Provide concrete file links (e.g. `[filename](file:///path/to/file#L10-L20)`) and drop-in code snippets for the fixes.
