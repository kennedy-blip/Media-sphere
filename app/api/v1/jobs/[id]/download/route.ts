import fs from "fs";
import { Readable } from "stream";
import { NextResponse } from "next/server";
import { ensureDownloadableFile } from "@/lib/serverlessEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MIME_MAP: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  try {
    const resolved = await ensureDownloadableFile(id);
    if (!resolved || !fs.existsSync(resolved.filePath)) {
      return NextResponse.json({ detail: "Job not found" }, { status: 404 });
    }

    const stat = fs.statSync(resolved.filePath);
    const total = stat.size;
    const url = new URL(req.url);
    const asDownload = url.searchParams.get("download") === "true";
    const mime = MIME_MAP[resolved.format] || "application/octet-stream";
    const disposition = `${asDownload ? "attachment" : "inline"}; filename="${resolved.filename}"`;

    const rangeHeader = req.headers.get("range");
    if (rangeHeader && !asDownload) {
      const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(total - 1, parseInt(m[2], 10)) : total - 1;
        if (start >= 0 && start <= end && end < total) {
          const chunkSize = end - start + 1;
          const nodeStream = fs.createReadStream(resolved.filePath, { start, end });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return new NextResponse(Readable.toWeb(nodeStream) as any, {
            status: 206,
            headers: {
              "Content-Type": mime,
              "Content-Length": String(chunkSize),
              "Content-Range": `bytes ${start}-${end}/${total}`,
              "Accept-Ranges": "bytes",
              "Content-Disposition": disposition,
            },
          });
        }
      }
    }

    const nodeStream = fs.createReadStream(resolved.filePath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new NextResponse(Readable.toWeb(nodeStream) as any, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(total),
        "Accept-Ranges": "bytes",
        "Content-Disposition": disposition,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { detail: err instanceof Error ? err.message : "Failed to download media asset" },
      { status: 500 }
    );
  }
}
