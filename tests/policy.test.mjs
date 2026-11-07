import test from "node:test";
import assert from "node:assert/strict";
import { can, canIssueEquipment, eventReadiness, isStaff } from "../src/lib/policy.mjs";

test("current production roles receive only their intended capabilities", () => {
  assert.equal(can("Administrator", "manage_events"), true);
  assert.equal(can("Director", "manage_team"), true);
  assert.equal(can("Videographer", "manage_events"), false);
  assert.equal(can("PTZ Camera Operator", "complete_checklists"), true);
  assert.equal(can("Equipment Manager", "manage_equipment"), true);
  assert.equal(can("Administrator", "manage_equipment_inventory"), true);
  assert.equal(can("Equipment Manager", "manage_equipment_inventory"), true);
  assert.equal(can("Director", "manage_equipment_inventory"), false);
  assert.equal(can("Videographer", "manage_equipment_inventory"), false);
  assert.equal(can("Audio Operator", "manage_equipment"), false);
  assert.equal(isStaff("Director"), true);
  assert.equal(isStaff("Video Operator"), false);
});

test("equipment handoffs respect condition, active loans, and remaining quantity", () => {
  const asset = { id: "asset-1", status: "Available", condition: "Good" };
  assert.equal(canIssueEquipment(asset, []), true);
  assert.equal(canIssueEquipment({ ...asset, status: "Checked out", quantity: 2 }, [{ id: "loan-1", assetId: "asset-1", borrowerId: "person-1", quantity: 1 }]), true);
  assert.equal(canIssueEquipment({ ...asset, condition: "Needs service" }, []), false);
  assert.equal(canIssueEquipment(asset, [{ id: "loan-1", assetId: "asset-1", borrowerId: "person-1" }]), false);
  assert.equal(canIssueEquipment(asset, [{ id: "loan-1", assetId: "asset-1", borrowerId: "person-1", returnAt: "2026-10-25T12:00:00Z" }]), true);
});

test("event readiness is based on required checklist items for that event", () => {
  const event = { id: "e1" };
  const failed = { id: "c1", eventId: "e1", userId: "u1", label: "Confirm recording", required: true, status: "Needs attention" };
  const ready = { ...failed, status: "Complete" };
  const unrelated = { ...ready, id: "c2", eventId: "e2" };
  assert.equal(eventReadiness(event, [failed]).label, "Needs attention");
  assert.equal(eventReadiness(event, [ready]).label, "Ready");
  assert.equal(eventReadiness(event, [unrelated]).label, "In progress");
  assert.equal(eventReadiness(event, []).label, "In progress");
});
