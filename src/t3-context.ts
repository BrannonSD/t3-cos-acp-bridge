// T3's generic ACP prompt advertises its own MCP browser. CoS owns execution
// and has no transport for that injected MCP server; keep the actual request
// and interaction mode, then name the tools the executor really has.
const wrapper =
  /^<t3_code_instructions>\n([\s\S]*?)\n<\/t3_code_instructions>\n\n<user_request>\n([\s\S]*)\n<\/user_request>(?:\s*<runtime_info>[\s\S]*?<\/runtime_info>\s*(?:<pull_request_linking>[\s\S]*?<\/pull_request_linking>)?)?\s*$/;
const ownWrapper =
  /^<cos_t3_runtime>\n[\s\S]*?\n<\/cos_t3_runtime>\n\n<user_request>\n([\s\S]*)\n<\/user_request>$/;
export function authoredT3Text(text: string) {
  return ownWrapper.exec(text)?.[1] ?? wrapper.exec(text)?.[2] ?? text;
}
export function coST3Prompt(text: string) {
  const match = wrapper.exec(text);
  const request = match?.[2] ?? text;
  const plan = match?.[1].startsWith("## T3 Code interaction mode: Plan\n");
  return `<cos_t3_runtime>\nT3 Code is the conversation display. Chat on Steroids is the execution runtime, using the user's main CoS session and connected ChatGPT account.\nUse the tools actually exposed by Chat on Steroids Core, Desktop and Plugins, with their existing instructions and permissions. For browser work use CoS browser tools and its managed browser; do not replace them with T3 preview/browser tools or inject T3's MCP server. For local files, commands, native desktop, skills and plugins use their CoS owners. Never assume a T3 tool exists. Do not launch separate agent sessions unless the user explicitly requests them.\n${plan ? "Interaction mode: Plan. Investigate read-only; do not execute an implementation or edit files. Return a plan for review." : match ? "Interaction mode: Default. Carry out the user's request within its authorized scope." : "Respect the current interaction mode and the user's authorized scope."}\n</cos_t3_runtime>\n\n<user_request>\n${request}\n</user_request>`;
}
