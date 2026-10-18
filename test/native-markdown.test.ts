import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeMarkdown } from "../src/native-markdown.js";
import { Translator } from "../src/translate.js";
const link = "\uE200url\uE202Example Domain\uE202https://example.com/\uE201";
test("native links become Markdown without changing tables, code, or authored text", () => {
  const content = `# Demo\n\n| Item | Count |\n| --- | --- |\n| Atlas | 7 |\n\nSource: ${link}\n\n\`\`\`json\n{"literal":"${link}"}\n\`\`\`\nInline: \`${link}\``;
  assert.equal(
    nativeMarkdown(content),
    content.replace(
      `Source: ${link}`,
      "Source: [Example Domain](https://example.com/)",
    ),
  );
});
test("references never invent destinations or emit executable Markdown links", () => {
  assert.equal(
    nativeMarkdown("\uE200cite\uE202turn0search0\uE201"),
    "[source link unavailable]",
  );
  assert.equal(
    nativeMarkdown(
      "\uE200url\uE202click [here]\uE202javascript:alert(1)\uE201",
    ),
    "click \\[here\\]",
  );
  assert.equal(
    nativeMarkdown("\uE200url\uE202a]b\uE202https://example.com/a(b)\uE201"),
    "[a\\]b](https://example.com/a%28b%29)",
  );
});
test("streamed native links do not leak partial tokens or create replacement duplicates", () => {
  for (const version of [1, 2] as const) {
    const translator = new Translator(version);
    const event = {
      seq: 1,
      position: 0,
      kind: "assistant_message",
      messageId: "reply",
      message: { text: "Source: " + link.slice(0, -1) },
    };
    assert.deepEqual(
      translator.event(event)[0].content,
      version === 1
        ? { type: "text", text: "Source: " }
        : [{ type: "text", text: "Source: " }],
    );
    const update = translator.event({
      ...event,
      seq: 2,
      message: { text: "Source: " + link },
    })[0];
    assert.deepEqual(
      update.content,
      version === 1
        ? { type: "text", text: "[Example Domain](https://example.com/)" }
        : [
            {
              type: "text",
              text: "Source: [Example Domain](https://example.com/)",
            },
          ],
    );
  }
});
