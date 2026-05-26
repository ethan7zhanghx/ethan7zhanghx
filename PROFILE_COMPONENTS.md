# Profile Components

This repository is a dynamic GitHub profile README. It avoids personal intro copy and renders a wall of generated SVG data components.

## What It Generates

- `stats-strip.svg`: compact totals for contributions, active days, streak, private-aware restricted contributions, pull requests, issues, and reviews.
- `contribution-skyline.svg`: a 3D-style annual commit skyline.
- `contribution-heatmap.svg`: a minimal private-aware commit heatmap.
- `year-pulse.svg`: a yearly commit waveform.
- `contribution-rings.svg`: a radial 365-day commit calendar.
- `work-rhythm.svg`: weekday/hour commit rhythm from accessible repositories.
- `language-orbit.svg`: aggregate language distribution from accessible repositories.
- `metrics.json`: sanitized raw aggregate data for debugging.

## Private Repository Support

GitHub's default `GITHUB_TOKEN` can update this repository, but it cannot read all of your private repositories. To include private repositories, create a token and save it as:

```text
PROFILE_STATS_TOKEN
```

Recommended token access:

- Fine-grained token: read-only access to the repositories you want counted, plus metadata.
- Classic token: `repo` and `read:user`.

Add it with GitHub CLI after the profile repository exists:

```bash
gh secret set PROFILE_STATS_TOKEN --repo ethan7zhanghx/ethan7zhanghx
```

The generated SVGs do not include private repository names. They only show aggregate counts, calendar density, rhythms, and language totals.

## Local Preview

```bash
PROFILE_USERNAME=ethan7zhanghx PROFILE_STATS_TOKEN="$(gh auth token)" npm run generate
```

Open `README.md` in GitHub or any Markdown preview that can display local SVG files.

## Useful Toggles

Environment variables:

- `PROFILE_USERNAME`: GitHub username to render.
- `PROFILE_OUTPUT_DIR`: output directory, defaults to `assets/profile`.
- `PROFILE_INCLUDE_REPO_NAMES`: set to `true` only if you intentionally want public/private repo names in `metrics.json`.
