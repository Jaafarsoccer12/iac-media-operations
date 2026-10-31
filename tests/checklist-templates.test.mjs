import test from "node:test";
import assert from "node:assert/strict";
import { hasChecklistTemplateNameConflict } from "../src/lib/checklist-templates.mjs";

const templates = [
  { id: "pre-event-ameen", name: "Ameen", category: "Pre-event" },
  { id: "legacy", name: "Legacy" },
];

test("same checklist name is allowed in another stage", () => {
  assert.equal(hasChecklistTemplateNameConflict(templates, "Ameen", "Quran"), false);
});

test("same checklist name is rejected within the same stage, ignoring capitalization", () => {
  assert.equal(hasChecklistTemplateNameConflict(templates, "ameen", "pre-event"), true);
});

test("editing a template does not conflict with itself, and legacy templates default to Pre-event", () => {
  assert.equal(hasChecklistTemplateNameConflict(templates, "Ameen", "Pre-event", "pre-event-ameen"), false);
  assert.equal(hasChecklistTemplateNameConflict(templates, "Legacy", "Pre-event"), true);
});
