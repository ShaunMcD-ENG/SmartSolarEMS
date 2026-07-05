# Amber Electric (Australia) Public API Reference

Reference for building a client against Amber Electric's public API. **Primary source**:
the live OpenAPI 3.0.0 spec served at `https://api.amber.com.au/v1` (`info.version: 2.1.0`
at time of writing — fetched directly, not from cached docs, so this reflects the exact
schema Amber currently returns). Secondary sources: Amber's hosted documentation page, the
`amberelectric/public-api` GitHub discussions repo (used by Amber's own dev team for public
Q&A), and the official Home Assistant `amberelectric` integration source code (used to
verify the feed-in sign convention against real, tested client behavior).

**Confidence: high** for schema fields, endpoints, and parameters (straight from the live
OpenAPI spec). **High** for the feed-in sign convention (independently confirmed against
production client code, see §5). **Medium** for the exact rate-limit number (confirmed via
an Amber engineer's GitHub reply, not in the OpenAPI spec itself, and the reply says the
number may be tuned before/after enforcement).

---

## 1. Authentication & base URL

| Item | Value |
|---|---|
| Base URL | `https://api.amber.com.au/v1` |
| Auth scheme | HTTP Bearer token (`securitySchemes.apiKey: {type: http, scheme: bearer}`) — send `Authorization: Bearer <token>` |
| Token generation | Personal API tokens: log in to your Amber account and generate a token on the developer page (`https://app.amber.com.au/developers`). Requires an Amber account. |
| OAuth2 (third-party apps) | Available for apps that want to access *other* customers' data with their consent. Authorization URL `https://app.amber.com.au/oauth/authorize`, token URL `https://api.amber.com.au/oauth/token`. Scopes: `sites`, `prices`, `usage`. Requires filling in an access-request form (linked from the OpenAPI spec) before Amber grants OAuth client credentials. |
| Docs page | `https://app.amber.com.au/developers/documentation/` (human-readable); OpenAPI spec at `https://api.amber.com.au/v1` root / historically also published at `app.amber.com.au/swagger.json` |
| GitHub | `https://github.com/amberelectric/public-api` — discussion/support repo for the public API, staffed by Amber engineers |

## 2. Rate limits

- **Documented figure (community-confirmed, not in the OpenAPI spec body): ~50 requests
  per 5-minute window, per account** (not per site, not per API key — i.e. if you have
  multiple sites or tokens on one account, they share the same 50/5min budget).
- Source: Amber engineer "madpilot" in `amberelectric/public-api` Discussion #146
  ("Rate limiting is coming..."): *"API limits are per account, not per site, or per API
  key... This is implemented now so you can see how close to the sun you are flying,
  without the limit being enforced... We can also bump up the numbers on a
  customer-by-customer basis if there is a good reason."* Treat 50/5min as the working
  assumption, but expect it to be tunable/negotiable and possibly revised.
- **Response headers** (per the OpenAPI `components.headers`, following the IETF
  `draft-ietf-httpapi-ratelimit-headers` draft):
  - `RateLimit-Limit` (integer) — requests allowed per window
  - `RateLimit-Remaining` (integer) — remaining quota this window
  - `RateLimit-Reset` (integer) — seconds until the window resets
  - `RateLimit-Policy` (string) — the policy descriptor
  - **Read these headers at runtime rather than hardcoding 50/5min** — Amber may adjust the
    actual numbers.

## 3. Endpoints

### `GET /sites`

Returns all sites linked to the authenticated account. No parameters. Requires
`apiKey` or OAuth scope `sites`.

**Response**: array of `Site` objects.

#### `Site` schema

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Unique site identifier (ULID-style, e.g. `01F5A5CRKMZ5BCX9P1S4V990AM`) — used as `{siteId}` path param elsewhere |
| `nmi` | string | yes | National Metering Identifier, 10–11 chars |
| `channels` | array of `Channel` | yes | Meter channels readable at this site |
| `network` | string | yes | Distribution network name, e.g. `"Jemena"` |
| `status` | `SiteStatus` enum | yes | `pending` \| `active` \| `closed` — see below |
| `activeFrom` | date (ISO 8601) | no | Date site became active; may be in the future for pending sites |
| `closedOn` | date (ISO 8601) | no | Date site closed; undefined if pending/active |
| `intervalLength` | number, enum `[5, 30]` | yes | Billing interval length in minutes; default 30 |

`SiteStatus` enum meanings: `pending` = still transferring (address must be correct or
contact Amber support); `active` = currently supplied by Amber; `closed` = no longer
supplied.

#### `Channel` schema (nested in `Site.channels`)

