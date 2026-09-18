/* ─────────────────────────────────────────────────────────────────
   worker-proxy.js — optional CORS proxy for the Jev / TypeSafe API.
   Deploy with Cloudflare Workers. The browser sends the user's API
   key in the Authorization header; the worker forwards it to TypeSafe
   and adds permissive CORS headers to the response.
   ───────────────────────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, target: env.JEV_TARGET || 'https://api.typesafe.ai/v1/systemone' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    // Only proxy the /jev/* path
    const target = env.JEV_TARGET || 'https://api.typesafe.ai/v1/systemone';
    if (url.pathname === '/jev' || url.pathname.startsWith('/jev/')) {
      const targetUrl = new URL(target);
      targetUrl.pathname = url.pathname.replace(/^\/jev/, targetUrl.pathname);
      targetUrl.search = url.search;

      const init = {
        method: request.method,
        headers: new Headers(request.headers),
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.clone().arrayBuffer(),
      };
      // Strip incoming Host so upstream doesn't reject
      init.headers.delete('host');

      try {
        const upstream = await fetch(targetUrl.toString(), init);
        const body = await upstream.arrayBuffer();
        return new Response(body, {
          status: upstream.status,
          headers: {
            ...Object.fromEntries(upstream.headers),
            ...corsHeaders(),
            'Access-Control-Allow-Origin': request.headers.get('origin') || '*',
          },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Upstream failure: ' + (e?.message || String(e)) }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, User-Agent',
    'Access-Control-Max-Age': '86400',
  };
}