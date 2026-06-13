import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemberAnswer } from "./types.js";

export function createRunDir(): string {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  const hours = now.getHours().toString().padStart(2, "0");
  const minutes = now.getMinutes().toString().padStart(2, "0");
  const seconds = now.getSeconds().toString().padStart(2, "0");
  const runId = `${year}${month}${day}-${hours}${minutes}${seconds}-${process.pid}`;
  const path = join(tmpdir(), "council", runId);
  mkdirSync(path, { recursive: true });
  return path;
}

export function saveQuestion(runDir: string, question: string): string {
  const filePath = join(runDir, "question.md");
  writeFileSync(filePath, question, "utf8");
  return filePath;
}

export function saveMemberAnswer(runDir: string, id: string, round: 1 | 2, text: string): string {
  const filePath = join(runDir, `${id}.r${round}.md`);
  writeFileSync(filePath, text, "utf8");
  return filePath;
}

export function loadSavedRun(dir: string): { question: string; answers: MemberAnswer[] } {
  const questionPath = join(dir, "question.md");
  if (!existsSync(questionPath)) {
    throw new Error(`No question.md found in ${dir}`);
  }
  const question = readFileSync(questionPath, "utf8");

  const files = readdirSync(dir);
  const answerFiles = files.filter((f) => /\.r[12]\.md$/.test(f));

  if (answerFiles.length === 0) {
    throw new Error(`No answer files found in ${dir}`);
  }

  const byId = new Map<string, { r1?: string; r2?: string }>();
  for (const file of answerFiles) {
    const match = file.match(/^(.+)\.(r[12])\.md$/);
    if (!match) {
      continue;
    }
    const [, memberId, roundKey] = match;
    if (!memberId || !roundKey) {
      continue;
    }
    const entry = byId.get(memberId) ?? {};
    const text = readFileSync(join(dir, file), "utf8");
    if (roundKey === "r1") {
      entry.r1 = text;
    } else {
      entry.r2 = text;
    }
    byId.set(memberId, entry);
  }

  const answers: MemberAnswer[] = Array.from(byId.entries())
    .map(([id, entry]) => ({
      id,
      text: entry.r2 ?? entry.r1 ?? "",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (answers.length === 0) {
    throw new Error(`No answer files found in ${dir}`);
  }

  return { question, answers };
}
