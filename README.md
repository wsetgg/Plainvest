# Plainvest: deploy guide

Files: `index.html` (the page) and `api/analyze.js` (the backend). No dependencies. Needs Node 18+.

## Deploy on Vercel (free)
1. Put this folder in a GitHub repo, or install the Vercel CLI and run `vercel` inside the folder.
2. In Vercel, open Project > Settings > Environment Variables and add:
   - `SEC_USER_AGENT` = `Plainvest yourname@youremail.com` (required; the SEC blocks requests without a real contact)
   - `ANTHROPIC_API_KEY` = your key from console.anthropic.com (optional; without it, summaries use built-in templates)
3. Redeploy. Open your site and try AAPL, KO, or TSLA.

## Notes
- Results are cached for 24 hours at Vercel's edge, which keeps you far below the SEC's 10 requests/second limit.
- Foreign companies that file 20-F reports, and some banks and insurers, may show "can't analyze yet".
- Thresholds (e.g. 10% margin = good) are rough and live in `analyzeFacts`. Adjust them as you learn.
