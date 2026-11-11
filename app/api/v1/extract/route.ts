import { NextResponse } from "next/server";
import { extractUrls } from "@/lib/serverlessEngine";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const rawUrls = Array.isArray(body?.urls)
      ? body.urls.map((u: unknown) => String(u ?? "").trim()).filter(Boolean)
      : [];
    if (!rawUrls.length || rawUrls.length > 20) {
      return NextResponse.json(
        { detail: "Provide between 1 and 20 non-empty URLs" },
        { status: 422 }
      );
    }
    return NextResponse.json(extractUrls(rawUrls));
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }
}
