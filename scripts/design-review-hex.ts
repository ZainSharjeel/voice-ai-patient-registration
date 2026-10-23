export interface HexFinding {
  file: string;
  line: number;
  match: string;
}

export function exemptSourceFiles(
  templateManifest: string | null,
): Set<string> {
  const exempt = new Set(["src/index.css"]);
  if (templateManifest === null) return exempt;
  const managed = (
    JSON.parse(templateManifest) as { managed_files?: Record<string, string> }
  ).managed_files;
  for (const file of Object.keys(managed ?? {})) exempt.add(file);
  return exempt;
}

export function hexColorFindings(file: string, source: string): HexFinding[] {
  const findings: HexFinding[] = [];
  source.split("\n").forEach((line, i) => {
    const match = line.match(/#[0-9a-fA-F]{3,8}\b/);
    if (match && !line.trimStart().startsWith("//")) {
      findings.push({ file, line: i + 1, match: match[0] });
    }
  });
  return findings;
}
