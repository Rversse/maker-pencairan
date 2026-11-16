import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Retired endpoint: the Maker frontend now uses maker-master-data-secure,
// which validates the application's opaque session token and scopes kitchens
// by role. Keep this route closed to prevent unauthenticated master-data access.
Deno.serve((_request: Request) => {
  return new Response(JSON.stringify({
    error: "Endpoint retired. Use authenticated Maker application access.",
  }), {
    status: 410,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
