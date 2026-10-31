import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ epochMs: Date.now() }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
