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
  const response = await fetch(configuration.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      createRequestBody(configuration.sha256Hash, page, configuration.perPage),
    ),
  });

  const responseText = await response.text();
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(`The server returned invalid JSON for page ${page}`);
  }

  if (!response.ok) {
    const errorDetails = payload.errors
      ? `: ${JSON.stringify(payload.errors)}`
      : "";
    throw new Error(`Request for page ${page} failed with HTTP ${response.status}${errorDetails}`);
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`GraphQL request for page ${page} failed: ${JSON.stringify(payload.errors)}`);
  }

  const matches = payload.data?.matches;
  if (
    !matches ||
    !Array.isArray(matches.items) ||
    !matches.paginationInfo ||
    !Number.isInteger(matches.paginationInfo.total)
  ) {
    throw new Error(`Response for page ${page} does not contain the expected matches structure`);
  }

  return matches;
}

async function fetchAllMatches(configuration) {
  const items = [];
  let page = 1;
  let total = null;

  while (total === null || items.length < total) {
    const result = await fetchPage(configuration, page);
    total ??= result.paginationInfo.total;

    if (result.paginationInfo.total !== total) {
      throw new Error("The total item count changed while retrieving pages");
    }
    if (result.items.length === 0 && items.length < total) {
      throw new Error(`Page ${page} returned no items before all matches were retrieved`);
    }

    items.push(...result.items);
    if (items.length > total) {
      items.length = total;
    }
    page += 1;
  }

  return items;
}

function formatUtcDate(value, fieldName) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Match has an invalid ${fieldName}: ${value}`);
  }

  return date.toISOString().replace(/[-:]/g, "").replace(".000", "");
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
    throw new Error(`Match ${match.slug ?? "<unknown>"} has no ${type} team name`);
  }
  return team.name;
}

function createMappedEvent(match) {
  if (!match.slug || !match.startsAtUTC || !match.competition?.abbreviation) {
    throw new Error("Match is missing slug, startsAtUTC, or competition abbreviation");
  }

  const start = new Date(match.startsAtUTC);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Match ${match.slug} has an invalid startsAtUTC value`);
  }

  const end = new Date(start.getTime() + MATCH_DURATION_MS);
  const home = getTeamName(match, "HOME");
  const away = getTeamName(match, "AWAY");
  const summary = `${match.competition.abbreviation}: ${home} - ${away}`;

  return {
    uid: match.slug,
    dtstamp: formatUtcDate(new Date(), "current timestamp"),
    start,
    end,
    startUtc: formatUtcDate(start, "startsAtUTC"),
    endUtc: formatUtcDate(end, "match end"),
    competition: match.competition.abbreviation,
    home,
    away,
    summary,
  };
}

function createIcsEvent(event) {
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

function createHtmlCalendar(events) {
  const rows = events
    .map(
      (event) => `      <tr>
        <td>${escapeHtml(event.start.toISOString())}</td>
        <td>${escapeHtml(event.end.toISOString())}</td>
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
  const matches = await fetchAllMatches(configuration);
  const events = matches.map(createMappedEvent);
  await Promise.all([
    fs.writeFile(configuration.output, createCalendar(events), "utf8"),
    fs.writeFile(configuration.htmlOutput, createHtmlCalendar(events), "utf8"),
  ]);
  console.log(
    `Wrote ${matches.length} matches to ${configuration.output} and ${configuration.htmlOutput}`,
  );
}

main().catch((error) => {
  console.error(`Unable to generate calendar: ${error.message}`);
  process.exitCode = 1;
});
