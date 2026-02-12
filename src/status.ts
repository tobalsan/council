function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function memberStart(memberId: string, round: 1 | 2): void {
  const phase = round === 1 ? "initial answer" : "revision";
  log(`⟳ Querying member "${memberId}" (${phase})...`);
}

export function memberSuccess(memberId: string, elapsedSec: number, round: 1 | 2): void {
  const phase = round === 1 ? "round 1" : "round 2";
  log(`✓ Member "${memberId}" responded in ${elapsedSec.toFixed(1)}s (${phase})`);
}

export function memberFail(memberId: string, reason: string, round: 1 | 2): void {
  const action = round === 1 ? "skipping" : "using round 1 fallback";
  log(`✗ Member "${memberId}" failed: ${reason} — ${action}`);
}

export function headStart(): void {
  log("⟳ Head is synthesizing final answer...");
}

export function headSuccess(): void {
  log("✓ Council deliberation complete");
}

export function headFail(reason: string): void {
  log(`✗ Head failed: ${reason}`);
}
