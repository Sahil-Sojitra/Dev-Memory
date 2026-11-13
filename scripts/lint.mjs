import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const failures = [];
const files = [];
function collect(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) collect(file);
    else if (/\.(?:ts|mjs|md)$/.test(entry.name)) files.push(file);
  }
}
for (const directory of ["src", "api", "tests", "scripts", "docs"]) collect(path.join(root, directory));
for (const file of ["README.md", ".gitignore", ".env.example", ".npmrc", ".nvmrc", "package.json", "tsconfig.json", "tsconfig.build.json", "tsconfig.vercel.json", "vercel.json", "vitest.config.ts"]) {
  files.push(path.join(root, file));
}
function fail(file, message) {
  failures.push(path.relative(root, file).replaceAll("\\", "/") + ": " + message);
}
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  if (/[ \t]+$/m.test(text)) fail(file, "trailing whitespace");
  if (!text.endsWith("\n") || /\r?\n\r?\n$/.test(text)) fail(file, "end with exactly one newline");
  if (/^(?:<<<<<<< |=======$|>>>>>>> )/m.test(text)) fail(file, "merge conflict marker");
  if (!file.endsWith(".ts")) continue;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const relative = path.relative(root, file).replaceAll("\\", "/");
  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) fail(file, "explicit any is forbidden");
    if ((relative.startsWith("src/") || relative.startsWith("api/")) && ts.isPropertyAccessExpression(node)) {
      if (node.expression.getText(source) === "console") fail(file, "use the structured logger, not console");
      if (node.expression.getText(source) === "process" && node.name.text === "stdout") fail(file, "stdout is reserved for MCP");
    }
    let moduleName;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) moduleName = node.moduleSpecifier.text;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require") && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) moduleName = node.arguments[0].text;
    if (moduleName?.startsWith("@notionhq/client") && !relative.startsWith("src/integrations/notion/")) fail(file, "Notion SDK imports belong only in src/integrations/notion");
    if (relative.startsWith("src/domain/") && moduleName?.startsWith(".")) {
      const target = path.resolve(path.dirname(file), moduleName);
      if (!target.startsWith(path.join(root, "src", "domain") + path.sep)) fail(file, "domain cannot import infrastructure");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const template = fs.readFileSync(path.join(root, ".env.example"), "utf8");
for (const line of template.split(/\r?\n/)) {
  if (/^(?:NOTION_API|MCP_BEARER_TOKEN(?:_NEXT)?_SHA256)=.+$/.test(line)) fail(".env.example", "credential placeholders must be empty");
}
if (failures.length) {
  process.stderr.write(failures.join("\n") + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write("Lint passed: " + files.length + " files; formatting and TypeScript architecture rules.\n");
}
