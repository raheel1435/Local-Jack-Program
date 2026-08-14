import "server-only";
import OpenAI from "openai";

const DEFAULT_MODEL = "gpt-realtime-2";
const CLIENT_SECRET_TTL_SECONDS = 300;

export async function POST(): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return Response.json(
      {
        ok: false,
        reason: "missing_api_key",
        message: "The OpenAI connection has not been configured. Set OPENAI_API_KEY on the server and restart.",
      },
      { status: 503 },
    );
  }

  const model = process.env.OPENAI_REALTIME_MODEL || DEFAULT_MODEL;
  const client = new OpenAI({ apiKey });

  try {
    const clientSecret = await client.realtime.clientSecrets.create({
      expires_after: { anchor: "created_at", seconds: CLIENT_SECRET_TTL_SECONDS },
      session: { type: "realtime", model },
    });

    return Response.json({
      ok: true,
      clientSecret: clientSecret.value,
      expiresAt: clientSecret.expires_at,
      model,
    });
  } catch (error) {
    // Never forward the raw provider error (may reference the key/account) to the browser.
    console.error("[jack] Failed to create Realtime client secret:", error instanceof Error ? error.message : error);
    return Response.json(
      {
        ok: false,
        reason: "upstream_error",
        message: "Couldn't start a connection to OpenAI right now. Please try again in a moment.",
      },
      { status: 502 },
    );
  }
}
