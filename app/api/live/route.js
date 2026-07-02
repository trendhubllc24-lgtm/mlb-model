import { getEspnSlate, extractLiveGames } from "@/lib/sources";

export const dynamic = "force-dynamic";

// No secret required — read-only and cheap. Safe for the frontend to poll
// every ~10-25s while there are live games.
export async function GET() {
  try {
    const slate = await getEspnSlate();
    const live = extractLiveGames(slate);
    return Response.json({ ok: true, live, checkedAt: new Date().toISOString() });
  } catch (err) {
    return Response.json({ ok: false, live: [], error: String(err) }, { status: 200 });
  }
}
