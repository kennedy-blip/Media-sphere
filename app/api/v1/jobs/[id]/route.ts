import { NextResponse } from "next/server";
import { cancelServerlessJob, getServerlessJob } from "@/lib/serverlessEngine";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const job = getServerlessJob(id);
  if (!job) {
    return NextResponse.json({ detail: "Job not found" }, { status: 404 });
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
