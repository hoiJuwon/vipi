import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GREEN_PROMPT = "\x1b[1;38;2;130;253;172m>\x1b[22;39m";

export function normalizeAssistantHeadings(markdown: string): string {
  let fence: "```" | "~~~" | undefined;
  return markdown.split("\n").map((line) => {
    const marker = line.match(/^\s*(```|~~~)/u)?.[1] as "```" | "~~~" | undefined;
    if (marker) {
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      return line;
    }
    // Pi intentionally reprints ### and deeper heading prefixes. H2 receives
    // the same rendered heading treatment without exposing Markdown source.
    return fence ? line : line.replace(/^\s*#{3,6}\s+/u, "## ");
  }).join("\n");
}

export default function messageStyle(pi: ExtensionAPI): void {
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType === "user") return `  ${GREEN_PROMPT} ${markdown}`;
    if (context.messageType === "assistant") return normalizeAssistantHeadings(markdown);
    return markdown;
  });
}
