import { after, NextResponse } from "next/server";
import {
  cancelServerlessJob,
  getServerlessJob,
  runRealServerlessJob,
} from "@/lib/serverlessEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const { job, needsRun } = getServerlessJob(id);
  if (!job) {
    return NextResponse.json({ detail: "Job not found" }, { status: 404 });
  }
  if (needsRun) {
    after(async () => {
      await runRealServerlessJob(id);
    });
  }
  return NextResponse.json(job);
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const res = cancelServerlessJob(id);
  if (!res.found) {
    return NextResponse.json({ detail: "Job not found" }, { status: 404 });
  }
  return NextResponse.json({ cancelled: res.cancelled, id });
}
