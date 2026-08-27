import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAllowlist, decideAccess, parseSkillVersion } from "../src/engine/access.js";

test("allowlist parses comma/space separated, lowercases, drops junk", () => {
  const set = parseAllowlist("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA, 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n not-an-address 0x123");
  assert.equal(set.size, 2);
  assert.ok(set.has("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  assert.ok(set.has("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
});

test("empty allowlist is an empty set", () => {
  assert.equal(parseAllowlist("").size, 0);
  assert.equal(parseAllowlist("   ").size, 0);
});

test("no qualifying path = locked out, fails closed", () => {
  const r = decideAccess([]);
  assert.equal(r.ok, false);
  assert.equal(r.via, null);
  assert.deepEqual(r.paths, []);
});

test("earned on-chain paths outrank the pre-launch allowlist in the reported via", () => {
  assert.equal(decideAccess(["allowlist", "stake"]).via, "stake");
  assert.equal(decideAccess(["allowlist", "meridian"]).via, "meridian");
  assert.equal(decideAccess(["allowlist"]).via, "allowlist");
});

test("meridian is the top-reported path when several qualify", () => {
  const r = decideAccess(["allowlist", "stake", "meridian", "agent"]);
  assert.equal(r.ok, true);
  assert.equal(r.via, "meridian");
  assert.deepEqual(r.paths, ["allowlist", "stake", "meridian", "agent"]);
});

test("skill version reads the frontmatter's version line", () => {
  const content = "---\nname: meridian-engine\nversion: 3\ndescription: x\n---\n\n# body\n";
  assert.equal(parseSkillVersion(content), "3");
});

test("skill version tolerates real-world spacing and a body that also says 'version'", () => {
  const content = "---\nversion:   2\n---\nThis skill has a version note in the body too: version: 99\n";
  assert.equal(parseSkillVersion(content), "2", "the FIRST version: line wins, from the frontmatter");
});

test("skill version is 'unknown' rather than throwing on a malformed file", () => {
  assert.equal(parseSkillVersion("no frontmatter here at all"), "unknown");
  assert.equal(parseSkillVersion(""), "unknown");
});
