import semver from "semver";
import { z } from "zod";

/** GitHub REST "list releases" item: only the fields the version history uses. */
const assetSchema = z.object({ name: z.string(), browser_download_url: z.string().url(), size: z.number() });
const releaseSchema = z.object({
  tag_name: z.string(),
  name: z.string().nullable(),
  body: z.string().nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable(),
  html_url: z.string().url(),
  assets: z.array(assetSchema),
});
export const releasesSchema = z.array(releaseSchema);
export type GithubRelease = z.infer<typeof releaseSchema>;
export type ReleaseAsset = z.infer<typeof assetSchema>;

export type Channel = "stable" | "beta";
export type Platform = "win32" | "darwin";

export interface VersionEntry {
  version: string;
  tag: string;
  title: string;
  notes: string;
  publishedAt: string | null;
  channel: Channel;
  url: string;
  isCurrent: boolean;
  isNewer: boolean;
  /** Installer for this computer, or null when that release has none (then it cannot be installed from the app). */
  installer: ReleaseAsset | null;
  /** electron-builder metadata (latest.yml / latest-mac.yml) holding the installer's SHA-512. */
  metadata: ReleaseAsset | null;
}

export function installerPattern(platform: Platform, arch: string): RegExp {
  return platform === "win32" ? /-Setup-[^/]+\.exe$/ : new RegExp(`-${arch}\\.dmg$`);
}

export function metadataName(platform: Platform): string {
  return platform === "win32" ? "latest.yml" : "latest-mac.yml";
}

/**
 * Newest first. Drafts are never listed; pre-releases are "beta" and only listed on the beta channel
 * (the version the user is running is always listed so they can see where they are).
 */
export function toVersionList(raw: unknown, current: string, channel: Channel, platform: Platform, arch: string): VersionEntry[] {
  const pattern = installerPattern(platform, arch);
  const meta = metadataName(platform);
  const out: VersionEntry[] = [];
  for (const r of releasesSchema.parse(raw)) {
    if (r.draft) continue;
    const version = semver.valid(semver.clean(r.tag_name));
    if (!version) continue;
    const isCurrent = semver.eq(version, current);
    const relChannel: Channel = r.prerelease ? "beta" : "stable";
    if (relChannel === "beta" && channel === "stable" && !isCurrent) continue;
    out.push({
      version,
      tag: r.tag_name,
      title: r.name?.trim() || `v${version}`,
      notes: (r.body ?? "").slice(0, 20_000),
      publishedAt: r.published_at,
      channel: relChannel,
      url: r.html_url,
      isCurrent,
      isNewer: semver.gt(version, current),
      installer: r.assets.find((a) => pattern.test(a.name)) ?? null,
      metadata: r.assets.find((a) => a.name === meta) ?? null,
    });
  }
  return out.sort((a, b) => semver.rcompare(a.version, b.version));
}

/**
 * SHA-512 (base64) of `fileName` from an electron-builder latest*.yml. Small line parser: the format is fixed
 * ("files:" list of "- url:" / "sha512:" / "size:"), and a missing entry returns null so the install is refused.
 */
export function sha512FromMetadata(yml: string, fileName: string): string | null {
  let currentUrl: string | null = null;
  for (const rawLine of yml.split(/\r?\n/)) {
    const line = rawLine.trim();
    const url = /^-\s*url:\s*(.+)$/.exec(line);
    if (url) {
      currentUrl = unquote(url[1]!);
      continue;
    }
    const sha = /^sha512:\s*(.+)$/.exec(line);
    if (sha && currentUrl === fileName) return unquote(sha[1]!);
    if (/^[a-zA-Z]/.test(rawLine)) currentUrl = null; // left the files: list
  }
  return null;
}

function unquote(s: string): string {
  const t = s.trim();
  return (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')) ? t.slice(1, -1) : t;
}