| Field | Type | Notes |
|---|---|---|
| `identifier` | string | e.g. `"E1"` |
| `type` | `ChannelType` enum | `general` \| `controlledLoad` \| `feedIn` |
| `tariff` | string | Tariff code, e.g. `"A100"` |

`general` = your normal continuous-supply circuit (appliances/lights). `controlledLoad` =
switched circuits (e.g. hot water) only on part of the day. `feedIn` = exported solar/
battery power — present only if you have solar or a battery.

### `GET /sites/{siteId}/prices`

Returns all priced intervals between `startDate` and `endDate` (inclusive on both ends).
Requires `apiKey` or OAuth scope `prices`.

| Param | In | Required | Notes |
|---|---|---|---|
| `siteId` | path | yes | From `/sites` |
| `startDate` | query, date | no | Defaults to today. Range `endDate - startDate` must not exceed 7 days |
| `endDate` | query, date | no | Defaults to today |
| `resolution` | query, int enum `[5, 30]` | no | Defaults to your billing interval length |

**Response**: array of `Interval` objects (see §4), one per channel per time interval.
**Return order: General channel intervals, then Controlled Load, then Feed In** — the
OpenAPI description explicitly warns: *"If a channel is added or removed the index offset
will change. It is best to filter or group the array by channel type"* rather than index
into the array positionally.

Errors: `400` bad request, `401` bad/missing token, `404` site not found, `422` date range
> 7 days, `500` internal error.

### `GET /sites/{siteId}/prices/current`

Returns the current price, optionally with forecast/actual intervals either side of now.

| Param | In | Required | Notes |
|---|---|---|---|
| `siteId` | path | yes | |
| `next` | query, int | no | Return the *next* N forecast intervals. `next + previous` total must not exceed 2048 |
| `previous` | query, int | no | Return the *previous* N actual intervals. Same 2048 cap |
| `resolution` | query, int enum `[5, 30]` | no | Defaults to billing interval length |

**Response**: array of `Interval` objects — same General → Controlled Load → Feed In
ordering caveat as `/prices`. Without `next`/`previous`, returns just the current interval
per channel. Errors: `400`, `401`, `404`, `422` (>2048 intervals requested), `500`.

### `GET /sites/{siteId}/usage`

Returns metered usage between `startDate` and `endDate`. Max 90 days of history available
in total (not per request — the 7-day-per-request cap still applies, so backfilling 90 days
requires ~13 sequential 7-day requests). Requires OAuth scope `usage`.

| Param | In | Required | Notes |
|---|---|---|---|
| `siteId` | path | yes | |
| `startDate` | query, date | **yes** | Range must not exceed 7 days |
| `endDate` | query, date | **yes** | |
| `resolution` | query | no | **Deprecated** — always returns your billing interval length now; any value you pass is ignored |

**Response**: array of `Usage` objects (extends `BaseInterval`, see §4), same channel
ordering caveat. Errors: `400`, `401`, `404`, `422` (>7 days), `500`.

#### `Usage` schema (in addition to `BaseInterval` fields)

| Field | Type | Notes |
|---|---|---|
| `type` | string enum `"Usage"` | |
| `channelIdentifier` | string | Matches a `Channel.identifier` from `/sites` |
| `kwh` | number | Consumed (positive) or generated (**negative**) kWh for the interval |
| `quality` | enum `estimated` \| `billable` | `estimated` = meter comms trouble, retailer estimated it; `billable` = will appear on your bill |
| `cost` | number | Total cost for this interval's consumption/generation, **includes GST** |

### `GET /state/{state}/renewables/current`

Current/forecast/historical renewables percentage for a state. No auth required
(`security: []` in the spec — this endpoint is public).

