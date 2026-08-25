import matplotlib.pyplot as plt
import matplotlib.patches as mpatches

plt.style.use("seaborn-v0_8-whitegrid")

# Fixed order per docs/hypothesis-2b.md reporting rule - never sorted by result.
bars = ["5m", "15m", "1H", "4H"]
data = {
    "5m":  {"real": 34.49, "pct": 73.3, "p95": 35.14, "min": 31.98, "mean": 34.11, "max": 36.28},
    "15m": {"real": 34.69, "pct": 8.1,  "p95": 38.53, "min": 32.40, "mean": 36.42, "max": 40.90},
    "1H":  {"real": 36.64, "pct": 56.3, "p95": 40.60, "min": 27.13, "mean": 36.28, "max": 44.53},
    "4H":  {"real": 30.43, "pct": 57.2, "p95": 40.04, "min": 4.17,  "mean": 29.26, "max": 50.00},
}

fig, ax = plt.subplots(figsize=(9, 7))

x = list(range(len(bars)))
NULL_COLOR = "#9aa5b1"
REAL_COLOR = "#c0392b"
P95_COLOR = "#2c3e50"

for i, bar in enumerate(bars):
    d = data[bar]
    # Full 1000-trial permutation-null range (min-max), as a vertical band.
    ax.plot([i, i], [d["min"], d["max"]], color=NULL_COLOR, linewidth=6, solid_capstyle="round", alpha=0.45, zorder=1)
    # Null mean, small tick.
    ax.plot([i - 0.14, i + 0.14], [d["mean"], d["mean"]], color=NULL_COLOR, linewidth=2, zorder=2)
    # 95th-percentile pass bar (pre-registered criterion 3 threshold).
    ax.plot([i - 0.22, i + 0.22], [d["p95"], d["p95"]], color=P95_COLOR, linewidth=2.5, zorder=3)
    # Real gross win rate.
    ax.scatter([i], [d["real"]], color=REAL_COLOR, s=130, zorder=4, edgecolor="white", linewidth=1.2)
    # Percentile annotation.
    ax.annotate(
        f"{d['real']:.1f}%\n(pct {d['pct']:.1f})",
        (i, d["real"]),
        textcoords="offset points",
        xytext=(0, -28 if bar != "15m" else -34),
        ha="center",
        fontsize=9,
        color=REAL_COLOR,
        fontweight="bold",
    )

# Zero-cost break-even reference (1/3 win rate at 2:1 R:R).
ax.axhline(33.33, color="#b8860b", linestyle=":", linewidth=1.3, zorder=0)
ax.text(len(bars) - 0.55, 33.33, "33.33% zero-cost break-even", color="#8a6d00", fontsize=8.5, va="bottom", ha="right")

ax.set_xticks(x)
ax.set_xticklabels(bars, fontsize=12)
ax.set_ylabel("Gross win rate (fee=0, slippage=0, funding=0)", fontsize=11)
ax.set_title(
    "No timeframe's real win rate clears its own 95th-percentile chance bar",
    fontsize=13.5, fontweight="bold", pad=40,
)
ax.text(
    0.5, 1.065,
    "Phase 2b: same frozen signal, 4 timeframes, each against its own 1000-trial random-direction permutation null",
    transform=ax.transAxes, ha="center", fontsize=9.5, color="#555555",
)

real_handle = plt.Line2D([0], [0], marker="o", color="w", markerfacecolor=REAL_COLOR, markersize=10, label="Real gross win rate")
p95_handle = mpatches.Patch(facecolor="none", edgecolor=P95_COLOR, linewidth=2.5, label="95th-pct bar (pass threshold)")
null_handle = mpatches.Patch(color=NULL_COLOR, alpha=0.45, label="1000-trial null range (min-max)")
mean_handle = plt.Line2D([0], [0], color=NULL_COLOR, linewidth=2, label="Null mean")
ax.legend(handles=[real_handle, p95_handle, null_handle, mean_handle], loc="upper left", fontsize=8.7, framealpha=0.9)

ax.set_ylim(0, 55)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
ax.set_xlim(-0.5, len(bars) - 0.5)

fig.text(
    0.5, 0.005,
    "Caveat (auditor finding, docs/phase2b-results.md): this null's construction has a known reliability issue - "
    "read as transparency, not a settled chance comparison.",
    ha="center", fontsize=7.7, color="#8a3b3b", style="italic",
)

plt.tight_layout(rect=(0, 0.025, 1, 1))
out_path = r"F:\0-projects\Orbits\docs\phase2b-timeframe-comparison.png"
plt.savefig(out_path, dpi=150, bbox_inches="tight")
print("saved", out_path)
