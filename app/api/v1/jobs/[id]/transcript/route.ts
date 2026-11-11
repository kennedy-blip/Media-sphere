import { NextResponse } from "next/server";
import { getServerlessJob } from "@/lib/serverlessEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const { job } = getServerlessJob(id);
  if (!job) {
    return NextResponse.json({ detail: "Job not found" }, { status: 404 });
  }
  return NextResponse.json({
    transcript: job.transcript ?? null,
    summary: job.summary ?? null,
    srt: job.srt ?? null,
    status: job.status,
  });
}
