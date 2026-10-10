export function chatLinks(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  let cursor = 0;
  for (const match of text.matchAll(
    /(?:^|[\s([<{"'“‘])(https?:\/\/[^\s<>"'`“”‘’]+)/gi,
  )) {
    let link = match[1];
    // Keep sentence punctuation outside links without truncating balanced URL brackets.
    while (link) {
      const end = link.at(-1)!;
      const open = { ")": "(", "]": "[", "}": "{" }[end];
      if (
        /[.,!?;:]/.test(end) ||
        (open && link.split(end).length > link.split(open).length)
      ) {
        link = link.slice(0, -1);
      } else break;
    }
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      /[\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(link)
    )
      continue;
    const start = match.index + match[0].length - match[1].length;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: link, href: url.href });
    cursor = start + link.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}
