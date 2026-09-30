#!/usr/bin/env node

/*
 * Requires Node.js 20 or newer.
 *
 * Examples:
 *   node generate-calendar.js
 *   node generate-calendar.js --url https://example/graphql --sha256Hash <hash>
 *   node generate-calendar.js --output calendar.ics --html-output calendar.html --perPage 50
 *
 * The URL and hash can also be set with MATCHES_URL and MATCHES_SHA256_HASH.
 */

const fs = require("node:fs/promises");

const DEFAULT_URL = "https://d2e3twic1m8a2a.cloudfront.net/graphql";
const DEFAULT_SHA256_HASH =
  "4b77290ab94dc208967168a2fc4d9b902327e68691379af625b340c68cc04c2a";
const DEFAULT_OUTPUT = "./public/calendar.ics";
const DEFAULT_HTML_OUTPUT = "./public/calendar.html";
const DEFAULT_PER_PAGE = 20;
const MATCH_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_ERROR_DETAIL_LENGTH = 500;

function errorDetail(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  const sanitized = text.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  if (sanitized.length <= MAX_ERROR_DETAIL_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_ERROR_DETAIL_LENGTH)}... [truncated]`;
}

function endpointLabel(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<configured endpoint>";
  }
}

function formatError(error) {
  const lines = [error.stack ?? `${error.name}: ${error.message}`];
  let cause = error.cause;
  while (cause) {
    lines.push(`Caused by: ${cause.stack ?? `${cause.name}: ${cause.message}`}`);
    cause = cause.cause;
  }
  return lines.join("\n");
}

function parseArguments(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }

    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
    const value =
      separator === -1
        ? argv[++index]
        : argument.slice(separator + 1);

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }

    options[name] = value;
  }

  return options;
}

function getConfiguration() {
  const options = parseArguments(process.argv.slice(2));
  const perPage = Number(options.perPage ?? process.env.MATCHES_PER_PAGE ?? DEFAULT_PER_PAGE);

  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new Error("--perPage must be a positive integer");
  }

  return {
    url: options.url ?? process.env.MATCHES_URL ?? DEFAULT_URL,
    sha256Hash:
      options.sha256Hash ??
      options.hash ??
      process.env.MATCHES_SHA256_HASH ??
      DEFAULT_SHA256_HASH,
    output: options.output ?? process.env.MATCHES_OUTPUT ?? DEFAULT_OUTPUT,
    htmlOutput:
      options["html-output"] ??
      process.env.MATCHES_HTML_OUTPUT ??
      DEFAULT_HTML_OUTPUT,
    perPage,
  };
}

function createRequestBody(sha256Hash, page, perPage) {
  return {
    operationName: "GetMatches",
    variables: {
      competition: null,
      clubbruggeTeam: {
        slug: "a-kern",
      },
      played: false,
      forStandings: false,
      pageFilter: {
        page,
        perPage,
      },
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash,
      },
    },
  };
}

async function fetchPage(configuration, page) {
  const endpoint = endpointLabel(configuration.url);
  const requestStartedAt = Date.now();
  console.log(`[request] Page ${page}: POST ${endpoint}`);

  let response;
  try {
    response = await fetch(configuration.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        createRequestBody(configuration.sha256Hash, page, configuration.perPage),
      ),
    });
  } catch (error) {
    throw new Error(
      `Network request failed for page ${page} at ${endpoint} after ${Date.now() - requestStartedAt} ms: ${error.message}`,
      { cause: error },
    );
  }

  let responseText;
  try {
    responseText = await response.text();
  } catch (error) {
    throw new Error(
      `Could not read response for page ${page} from ${endpoint} (HTTP ${response.status}, after ${Date.now() - requestStartedAt} ms): ${error.message}`,
      { cause: error },
    );
  }

  let payload;
  if (!response.ok) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = null;
    }
    const errorDetails = payload?.errors
      ? `; GraphQL errors: ${errorDetail(payload.errors)}`
      : `; response: ${errorDetail(responseText || "<empty body>")}`;
    throw new Error(
      `Request for page ${page} failed at ${endpoint} with HTTP ${response.status} ${response.statusText} after ${Date.now() - requestStartedAt} ms${errorDetails}`,
    );
  }

  try {
    payload = JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      `Invalid JSON in response for page ${page} from ${endpoint} (HTTP ${response.status}, content-type: ${response.headers.get("content-type") ?? "unknown"}); response: ${errorDetail(responseText || "<empty body>")}`,
      { cause: error },
    );
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(
      `GraphQL request failed for page ${page} at ${endpoint}: ${errorDetail(payload.errors)}`,
    );
  }

  const matches = payload?.data?.matches;
  if (
    !matches ||
    !Array.isArray(matches.items) ||
    !matches.paginationInfo ||
    !Number.isInteger(matches.paginationInfo.total) ||
    matches.paginationInfo.total < 0
  ) {
    const topLevelFields =
      payload && typeof payload === "object"
        ? Object.keys(payload).join(", ") || "<none>"
        : `<${payload === null ? "null" : typeof payload}>`;
    throw new Error(
      `Unexpected response structure for page ${page} from ${endpoint}; expected data.matches.items[] and a non-negative integer paginationInfo.total. Top-level fields: ${topLevelFields}`,
    );
  }

  console.log(
    `[request] Page ${page}: HTTP ${response.status} in ${Date.now() - requestStartedAt} ms; received ${matches.items.length} item(s); total reported: ${matches.paginationInfo.total}`,
  );
  return matches;
}

async function fetchAllMatches(configuration) {
  const items = [];
  let page = 1;
  let total = null;

  while (total === null || items.length < total) {
    let result;
    try {
      result = await fetchPage(configuration, page);
    } catch (error) {
      throw new Error(
        `Failed while retrieving matches (page ${page}; collected ${items.length}${total === null ? "" : ` of ${total}`}): ${error.message}`,
        { cause: error },
      );
    }
    total ??= result.paginationInfo.total;

    if (result.paginationInfo.total !== total) {
      throw new Error(
        `Pagination total changed on page ${page}: expected ${total}, received ${result.paginationInfo.total} after collecting ${items.length} item(s)`,
      );
    }
    if (result.items.length === 0 && items.length < total) {
      throw new Error(
        `Page ${page} returned no items before retrieval was complete (${items.length} of ${total} collected; page size ${configuration.perPage})`,
      );
    }

    items.push(...result.items);
    if (items.length > total) {
      items.length = total;
    }
    page += 1;
  }

  console.log(`[matches] Retrieved all ${items.length} match(es).`);
  return items;
}

function formatUtcDate(value, fieldName) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Match has an invalid ${fieldName}: ${value}`);
  }

  return date.toISOString().replace(/[-:]/g, "").replace(".000", "");
}

