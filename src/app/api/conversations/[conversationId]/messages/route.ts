import { withLibrary } from "@/server/runtime";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  return withLibrary(async handlers => {
    const { conversationId } = await context.params;
    return handlers.listMessages(request, conversationId);
  });
}
