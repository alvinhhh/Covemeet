import assert from "node:assert/strict";
import test from "node:test";
import { chatLinks } from "../src/chat-links.ts";

test("chat links preserve every character, including whitespace and surrounding punctuation", () => {
  const text =
    "  Notes:\n(https://example.com/a_(b)).\n<http://[::1]:8080/> and “HTTPS://example.org?q=a&b=2”, done.  ";
  const parts = chatLinks(text);
  assert.equal(parts.map((part) => part.text).join(""), text);
  assert.deepEqual(
    parts.filter((part) => part.href),
    [
      { text: "https://example.com/a_(b)", href: "https://example.com/a_(b)" },
      { text: "http://[::1]:8080/", href: "http://[::1]:8080/" },
      {
        text: "HTTPS://example.org?q=a&b=2",
        href: "https://example.org/?q=a&b=2",
      },
    ],
  );
  assert.deepEqual(chatLinks(""), []);
});

test("only explicit valid HTTP and HTTPS links are clickable", () => {
  for (const text of [
    "javascript:alert(1)",
    "javascript:https://example.com",
    "data:text/html,https://example.com",
    "ftp://example.com/file",
    "mailto:hello@example.com",
    "//example.com",
    "www.example.com",
    "https://",
    "https://example.com:bad/path",
    "https://trusted.example@other.example/",
    "https://example.com/\\other.example",
    "https://example.com/\u202eevil",
  ]) {
    const parts = chatLinks(text);
    assert.equal(parts.map((part) => part.text).join(""), text);
    assert.ok(
      parts.every((part) => !part.href),
      text,
    );
  }
});

test("multiple links preserve encoded punctuation and balanced query brackets", () => {
  const text =
    "https://example.com/?q=(a[b]) https://example.org/a%29!, then https://example.net/path";
  const parts = chatLinks(text);
  assert.equal(parts.map((part) => part.text).join(""), text);
  assert.deepEqual(
    parts.filter((part) => part.href).map((part) => part.text),
    [
      "https://example.com/?q=(a[b])",
      "https://example.org/a%29",
      "https://example.net/path",
    ],
  );
});
