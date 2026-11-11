import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ status: "ok", service: "mediasphere-api", version: "1.0.0" });
}
