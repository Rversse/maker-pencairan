import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// One-time Maker Admin bootstrap has completed. This public route is retired.
Deno.serve((_request: Request) => new Response(JSON.stringify({
  error: "Bootstrap endpoint retired.",
}), {
  status: 410,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  },
}));
