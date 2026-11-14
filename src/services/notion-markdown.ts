import type { BodyBlock } from "../domain/knowledge-entry.ts";

export function renderBlock(block: BodyBlock): { text: string; supported: boolean } {
  const text = block.markdown;
  switch (block.type) {
    case "paragraph": return { text, supported: true };
    case "heading_1": return { text: "# " + text, supported: true };
    case "heading_2": return { text: "## " + text, supported: true };
    case "heading_3": return { text: "### " + text, supported: true };
    case "bulleted_list_item": return { text: "- " + text, supported: true };
    case "numbered_list_item": return { text: "1. " + text, supported: true };
    case "to_do": return { text: "- [" + (block.checked ? "x" : " ") + "] " + text, supported: true };
    case "quote": return { text: "> " + text.replaceAll("\n", "\n> "), supported: true };
    case "callout": return { text: "> " + text.replaceAll("\n", "\n> "), supported: true };
    case "toggle": return { text: "**" + text + "**", supported: true };
    case "code": {
      const fence = "`".repeat(Math.max(3, ...[...block.text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
      const language = (block.language ?? "").replace(/[^a-zA-Z0-9_+-]/g, "");
      return { text: fence + language + "\n" + block.text + "\n" + fence, supported: true };
    }
    case "divider": return { text: "---", supported: true };
    case "equation": return { text: "$$\n" + block.text + "\n$$", supported: true };
    case "table_row": return { text: "| " + (block.cells ?? []).map((cell) => cell.replaceAll("|", "\\|").replaceAll("\n", "<br>")).join(" | ") + " |", supported: true };
    case "column_list": case "column": case "table": case "synced_block": return { text: "", supported: true };
    case "image": case "video": case "audio": case "file": case "pdf": case "bookmark": case "embed": case "link_preview":
      return { text: block.url ? "[" + (block.caption || block.type) + "](" + block.url + ")" : "[" + block.type + ": unavailable URL]", supported: block.url !== undefined };
    case "child_page": return { text: "Child page: " + block.text + " (content not expanded)", supported: false };
    default: return { text: "[Unsupported Notion block: " + block.type + "]", supported: false };
  }
}
