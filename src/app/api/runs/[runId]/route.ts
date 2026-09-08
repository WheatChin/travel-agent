import { withLibrary } from "@/server/runtime";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return withLibrary(async handlers => {
    const { runId } = await context.params;
    return handlers.getRun(request, runId);
  });
}
