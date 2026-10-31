// SessionStart hook for heystack-timeline. Dependency-free, no network: it only
// tells the agent which session id to pass to heystack_start_investigation so
// hook steps land in the same investigation. mcp_tool SessionStart hooks are
// skipped at launch, hence a local command.
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let id;
  try {
    id = JSON.parse(raw).session_id;
  } catch {
    return;
  }
  if (typeof id !== "string" || !id) return;
  const additionalContext = `Heystack timeline is on: pass client_session_id ${JSON.stringify(id)} to heystack_start_investigation.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
});
