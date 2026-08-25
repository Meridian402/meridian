import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffImage, logoFileName, isLogoName, contentTypeFor } from "../src/launch/logos.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 5]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50, 6, 7]);

test("sniff identifies png, jpg, webp by magic bytes", () => {
  assert.equal(sniffImage(png), "png");
  assert.equal(sniffImage(jpg), "jpg");
  assert.equal(sniffImage(webp), "webp");
});

test("sniff rejects non-images and tiny buffers regardless of claimed type", () => {
  assert.equal(sniffImage(new TextEncoder().encode("<svg onload=alert(1)></svg>")), null);
  assert.equal(sniffImage(new TextEncoder().encode("GIF89a not supported here")), null);
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50])), null);
});

test("filenames are content-addressed and deterministic", () => {
  const a = logoFileName(png, "png");
  assert.equal(a, logoFileName(png, "png"));
  assert.match(a, /^[0-9a-f]{64}\.png$/);
  assert.notEqual(a.split(".")[0], logoFileName(jpg, "jpg").split(".")[0]);
});

test("the name guard blocks traversal and junk", () => {
  assert.equal(isLogoName(logoFileName(webp, "webp")), true);
  assert.equal(isLogoName("../../etc/passwd"), false);
  assert.equal(isLogoName("z".repeat(64) + ".png"), false); // not hex
  assert.equal(isLogoName("deadbeef.png"), false); // too short
  assert.equal(isLogoName(logoFileName(png, "png") + "/x"), false);
});

test("content types map from extension", () => {
  assert.equal(contentTypeFor("x.png"), "image/png");
  assert.equal(contentTypeFor("x.jpg"), "image/jpeg");
  assert.equal(contentTypeFor("x.webp"), "image/webp");
});
