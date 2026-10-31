import "server-only";
import { createSign } from "node:crypto";

type EquipmentSheetRow = {
  assetCode: string;
  serial: string;
  category: string;
  model: string;
  name: string;
  quantity: number;
  notes: string;
};

type GoogleTokenResponse = { access_token?: string };
type GoogleValuesResponse = { values?: unknown[][]; updates?: { updatedRange?: string } };

const inventoryTab = "Inventory";
const firstInventoryRow = 5;
const lastSupportedRow = 1000;
const spreadsheetScope = "https://www.googleapis.com/auth/spreadsheets";

export function isEquipmentSheetConfigured() {
  return Boolean(process.env.IAC_EQUIPMENT_SPREADSHEET_ID && process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY);
}

function config() {
  const spreadsheetId = process.env.IAC_EQUIPMENT_SPREADSHEET_ID!;
  const serviceAccountEmail = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL!;
  const privateKey = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY!.replace(/\\n/g, "\n");
  return { spreadsheetId, serviceAccountEmail, privateKey };
}

function signedAssertion(serviceAccountEmail: string, privateKey: string) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: serviceAccountEmail,
    scope: spreadsheetScope,
    aud: "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: issuedAt + 3600,
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
}

async function accessToken(serviceAccountEmail: string, privateKey: string) {
  const assertion = signedAssertion(serviceAccountEmail, privateKey);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Google Sheets sign-in failed. Check the service account email and private key settings.");
  const result = await response.json() as GoogleTokenResponse;
  if (!result.access_token) throw new Error("Google Sheets did not return an access token.");
  return result.access_token;
}

function expectedValues(asset: EquipmentSheetRow) {
  return [asset.assetCode, asset.serial, asset.category, asset.model, asset.name, asset.quantity, asset.notes];
}

function sameRow(actual: unknown[] | undefined, expected: (string | number)[]) {
  return expected.every((value, index) => String(actual?.[index] ?? "") === String(value));
}

async function sheetRequest<T>(spreadsheetId: string, token: string, range: string) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Google Sheets could not read or save the equipment inventory. Check the sheet name and service account edit access.");
  return await response.json() as T;
}

export async function syncNewEquipmentToSheet(asset: EquipmentSheetRow) {
  if (!isEquipmentSheetConfigured()) return false;
  const { spreadsheetId, serviceAccountEmail, privateKey } = config();
  const token = await accessToken(serviceAccountEmail, privateKey);
  const readRange = `'${inventoryTab}'!A${firstInventoryRow}:G${lastSupportedRow}`;
  const existing = await sheetRequest<GoogleValuesResponse>(spreadsheetId, token, readRange);
  const expected = expectedValues(asset);
  const existingRow = existing.values?.find((row) => String(row[0] ?? "").trim().toLowerCase() === asset.assetCode.trim().toLowerCase());
  if (existingRow) {
    if (sameRow(existingRow, expected)) return true;
    throw new Error(`Asset ID ${asset.assetCode} already exists in the Google inventory with different details. Resolve that row before adding it in the app.`);
  }

  const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'${inventoryTab}'!A4:G${lastSupportedRow}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const appendResponse = await fetch(appendUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ majorDimension: "ROWS", values: [expected] }),
    cache: "no-store",
  });
  if (!appendResponse.ok) throw new Error("Google Sheets could not save the new equipment item. Check the inventory sheet and service account edit access.");
  const appended = await appendResponse.json() as GoogleValuesResponse;

  const rowMatch = appended.updates?.updatedRange?.match(/!A(\d+):G\d+$/);
  const appendedRow = rowMatch ? Number(rowMatch[1]) : null;
  if (!appendedRow) return true;

  const destinationRowIndex = appendedRow - 1;
  const formatUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  const formatResponse = await fetch(formatUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ copyPaste: {
      source: { sheetId: 1890990797, startRowIndex: 4, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 7 },
      destination: { sheetId: 1890990797, startRowIndex: destinationRowIndex, endRowIndex: destinationRowIndex + 1, startColumnIndex: 0, endColumnIndex: 7 },
      pasteType: "PASTE_FORMAT",
      pasteOrientation: "NORMAL",
    } }] }),
    cache: "no-store",
  });
  if (!formatResponse.ok) console.warn("Equipment inventory was synced, but its spreadsheet row formatting could not be copied.");
  return true;
}
