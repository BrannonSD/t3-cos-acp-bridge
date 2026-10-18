/** Convert only self-contained native references. Never invent URLs for opaque IDs. */
export function nativeMarkdown(text: string): string {
  // Code examples are literal. Keep complete or still-streaming fenced/inline code intact.
  return text.replace(
    /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?=\n|$)|$)|(`+)[^\n]*?\2|[^`~]+|[`~]/g,
    (part) => {
      if (/^(`|~{3})/.test(part)) return part;
      return (
        part
          .replace(
            /\uE200url\uE202([^\uE200-\uE202]*)\uE202([^\uE200-\uE202]*)\uE201/g,
            (_all, label: string, href: string) => {
              const title = label.trim().replace(/[\\[\]]/g, "\\$&");
              try {
                const url = new URL(href.trim());
                if (!/^https?:$/.test(url.protocol))
                  return title || "[link unavailable]";
                const destination = url.href.replace(
                  /[()<>]/g,
                  (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
                );
                return `[${title || destination}](${destination})`;
              } catch {
                return title || "[link unavailable]";
              }
            },
          )
          .replace(
            /\uE200(?:cite|filecite)\uE202[^\uE200\uE201]*\uE201/g,
            "[source link unavailable]",
          )
          // Unknown native widgets have no renderable representation in ACP.
          .replace(/\uE200[^\uE200\uE201]*\uE201/g, "")
          // A partial reference must not leak during streaming; the next revision completes it.
          .replace(/\uE200[^\uE201]*$/, "")
      );
    },
  );
}
