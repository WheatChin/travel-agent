import { withLibrary } from "@/server/runtime";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return withLibrary(handlers => handlers.listTrips(request));
}
