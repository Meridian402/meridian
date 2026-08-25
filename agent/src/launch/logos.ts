// Token logo uploads for agent launches. A team picks a file on the Launch
// page, it lands here, and the returned URL goes into TokenParams.logo when
// the launch is prepared. Content-addressed storage: the filename is the
// sha256 of the bytes, so re-uploads dedupe, nothing can be overwritten, and
// the URL a launch bakes in can never be repointed at different content.
//
// Honest centralization note: v1 serves logos from Meridian's own API host.
// The right long-term home is IPFS pinning so the launch's logo outlives our
// infrastructure; when that lands, this module returns ipfs:// URLs instead
// and nothing else changes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataPath } from "../dataDir.js";

export const LOGO_MAX_BYTES = 512 * 1024;
const LOGO_DIR = dataPath("launch-logos");
const NAME_RE = /^[0-9a-f]{64}\.(png|jpg|webp)$/;

export type LogoExt = "png" | "jpg" | "webp";

/** PURE: identify the image type from magic bytes, or null for anything that
 *  is not a png, jpeg, or webp. The declared Content-Type is never trusted. */
export function sniffImage(buf: Uint8Array): LogoExt | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

/** PURE: the content-addressed filename for these bytes. */
export function logoFileName(buf: Uint8Array, ext: LogoExt): string {
  return `${createHash("sha256").update(buf).digest("hex")}.${ext}`;
}

/** PURE: is this a well-formed logo filename? Serves as the path-traversal
 *  guard on the read route: anything not matching never touches the fs. */
export function isLogoName(name: string): boolean {
  return NAME_RE.test(name);
}

export function contentTypeFor(name: string): string {
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg")) return "image/jpeg";
  return "image/webp";
}

/** Store the bytes (idempotent by construction) and return the filename. */
export function saveLogo(buf: Uint8Array, ext: LogoExt): string {
  if (!existsSync(LOGO_DIR)) mkdirSync(LOGO_DIR, { recursive: true });
  const name = logoFileName(buf, ext);
  const path = join(LOGO_DIR, name);
  if (!existsSync(path)) writeFileSync(path, buf);
  return name;
}

export function logoDiskPath(name: string): string | null {
  if (!isLogoName(name)) return null;
  const path = join(LOGO_DIR, name);
  return existsSync(path) ? path : null;
}

/** The public URL a launch bakes into its params. */
export function logoPublicUrl(name: string): string {
  const base = (process.env.MERIDIAN_PUBLIC_URL ?? "https://meridian402-api-production.up.railway.app").replace(/\/$/, "");
  return `${base}/api/launch/logo/${name}`;
}
