import { NextResponse } from "next/server";
import { validateUrl } from "@/lib/sanitizer";
import { createServerlessJob, validateJobOptions } from "@/lib/serverlessEngine";

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
    const opts = validateJobOptions(body);
    if (!opts.ok) {
      return NextResponse.json({ detail: opts.error }, { status: 422 });
    }
    const jobs = [];
    const errors = [];
    for (const raw of rawUrls) {
      const v = validateUrl(raw);
      if (!v.valid || !v.sanitizedUrl || !v.platform) {
        errors.push({ url: raw, error: v.error ?? "Invalid URL" });
        continue;
      }
      jobs.push(
        createServerlessJob({
          url: raw,
          sanitized_url: v.sanitizedUrl,
          platform: v.platform,
          resolution: opts.resolution,
          format: opts.format,
          trim_start: opts.trim_start,
          trim_end: opts.trim_end,
          generate_subtitles: Boolean(body?.generate_subtitles),
          generate_summary: Boolean(body?.generate_summary),
        })
      );
    }
    return NextResponse.json({ jobs, errors, created: jobs.length }, { status: 201 });
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }
}