function formatIcsDate(value, fieldName) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Match has an invalid ${fieldName}: ${value}`);
  }

  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function escapeIcsText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function getTeamName(match, type) {
  const team = match.teams?.find((entry) => entry.type === type)?.team;
  if (!team?.name) {
    throw new Error(
      `Match ${match.slug ?? "<unknown>"} has no ${type} team name; available team types: ${match.teams?.map((entry) => entry.type).join(", ") || "<none>"}`,
    );
  }
  return team.name;
}

function createMappedEvent(match) {
  const missingFields = [];
  if (!match?.slug) missingFields.push("slug");
  if (!match?.startsAtUTC) missingFields.push("startsAtUTC");
  const competition =
    match?.competition?.abbreviation?.trim() || match?.competition?.title?.trim();
  if (!competition) missingFields.push("competition.abbreviation or competition.title");
  if (missingFields.length > 0) {
    throw new Error(
      `Match ${match?.slug ?? "<unknown>"} is missing required field(s): ${missingFields.join(", ")}`,
    );
  }

  const start = new Date(match.startsAtUTC);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Match ${match.slug} has invalid startsAtUTC "${errorDetail(match.startsAtUTC)}"`);
  }

  const end = new Date(start.getTime() + MATCH_DURATION_MS);
  const isAllDay = start.getUTCHours() === 0 &&
    start.getUTCMinutes() === 0 &&
    start.getUTCSeconds() === 0 &&
    start.getUTCMilliseconds() === 0;
  const home = getTeamName(match, "HOME");
  const away = getTeamName(match, "AWAY");
  const isClubBruggeHome = home === "Club Brugge";
  const locationMarker = isClubBruggeHome ? "⌂" : "↗";
  const summary = `${locationMarker} ${competition}: ${home} - ${away}`;

  return {
    uid: match.slug,
    dtstamp: formatUtcDate(new Date(), "current timestamp"),
    start,
    end,
    isAllDay,
    startDate: formatIcsDate(start, "startsAtUTC"),
    endDate: formatIcsDate(
      isAllDay ? new Date(start.getTime() + 24 * 60 * 60 * 1000) : end,
      "match end",
    ),
    startUtc: formatUtcDate(start, "startsAtUTC"),
    endUtc: formatUtcDate(end, "match end"),
    competition,
    home,
    away,
    locationMarker,
    summary,
  };
}

