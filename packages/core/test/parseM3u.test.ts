import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, describe } from "node:test";

import { parseM3u } from "../src/playlist/parseM3u.ts";
import { detectFormat, decodePlaylistBytes } from "../src/playlist/detect.ts";
import { parseExtInf, scanAttributes } from "../src/playlist/attributes.ts";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

describe("format detection", () => {
  test("classifies the provider sample as extended M3U despite the .m3u8 URL", () => {
    // The real-world trap: URL says .m3u8, Content-Type says audio/mpegurl,
    // Content-Disposition says .m3u. Only the bytes are authoritative.
    const result = detectFormat(fixture("provider-sample.m3u"));
    assert.equal(result.format, "extended-m3u");
    assert.ok(result.confidence > 0.9);
  });

  test("distinguishes an HLS media playlist from an IPTV playlist", () => {
    // Both contain #EXTINF; only the #EXT-X-* tags disambiguate.
    const hls = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:5",
      "#EXT-X-VERSION:3",
      "#EXTINF:5.000,",
      "http://host/seg1.ts",
    ].join("\n");
    assert.equal(detectFormat(hls).format, "hls-media");
  });

  test("detects an HLS master playlist", () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200000\nhttp://host/v1.m3u8';
    assert.equal(detectFormat(master).format, "hls-master");
  });

  test("names XMLTV and HTML rather than reporting zero channels", () => {
    assert.equal(detectFormat('<?xml version="1.0"?><tv><channel id="a"/></tv>').format, "xmltv");
    assert.equal(detectFormat("<!DOCTYPE html><html><body>Login</body></html>").format, "html");
  });

  test("handles a UTF-8 BOM", () => {
    const withBom = "﻿#EXTM3U\n#EXTINF:-1 tvg-id=\"a\",A\nhttp://h/a";
    const result = detectFormat(withBom);
    assert.equal(result.hadBom, true);
    assert.equal(result.format, "extended-m3u");
  });

  test("decodes UTF-16LE via BOM", () => {
    const text = "#EXTM3U\n";
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < text.length; i++) bytes[2 + i * 2] = text.charCodeAt(i);
    assert.equal(decodePlaylistBytes(bytes).startsWith("#EXTM3U"), true);
  });
});

describe("attribute tokenizer", () => {
  test("keeps commas inside quoted values", () => {
    // The classic bug: splitting on ',' or using lastIndexOf(',') mangles both
    // the group and the title here.
    const { duration, attributes, title } = parseExtInf('-1 group-title="News, Live",BBC One, HD');
    assert.equal(duration, -1);
    assert.equal(attributes["group-title"], "News, Live");
    assert.equal(title, "BBC One, HD");
  });

  test("keeps '=' and '?' inside quoted URLs", () => {
    const { attributes } = scanAttributes('tvg-logo="http://a/b.png?w=1&h=2" tvg-id="x"');
    assert.equal(attributes["tvg-logo"], "http://a/b.png?w=1&h=2");
    assert.equal(attributes["tvg-id"], "x");
  });

  test("accepts single quotes, no quotes, spaces around '=', and mixed case", () => {
    const { attributes } = scanAttributes("TVG-ID='a1'  tvg-name=Bare   group-title = \"G\"");
    assert.equal(attributes["tvg-id"], "a1");
    assert.equal(attributes["tvg-name"], "Bare");
    assert.equal(attributes["group-title"], "G");
  });

  test("recovers from a malformed attribute instead of losing the line", () => {
    const { attributes, title } = parseExtInf('-1 tvg-id="ok" garbage tvg-logo="l.png",Name');
    assert.equal(attributes["tvg-id"], "ok");
    assert.equal(attributes["tvg-logo"], "l.png");
    assert.equal(title, "Name");
  });

  test("recovers from an unterminated quote", () => {
    const { attributes, title } = parseExtInf('-1 tvg-id="unclosed,Name');
    assert.equal(attributes["tvg-id"], "unclosed,Name");
    assert.equal(title, "");
  });
});

describe("parsing the real provider playlist", () => {
  const playlist = parseM3u(fixture("provider-sample.m3u"));

  test("reads every channel", () => {
    assert.equal(playlist.channels.length, 297);
    assert.equal(playlist.issues.filter((i) => i.level === "error").length, 0);
  });

  test("extracts header metadata including the max-conn constraint", () => {
    assert.deepEqual(playlist.header.epgUrls, ["http://stream.example.com:8080/epg.xml.gz"]);
    assert.equal(playlist.header.maxConnections, 2);
    assert.equal(playlist.header.catchupType, "shift");
  });

  test("preserves Cyrillic names and groups", () => {
    const first = playlist.channels[0]!;
    assert.equal(first.name, "Первый канал");
    assert.equal(first.tvgId, "pervyj");
    assert.equal(first.groups[0], "Общероссийские");
    assert.equal(first.logo, "https://logos.example.com/channels/pervyj.png");
  });

  test("reads catchup from tvg-rec / catchup-days", () => {
    const first = playlist.channels[0]!;
    assert.equal(first.catchup?.days, 7);
  });

  test("treats #EXTINF:0 as live, not as zero-length VOD", () => {
    assert.ok(playlist.channels.every((c) => c.kind === "live"));
  });

  test("finds all six groups", () => {
    assert.equal(playlist.groups.length, 6);
    assert.ok(playlist.groups.includes("Кино"));
  });

  test("assigns unique, position-independent ids", () => {
    const ids = new Set(playlist.channels.map((c) => c.id));
    assert.equal(ids.size, playlist.channels.length);

    // Reversing the file must not change any channel's id — otherwise
    // favourites scramble whenever the provider reorders the playlist.
    const lines = fixture("provider-sample.m3u").split("\n");
    const header = lines[0]!;
    const blocks: string[][] = [];
    for (let i = 1; i + 2 < lines.length; i += 3) blocks.push(lines.slice(i, i + 3));
    const reversed = parseM3u([header, ...blocks.reverse().flat()].join("\n"));

    const byName = new Map(reversed.channels.map((c) => [c.name + c.url, c.id]));
    for (const c of playlist.channels) {
      assert.equal(byName.get(c.name + c.url), c.id, `id changed for ${c.name}`);
    }
  });
});

