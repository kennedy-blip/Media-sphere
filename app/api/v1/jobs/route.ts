import { after, NextResponse } from "next/server";
import { validateUrl } from "@/lib/sanitizer";
import {
  createServerlessJob,
  listServerlessJobs,
  runRealServerlessJob,
  validateJobOptions,
} from "@/lib/serverlessEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function GET() {
  return NextResponse.json({ jobs: listServerlessJobs() });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const rawUrl = String(body?.url ?? "").trim();
    const v = validateUrl(rawUrl);
    if (!v.valid || !v.sanitizedUrl || !v.platform) {
      return NextResponse.json({ detail: v.error ?? "Invalid URL" }, { status: 400 });
    }
    const opts = validateJobOptions(body);
    if (!opts.ok) {
      return NextResponse.json({ detail: opts.error }, { status: 422 });
    }
    const job = createServerlessJob({
      url: rawUrl,
      sanitized_url: v.sanitizedUrl,
      platform: v.platform,
      resolution: opts.resolution,
      format: opts.format,
      trim_start: opts.trim_start,
      trim_end: opts.trim_end,
      generate_subtitles: Boolean(body?.generate_subtitles),
      generate_summary: Boolean(body?.generate_summary),
    });

    after(async () => {
      await runRealServerlessJob(job.id);
    });

    return NextResponse.json(job, { status: 201 });
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }
}
