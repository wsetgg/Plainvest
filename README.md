# Plainvest

Plainvest explains US-listed companies' financial results and selected SEC announcements in plain English.

## Files

- `index.html` — homepage, company search, charts, and analysis report.
- `api/analyze.js` — Vercel serverless API, SEC data processing, announcement retrieval, AI explanations, Redis caching, and rate limiting.
- `api/analyze.test.js` — regression tests for core financial calculations.

## Environment variables

Configure these in Vercel Project Settings → Environment Variables:

- `SEC_USER_AGENT` — required. Identify the app and provide a monitored contact email in line with SEC fair-access guidance.
- `UPSTASH_REDIS_REST_URL` — required for shared analysis caching and daily limits.
- `UPSTASH_REDIS_REST_TOKEN` — required for shared analysis caching and daily limits.
- `ANTHROPIC_API_KEY` — optional. Enables AI-written company and announcement explanations; without it, the API uses fallback content.

Redeploy after changing environment variables.

## Behavior and limitations

- Successful company analyses are cached in Upstash Redis for 24 hours. Cached results include a generation timestamp; new SEC filings can arrive while a result is cached.
- The daily allowance applies to new analyses; a cache hit does not consume that allowance. Rate-limit and cache storage both depend on Upstash availability.
- Financial data is derived from SEC Company Facts. Free cash flow is shown only when both operating cash flow and capital expenditures are available.
- Recent announcements are selected from SEC submissions and linked filing exhibits. This is not a complete real-time news feed.
- Some foreign issuers, ETFs/funds, banks, insurers, newly listed companies, and unusual reporting formats may not be supported reliably.
- Financial ratios and simple status labels are educational heuristics, not sector-adjusted investment recommendations. Review original filings before relying on an interpretation.
- AI explanations can be unavailable, incomplete, or wrong; the interface should make that limitation visible.

## Regression tests

With Node.js 18 or newer installed, run:

```sh
node --test api/analyze.test.js
```
