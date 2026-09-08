import { withLibrary } from "@/server/runtime";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ tripId: string }> },
) {
  return withLibrary(async handlers => {
    const { tripId } = await context.params;
    return handlers.getTrip(request, tripId);
  });
}
