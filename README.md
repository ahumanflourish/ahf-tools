# ahf-tools

Tools from [A Human Flourish](https://ahumanflourish.com). This repo is also a
Claude Code plugin marketplace, so each tool installs on its own — there is
nothing to clone.

```
/plugin marketplace add ahumanflourish/ahf-tools
/plugin install portfolio-review@ahf-tools
```

## Tools

| Tool | Status | What it does |
|---|---|---|
| `portfolio-review` | **in development — not yet usable** | Compares a portfolio's history against passive reference strategies over the same period with the same cash flows. |

## Layout

Each tool is one directory under `tools/`, holding its skill, its computation
core, and the dashboard the skill renders locally.

```
tools/portfolio/
  .claude-plugin/plugin.json
  skills/analyse/SKILL.md      the skill Claude Code loads
  core/                        the engine + benchmark data
  dashboard.html               the template the skill populates  (not yet written)
```

## Privacy

The tools that handle personal data are built so that it never leaves the
machine they run on. Benchmark data is bundled rather than fetched, and nothing
is logged or sent anywhere. Where a path does involve a model reading the user's
data, that is stated at the point of choice rather than in a footer.
