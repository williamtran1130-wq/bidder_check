export async function GET() {
  const supabase_url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishable_key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const app_url = process.env.APP_URL;
  if (!supabase_url || !publishable_key || !app_url)
    return Response.json({ error: "Connection is not configured." }, { status: 503 });
  return Response.json({ supabase_url, publishable_key, app_url, snapshot_versions: [1, 2] }, { headers: { "Cache-Control": "no-store" } });
}
