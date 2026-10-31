export async function POST(_request: Request) {
  void _request;
  return Response.json(
    { error: "Notifications have been retired." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = POST;