describe("fault tolerance", () => {
  test("skips an #EXTINF with no URL but keeps the rest", () => {
    const playlist = parseM3u(
      ["#EXTM3U", "#EXTINF:-1,Orphan", "#EXTINF:-1,Good", "http://h/good"].join("\n"),
    );
    assert.equal(playlist.channels.length, 1);
    assert.equal(playlist.channels[0]!.name, "Good");
    assert.ok(playlist.issues.some((i) => i.code === "orphan-extinf"));
  });

  test("accepts CRLF and lone-CR line endings", () => {
    const body = '#EXTM3U\r\n#EXTINF:-1 tvg-id="a",A\r\nhttp://h/a\r\n';
    assert.equal(parseM3u(body).channels.length, 1);
    assert.equal(parseM3u(body).channels[0]!.name, "A");
  });

  test("handles a bare URL list with no directives", () => {
    const playlist = parseM3u("http://h/one.ts\nhttp://h/two.ts");
    assert.equal(playlist.channels.length, 2);
    assert.ok(playlist.issues.some((i) => i.code === "missing-extm3u"));
  });

  test("merges #EXTGRP with group-title and splits multi-groups", () => {
    const playlist = parseM3u(
      ['#EXTM3U', '#EXTINF:-1 group-title="A;B",N', "#EXTGRP:C", "http://h/x"].join("\n"),
    );
    assert.deepEqual(playlist.channels[0]!.groups, ["A", "B", "C"]);
  });

  test("captures #EXTVLCOPT headers and #EXTHTTP JSON", () => {
    const playlist = parseM3u(
      [
        "#EXTM3U",
        "#EXTINF:-1,N",
        "#EXTVLCOPT:http-user-agent=MyAgent/1.0",
        "#EXTVLCOPT:http-referrer=http://ref/",
        '#EXTHTTP:{"Cookie":"a=b"}',
        "http://h/x",
      ].join("\n"),
    );
    const c = playlist.channels[0]!;
    assert.equal(c.userAgent, "MyAgent/1.0");
    assert.equal(c.referrer, "http://ref/");
    assert.equal(c.httpHeaders?.["Cookie"], "a=b");
  });

  test("ignores malformed #EXTHTTP without dropping the channel", () => {
    const playlist = parseM3u(["#EXTM3U", "#EXTINF:-1,N", "#EXTHTTP:not json", "http://h/x"].join("\n"));
    assert.equal(playlist.channels.length, 1);
    assert.ok(playlist.issues.some((i) => i.code === "bad-exthttp"));
  });

  test("never throws on adversarial input", () => {
    const nasty = [
      "#EXTM3U url-tvg=",
      "#EXTINF:",
      "#EXTINF:abc,",
      '#EXTINF:-1 tvg-id="",',
      "#EXTGRP:",
      "#",
      "###",
      "#EXTINF:-1,Name with no url",
      "not-a-url-either",
      " ",
    ].join("\n");
    assert.doesNotThrow(() => parseM3u(nasty));
  });

  test("reports an error for a document with no entries", () => {
    const playlist = parseM3u("#EXTM3U\n");
    assert.equal(playlist.channels.length, 0);
    assert.ok(playlist.issues.some((i) => i.code === "no-channels" && i.level === "error"));
  });

  test("parses a large synthetic playlist in reasonable time", () => {
    const lines = ["#EXTM3U"];
    for (let i = 0; i < 50_000; i++) {
      lines.push(`#EXTINF:-1 tvg-id="c${i}" group-title="G${i % 50}",Channel ${i}`);
      lines.push(`http://host/stream/${i}.m3u8`);
    }
    const started = Date.now();
    const playlist = parseM3u(lines.join("\n"));
    const elapsed = Date.now() - started;
    assert.equal(playlist.channels.length, 50_000);
    assert.equal(playlist.groups.length, 50);
    // Generous bound: TV CPUs are far slower than dev machines, so this is a
    // regression guard against accidental O(n^2), not a performance claim.
    assert.ok(elapsed < 5000, `took ${elapsed}ms`);
  });
});
