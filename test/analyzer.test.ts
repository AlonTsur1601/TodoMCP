import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRequest } from "../src/analyzer.js";

test("small deterministic work recommends independent execution with no completion audit", () => {
  const result = analyzeRequest("Update the README. Run the tests.");
  assert.equal(result.sourceUnits.length, 2);
  assert.equal(result.recommendedMode, "direct");
  assert.equal(result.recommendedAction, "work_independently");
  assert.equal(result.completionAuditRecommended, false);
  assert.ok(result.sourceUnits.every((unit) => unit.id.startsWith("src_")));
});

test("small uncertain work stays independent but recommends one completion audit", () => {
  const result = analyzeRequest("Fix the runtime bug.");
  assert.equal(result.recommendedMode, "direct");
  assert.equal(result.recommendedAction, "work_independently");
  assert.equal(result.completionAuditRecommended, true);
  assert.ok(result.completionAuditReasons.includes("completion_uncertainty_detected"));
});

test("an exact small fix remains deterministic despite generic fix wording", () => {
  const result = analyzeRequest("Fix the typo by replacing teh with the.");
  assert.equal(result.recommendedAction, "work_independently");
  assert.equal(result.completionAuditRecommended, false);
});

test("compound list item is split into separate source units", () => {
  const result = analyzeRequest([
    "1. Add the server.",
    "2. Write unit tests and also create a smoke test.",
    "3. Document installation.",
  ].join("\n"));
  assert.equal(result.sourceUnits.length, 4);
  assert.equal(result.recommendedMode, "plan");
  assert.equal(result.recommendedAction, "create_plan");
  assert.equal(result.completionAuditRecommended, true);
  assert.match(result.sourceUnits[1]!.text, /unit tests/i);
  assert.match(result.sourceUnits[2]!.text, /smoke test/i);
});

test("Hebrew constraints and verification language are retained", () => {
  const result = analyzeRequest("תוסיף כלי חדש. אל תשנה שום קובץ אחר. ודא שהבדיקה נכשלת במקרה שגוי.");
  assert.equal(result.sourceUnits.length, 3);
  assert.equal(result.sourceUnits[1]!.kind, "constraint");
  assert.equal(result.sourceUnits[2]!.kind, "success_criterion");
});

test("source unit identifiers are stable", () => {
  const request = "Build one thing. Verify another thing.";
  assert.deepEqual(
    analyzeRequest(request).sourceUnits.map((unit) => unit.id),
    analyzeRequest(request).sourceUnits.map((unit) => unit.id),
  );
});

test("plain action conjunctions and semicolons are split without splitting platform nouns", () => {
  const english = analyzeRequest("Update the README and run the tests; document Windows and Linux support.");
  assert.deepEqual(english.sourceUnits.map((unit) => unit.text), [
    "Update the README",
    "run the tests",
    "document Windows and Linux support.",
  ]);
  const hebrew = analyzeRequest("תוסיף שרת ותכתוב בדיקות.");
  assert.equal(hebrew.sourceUnits.length, 2);
});
