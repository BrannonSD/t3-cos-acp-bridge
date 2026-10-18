import { test } from "node:test";
import assert from "node:assert/strict";
import { authoredT3Text, coST3Prompt } from "../src/t3-context.js";
test("CoS receives the exact authored request, its native tool ownership and T3 plan-mode constraint", () => {
  const request =
    "Inspect `file.txt`.\nKeep <user_request>literal tags</user_request> and | Markdown | intact.";
  for (const mode of ["Default", "Plan"]) {
    const wrapped = `<t3_code_instructions>\n## T3 Code interaction mode: ${mode}\n\nUse preview_open and delegate_task.\n</t3_code_instructions>\n\n<user_request>\n${request}\n</user_request>\n\n<runtime_info>generic ACP</runtime_info>\n\n<pull_request_linking>unavailable tools</pull_request_linking>`;
    const result = coST3Prompt(wrapped);
    assert.equal(authoredT3Text(wrapped), request);
    assert.equal(authoredT3Text(result), request);
    assert(!result.includes("preview_open"));
    assert(!result.includes("delegate_task"));
    assert(result.includes("use CoS browser tools"));
    assert.equal(result.includes("Interaction mode: Plan"), mode === "Plan");
  }
});
test("unrecognized framing is retained, ordinary text and slash commands remain intact", () => {
  for (const text of [
    "hello",
    "/cos-status",
    "<t3_code_instructions>user-authored fragment</t3_code_instructions>",
  ]) {
    assert.equal(authoredT3Text(text), text);
    assert.equal(authoredT3Text(coST3Prompt(text)), text);
  }
});