| Param | In | Required | Notes |
|---|---|---|---|
| `state` | path | yes | Valid: `nsw`, `sa`, `qld`, `vic` (note: **not** all NEM states/territories — no `tas` or `wa` in the example set; wa isn't part of the NEM at all) |
| `next` | query, int | no | Next N forecast intervals |
| `previous` | query, int | no | Previous N actual intervals |
| `resolution` | query, int enum `[5,30]` | no | Default 30 |

**Response**: array of `Renewable` objects — `ActualRenewable` \| `CurrentRenewable` \|
`ForecastRenewable`, each extending `BaseRenewable` (same `duration`/`date`/`nemTime`/
`startTime`/`endTime`/`renewables`/`descriptor` shape as the price intervals, minus the
price-specific fields). `descriptor` is a `RenewableDescriptor` enum: `best` \| `great` \|
`ok` \| `notGreat` \| `worst`.

---

## 4. Interval object schema — the core object of the API

`Interval` is a discriminated union (`oneOf`) on the `type` field:
`ActualInterval` | `CurrentInterval` | `ForecastInterval`. All three extend a common
`BaseInterval`.

### `BaseInterval` fields (shared by all three types, and by `Usage`)

| Field | Type | Unit | Notes |
|---|---|---|---|
| `type` | string | | Discriminator: `"ActualInterval"` \| `"CurrentInterval"` \| `"ForecastInterval"` (or `"Usage"` for the usage endpoint) |
| `duration` | integer, enum `[5,15,30]` | minutes | Length of this interval |
| `spotPerKwh` | number | **c/kWh, includes GST** | Raw NEM spot price — what generators are paid; drives the variable component of `perKwh` |
| `perKwh` | number | **c/kWh, includes GST** | What you actually pay per kWh for this channel/interval — **see §5 for the feed-in sign gotcha** |
| `date` | string (ISO 8601 date) | | Date the interval *belongs to*, in NEM time. Can differ from `nemTime`'s date component because the day's final interval ends at 12:00am/24:00 → rolls to the next calendar date in some representations |
| `nemTime` | string (ISO 8601 date-time) | | **The interval's NEM time = the time at the END of the interval, always UTC+10** (fixed offset, no DST — AEST year-round) |
| `startTime` | string (ISO 8601 date-time, UTC) | | Interval start, in UTC (`Z` suffix) |
| `endTime` | string (ISO 8601 date-time, UTC) | | Interval end, in UTC |
| `renewables` | number | % | Grid renewables percentage during this interval |
| `channelType` | `ChannelType` enum | | `general` \| `controlledLoad` \| `feedIn` |
| `tariffInformation` | `TariffInformation`, nullable | | See below; only populated if the site is on a time-of-use/block/demand tariff |
| `spikeStatus` | `SpikeStatus` enum | | `none` \| `potential` \| `spike` |
| `descriptor` | `PriceDescriptor` enum | | `negative` (deprecated, replaced by `extremelyLow`) \| `extremelyLow` \| `veryLow` \| `low` \| `neutral` \| `high` \| `spike` |

### `ActualInterval` — adds nothing beyond `BaseInterval` except pinning `type` to
`"ActualInterval"`. Represents a settled, historical price.

### `ForecastInterval` — a future interval, AEMO-modelled forecast

| Field | Type | Notes |
|---|---|---|
| `range` | `Range`, nullable | `{min, max}` c/kWh — shown only "when prices are particularly volatile" |
| `advancedPrice` | `AdvancedPrice`, nullable | Amber's own confidence-banded forecast (added as a feature — see Discussion #214 below) |

### `CurrentInterval` — the live, still-updating interval

| Field | Type | Notes |
|---|---|---|
| `estimate` | boolean, **required** | `true` = still an estimate (weighted average of 5-min actuals + 5-min forecasts so far this interval); `false` = locked in (final price for the interval, typically true in the last 5 minutes of the interval) |
| `range` | `Range`, nullable | Same as `ForecastInterval.range` |
| `advancedPrice` | `AdvancedPrice`, nullable | Same as `ForecastInterval.advancedPrice` |

### `Range` schema

| Field | Type | Notes |
|---|---|---|
| `min` | number | Estimated minimum price, c/kWh |
| `max` | number | Estimated maximum price, c/kWh |

### `AdvancedPrice` schema

Amber's confidence-banded forecast, layered on top of the raw AEMO forecast.

| Field | Type | Notes |
|---|---|---|
| `low` | number | Lower bound of the prediction band, c/kWh, includes network+market fees |
| `predicted` | number | Single best-guess price, c/kWh — use this if you need one number |
| `high` | number | Upper bound of the prediction band, c/kWh |

### `TariffInformation` schema

| Field | Type | Notes |
|---|---|---|
| `period` | enum: `offPeak` \| `shoulder` \| `solarSponge` \| `peak` | Only present if site is on a time-of-use tariff |
| `season` | enum: `default` \| `summer` \| `autumn` \| `winter` \| `spring` \| `nonSummer` \| `holiday` \| `weekend` \| `weekendHoliday` \| `weekday` | Only present if site is on a TOU tariff |
| `block` | number, 1–2 | Only present if site is on a block tariff |
| `demandWindow` | boolean | Only present if site is on a demand tariff |

---

## 5. Feed-in sign convention — **verified: positive `perKwh` means you PAY, negative means you EARN**

This is the single most error-prone field in the API and the task explicitly calls it out,
so it was independently verified two ways:

1. **The OpenAPI spec itself is silent on sign** — `perKwh`'s description is generic
   ("Number of cents you will pay per kilowatt-hour") and doesn't call out feed-in
   specially. This is *not* sufficient on its own to determine the convention.
2. **Verified against the official Home Assistant `amberelectric` integration source**
   (`homeassistant/components/amberelectric/sensor.py`, `home-assistant/core` repo, current
   `dev` branch), which is written against Amber's own `amberelectric` Python client
   library. The sensor code does this for every feed-in price it surfaces to users
   (current price, forecast prices, and the `extra_state_attributes` for both):

   ```python
   if interval.channel_type == ChannelType.FEEDIN:
       return format_cents_to_dollars(interval.per_kwh) * -1
   return format_cents_to_dollars(interval.per_kwh)
   ```

   The integration **multiplies the raw API `perKwh` by −1** before showing it to the user
   as a "Feed In Price" sensor. Home Assistant's own convention for that sensor is "positive
   = you are being paid" (the normal, human-friendly framing of a feed-in tariff). Since the
   integration has to *flip the sign* to get there, **the raw API value must already be the
   opposite**: raw `perKwh` on a `feedIn` channel is **negative when you're being paid
   (the common case)**, and **positive when you would have to pay to export (a negative
   feed-in-tariff event)**.

**Concretely**: if `channelType == "feedIn"` and `perKwh == -8.5`, you earn 8.5 c/kWh for
everything you export that interval (the normal case). If `perKwh == +3.2` on a `feedIn`
channel, you are being *charged* 3.2 c/kWh to export during that interval (a negative-FiT
event, which does happen on Amber during high-renewables/negative-wholesale periods).

**This is inverted relative to `general`/`controlledLoad` channels**, where positive
`perKwh` always simply means "you pay this much" — there's no sign flip needed for those.
**When writing a client, do not naively treat `perKwh` the same way across all three
channel types** — branch on `channelType` and flip sign for `feedIn` if you want an
"earnings-positive" number, or keep it raw if you want "cost-positive" consistently across
all channels (raw = cost-positive convention throughout, feed-in included).

*(Some community GitHub discussion excerpts assert the opposite convention informally, but
they were not primary/tested sources — the Home Assistant integration source code is a much
stronger signal since it is executable, tested-in-production code that had to get this
right for real users' dashboards not to be visibly wrong. Treat the code-derived conclusion
above as authoritative.)*

---

## 6. Timezone / NEM time handling

- **NEM time is a fixed UTC+10 offset year-round — there is no daylight saving in NEM
  time**, even though some Australian states (e.g. NSW, Vic, SA) observe DST locally. The
  `nemTime` field's description explicitly states *"UTC+10"* with no DST caveat, and this
  matches the general convention that AEMO's National Electricity Market operates all
  settlement on a single fixed offset (effectively AEST year-round) regardless of local
  clock changes in any given region.
- `startTime`/`endTime` are given in UTC (`Z` suffix) — convert these yourself if you need
  another local timezone (e.g. real Sydney local time including DST) for display purposes.
- **`date` can disagree with the date component of `nemTime`**: the spec calls this out
  directly — *"This may be different to the date component of nemTime, as the last interval
  of the day ends at 12:00 the following day"* — i.e. use `date` (not `nemTime`'s date part)
  when you want "which trading day does this interval belong to."
- **Interval timestamps use the interval-*ending* convention**: `nemTime` is explicitly
  documented as *"the time at the end of the interval"*. `endTime` (UTC) is the
  authoritative end-of-interval UTC timestamp; `startTime` = `endTime` − `duration` minutes.
  When aligning Amber intervals against other data sources (e.g. your own load metering, or
  a Modbus polling loop), **bucket by interval-end, not interval-start**, to match Amber's
  and AEMO's own convention.

---

## Sources

- Live OpenAPI 3.0.0 spec, `info.version 2.1.0`, fetched directly from
  `https://api.amber.com.au/v1` (also mirrored at
  `https://github.com/amberelectric/public-api/blob/main/swagger.json`)
- Amber developer documentation landing page:
  `https://app.amber.com.au/developers/documentation/`
- `amberelectric/public-api` GitHub Discussion #146, "Rate limiting is coming..." (rate
  limit figure, per-account scope, IETF rate-limit headers):
  https://github.com/amberelectric/public-api/discussions/146
- `amberelectric/public-api` GitHub Discussion #32, "Matching API prices with the bills"
  (spot price → retail price reconciliation formula context):
  https://github.com/amberelectric/public-api/discussions/32
- `amberelectric/public-api` GitHub Discussion #214, "Added Advanced Prices to intervals"
  (background on the `advancedPrice` field):
  https://github.com/amberelectric/public-api/discussions/214
- Home Assistant core `amberelectric` integration source
  (`homeassistant/components/amberelectric/sensor.py`, `home-assistant/core` `dev` branch)
  — used to verify the feed-in sign convention against tested production code:
  https://github.com/home-assistant/core/blob/dev/homeassistant/components/amberelectric/sensor.py
- Home Assistant `amberelectric` integration docs page:
  https://www.home-assistant.io/integrations/amberelectric/
