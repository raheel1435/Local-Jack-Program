import type {
  ErrorRequestHandler,
  RequestHandler,
} from "express";

import type {
  JackErrorResponse,
} from "../types/jack.js";

const ALLOWED_METHODS =
  "GET,HEAD,POST,DELETE,OPTIONS";

const ALLOWED_HEADERS =
  "Content-Type";

function statusFromError(
  error: unknown,
): number | undefined {
  if (
    !error ||
    typeof error !== "object"
  ) {
    return undefined;
  }

  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
  };

  const raw =
    typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.statusCode ===
          "number"
        ? candidate.statusCode
        : undefined;

  return raw;
}

function typeFromError(
  error: unknown,
): string | undefined {
  if (
    !error ||
    typeof error !== "object"
  ) {
    return undefined;
  }

  const value = (
    error as {
      type?: unknown;
    }
  ).type;

  return typeof value === "string"
    ? value
    : undefined;
}

/**
 * Browser-origin boundary for the loopback Jack gateway.
 *
 * IMPORTANT:
 * - no Origin header remains allowed for same-machine CLI/test clients;
 * - an allowed browser Origin is reflected exactly;
 * - a present but non-allowlisted Origin is rejected before body parsing or
 *   route work;
 * - DELETE is advertised because credential removal uses DELETE.
 */
export function createGatewayCorsMiddleware(
  allowedOrigins: readonly string[],
): RequestHandler {
  const allowed =
    new Set(allowedOrigins);

  return (req, res, next) => {
    const origin =
      req.headers.origin;

    // Responses vary by Origin. This is cheap on a local service and avoids
    // a cache ever reusing one origin's CORS headers for another.
    res.vary("Origin");

    if (
      origin &&
      !allowed.has(origin)
    ) {
      const err: JackErrorResponse = {
        error: "origin_not_allowed",
        detail:
          "This browser origin is not allowed to access the Jack local gateway.",
        code: "origin_not_allowed",
      };

      res.status(403).json(err);
      return;
    }

    if (origin) {
      res.setHeader(
        "Access-Control-Allow-Origin",
        origin,
      );
    }

    res.setHeader(
      "Access-Control-Allow-Methods",
      ALLOWED_METHODS,
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      ALLOWED_HEADERS,
    );

    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }

    next();
  };
}

/**
 * Keep an unknown gateway path inside Jack's JSON API contract instead of
 * falling through to Express's default HTML 404 page.
 */
export const gatewayNotFoundHandler:
  RequestHandler = (req, res) => {
    const err: JackErrorResponse = {
      error: "not_found",
      detail:
        `No Jack gateway route matches ${req.method} ${req.path}.`,
      code: "not_found",
    };

    res.status(404).json(err);
  };

/**
 * Final Express error boundary.
 *
 * Body parsers run before route handlers and throw through Express rather
 * than returning JackErrorResponse themselves. Normalize those failures and
 * never expose parser stack traces/raw internal errors to the browser.
 */
export const gatewayErrorHandler:
  ErrorRequestHandler = (
    error,
    _req,
    res,
    next,
  ) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const status =
      statusFromError(error);

    const type =
      typeFromError(error);

    if (
      status === 413 ||
      type === "entity.too.large"
    ) {
      const err: JackErrorResponse = {
        error: "payload_too_large",
        detail:
          "Request body exceeds the configured gateway size limit.",
        code: "payload_too_large",
      };

      res.status(413).json(err);
      return;
    }

    if (
      status === 400 ||
      type === "entity.parse.failed"
    ) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail:
          "Request body is not valid for this endpoint.",
        code: "invalid_request",
      };

      res.status(400).json(err);
      return;
    }

    // Keep detail private. Route-specific handlers are responsible for
    // returning safe public provider errors; anything reaching this final
    // boundary is genuinely unexpected.
    console.error(
      "[gateway] Unhandled request error",
      error,
    );

    const err: JackErrorResponse = {
      error: "internal_error",
      detail:
        "The Jack local gateway could not complete this request.",
      code: "internal_error",
    };

    res.status(500).json(err);
  };
