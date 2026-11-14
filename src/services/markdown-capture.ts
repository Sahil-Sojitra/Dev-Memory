import type { CaptureBlock } from "../domain/capture-knowledge.ts";
import { CAPTURE_MAX_BLOCKS } from "../domain/capture-knowledge.ts";
import { RequestValidationError } from "../domain/errors.ts";

// Deliberately a small Markdown subset. Other inline/layout syntax is retained
// as literal text rather than executed, downloaded or silently discarded.
export function markdownToBlocks(content: string | undefined): readonly CaptureBlock[] {
  if (content === undefined) return Object.freeze([]);
  const blocks: CaptureBlock[] = [];
  const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  let paragraph: string[] = [];
  const add = (block: CaptureBlock) => {
    if (blocks.length >= CAPTURE_MAX_BLOCKS) throw new RequestValidationError([{ field: "content" }]);
    blocks.push(Object.freeze(block));
  };
  const flush = () => { if (paragraph.length) { add({ type: "paragraph", text: paragraph.join("\n") }); paragraph = []; } };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = /^(`{3,}|~{3,})([^\s]*)\s*$/.exec(line);
    if (fence) {
      flush(); const code: string[] = []; const marker = fence[1]!;
      for (index++; index < lines.length; index++) {
        const candidate = lines[index]!;
        if (new RegExp("^" + marker[0] + "{" + marker.length + ",}\\s*$").test(candidate)) break;
        code.push(candidate);
      }
      add({ type: "code", text: code.join("\n"), language: fence[2] || "plain text" }); continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const task = /^[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.+)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (heading || task || bullet || numbered || quote || /^(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flush();
      if (heading) add({ type: ("heading_" + heading[1]!.length) as "heading_1" | "heading_2" | "heading_3", text: heading[2]! });
      else if (task) add({ type: "to_do", text: task[2]!, checked: task[1]!.toLowerCase() === "x" });
      else if (bullet) add({ type: "bulleted_list_item", text: bullet[1]! });
      else if (numbered) add({ type: "numbered_list_item", text: numbered[1]! });
      else if (quote) add({ type: "quote", text: quote[1]! });
      else add({ type: "divider", text: "" });
    } else paragraph.push(line);
  }
  flush(); return Object.freeze(blocks);
}
