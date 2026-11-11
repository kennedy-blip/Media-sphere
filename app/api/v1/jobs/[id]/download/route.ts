import { NextResponse } from "next/server";
import { buildPlayableWavBytes, getServerlessJob } from "@/lib/serverlessEngine";

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const job = getServerlessJob(id);
  if (!job) {
    return NextResponse.json({ detail: "Job not found" }, { status: 404 });
  }
  if (job.status !== "ready") {
    return NextResponse.json(
      { detail: `Job is not ready (status: ${job.status})` },
      { status: 409 }
    );
  }
  const url = new URL(req.url);
  const asDownload = url.searchParams.get("download") === "true";
  const ext = job.format || "mp4";
  const safeTitle = job.title.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || id;
  const disposition = `${asDownload ? "attachment" : "inline"}; filename="${safeTitle}.${ext}"`;

  if (ext === "mp3" || ext === "wav") {
    const wav = buildPlayableWavBytes(2);
    return new NextResponse(new Uint8Array(wav), {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Disposition": disposition,
      },
    });
  }

  const header = Buffer.from("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom", "binary");
  const meta = Buffer.from(`MediaSphere asset\nTitle: ${job.title}\nJob: ${id}\n`, "utf8");
  const pad = Buffer.alloc(50_000);
  const payload = Buffer.concat([header, meta, pad]);
  return new NextResponse(new Uint8Array(payload), {
    headers: {
      "Content-Type": ext === "webm" ? "video/webm" : "video/mp4",
      "Content-Disposition": disposition,
    },
  });
}
