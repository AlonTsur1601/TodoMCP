import { createHash } from "node:crypto";
import type { RequestAnalysis, SourceUnit, SourceUnitKind } from "./types.js";

const CONSTRAINT_RE = /(?:\bonly\b|\bmust\b|\bnever\b|\bwithout\b|\bdo not\b|\bdon't\b|\bshould not\b|רק|חייב|אסור|לעולם לא|בלי|אל |לא לשנות|לא לגעת)/iu;
const SUCCESS_RE = /(?:\bverify\b|\bensure\b|\bacceptance\b|\bpasses?\b|\bsuccess\b|לוודא|ודא|אימות|בדיקה|הצלחה|יעבור)/iu;
const CONTEXT_RE = /(?:\bfor context\b|\bbackground\b|לרקע|רקע בלבד|שים לב ש)/iu;
const HIGH_RISK_RE = /(?:auth|security|permission|payment|secret|deploy|migration|database|אבטחה|הרשאות|תשלום|סוד|פריסה|מיגרציה|מסד נתונים)/iu;
const DEPENDENCY_RE = /(?:\bafter\b|\bbefore\b|\bdepends?\b|\bthen\b|לאחר|לפני|תלוי|ואז)/iu;
const COMPOUND_SPLIT_RE = /\s+(?:and\s+then|and\s+also|as\s+well\s+as|וגם|ולאחר\s+מכן|וכן)\s+/giu;
const ACTION_CONNECTOR_RE = /\s+(?:and\s+(?=(?:add|build|create|delete|document|implement|remove|rename|run|test|update|verify|write)\b)|ו(?=(?:הוסף|תוסיף|בנה|תבנה|צור|תיצור|מחק|תמחק|כתוב|תכתוב|הרץ|תריץ|בדוק|תבדוק|עדכן|תעדכן|ודא|תוודא)(?:\s|$)))/giu;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function classify(text: string): SourceUnitKind {
  if (CONSTRAINT_RE.test(text)) return "constraint";
  if (SUCCESS_RE.test(text)) return "success_criterion";
  if (CONTEXT_RE.test(text)) return "context";
  return "action";
}

function cleanSegment(value: string): string {
  return value
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|[א-ת][.)]\s+)/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function basicSegments(request: string): string[] {
  const lines = request.replace(/\r\n?/g, "\n").split("\n");
  const segments: string[] = [];

  for (const line of lines) {
    const cleaned = cleanSegment(line);
    if (!cleaned) continue;
    const sentenceParts = cleaned.split(/(?:;\s*|(?<=[.!?])\s+(?=[\p{L}\p{N}]))/gu);
    for (const sentence of sentenceParts) {
      for (const compoundPart of sentence.split(COMPOUND_SPLIT_RE)) {
        for (const part of compoundPart.split(ACTION_CONNECTOR_RE)) {
          const unit = cleanSegment(part);
          if (unit) segments.push(unit);
        }
      }
    }
  }
  return segments;
}

export function analyzeRequest(request: string): RequestAnalysis {
  const requestHash = hash(request);
  const rawSegments = basicSegments(request);
  if (rawSegments.length > 5_000) throw new Error("Request produces more than 5,000 source units; split it into separate requests.");
  const sourceUnits: SourceUnit[] = rawSegments.map((text, ordinal) => {
    const signals: string[] = [];
    if (CONSTRAINT_RE.test(text)) signals.push("constraint_language");
    if (SUCCESS_RE.test(text)) signals.push("verification_language");
    if (DEPENDENCY_RE.test(text)) signals.push("dependency_language");
    if (HIGH_RISK_RE.test(text)) signals.push("high_risk_language");
    if (text.length > 240) signals.push("long_clause");
    return {
      id: `src_${hash(`${ordinal}\0${text}`).slice(0, 12)}`,
      text,
      kind: classify(text),
      signals,
      ordinal,
    };
  });

  const actionable = sourceUnits.filter((unit) => unit.kind !== "context");
  const reasons: string[] = [];
  if (actionable.length > 3) reasons.push("more_than_three_actionable_units");
  if (sourceUnits.some((unit) => unit.signals.includes("dependency_language"))) reasons.push("dependency_language_detected");
  if (sourceUnits.some((unit) => unit.signals.includes("high_risk_language"))) reasons.push("high_risk_language_detected");
  if (sourceUnits.some((unit) => unit.signals.includes("long_clause"))) reasons.push("long_clause_requires_review");

  return {
    requestHash,
    sourceUnits,
    recommendedMode: reasons.length > 0 || actionable.length > 3 ? "plan" : "direct",
    reasons,
  };
}