function createIcsEvent(event) {
  if (event.isAllDay) {
    return [
      "BEGIN:VEVENT",
      `UID:${escapeIcsText(event.uid)}`,
      `DTSTAMP:${event.dtstamp}`,
      `DTSTART;VALUE=DATE:${event.startDate}`,
      `DTEND;VALUE=DATE:${event.endDate}`,
      `SUMMARY:${escapeIcsText(event.summary)}`,
      "END:VEVENT",
    ].join("\r\n");
  }

  return [
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(event.uid)}`,
    `DTSTAMP:${event.dtstamp}`,
    `DTSTART:${event.startUtc}`,
    `DTEND:${event.endUtc}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
    "END:VEVENT",
  ].join("\r\n");
}

function createCalendar(events) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Club Brugge Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Club Brugge",
    "",
    ...events.map(createIcsEvent).flatMap((event) => [event, ""]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function formatHtmlDate(date) {
  return date.toISOString().slice(0, 10);
}

function createHtmlCalendar(events) {
  const rows = events
    .map(
      (event) => `      <tr>
        <td aria-label="${event.locationMarker === "⌂" ? "Home" : "Away"}">${escapeHtml(event.locationMarker)}</td>
        <td>${escapeHtml(event.isAllDay ? `${formatHtmlDate(event.start)} (Time TBD)` : event.start.toISOString())}</td>
        <td>${escapeHtml(event.isAllDay ? `${formatHtmlDate(event.start)} (Time TBD)` : event.end.toISOString())}</td>
        <td>${escapeHtml(event.competition)}</td>
        <td>${escapeHtml(`${event.home} - ${event.away}`)}</td>
        <td>${escapeHtml(event.uid)}</td>
      </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Club Brugge Calendar</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 0.5rem; text-align: left; }
    th { background: #f2f2f2; }
  </style>
</head>
<body>
  <h1>Club Brugge Calendar</h1>
  <table>
    <caption>Matches in UTC</caption>
    <thead>
      <tr>
        <th scope="col">Location</th>
        <th scope="col">Start (UTC)</th>
        <th scope="col">End (UTC)</th>
        <th scope="col">Competition</th>
        <th scope="col">Match</th>
        <th scope="col">UID</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>
`;
}

async function main() {
  const configuration = getConfiguration();
  console.log(
    `[start] Endpoint: ${endpointLabel(configuration.url)}; page size: ${configuration.perPage}; output: ${configuration.output}; HTML: ${configuration.htmlOutput}`,
  );
  const matches = await fetchAllMatches(configuration);
  console.log(`[mapping] Converting ${matches.length} match(es) to calendar events.`);
  const events = matches.map((match, index) => {
    try {
      return createMappedEvent(match);
    } catch (error) {
      throw new Error(
        `Could not map match ${index + 1} of ${matches.length} (slug: ${match.slug ?? "<missing>"}): ${error.message}`,
        { cause: error },
      );
    }
  });

  const outputs = [
    [configuration.output, createCalendar(events), "ICS"],
    [configuration.htmlOutput, createHtmlCalendar(events), "HTML"],
  ];
  await Promise.all(
    outputs.map(async ([path, content, format]) => {
      try {
        await fs.writeFile(path, content, "utf8");
      } catch (error) {
        throw new Error(`Could not write ${format} calendar to "${path}": ${error.message}`, {
          cause: error,
        });
      }
      console.log(`[output] Wrote ${format} calendar to ${path}`);
    }),
  );
  console.log(`[done] Generated calendars for ${matches.length} match(es).`);
}

main().catch((error) => {
  console.error(`Unable to generate calendar:\n${formatError(error)}`);
  process.exitCode = 1;
});
