import { withLibrary } from "@/server/runtime";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return withLibrary(handlers => handlers.listConversations(request));
}

export async function POST(request: Request) {
  return withLibrary(handlers => handlers.createConversation(request));
}
