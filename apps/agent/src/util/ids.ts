import { createHash, randomBytes } from "node:crypto";

export const newId = (prefix: string): string => `${prefix}_${randomBytes(6).toString("hex")}`;

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Short alphanumeric id safe for exchange client order ids (most cap at 32-36 chars). */
export const shortId = (): string => randomBytes(4).toString("hex");
