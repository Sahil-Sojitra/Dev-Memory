// Linear scan with constant auxiliary space: never spread untrusted text into
// function arguments or allocate an array for every backtick run.
export function backtickFence(text: string, minimum: number): string {
  let longest = 0;
  let current = 0;
  for (let index = 0; index < text.length; index++) {
    current = text[index] === "`" ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return "`".repeat(Math.max(minimum, longest + 1));
}
