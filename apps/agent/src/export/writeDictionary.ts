// `pnpm --filter agent gen:dict` regenerates the repo-level DATA_DICTIONARY.md from the export contract.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dictionaryMarkdown } from "./dictionary";

const out = fileURLToPath(new URL("../../../../DATA_DICTIONARY.md", import.meta.url));
writeFileSync(out, dictionaryMarkdown());
console.log(`wrote ${out}`);
