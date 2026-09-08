import { withLibrary } from "@/server/runtime";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return withLibrary(handlers => handlers.bootstrap(request));
}
